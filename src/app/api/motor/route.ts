// Motor de detecção de alertas — POST /api/motor
// Rota protegida por x-motor-key (MOTOR_SECRET). Nunca use em client.

import pg from "pg";
import { createAdminClient } from "@/lib/supabase/admin";
import {
  buscarAlvos,
  agruparAlvosPorPlaca,
  agruparPontosPorPlaca,
  distAlvoPendenteMaisProximoM,
  alvoPendenteMaisProximo,
  alvoMaisProximoQualquer,
  rumoGraus,
  haversineM,
  normalizar,
} from "@/lib/unitrac";
import type { EntregasPlaca, PontoEntrega } from "@/lib/unitrac";
import { avaliar, detectarJammer, foraDeRota, emHorarioOperacao } from "@/lib/detectores";
import { temPOIProximo } from "@/lib/overpass";
import {
  hashAlvos, buscarRotaOSRM, distanciaAoCorredorM, centroideGeo, RAIO_CORREDOR_M,
} from "@/lib/osrm";
import { buscarTiroteiosRJ } from "@/lib/fogocruzado";
import type { Tiroteio } from "@/lib/fogocruzado";

// Função serverless: roda em sao paulo (gru1, ver vercel.json) e pode levar ate 60s.
export const maxDuration = 60;

// Timeout para chamadas Unitrac (20 segundos)
const TIMEOUT_UNITRAC_MS = 20_000;

// Limite de geocodes novos (Nominatim) por ciclo do motor.
// Baixo de proposito: o Nominatim e lento/restrito a partir de datacenter (Vercel),
// entao geocodamos poucos por ciclo e vamos cobrindo aos poucos (cache no banco).
// Com a chave do Google (cota alta), geocodamos bem mais por ciclo — inclusive
// veículos em movimento que estão em alerta. Sem ela, caímos no Nominatim, que
// é restrito a partir de datacenter, então poucos por ciclo.
const TEM_GOOGLE_GEOCODE = !!process.env.GOOGLE_MAPS_API_KEY;
const LIMITE_GEOCODES_NOVOS = TEM_GOOGLE_GEOCODE ? 30 : 3;

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

// ─── buscarAlvos com timeout ───────────────────────────────────────────────
// Retorna entregas (contagem feito/total) E os pontos de entrega por placa
// (a rota planejada), usados pelo detector de desvio.
async function buscarAlvosComTimeout(cvs: string[]): Promise<{
  entregas: Map<string, EntregasPlaca>;
  pontos: Map<string, PontoEntrega[]>;
}> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TIMEOUT_UNITRAC_MS);
  try {
    const alvos = await buscarAlvos(cvs);
    clearTimeout(timer);
    return { entregas: agruparAlvosPorPlaca(alvos), pontos: agruparPontosPorPlaca(alvos) };
  } catch (err) {
    clearTimeout(timer);
    throw err;
  }
}

