// Motor de detecção de alertas — POST /api/motor
// Rota protegida por x-motor-key (MOTOR_SECRET). Nunca use em client.

import pg from "pg";
import { createAdminClient } from "@/lib/supabase/admin";
import { buscarPosicoes, normalizar } from "@/lib/unitrac";
import { avaliar } from "@/lib/detectores";

// Timeout para chamadas Unitrac (20 segundos)
const TIMEOUT_UNITRAC_MS = 20_000;

// ─── Converte datagps da Unitrac (DD/MM/YYYY HH:MM:SS) para ISO ou null ───
function parseDatagps(raw: string | undefined | null): string | null {
  if (!raw) return null;
  // Formato possivel: "22/06/2026 15:57:56" ou ISO "2026-06-22T..."
  const match = raw.match(/^(\d{2})\/(\d{2})\/(\d{4})\s+(\d{2}):(\d{2}):(\d{2})/);
  if (match) {
    const [, d, m, y, hh, mm, ss] = match;
    return `${y}-${m}-${d}T${hh}:${mm}:${ss}Z`;
  }
  // Tentar parsear direto (pode ser ISO)
  const ts = Date.parse(raw);
  return isNaN(ts) ? null : new Date(ts).toISOString();
}

// ─── Pool pg (necessário para ST_MakePoint no upsert de posicoes_atuais) ───
function criaPgPool() {
  return new pg.Pool({
    connectionString: process.env.DATABASE_URL,
    ssl: { rejectUnauthorized: false },
    max: 3,
  });
}

// ─── buscarPosicoes com timeout por AbortController ───────────────────────
async function buscarPosicoesComTimeout(cvs: string[]): Promise<unknown[]> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TIMEOUT_UNITRAC_MS);
  try {
    // Injeta o signal; buscarPosicoes nativo nao tem signal, entao reescrevemos
    // a chamada inline para evitar modificar o modulo unitrac.
    const BASE_URL = "https://datalayer.portalunitrac.com";
    const res = await fetch(`${BASE_URL}/mapa_servicos/posicoes/N/N`, {
      method: "POST",
      headers: {
        accept: "application/json",
        "content-type": "application/json",
      },
      body: JSON.stringify(cvs),
      signal: controller.signal,
    });
    if (!res.ok) {
      throw new Error(`buscarPosicoes HTTP ${res.status}`);
    }
    const data = (await res.json()) as { Posicoes: unknown[] };
    return data.Posicoes;
  } finally {
    clearTimeout(timer);
  }
}

// ─── Handler principal ───────────────────────────────────────────────────────

