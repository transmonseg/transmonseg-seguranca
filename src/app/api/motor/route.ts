// Motor de detecção de alertas — POST /api/motor
// Rota protegida por x-motor-key (MOTOR_SECRET). Nunca use em client.

import pg from "pg";
import { createAdminClient } from "@/lib/supabase/admin";
import { buscarPosicoes, normalizar } from "@/lib/unitrac";
import { avaliar } from "@/lib/detectores";

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

  try {
    // 2. Carregar clientes ativos + veiculos ativos
    const { data: clientes, error: erroClientes } = await supabase
      .from("clientes")
      .select("id, cod_user_unitrac")
      .eq("ativo", true);

    if (erroClientes || !clientes) {
      throw new Error(`Erro ao carregar clientes: ${erroClientes?.message}`);
    }

    // Mapear cv → { veiculo_id, cliente_id }
    const mapaCv = new Map<string, { veiculo_id: string; cliente_id: string }>();

    for (const cliente of clientes) {
      const { data: veiculos, error: erroVeiculos } = await supabase
        .from("veiculos")
        .select("id, cv")
        .eq("cliente_id", cliente.id)
        .eq("ativo", true);

      if (erroVeiculos) {
        console.error(`Erro veiculos cliente ${cliente.id}:`, erroVeiculos.message);
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
        posicoesRaw = await buscarPosicoes(cvsCliente);
      } catch (err) {
        console.error(`buscarPosicoes falhou para cliente ${cliente.id}:`, err);
        continue;
      }

      // Normalizar e processar cada posicao
      for (const raw of posicoesRaw) {
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

        // Avaliar alerta
        const alerta = avaliar(pos, { paradoMin });

        // Determinar nivel
        let nivel: string;
        if (alerta?.nivel === "critico") {
          nivel = "vermelho";
        } else if (alerta?.nivel === "atencao") {
          nivel = "amarelo";
        } else {
          nivel = "verde";
        }

        const motivo = alerta?.motivo ?? null;

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
          // Sem alerta — resolver alertas ativos existentes
          if (alertasAtivos && alertasAtivos.length > 0) {
            const ids = alertasAtivos.map((a) => a.id);
            await supabase
              .from("alertas")
              .update({ status: "resolvido", resolvido_em: agora.toISOString() })
              .in("id", ids);
          }
        }
      }
    }

    // 7. Contar alertas ativos totais
    const { count: qtdAlertasAtivos } = await supabase
      .from("alertas")
      .select("id", { count: "exact", head: true })
      .eq("status", "ativo");

    totalAlertasAtivos = qtdAlertasAtivos ?? 0;

    return Response.json({
      processados: totalProcessados,
      frescos: totalFrescos,
      alertas_ativos: totalAlertasAtivos,
    });
  } finally {
    await pool.end();
  }
}