// ─── Geocode reverso via Nominatim com cache em banco ─────────────────────
// Retorna o endereco formatado (3 primeiras partes do display_name) ou null.
async function geocodeReverso(
  lat: number,
  lng: number,
  pool: pg.Pool,
  contadorNovos: { valor: number }
): Promise<string | null> {
  // Arredondar a 4 casas para usar como chave de cache
  const latR = Math.round(lat * 10000) / 10000;
  const lngR = Math.round(lng * 10000) / 10000;

  // Consultar cache no banco
  const pgClient = await pool.connect();
  try {
    const { rows } = await pgClient.query<{ endereco: string }>(
      `SELECT endereco FROM geocode_cache WHERE lat = $1 AND lng = $2 LIMIT 1`,
      [latR, lngR]
    );
    if (rows.length > 0) {
      return rows[0].endereco;
    }
  } finally {
    pgClient.release();
  }

  // Cache miss: verificar orçamento antes de chamar Nominatim
  if (contadorNovos.valor >= LIMITE_GEOCODES_NOVOS) {
    return null;
  }
  contadorNovos.valor += 1;

  try {
    let endereco: string | null = null;
    const chaveGoogle = process.env.GOOGLE_MAPS_API_KEY;

    if (chaveGoogle) {
      // Google Geocoding (reverso): preciso e com cota alta. Pega rua + bairro.
      const url = `https://maps.googleapis.com/maps/api/geocode/json?latlng=${lat},${lng}&language=pt-BR&key=${chaveGoogle}`;
      const res = await fetch(url, { signal: AbortSignal.timeout(4000) });
      if (res.ok) {
        const data = (await res.json()) as { results?: { formatted_address?: string }[] };
        const fa = data.results?.[0]?.formatted_address;
        if (fa) endereco = fa.split(",").map((p) => p.trim()).slice(0, 2).join(", ");
      }
    } else {
      // Nominatim (OpenStreetMap): grátis, mas restrito de datacenter.
      const url = `https://nominatim.openstreetmap.org/reverse?lat=${lat}&lon=${lng}&format=json&accept-language=pt-BR`;
      const res = await fetch(url, {
        headers: { "User-Agent": "TransmonsegCentral/1.0" },
        signal: AbortSignal.timeout(3000),
      });
      if (res.ok) {
        const data = (await res.json()) as { display_name?: string };
        if (data.display_name) endereco = data.display_name.split(",").map((p) => p.trim()).slice(0, 3).join(", ");
      }
    }
    if (!endereco) return null;

    // Salvar no cache
    const pgSave = await pool.connect();
    try {
      await pgSave.query(
        `INSERT INTO geocode_cache (lat, lng, endereco) VALUES ($1, $2, $3)
         ON CONFLICT (lat, lng) DO NOTHING`,
        [latR, lngR, endereco]
      );
    } finally {
      pgSave.release();
    }

    return endereco;
  } catch {
    return null;
  }
}

// ─── Point-in-polygon (ray casting) para checar se o veículo está na base ───
// As bases são polígonos reais (perímetro de onde a frota estaciona), não
// círculos. Lida com Polygon e MultiPolygon; ignora buracos (buffers não têm).
type GeoJSONGeom =
  | { type: "Polygon"; coordinates: number[][][] }
  | { type: "MultiPolygon"; coordinates: number[][][][] };

function pontoEmAnel(lng: number, lat: number, anel: number[][]): boolean {
  let dentro = false;
  for (let i = 0, j = anel.length - 1; i < anel.length; j = i++) {
    const xi = anel[i][0], yi = anel[i][1];
    const xj = anel[j][0], yj = anel[j][1];
    const cruza = yi > lat !== yj > lat && lng < ((xj - xi) * (lat - yi)) / (yj - yi) + xi;
    if (cruza) dentro = !dentro;
  }
  return dentro;
}