export async function POST(request: Request) {
  // 1. Segurança
  const chave = request.headers.get("x-motor-key");
  if (!chave || chave !== process.env.MOTOR_SECRET) {
    return Response.json({ erro: "Nao autorizado" }, { status: 401 });
  }

  const supabase = createAdminClient();
  const pool = criaPgPool();
  const agora = new Date();
  const erros: string[] = [];

  try {
    // 2. Carregar clientes ativos + veiculos ativos
    const { data: clientes, error: erroClientes } = await supabase
      .from("clientes")
      .select("id, cod_user_unitrac")
      .eq("ativo", true);

    if (erroClientes || !clientes) {
      return Response.json(
        { erro: `Erro ao carregar clientes: ${erroClientes?.message}` },
        { status: 500 }
      );
    }

    // Mapear cv -> { veiculo_id, cliente_id }
    const mapaCv = new Map<string, { veiculo_id: string; cliente_id: string }>();

    for (const cliente of clientes) {
      const { data: veiculos, error: erroVeiculos } = await supabase
        .from("veiculos")
        .select("id, cv")
        .eq("cliente_id", cliente.id)
        .eq("ativo", true);

      if (erroVeiculos) {
        const msg = `Erro veiculos cliente ${cliente.id}: ${erroVeiculos.message}`;
        console.error(msg);
        erros.push(msg);
        continue;
      }

      for (const v of veiculos ?? []) {
        mapaCv.set(v.cv, { veiculo_id: v.id, cliente_id: cliente.id });
      }
    }

    // 3. Carregar posicoes_atuais atuais para calcular parado_desde
    const { data: posatuaisRows } = await supabase
      .from("posicoes_atuais")
      .select("veiculo_id, lat, lng, velocidade, parado_desde");

    const mapaPosAtual = new Map<
      string,
      { lat: number | null; lng: number | null; velocidade: number | null; parado_desde: string | null }
    >();

    for (const row of posatuaisRows ?? []) {
      mapaPosAtual.set(row.veiculo_id, {
        lat: row.lat,
        lng: row.lng,
        velocidade: row.velocidade,
        parado_desde: row.parado_desde,
      });
    }

    // 4. Buscar posicoes de TODOS os CVs de uma vez por cliente
    let totalProcessados = 0;
    let totalFrescos = 0;
    let totalAlertasAtivos = 0;

    for (const cliente of clientes) {
      // Obter CVs deste cliente
      const cvsCliente = [...mapaCv.entries()]
        .filter(([, v]) => v.cliente_id === cliente.id)
        .map(([cv]) => cv);

      if (cvsCliente.length === 0) continue;

      let posicoesRaw: unknown[];
      try {
        posicoesRaw = await buscarPosicoesComTimeout(cvsCliente);
      } catch (err) {
        const isTimeout = err instanceof Error && err.name === "AbortError";
        const msg = isTimeout
          ? `Timeout (${TIMEOUT_UNITRAC_MS / 1000}s) ao buscar posicoes do cliente ${cliente.id}`
          : `buscarPosicoes falhou para cliente ${cliente.id}: ${String(err)}`;
        console.error(msg);
        erros.push(msg);
        continue;
      }

      // Normalizar e processar cada posicao
      for (const raw of posicoesRaw) {
        try {
          const pos = normalizar(raw as Record<string, unknown>);
          totalProcessados++;

          const entrada = mapaCv.get(pos.cv);
          if (!entrada) continue;

          const { veiculo_id, cliente_id } = entrada;

          // Calcular parado_desde
          let parado_desde: string | null = null;
          let paradoMin = 0;

          if (pos.velocidade === 0) {
            const anterior = mapaPosAtual.get(veiculo_id);
            const estavParado = anterior && anterior.velocidade === 0;

            // Verificar se ficou no mesmo lugar (lat/lng arredondados a 4 casas)
            const mesmoPonto =
              anterior &&
              anterior.lat !== null &&
              anterior.lng !== null &&
              Math.round(anterior.lat * 10000) === Math.round(pos.lat * 10000) &&
              Math.round(anterior.lng * 10000) === Math.round(pos.lng * 10000);

            if (estavParado && mesmoPonto && anterior.parado_desde) {
              // Manter parado_desde anterior
              parado_desde = anterior.parado_desde;
            } else {
              // Novo ponto de parada
              parado_desde = agora.toISOString();
            }

            paradoMin = Math.round((agora.getTime() - new Date(parado_desde).getTime()) / 60000);
          }

          // Avaliar alerta — somente para posicoes FRESCAS (atraso <= 60)
          // Posicoes nao frescas entram como "sem_comunicacao" (informativo), nunca como alerta.
          const alerta = pos.fresco ? avaliar(pos, { paradoMin }) : null;

          // Determinar nivel da posicao atual
          let nivel: string;
          if (!pos.fresco) {
            // Dado congelado — nivel cinza (sem_comunicacao, informativo)
            nivel = "cinza";
          } else if (alerta?.nivel === "critico") {
            nivel = "vermelho";
          } else if (alerta?.nivel === "atencao") {
            nivel = "amarelo";
          } else {
            nivel = "verde";
          }

          const motivo = pos.fresco ? (alerta?.motivo ?? null) : `Sem comunicacao ha ${pos.atraso}min`;

          // 5. Upsert em posicoes_atuais via pg (para ST_MakePoint)
          const pgClient = await pool.connect();
          try {
            await pgClient.query(
              `INSERT INTO posicoes_atuais
                (veiculo_id, lat, lng, geom, velocidade, ignicao, atraso_min,
                 panico, bau_aberto, nivel, motivo, datagps, parado_desde, updated_at)
               VALUES
                ($1, $2, $3,
                 ST_SetSRID(ST_MakePoint($4, $3), 4326)::geography,
                 $5, $6, $7, $8, $9, $10, $11,
                 $12::timestamptz, $13::timestamptz, $14::timestamptz)
               ON CONFLICT (veiculo_id) DO UPDATE SET
                 lat          = EXCLUDED.lat,
                 lng          = EXCLUDED.lng,
                 geom         = EXCLUDED.geom,
                 velocidade   = EXCLUDED.velocidade,
                 ignicao      = EXCLUDED.ignicao,
                 atraso_min   = EXCLUDED.atraso_min,
                 panico       = EXCLUDED.panico,
                 bau_aberto   = EXCLUDED.bau_aberto,
                 nivel        = EXCLUDED.nivel,
                 motivo       = EXCLUDED.motivo,
                 datagps      = EXCLUDED.datagps,
                 parado_desde = EXCLUDED.parado_desde,
                 updated_at   = EXCLUDED.updated_at`,
              [
                veiculo_id,
                pos.lat,
                pos.lng,
                pos.lng, // $4 = lng para ST_MakePoint(lng, lat)
                pos.velocidade,
                pos.ignicao,
                pos.atraso,
                pos.panico,
                pos.bau,
                nivel,
                motivo,
                parseDatagps(pos.datagps) ?? agora.toISOString(),
                parado_desde,
                agora.toISOString(),
              ]
            );
          } finally {
            pgClient.release();
          }

          // 6. Gerenciar alertas — somente para posicoes frescas
          if (!pos.fresco) continue;
          totalFrescos++;

          // Buscar alertas ativos existentes para este veiculo
          const { data: alertasAtivos } = await supabase
            .from("alertas")
            .select("id, tipo")
            .eq("veiculo_id", veiculo_id)
            .eq("status", "ativo");

          // Alertas do detector (panico, bau, jammer, excesso, parada_longa)
          // Excluir alertas do tipo 'favela' da resolucao automatica aqui
          // (o bloco de favela cuida disso separadamente)
          const alertasNaoFavela = (alertasAtivos ?? []).filter((a) => a.tipo !== "favela");

          if (alerta) {
            // Verificar se ja existe alerta ativo do mesmo tipo
            const jaExiste = (alertasAtivos ?? []).some((a) => a.tipo === alerta.tipo);

            if (!jaExiste) {
              // Inserir novo alerta
              await supabase.from("alertas").insert({
                cliente_id,
                veiculo_id,
                nivel: alerta.nivel,
                tipo: alerta.tipo,
                motivo: alerta.motivo,
                score: alerta.score,
                status: "ativo",
                lat: pos.lat,
                lng: pos.lng,
                desde: agora.toISOString(),
              });
            }
          } else {
            // Sem alerta detectado — resolver alertas ativos existentes (exceto favela)
            if (alertasNaoFavela.length > 0) {
              const ids = alertasNaoFavela.map((a) => a.id);
              await supabase
                .from("alertas")
                .update({ status: "resolvido", resolvido_em: agora.toISOString() })
                .in("id", ids);
            }
          }
        } catch (errVeiculo) {
          const msg = `Erro ao processar veiculo (raw): ${String(errVeiculo)}`;
          console.error(msg);
          erros.push(msg);
          // Continua para o proximo veiculo
        }
      }
    }

    // 7. Detector de favela — query batch eficiente via ST_Intersects + GIST
    // Retorna apenas veiculos frescos (atraso_min <= 60) dentro de alguma favela.
    {
      const pgClient = await pool.connect();
      try {
        const { rows: veiculosEmFavela } = await pgClient.query<{
          veiculo_id: string;
          cliente_id: string;
          lat: number;
          lng: number;
          nome_favela: string;
        }>(
          `SELECT
             p.veiculo_id,
             v.cliente_id,
             p.lat,
             p.lng,
             g.nome AS nome_favela
           FROM posicoes_atuais p
           JOIN veiculos v ON v.id = p.veiculo_id
           JOIN geofences g
             ON g.tipo = 'favela'
             AND ST_Intersects(g.geom, p.geom)
           WHERE p.atraso_min <= 60`
        );

        for (const vf of veiculosEmFavela) {
          try {
            // Atualizar nivel para vermelho
            await pgClient.query(
              `UPDATE posicoes_atuais SET nivel = 'vermelho' WHERE veiculo_id = $1`,
              [vf.veiculo_id]
            );

            // Idempotente: so inserir alerta favela se nao houver um ativo
            const { data: alertaFavelaAtivo } = await supabase
              .from("alertas")
              .select("id")
              .eq("veiculo_id", vf.veiculo_id)
              .eq("tipo", "favela")
              .eq("status", "ativo")
              .maybeSingle();

            if (!alertaFavelaAtivo) {
              await supabase.from("alertas").insert({
                cliente_id: vf.cliente_id,
                veiculo_id: vf.veiculo_id,
                nivel: "critico",
                tipo: "favela",
                motivo: `Dentro da favela: ${vf.nome_favela}`,
                score: 95,
                status: "ativo",
                lat: vf.lat,
                lng: vf.lng,
                desde: agora.toISOString(),
              });
            }
          } catch (errFavela) {
            const msg = `Erro ao processar favela para veiculo ${vf.veiculo_id}: ${String(errFavela)}`;
            console.error(msg);
            erros.push(msg);
          }
        }

        // Resolver alertas favela de veiculos que saíram da area de risco
        // (so veiculos que TINHAM alerta ativo de favela mas nao estao mais nela)
        if (veiculosEmFavela.length >= 0) {
          const idsEmFavela = veiculosEmFavela.map((vf) => vf.veiculo_id);

          // Buscar alertas favela ativos
          const { data: alertasFavelaAtivos } = await supabase
            .from("alertas")
            .select("id, veiculo_id")
            .eq("tipo", "favela")
            .eq("status", "ativo");

          const parasResolver = (alertasFavelaAtivos ?? []).filter(
            (a) => !idsEmFavela.includes(a.veiculo_id)
          );

          if (parasResolver.length > 0) {
            const ids = parasResolver.map((a) => a.id);
            await supabase
              .from("alertas")
              .update({ status: "resolvido", resolvido_em: agora.toISOString() })
              .in("id", ids);
          }
        }
      } catch (errBatchFavela) {
        const msg = `Erro no batch de favela: ${String(errBatchFavela)}`;
        console.error(msg);
        erros.push(msg);
      } finally {
        pgClient.release();
      }
    }

    // 8. Contar alertas ativos totais
    const { count: qtdAlertasAtivos } = await supabase
      .from("alertas")
      .select("id", { count: "exact", head: true })
      .eq("status", "ativo");

    totalAlertasAtivos = qtdAlertasAtivos ?? 0;

    return Response.json({
      processados: totalProcessados,
      frescos: totalFrescos,
      alertas_ativos: totalAlertasAtivos,
      erros,
    });
  } catch (errGeral) {
    console.error("Erro geral no motor:", errGeral);
    return Response.json(
      {
        erro: `Erro interno do motor: ${String(errGeral)}`,
        processados: 0,
        frescos: 0,
        alertas_ativos: 0,
        erros: [String(errGeral)],
      },
      { status: 500 }
    );
  } finally {
    await pool.end();
  }
}