function pontoEmGeo(lng: number, lat: number, geom: GeoJSONGeom | null): boolean {
  if (!geom) return false;
  if (geom.type === "Polygon") return pontoEmAnel(lng, lat, geom.coordinates[0]);
  if (geom.type === "MultiPolygon") return geom.coordinates.some((poly) => pontoEmAnel(lng, lat, poly[0]));
  return false;
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
  const emOperacao = emHorarioOperacao(agora);

  // Contador de geocodes novos consumidos neste ciclo
  const contadorGeocodesNovos = { valor: 0 };

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

    // Mapear cv -> { veiculo_id, cliente_id, placa }
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

    // 3a. Carregar bases de cada cliente (polígonos do perímetro real).
    // Estrutura: cliente_id -> lista de { nome, geom (GeoJSON) }
    const mapaBasesCliente = new Map<
      string,
      { nome: string; geom: GeoJSONGeom | null }[]
    >();

    {
      const pgBases = await pool.connect();
      try {
        const { rows: basesRows } = await pgBases.query<{
          cliente_id: string;
          nome: string;
          geojson: string;
        }>(
          `SELECT cliente_id, nome, ST_AsGeoJSON(geom::geometry) AS geojson FROM bases`
        );
        for (const b of basesRows) {
          const lista = mapaBasesCliente.get(b.cliente_id) ?? [];
          let geom: GeoJSONGeom | null = null;
          try { geom = JSON.parse(b.geojson) as GeoJSONGeom; } catch { /* ignora */ }
          lista.push({ nome: b.nome, geom });
          mapaBasesCliente.set(b.cliente_id, lista);
        }
      } catch (errBases) {
        // Nao impede o motor de rodar; sem bases = foraDaBase=true para todos
        const msg = `Aviso: erro ao carregar bases (${String(errBases)})`;
        console.warn(msg);
        erros.push(msg);
      } finally {
        pgBases.release();
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

    // Tiroteios ATIVOS (últimas 3h) do RJ inteiro — risco em tempo real comum
    // a todas as frotas. Cruzamos com cada veículo (detector tiroteio próximo).
    // Falha graciosa: sem tiroteios, o detector simplesmente não dispara.
    let tiroteiosAtivos: Tiroteio[] = [];
    try {
      tiroteiosAtivos = (await buscarTiroteiosRJ(1)).filter((t) => t.recente);
    } catch {
      tiroteiosAtivos = [];
    }

    // Acumulador de pontos de entrega por veiculo_id — usado na supressao
    // de alerta favela quando o proprio destino esta dentro da comunidade.
    const veiculoIdToAlvos = new Map<string, PontoEntrega[]>();

    // Cache de rotas OSRM por veiculo (validade 4h). Carregado em lote antes
    // do loop para evitar N queries individuais.
    const mapaRotasCache = new Map<string, { alvos_hash: string; pontos_rota: [number, number][] }>();
    {
      const todosVeiculoIds = [...mapaCv.values()].map((v) => v.veiculo_id);
      if (todosVeiculoIds.length > 0) {
        const pgRotas = await pool.connect();
        try {
          const { rows: rotasRows } = await pgRotas.query<{
            veiculo_id: string;
            alvos_hash: string;
            pontos_rota: [number, number][];
          }>(
            `SELECT veiculo_id, alvos_hash, pontos_rota
             FROM rotas_cache
             WHERE veiculo_id = ANY($1::uuid[])
               AND criado_em > now() - interval '4 hours'`,
            [todosVeiculoIds]
          );
          for (const r of rotasRows) {
            mapaRotasCache.set(r.veiculo_id, { alvos_hash: r.alvos_hash, pontos_rota: r.pontos_rota });
          }
        } catch { /* graceful: sem cache = recalcula */ } finally {
          pgRotas.release();
        }
      }
    }
    // Acumula rotas novas/atualizadas para upsert em batch ao final do ciclo.
    const rotasParaUpsert: { veiculo_id: string; alvos_hash: string; pontos_rota: [number, number][] }[] = [];
    let osrmChamadasNoCiclo = 0;
    const OSRM_MAX_POR_CICLO = 5;

    for (const cliente of clientes) {
      // Benassi: cliente cod_user_unitrac "4586" tem detector de parada no cliente.
      const ehBenassi = cliente.cod_user_unitrac === "4586";

      // Obter CVs deste cliente
      const cvsCliente = [...mapaCv.entries()]
        .filter(([, v]) => v.cliente_id === cliente.id)
        .map(([cv]) => cv);

      if (cvsCliente.length === 0) continue;

      // 4a. Buscar posicoes do cliente
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

      // 4b. Buscar alvos (entregas + pontos da rota) deste cliente
      let entregasPorPlaca = new Map<string, EntregasPlaca>();
      let pontosPorPlaca = new Map<string, PontoEntrega[]>();
      try {
        const res = await buscarAlvosComTimeout(cvsCliente);
        entregasPorPlaca = res.entregas;
        pontosPorPlaca = res.pontos;
      } catch (err) {
        // Nao-critico: entregas ficam 0/0 se API falhar
        const msg = `Aviso: buscarAlvos falhou para cliente ${cliente.id}: ${String(err)}`;
        console.warn(msg);
        erros.push(msg);
      }

      // Normalizar e processar cada posicao
      for (const raw of posicoesRaw) {
        try {
          const pos = normalizar(raw as Record<string, unknown>);
          totalProcessados++;

          const entrada = mapaCv.get(pos.cv);
          if (!entrada) continue;

          const { veiculo_id, cliente_id } = entrada;

          // Posição anterior (para parado_desde e para o afastamento do desvio)
          const anterior = mapaPosAtual.get(veiculo_id);

          // Calcular parado_desde
          let parado_desde: string | null = null;
          let paradoMin = 0;

          if (pos.velocidade === 0) {
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

          // Calcular se o veiculo esta dentro de alguma base do cliente
          // (point-in-polygon contra o perímetro real da base).
          const basesCliente = mapaBasesCliente.get(cliente_id) ?? [];
          const baseOcupada = basesCliente.find((b) => pontoEmGeo(pos.lng, pos.lat, b.geom));
          const foraDaBase = !baseOcupada;

          // ─── Desvio de rota: distância aos pontos de entrega pendentes ──
          // A rota planejada são os alvos (pontos) do veículo. O detector de
          // desvio compara a distância atual ao ponto pendente mais próximo
          // com a do ciclo anterior (afastamento).
          const pontosVeiculo = pontosPorPlaca.get(pos.placa);
          veiculoIdToAlvos.set(veiculo_id, pontosVeiculo ?? []);
          const temPendentes = (pontosVeiculo ?? []).some((pt) => !pt.feito);
          const maisProximo = alvoPendenteMaisProximo(pos.lat, pos.lng, pontosVeiculo);
          const distAlvoM = maisProximo?.distM ?? null;
          const distAlvoAnteriorM =
            anterior && anterior.lat != null && anterior.lng != null
              ? distAlvoPendenteMaisProximoM(anterior.lat, anterior.lng, pontosVeiculo)
              : null;

          // Parada no cliente (Benassi): verificar se o veiculo esta parado
          // dentro do raio de qualquer ponto da rota (feito OU pendente).
          const maisProximoQualquer = alvoMaisProximoQualquer(pos.lat, pos.lng, pontosVeiculo);
          const noCliente =
            pos.velocidade === 0 &&
            maisProximoQualquer !== null &&
            maisProximoQualquer.distM <= Math.max(maisProximoQualquer.ponto.raio, 150);

          // Rumo do movimento (ciclo anterior → posição atual) e rumo até o
          // ponto pendente mais próximo, para o detector corroborar o desvio.
          const rumoMovimento =
            anterior && anterior.lat != null && anterior.lng != null &&
            (anterior.lat !== pos.lat || anterior.lng !== pos.lng)
              ? rumoGraus(anterior.lat, anterior.lng, pos.lat, pos.lng)
              : null;
          const rumoAlvo = maisProximo
            ? rumoGraus(pos.lat, pos.lng, maisProximo.ponto.lat, maisProximo.ponto.lng)
            : null;
          // Condição FROUXA de permanência: ainda fora de rota (anti-pisca).
          const estaForaDeRota = pos.fresco && foraDeRota(pos, { distAlvoM, temPendentes, emOperacao, foraDaBase });

          // ─── Corredor OSRM: distância do veículo à rota planejada ───────
          // Calculado apenas para veículos frescos, em operação, fora da base
          // e com entregas pendentes. Usa cache de 4h; máx 5 chamadas/ciclo.
          let distCorredorM: number | null = null;
          if (temPendentes && emOperacao && foraDaBase && pos.fresco) {
            const pendentes = (pontosVeiculo ?? []).filter((pt) => !pt.feito);
            if (pendentes.length > 0) {
              const novoHash = hashAlvos(pendentes);
              const cachado = mapaRotasCache.get(veiculo_id);
              let pontosRota: [number, number][] | null = cachado?.pontos_rota ?? null;

              if (!cachado || cachado.alvos_hash !== novoHash) {
                if (osrmChamadasNoCiclo < OSRM_MAX_POR_CICLO) {
                  const basesCliente2 = mapaBasesCliente.get(cliente_id) ?? [];
                  const centroBase = basesCliente2.length > 0
                    ? centroideGeo(basesCliente2[0].geom)
                    : null;
                  const waypoints: { lat: number; lng: number }[] = [];
                  if (centroBase) waypoints.push(centroBase);
                  waypoints.push(...pendentes.map((p) => ({ lat: p.lat, lng: p.lng })));
                  if (waypoints.length >= 2) {
                    const rota = await buscarRotaOSRM(waypoints);
                    if (rota) {
                      pontosRota = rota;
                      osrmChamadasNoCiclo++;
                      rotasParaUpsert.push({ veiculo_id, alvos_hash: novoHash, pontos_rota: rota });
                      mapaRotasCache.set(veiculo_id, { alvos_hash: novoHash, pontos_rota: rota });
                    }
                  }
                }
              }

              if (pontosRota && pontosRota.length > 0) {
                distCorredorM = distanciaAoCorredorM(pos.lat, pos.lng, pontosRota);
              }
            }
          }

          // ─── Tiroteio próximo: dist ao tiroteio ATIVO mais perto ────────
          let distTiroteioM: number | null = null;
          let tiroteioIdadeMin: number | null = null;
          if (pos.fresco && tiroteiosAtivos.length > 0) {
            for (const t of tiroteiosAtivos) {
              const d = haversineM(pos.lat, pos.lng, t.lat, t.lng);
              if (distTiroteioM === null || d < distTiroteioM) {
                distTiroteioM = d;
                tiroteioIdadeMin = t.idadeMin;
              }
            }
          }

          // ─── Entregas do veículo ────────────────────────────────────────
          const entregas = entregasPorPlaca.get(pos.placa) ?? { feitos: 0, total: 0 };
          const entregas_feitas = entregas.feitos;
          const entregas_total = entregas.total;

          // Determinar nivel e alerta com ordem de prioridade correta:
          //
          // 1. JAMMER (prioridade maxima): ignicao ligada + atraso entre 15 e 720 min.
          //    Prevalece mesmo que o veiculo nao seja "fresco" (atraso > 60).
          //    Sinal que some com veiculo ligado e o alerta mais critico do sistema.
          //
          // 2. SEM COMUNICACAO (cinza, informativo, sem alerta): nao e jammer
          //    E (atraso > 720 OU (atraso > 60 E ignicao desligada)).
          //    Morto/defeito ou desligado legitimamente.
          //
          // 3. FRESCO (atraso <= 60): rodar avaliar() normalmente (panico, bau,
          //    excesso, parada_longa) + detector de favela.

          const alertaJammer = detectarJammer(pos);
          const ehSemComunicacao =
            !alertaJammer &&
            (pos.atraso > 720 || (pos.atraso > 60 && !pos.ignicao));

          // ─── Parada anomala: calcular contexto (so para candidatos reais) ──
          // Candidato: parado entre 12 e 89 min, fresco, fora de base, fora de cliente.
          const candidatoParadaAnomala =
            pos.fresco &&
            pos.velocidade === 0 &&
            paradoMin >= 12 && paradoMin < 90 &&
            foraDaBase && !noCliente && emOperacao;

          let estavEmMovimento = false;
          let esMadrugada = false;
          let temPOI = false;
          const jaParedoNoCicloAnterior =
            anterior != null &&
            anterior.velocidade === 0 &&
            anterior.lat != null && anterior.lng != null &&
            Math.round(anterior.lat * 10000) === Math.round(pos.lat * 10000) &&
            Math.round(anterior.lng * 10000) === Math.round(pos.lng * 10000);

          if (candidatoParadaAnomala) {
            estavEmMovimento = anterior != null && (anterior.velocidade ?? 0) >= 30;
            const horaSP = parseInt(
              new Intl.DateTimeFormat("pt-BR", {
                timeZone: "America/Sao_Paulo", hour: "numeric", hour12: false,
              }).format(agora),
              10
            );
            esMadrugada = horaSP >= 0 && horaSP < 5;
            temPOI = await temPOIProximo(pos.lat, pos.lng, pool);
          }

          const alerta = alertaJammer
            ? alertaJammer
            : pos.fresco
              ? avaliar(pos, {
                  paradoMin,
                  emOperacao,
                  foraDaBase,
                  noCliente,
                  ehBenassi,
                  distAlvoM,
                  distAlvoAnteriorM,
                  temPendentes,
                  rumoMovimento,
                  rumoAlvo,
                  distTiroteioM,
                  tiroteioIdadeMin,
                  estavEmMovimento: candidatoParadaAnomala ? estavEmMovimento : undefined,
                  esMadrugada,
                  emZonaRisco: false,
                  temPOIProximo: temPOI,
                  jaParedoNoCicloAnterior,
                  distCorredorM,
                })
              : null;

          // Determinar nivel da posicao atual
          let nivel: string;
          if (alertaJammer) {
            // Jammer: critico, vermelho, independente de fresco
            nivel = "vermelho";
          } else if (ehSemComunicacao) {
            // Dado congelado sem ignicao ou morto — nivel cinza (informativo)
            nivel = "cinza";
          } else if (alerta?.nivel === "critico") {
            nivel = "vermelho";
          } else if (alerta?.nivel === "atencao") {
            nivel = "amarelo";
          } else {
            nivel = "verde";
          }

          // ─── Localização do veículo (agora que sabemos o nível) ─────────
          // Base > endereço (parado OU em alerta, inclusive em movimento) > Em deslocamento.
          // Geocodar veículo em alerta mesmo andando: a central quer a rua em tempo real.
          let localVeiculo: string | null = null;
          if (baseOcupada) {
            localVeiculo = baseOcupada.nome;
          } else if (pos.fresco) {
            const emAlerta = nivel === "vermelho" || nivel === "amarelo";
            if (pos.velocidade === 0 || emAlerta) {
              localVeiculo = await geocodeReverso(pos.lat, pos.lng, pool, contadorGeocodesNovos);
            } else {
              localVeiculo = "Em deslocamento";
            }
          }

          // ─── Nível "concluido": recolhido na base com entregas feitas ──
          // Sobrescreve verde/amarelo (informativo, nao e alerta).
          if (
            nivel === "verde" &&
            !foraDaBase &&
            !pos.ignicao &&
            entregas_feitas > 0
          ) {
            nivel = "concluido";
          }

          const motivo = alertaJammer
            ? alertaJammer.motivo
            : ehSemComunicacao
              ? `Sem comunicacao ha ${pos.atraso}min`
              : (alerta?.motivo ?? null);

          // 5. Upsert em posicoes_atuais via pg (para ST_MakePoint)
          const pgClient = await pool.connect();
          try {
            await pgClient.query(
              `INSERT INTO posicoes_atuais
                (veiculo_id, lat, lng, geom, velocidade, ignicao, atraso_min,
                 panico, bau_aberto, nivel, motivo, datagps, parado_desde, updated_at,
                 entregas_feitas, entregas_total, local)
               VALUES
                ($1, $2, $3,
                 ST_SetSRID(ST_MakePoint($4, $2), 4326)::geography,
                 $5, $6, $7, $8, $9, $10, $11,
                 $12::timestamptz, $13::timestamptz, $14::timestamptz,
                 $15, $16, $17)
               ON CONFLICT (veiculo_id) DO UPDATE SET
                 lat              = EXCLUDED.lat,
                 lng              = EXCLUDED.lng,
                 geom             = EXCLUDED.geom,
                 velocidade       = EXCLUDED.velocidade,
                 ignicao          = EXCLUDED.ignicao,
                 atraso_min       = EXCLUDED.atraso_min,
                 panico           = EXCLUDED.panico,
                 bau_aberto       = EXCLUDED.bau_aberto,
                 nivel            = EXCLUDED.nivel,
                 motivo           = EXCLUDED.motivo,
                 datagps          = EXCLUDED.datagps,
                 parado_desde     = EXCLUDED.parado_desde,
                 updated_at       = EXCLUDED.updated_at,
                 entregas_feitas  = EXCLUDED.entregas_feitas,
                 entregas_total   = EXCLUDED.entregas_total,
                 local            = COALESCE(EXCLUDED.local, posicoes_atuais.local)`,
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
                entregas_feitas,
                entregas_total,
                localVeiculo,
              ]
            );
          } finally {
            pgClient.release();
          }

          // 6. Gerenciar alertas — para posicoes frescas E para jammers
          // (jammer pode ocorrer com atraso > 60, portanto !fresco, mas e critico)
          const deveGerenciarAlertas = pos.fresco || !!alertaJammer;
          if (!deveGerenciarAlertas) continue;
          if (pos.fresco) totalFrescos++;

          // Alertas EM ABERTO (ativo OU reconhecido pelo operador). Reconhecido
          // conta como em aberto: o operador assumiu, NAO duplicar nem recriar.
          const { data: alertasAbertos } = await supabase
            .from("alertas")
            .select("id, tipo")
            .eq("veiculo_id", veiculo_id)
            .in("status", ["ativo", "reconhecido"]);

          // Tipos SILENCIADOS: o operador marcou falso positivo ha pouco (2h).
          // Respeitamos a decisao dele e nao recriamos o alerta nesse periodo.
          const desde2h = new Date(agora.getTime() - 2 * 60 * 60 * 1000).toISOString();
          const { data: falsosRecentes } = await supabase
            .from("alertas")
            .select("tipo")
            .eq("veiculo_id", veiculo_id)
            .eq("status", "falso_positivo")
            .gte("resolvido_em", desde2h);
          const tiposSilenciados = new Set((falsosRecentes ?? []).map((a) => a.tipo));

          // Resolucao automatica generica: todos os tipos EXCETO favela, desvio
          // e parada_anomala, que tem ciclo de vida proprio (tratados separado).
          const alertasGerenciados = (alertasAbertos ?? []).filter(
            (a) => a.tipo !== "favela" && a.tipo !== "desvio" && a.tipo !== "parada_anomala"
          );
          const desvioAtivo = (alertasAbertos ?? []).find((a) => a.tipo === "desvio");

          if (alerta) {
            const jaExiste = (alertasAbertos ?? []).some((a) => a.tipo === alerta.tipo);
            const silenciado = tiposSilenciados.has(alerta.tipo);

            if (!jaExiste && !silenciado) {
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
          } else if (alertasGerenciados.length > 0) {
            // Sem alerta de maior prioridade — resolver os genericos em aberto.
            await supabase
              .from("alertas")
              .update({ status: "resolvido", resolvido_em: agora.toISOString() })
              .in("id", alertasGerenciados.map((a) => a.id));
          }

          // ─── Ciclo de vida do DESVIO (anti-pisca) ──────────────────────
          // Criado pelo gatilho estrito (via `alerta`, faixa local + afastando +
          // rumo oposto). Mas só RESOLVIDO quando o veiculo VOLTA pra rota
          // (estaForaDeRota=false: chegou perto de um ponto, entrou na base, ou
          // acabaram os pendentes). Assim um mesmo desvio = um unico alerta, em
          // vez de criar/resolver a cada ciclo conforme a distancia oscila.
          if (desvioAtivo && !estaForaDeRota) {
            await supabase
              .from("alertas")
              .update({ status: "resolvido", resolvido_em: agora.toISOString() })
              .eq("id", desvioAtivo.id);
          }
        } catch (errVeiculo) {
          const msg = `Erro ao processar veiculo (raw): ${String(errVeiculo)}`;
          console.error(msg);
          erros.push(msg);
          // Continua para o proximo veiculo
        }
      }
    }

    // Upsert das rotas OSRM calculadas neste ciclo
    if (rotasParaUpsert.length > 0) {
      const pgRotasUp = await pool.connect();
      try {
        for (const r of rotasParaUpsert) {
          await pgRotasUp.query(
            `INSERT INTO rotas_cache (veiculo_id, alvos_hash, pontos_rota, criado_em)
             VALUES ($1, $2, $3::jsonb, now())
             ON CONFLICT (veiculo_id) DO UPDATE SET
               alvos_hash  = EXCLUDED.alvos_hash,
               pontos_rota = EXCLUDED.pontos_rota,
               criado_em   = EXCLUDED.criado_em`,
            [r.veiculo_id, r.alvos_hash, JSON.stringify(r.pontos_rota)]
          );
        }
      } catch (errRotas) {
        const msg = `Aviso: erro ao salvar rotas_cache: ${String(errRotas)}`;
        console.warn(msg);
        erros.push(msg);
      } finally {
        pgRotasUp.release();
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
          geofence_geojson: GeoJSONGeom;
        }>(
          `SELECT
             p.veiculo_id,
             v.cliente_id,
             p.lat,
             p.lng,
             g.nome AS nome_favela,
             ST_AsGeoJSON(g.geom::geometry)::json AS geofence_geojson
           FROM posicoes_atuais p
           JOIN veiculos v ON v.id = p.veiculo_id
           JOIN geofences g
             ON g.tipo = 'favela'
             AND ST_Intersects(g.geom, p.geom)
           WHERE p.atraso_min <= 60`
        );

        for (const vf of veiculosEmFavela) {
          try {
            // Suprimir alerta se o proprio ponto de entrega pendente esta dentro
            // da mesma comunidade — o caminhao esta la para entregar, nao e suspeito.
            const alvosVeiculo = veiculoIdToAlvos.get(vf.veiculo_id) ?? [];
            const temEntregaNaFavela = alvosVeiculo
              .filter((a) => !a.feito)
              .some((a) => pontoEmGeo(a.lng, a.lat, vf.geofence_geojson));
            if (temEntregaNaFavela) continue;

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
      geocodes_novos: contadorGeocodesNovos.valor,
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
        geocodes_novos: 0,
        erros: [String(errGeral)],
      },
      { status: 500 }
    );
  } finally {
    await pool.end();
  }
}
