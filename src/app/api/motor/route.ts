// Motor de detecção de alertas — POST /api/motor
// Rota protegida por x-motor-key (MOTOR_SECRET). Nunca use em client.

import pg from "pg";
import { createAdminClient } from "@/lib/supabase/admin";
import {
  agruparAlvosPorPlaca,
  agruparPontosPorPlaca,
  alvoMaisProximoQualquer,
  rumoGraus,
  haversineM,
  normalizar,
  centroideGeo,
  distanciaAoSegmentoM,
} from "@/lib/unitrac";
import type { EntregasPlaca, PontoEntrega } from "@/lib/unitrac";
import {
  avaliar,
  detectarJammer,
  foraDeRota,
  afastouDeTudo,
  emHorarioOperacao,
  detectarRetornoTardio,
  detectarParadaNoturnaIgnicaoAtiva,
  detectarAceleracaoBrusca,
  calcularRiscoArea,
  type Alerta,
} from "@/lib/detectores";
import { temPOIProximo } from "@/lib/overpass";
import { celulasDoSegmento, vizinhanca3x3, celulaDe } from "@/lib/celulas";
import { buscarTiroteiosRJ, obterPerfilHorario } from "@/lib/fogocruzado";
import type { Tiroteio } from "@/lib/fogocruzado";
import { manterSessaoViva } from "@/lib/unitrac-comandos";
import { obterRouboCarga } from "@/lib/roubocarga";
import { atualizarPerfilRota, desvioPadraoDe } from "@/lib/rotaperfil";
import type { PerfilRotaEstado } from "@/lib/rotaperfil";

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

// ─── Cache em memória da frota por cliente (best-effort entre ciclos) ──────
// A frota (quais veículos existem/estão ativos) muda raríssimo — não faz
// sentido reler do banco toda vez que o motor roda (a cada 1 min, pra sempre).
// Cache de módulo: sobrevive entre invocações enquanto a instância serverless
// ficar "quente" (comum rodando a cada 1 min); se der cold start, só refaz a
// consulta normalmente — sem risco de dado errado, só menos cache-hit.
type VeiculoCache = { veiculos: { id: string; cv: string; grupo: string | null }[]; expiraEm: number };
const CACHE_FROTA_MS = 3 * 60_000; // 3 min: renova rápido o bastante pra pegar veículo novo/desativado sem demora perceptível
const cacheFrotaPorCliente = new Map<string, VeiculoCache>();

// Tapete histórico (Camada 2 do desvio): células que a frota já percorreu nos
// últimos 30 dias, por cliente. É o sinal PRIMÁRIO e precisa estar disponível
// desde o 1º ciclo suspeito — por isso cacheado por cliente (não por
// veículo), com TTL curto, em vez de 1 query por veículo por ciclo.
type TapeteCache = { celulas: Set<string>; expiraEm: number };
const CACHE_TAPETE_MS = 3 * 60_000;
const cacheTapetePorCliente = new Map<string, TapeteCache>();

// Perfil de rota (baseline estatístico por destino, ver rotaperfil.ts): média
// e desvio-padrão (EWMA) do desvio perpendicular observado na aproximação
// final de cada destino já visitado. Mesmo padrão de cache do tapete: 1
// busca por cliente, TTL curto, nunca 1 query por veículo por ciclo.
type PerfilRotaCache = { perfis: Map<string, PerfilRotaEstado>; expiraEm: number };
const CACHE_PERFIL_ROTA_MS = 3 * 60_000;
const cachePerfilRotaPorCliente = new Map<string, PerfilRotaCache>();
// Distância (m) ao pendente mais próximo pra considerar "aproximação final"
// e amostrar o desvio perpendicular pro perfil daquele destino específico.
const PERFIL_ROTA_PROXIMIDADE_M = 500;

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
// Fetch inline com AbortSignal — buscarAlvos() nao aceita signal, por isso
// reescrevemos a chamada diretamente (mesmo padrao de buscarPosicoesComTimeout).
async function buscarAlvosComTimeout(cvs: string[]): Promise<{
  entregas: Map<string, EntregasPlaca>;
  pontos: Map<string, PontoEntrega[]>;
}> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TIMEOUT_UNITRAC_MS);
  try {
    const BASE_URL_ALVOS = "https://datalayer.portalunitrac.com";
    const res = await fetch(`${BASE_URL_ALVOS}/mapa_servicos/alvos`, {
      method: "POST",
      headers: { accept: "application/json", "content-type": "application/json" },
      body: JSON.stringify(cvs),
      signal: controller.signal,
    });
    clearTimeout(timer);
    if (!res.ok) throw new Error(`buscarAlvos HTTP ${res.status}`);
    const data = (await res.json()) as { alvos?: Parameters<typeof agruparAlvosPorPlaca>[0] };
    const alvos = data.alvos ?? [];
    return { entregas: agruparAlvosPorPlaca(alvos), pontos: agruparPontosPorPlaca(alvos) };
  } catch (err) {
    clearTimeout(timer);
    throw err;
  }
}

// ─── Cache em memoria de geocode_cache (tabela inteira, ~45k linhas/6MB) ───
// Achado 07/07/2026 investigando estouro de CPU da Vercel: geocodeReverso
// fazia 1 pool.connect()+SELECT por veiculo parado/em alerta -- num ciclo
// tipico isso e ~170 dos ~300 veiculos (maioria da frota parada fazendo
// entrega). Igual ao tapete/perfil de rota: 1 busca da tabela inteira,
// cacheada por CACHE_GEOCODE_MS, em vez de 1 query por veiculo.
type GeocodeCacheGlobal = { mapa: Map<string, string>; expiraEm: number };
const CACHE_GEOCODE_MS = 3 * 60_000;
let cacheGeocodeGlobal: GeocodeCacheGlobal | null = null;

function chaveGeocode(lat: number, lng: number): string {
  const latR = Math.round(lat * 10000) / 10000;
  const lngR = Math.round(lng * 10000) / 10000;
  return `${latR}:${lngR}`;
}

async function getGeocodeCacheGlobal(pool: pg.Pool): Promise<Map<string, string>> {
  if (cacheGeocodeGlobal && cacheGeocodeGlobal.expiraEm > Date.now()) {
    return cacheGeocodeGlobal.mapa;
  }
  const pgClient = await pool.connect();
  try {
    const { rows } = await pgClient.query<{ lat: number; lng: number; endereco: string }>(
      `SELECT lat, lng, endereco FROM geocode_cache`
    );
    const mapa = new Map(rows.map((r) => [chaveGeocode(r.lat, r.lng), r.endereco]));
    cacheGeocodeGlobal = { mapa, expiraEm: Date.now() + CACHE_GEOCODE_MS };
    return mapa;
  } catch {
    return cacheGeocodeGlobal?.mapa ?? new Map();
  } finally {
    pgClient.release();
  }
}

// ─── Geocode reverso via Nominatim com cache em memoria + banco ───────────
// Retorna o endereco formatado (3 primeiras partes do display_name) ou null.
async function geocodeReverso(
  lat: number,
  lng: number,
  pool: pg.Pool,
  contadorNovos: { valor: number },
  cacheGeocode: Map<string, string>
): Promise<string | null> {
  const chave = chaveGeocode(lat, lng);
  const latR = Math.round(lat * 10000) / 10000;
  const lngR = Math.round(lng * 10000) / 10000;

  const doCache = cacheGeocode.get(chave);
  if (doCache !== undefined) return doCache;

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

    // Salvar no cache (banco + memoria, pra outro veiculo no MESMO ciclo e
    // mesma celula ~11m nao repetir a chamada externa).
    cacheGeocode.set(chave, endereco);
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

// Ponto de INÍCIO de uma sequência de desvio (1º ciclo em que o veículo se
// afastou de todos os destinos legítimos). Persistido em posicoes_atuais
// para sobreviver entre ciclos e nascer o alerta já com o local correto.
type DesvioInicio = { lat: number; lng: number; ts: string; menor_dist_m: number };

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
  const desde2h = new Date(agora.getTime() - 2 * 60 * 60 * 1000).toISOString();

  // Contador de geocodes novos consumidos neste ciclo
  const contadorGeocodesNovos = { valor: 0 };
  // Cache em memoria da tabela geocode_cache inteira (ver getGeocodeCacheGlobal
  // acima) — elimina 1 SELECT por veiculo parado/em alerta (era ~170/ciclo).
  const cacheGeocode = await getGeocodeCacheGlobal(pool);

  // Keep-alive da sessao do portal Unitrac (sirene/bloqueio) — pinga pra
  // evitar expirar por inatividade. Nao-critico: falha aqui nunca derruba o
  // ciclo do motor, so significa que a sessao guardada esta morta/ausente.
  manterSessaoViva().catch(() => {});

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
    const mapaCv = new Map<string, { veiculo_id: string; cliente_id: string; grupo: string | null }>();

    for (const cliente of clientes) {
      const cache = cacheFrotaPorCliente.get(cliente.id);
      let veiculos: { id: string; cv: string; grupo: string | null }[];

      if (cache && cache.expiraEm > Date.now()) {
        veiculos = cache.veiculos;
      } else {
        const { data, error: erroVeiculos } = await supabase
          .from("veiculos")
          .select("id, cv, grupo")
          .eq("cliente_id", cliente.id)
          .eq("ativo", true);

        if (erroVeiculos) {
          const msg = `Erro veiculos cliente ${cliente.id}: ${erroVeiculos.message}`;
          console.error(msg);
          erros.push(msg);
          continue;
        }
        veiculos = data ?? [];
        cacheFrotaPorCliente.set(cliente.id, { veiculos, expiraEm: Date.now() + CACHE_FROTA_MS });
      }

      for (const v of veiculos) {
        mapaCv.set(v.cv, { veiculo_id: v.id, cliente_id: cliente.id, grupo: v.grupo ?? null });
      }
    }

    // Grupos de frota confirmados (varredura na API, 30/06/2026) que NUNCA reportam
    // posicao GPS — sao equipamento de armazem (paleteiras), nao veiculo rastreado.
    // Excluir da chamada de posicoes economiza payload sem perder nada (a Unitrac
    // nunca retorna esses CVs de qualquer forma).
    const GRUPOS_SEM_GPS = new Set(["PALETEIRAS"]);

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
      .select("veiculo_id, lat, lng, velocidade, parado_desde, desvio_streak, desvio_inicio, ultimo_evento");

    const mapaPosAtual = new Map<
      string,
      {
        lat: number | null; lng: number | null; velocidade: number | null;
        parado_desde: string | null; desvio_streak: number; desvio_inicio: DesvioInicio | null;
        ultimo_evento: string | null;
      }
    >();

    for (const row of posatuaisRows ?? []) {
      mapaPosAtual.set(row.veiculo_id, {
        lat: row.lat,
        lng: row.lng,
        velocidade: row.velocidade,
        parado_desde: row.parado_desde,
        desvio_streak: row.desvio_streak ?? 0,
        desvio_inicio: (row.desvio_inicio as DesvioInicio | null) ?? null,
        ultimo_evento: row.ultimo_evento ?? null,
      });
    }

    // Eventos nativos "rotineiros" da Unitrac — nao viram linha na tabela `eventos`
    // (senao toda transmissao periodica de 220+ veiculos vira log, sem sinal nenhum).
    const EVENTOS_ROTINEIROS = new Set(["TRANSMISSÃO TEMPORIZADA"]);
    // Acumula eventos NOTAVEIS (mudaram de estado) pra inserir em lote no fim do ciclo.
    const eventosNovos: { veiculo_id: string; tipo: string; payload: Record<string, unknown>; ts: string }[] = [];

    // 4. Buscar posicoes de TODOS os CVs de uma vez por cliente
    let totalProcessados = 0;
    let totalFrescos = 0;
    let totalAlertasAtivos = 0;

    // Tiroteios ATIVOS (últimas 3h) do RJ inteiro — risco em tempo real comum
    // a todas as frotas. Cruzamos com cada veículo (detector tiroteio próximo).
    // Falha graciosa: sem tiroteios, o detector simplesmente não dispara.
    // Exclui acaoPolicial=true (achado da pesquisa 07/07): operação policial
    // de rotina não é preditiva de assalto a carga — contar isso como risco
    // infla o score de área numa região só porque teve uma blitz/operação.
    let tiroteiosAtivos: Tiroteio[] = [];
    try {
      tiroteiosAtivos = (await buscarTiroteiosRJ(1)).filter((t) => t.recente && !t.acaoPolicial);
    } catch {
      tiroteiosAtivos = [];
    }

    // ─── Score de risco de área (camada 3 do desvio) ────────────────────
    // Combina favela + CISP (roubo de carga do ISP-RJ) + corredor de rodovia
    // de alto risco (BR-040/101/116/493, curado a partir de Firjan/NTC) —
    // ver calcularRiscoArea em lib/detectores.ts. Batch único pra toda a
    // frota fresca (não por veículo candidato): testado que a versão
    // correlacionada por linha é ~150x mais lenta (CTE com JOIN normal:
    // ~230ms pra ~300 veículos; scalar subquery por linha: ~35s — acima do
    // orçamento de um ciclo de 1min). Falha graciosa: sem dado, risco fica 0.
    const riscoPorVeiculo = new Map<string, { emFavela: boolean; cisp: string | null; emCorredorRisco: boolean }>();
    try {
      const { rows } = await pool.query<{ veiculo_id: string; em_favela: boolean; cisp: string | null; em_corredor_risco: boolean }>(
        `WITH cisp AS (
           SELECT p.veiculo_id, g.meta->>'cisp' as cisp
           FROM posicoes_atuais p
           JOIN geofences g ON g.tipo = 'cisp' AND ST_Intersects(g.geom, p.geom)
           WHERE p.atraso_min <= 60
         ),
         corredor AS (
           SELECT DISTINCT p.veiculo_id
           FROM posicoes_atuais p
           JOIN geofences g ON g.tipo = 'risco' AND ST_DWithin(g.geom, p.geom, 250)
           WHERE p.atraso_min <= 60
         )
         SELECT
           p.veiculo_id,
           EXISTS (SELECT 1 FROM geofences g WHERE g.tipo = 'favela' AND ST_Intersects(g.geom, p.geom)) AS em_favela,
           cisp.cisp,
           (corredor.veiculo_id IS NOT NULL) AS em_corredor_risco
         FROM posicoes_atuais p
         LEFT JOIN cisp ON cisp.veiculo_id = p.veiculo_id
         LEFT JOIN corredor ON corredor.veiculo_id = p.veiculo_id
         WHERE p.atraso_min <= 60`
      );
      for (const r of rows) {
        riscoPorVeiculo.set(r.veiculo_id, { emFavela: r.em_favela, cisp: r.cisp, emCorredorRisco: r.em_corredor_risco });
      }
    } catch (errRisco) {
      erros.push(`Aviso: score de risco de area indisponivel neste ciclo: ${String(errRisco)}`);
    }

    // Roubo de carga por CISP (ISP-RJ, cache de 6h na própria lib) — mapa
    // cisp -> total nos últimos 12 meses, pra resolver o rouboCargaCispTotal
    // de cada veículo via o cisp já resolvido acima.
    const rouboCargaPorCisp = new Map<string, number>();
    try {
      const dadosRoubo = await obterRouboCarga();
      for (const item of dadosRoubo?.ranking ?? []) rouboCargaPorCisp.set(item.cisp, item.total);
    } catch {
      // Sem dado: rouboCargaCispTotal fica null pra todo mundo, calcularRiscoArea trata como 0.
    }

    // Perfil horario multiplicativo (Fogo Cruzado, cache de 24h na propria
    // lib — nao busca historico a cada ciclo, so 1x/dia). Substitui o antigo
    // bonus fixo de madrugada por um fator continuo por hora (0-23),
    // consenso da literatura STKDE/aoristic. Falha graciosa: sem dado,
    // fator fica 1 (neutro) pra toda hora, nao inventa risco nem penaliza.
    let perfilHorario: number[] = new Array(24).fill(1);
    try {
      perfilHorario = await obterPerfilHorario();
    } catch {
      // mantem neutro
    }

    // Acumulador de pontos de entrega por veiculo_id — usado na supressao
    // de alerta favela quando o proprio destino esta dentro da comunidade.
    const veiculoIdToAlvos = new Map<string, PontoEntrega[]>();

    // Clientes que processaram posicoes com sucesso neste ciclo.
    // Usado para filtrar a resolucao de alertas de favela: nao resolver alertas
    // de clientes cujo fetch falhou (evita resolver alerta de veiculo parado em
    // comunidade por culpa de timeout pontual da API Unitrac).
    const clientesComSucesso = new Set<string>();

    // Celulas do tapete cobertas pelo trajeto de cada veiculo neste ciclo —
    // upsert em batch ao final (ver Camada 2 do desvio, abaixo no loop).
    const celulasCiclo: { cliente_id: string; celula: string }[] = [];

    // Posicoes de TODOS os veiculos processados neste ciclo — upsert em UM
    // batch ao final (mesma logica de celulasCiclo acima), em vez de 1
    // pool.connect()+query POR VEICULO dentro do loop. Achado 07/07/2026
    // investigando estouro de cota de CPU da Vercel (Fluid Active): esse era
    // o maior gargalo real do motor -- ~300 round-trips de rede+conexao por
    // ciclo, incondicional, todo santo ciclo. Nao muda nenhuma logica de
    // deteccao, so a mecanica de escrever no banco.
    type LinhaPosicaoCiclo = {
      veiculo_id: string; lat: number; lng: number; velocidade: number; ignicao: boolean;
      atraso_min: number; panico: boolean; bau_aberto: boolean; nivel: string; motivo: string | null;
      datagps: string; parado_desde: string | null; updated_at: string; entregas_feitas: number;
      entregas_total: number; local: string | null; desvio_streak: number; rumo: number | null;
      ultimo_evento: string | null; desvio_inicio: string | null;
    };
    const posicoesCiclo: LinhaPosicaoCiclo[] = [];

    // Tapete por cliente: busca TODAS as celulas de uma vez (via pool, sem o
    // limite de linhas do PostgREST) e cacheia em memoria por CACHE_TAPETE_MS.
    // E o sinal PRIMARIO do desvio (nao so um modulador), entao precisa estar
    // pronto desde o 1o ciclo suspeito de cada veiculo — por isso 1 busca por
    // cliente aqui, nao 1 query por veiculo candidato dentro do loop.
    async function getTapeteCliente(clienteId: string): Promise<Set<string>> {
      const cache = cacheTapetePorCliente.get(clienteId);
      if (cache && cache.expiraEm > Date.now()) return cache.celulas;
      const pgTapete = await pool.connect();
      try {
        const { rows } = await pgTapete.query<{ celula: string }>(
          `SELECT celula FROM corredor_celulas WHERE cliente_id = $1`,
          [clienteId]
        );
        const celulas = new Set(rows.map((r) => r.celula));
        cacheTapetePorCliente.set(clienteId, { celulas, expiraEm: Date.now() + CACHE_TAPETE_MS });
        return celulas;
      } catch {
        return cache?.celulas ?? new Set();
      } finally {
        pgTapete.release();
      }
    }

    // Perfil de rota por cliente: mesmo padrão do tapete acima (1 busca por
    // cliente, cacheada). Tabela pequena (1 linha por destino já visitado,
    // não por evento/ciclo) — nunca chega perto do volume do tapete.
    async function getPerfilRotaCliente(clienteId: string): Promise<Map<string, PerfilRotaEstado>> {
      const cache = cachePerfilRotaPorCliente.get(clienteId);
      if (cache && cache.expiraEm > Date.now()) return cache.perfis;
      const pgPerfil = await pool.connect();
      try {
        const { rows } = await pgPerfil.query<{
          celula: string; n_amostras: number; media_m: number; variancia_m2: number;
        }>(
          `SELECT celula, n_amostras, media_m, variancia_m2 FROM rota_perfil WHERE cliente_id = $1`,
          [clienteId]
        );
        const perfis = new Map(
          rows.map((r) => [r.celula, { nAmostras: r.n_amostras, mediaM: r.media_m, varianciaM2: r.variancia_m2 }])
        );
        cachePerfilRotaPorCliente.set(clienteId, { perfis, expiraEm: Date.now() + CACHE_PERFIL_ROTA_MS });
        return perfis;
      } catch {
        return cache?.perfis ?? new Map();
      } finally {
        pgPerfil.release();
      }
    }

    // Amostras do perfil de rota coletadas neste ciclo (chave cliente_id:celula
    // -> estado final ja atualizado) — upsert em batch ao final, igual tapete.
    const perfilRotaTocadoCiclo = new Map<string, { cliente_id: string; celula: string; estado: PerfilRotaEstado }>();

    for (const cliente of clientes) {
      // Obter CVs deste cliente
      const cvsCliente = [...mapaCv.entries()]
        .filter(([, v]) => v.cliente_id === cliente.id)
        .map(([cv]) => cv);

      if (cvsCliente.length === 0) continue;

      // Posicoes: exclui grupos que nunca reportam GPS (ver GRUPOS_SEM_GPS acima).
      const cvsParaPosicoes = [...mapaCv.entries()]
        .filter(([, v]) => v.cliente_id === cliente.id && !(v.grupo && GRUPOS_SEM_GPS.has(v.grupo)))
        .map(([cv]) => cv);

      // 4a. Buscar posicoes do cliente
      let posicoesRaw: unknown[];
      try {
        posicoesRaw = await buscarPosicoesComTimeout(cvsParaPosicoes);
      } catch (err) {
        const isTimeout = err instanceof Error && err.name === "AbortError";
        const msg = isTimeout
          ? `Timeout (${TIMEOUT_UNITRAC_MS / 1000}s) ao buscar posicoes do cliente ${cliente.id}`
          : `buscarPosicoes falhou para cliente ${cliente.id}: ${String(err)}`;
        console.error(msg);
        erros.push(msg);
        continue;
      }

      // Cliente processou posicoes com sucesso — marcar para filtro de favela.
      clientesComSucesso.add(cliente.id);

      // 4b. Buscar alvos (entregas + pontos da rota) deste cliente
      let entregasPorPlaca = new Map<string, EntregasPlaca>();
      let pontosPorPlaca = new Map<string, PontoEntrega[]>();
      let alvosApiOk = false;
      try {
        const res = await buscarAlvosComTimeout(cvsCliente);
        entregasPorPlaca = res.entregas;
        pontosPorPlaca = res.pontos;
        alvosApiOk = true;
      } catch (err) {
        // Nao-critico: mantemos os mapas vazios; alvosApiOk=false impede o
        // detector saida_nao_autorizada de disparar (evita falsos criticos em massa).
        const msg = `Aviso: buscarAlvos falhou para cliente ${cliente.id}: ${String(err)}`;
        console.warn(msg);
        erros.push(msg);
      }

      // Pre-passada: coleta os veiculos PARADOS e frescos do cliente. Usado para
      // detectar congestionamento — varios parados na mesma area = transito/fila,
      // nao roubo. Comparar veiculos entre si mata o falso positivo de parada anomala.
      const paradosFrescos: { lat: number; lng: number }[] = [];
      for (const raw of posicoesRaw) {
        try {
          const p = normalizar(raw as Record<string, unknown>);
          if (p.fresco && p.velocidade === 0 && p.lat != null && p.lng != null) {
            paradosFrescos.push({ lat: p.lat, lng: p.lng });
          }
        } catch { /* posicao malformada: ignora na pre-passada */ }
      }
      const RAIO_CONGESTION_M = 250;

      // Batch: carregar alertas do cliente de uma vez (2 queries por ciclo em vez de N por veículo).
      const { data: todosAlertasAbertos } = await supabase
        .from("alertas")
        .select("id, tipo, veiculo_id")
        .eq("cliente_id", cliente.id)
        .in("status", ["ativo", "reconhecido"]);

      const mapaAlertasAbertos = new Map<string, { id: string; tipo: string }[]>();
      for (const ab of todosAlertasAbertos ?? []) {
        const lista = mapaAlertasAbertos.get(ab.veiculo_id) ?? [];
        lista.push({ id: ab.id, tipo: ab.tipo });
        mapaAlertasAbertos.set(ab.veiculo_id, lista);
      }

      const { data: todosFalsosRecentes } = await supabase
        .from("alertas")
        .select("tipo, veiculo_id")
        .eq("cliente_id", cliente.id)
        .eq("status", "falso_positivo")
        .gte("resolvido_em", desde2h);

      const mapaTiposSilenciados = new Map<string, Set<string>>();
      for (const fp of todosFalsosRecentes ?? []) {
        const set = mapaTiposSilenciados.get(fp.veiculo_id) ?? new Set<string>();
        set.add(fp.tipo);
        mapaTiposSilenciados.set(fp.veiculo_id, set);
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

          // Linha do tempo de eventos nativos: so grava quando o tipevnome MUDOU
          // pra algo notavel (nao "TRANSMISSÃO TEMPORIZADA", a transmissao de rotina).
          if (pos.evento && !EVENTOS_ROTINEIROS.has(pos.evento) && pos.evento !== anterior?.ultimo_evento) {
            eventosNovos.push({
              veiculo_id,
              tipo: pos.evento,
              payload: { placa: pos.placa, velocidade: pos.velocidade, ignicao: pos.ignicao },
              ts: parseDatagps(pos.datagps) ?? new Date().toISOString(),
            });
          }

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

          // Rumo e distância até a base mais próxima (para suprimir saida_nao_autorizada ao retornar)
          let rumoBase: number | null = null;
          let distBaseM: number | null = null;
          if (foraDaBase && basesCliente.length > 0) {
            const porDist = basesCliente
              .map(b => { const c = centroideGeo(b.geom); return c ? { c, dist: haversineM(pos.lat, pos.lng, c.lat, c.lng) } : null; })
              .filter((x): x is { c: { lat: number; lng: number }; dist: number } => x !== null)
              .sort((a, b) => a.dist - b.dist);
            if (porDist[0]) {
              distBaseM = porDist[0].dist;
              rumoBase = rumoGraus(pos.lat, pos.lng, porDist[0].c.lat, porDist[0].c.lng);
            }
          }

          // ─── Desvio v4: afastamento de TODOS os destinos legítimos ──────
          // Sem rota planejada, desvio é comportamento: o veículo se afasta
          // de TODOS os destinos (alvos pendentes + bases) em vez de
          // progredir rumo a pelo menos um deles. NÃO usa só "o mais
          // próximo" — corrigido ao vivo em 06/07/2026 (flood de 22 falsos
          // positivos em 20min): motorista indo pra entrega que não é a
          // mais próxima (comuníssimo com 2+ pendentes) disparava desvio
          // numa entrega normal. Ver detectarDesvio em lib/detectores.ts.
          const pontosVeiculo = pontosPorPlaca.get(pos.placa);
          veiculoIdToAlvos.set(veiculo_id, pontosVeiculo ?? []);
          const pendentes = (pontosVeiculo ?? []).filter((pt) => !pt.feito);
          const temPendentes = pendentes.length > 0;
          const centroidesBases = basesCliente
            .map((b) => centroideGeo(b.geom))
            .filter((c): c is { lat: number; lng: number } => c !== null);
          const destinos = [
            ...pendentes.map((pt) => ({ lat: pt.lat, lng: pt.lng })),
            ...centroidesBases,
          ];
          const temAnterior = !!anterior && anterior.lat != null && anterior.lng != null;
          const distDestinosM = destinos.map((d) => haversineM(pos.lat, pos.lng, d.lat, d.lng));
          const distDestinosAnteriorM = temAnterior
            ? destinos.map((d) => haversineM(anterior!.lat!, anterior!.lng!, d.lat, d.lng))
            : [];
          const menorDistDestinoM = distDestinosM.length > 0 ? Math.min(...distDestinosM) : null;

          // Trajeto perpendicular (ponto cego do afastamento, ver detectarDesvio):
          // distância do veículo à reta mais próxima entre alguma base e algum
          // destino/pendente — pega o "aproximando de qualquer destino, mas por
          // um caminho absurdo" que o gatilho por afastamento não vê. Não
          // persiste nada novo: só compara ciclo atual x anterior, em memória.
          const segmentosPlausiveis =
            centroidesBases.length > 0
              ? destinos.flatMap((d) => centroidesBases.map((b) => ({ origem: b, destino: d })))
              : [];
          const desvioTrajetoM =
            segmentosPlausiveis.length > 0
              ? Math.min(...segmentosPlausiveis.map((s) => distanciaAoSegmentoM(pos, s.origem, s.destino)))
              : null;
          const desvioTrajetoAnteriorM =
            temAnterior && segmentosPlausiveis.length > 0
              ? Math.min(
                  ...segmentosPlausiveis.map((s) =>
                    distanciaAoSegmentoM({ lat: anterior!.lat!, lng: anterior!.lng! }, s.origem, s.destino)
                  )
                )
              : null;

          // Guarda anti-teleporte: salto implausível entre ciclos (>2,5km em
          // ~1min, ou seja >150km/h implícitos) congela o streak.
          const saltoImplausivel =
            temAnterior && haversineM(anterior!.lat!, anterior!.lng!, pos.lat, pos.lng) > 2500;

          let desvioStreak: number = anterior?.desvio_streak ?? 0;
          let desvioInicio: DesvioInicio | null = anterior?.desvio_inicio ?? null;
          if (pos.fresco && !saltoImplausivel && pos.velocidade > 0 && temAnterior) {
            if (afastouDeTudo(distDestinosM, distDestinosAnteriorM)) {
              desvioStreak += 1;
              if (desvioStreak === 1) {
                desvioInicio = {
                  lat: anterior!.lat!,
                  lng: anterior!.lng!,
                  ts: agora.toISOString(),
                  menor_dist_m: distDestinosAnteriorM.length > 0 ? Math.min(...distDestinosAnteriorM) : 0,
                };
              }
            } else {
              desvioStreak = 0;
              desvioInicio = null;
            }
          }
          const afastamentoAcumuladoM =
            desvioInicio && menorDistDestinoM !== null
              ? menorDistDestinoM - desvioInicio.menor_dist_m
              : 0;

          // Camada 2 (tapete): sinal PRIMÁRIO, calculado TODO ciclo (não só
          // quando já suspeito) — precisa estar pronto desde o 1º ciclo pra
          // decidir a severidade rápido. Custo já é baixo: getTapeteCliente
          // cacheia o Set inteiro do cliente por CACHE_TAPETE_MS, então isso
          // aqui é só um Set.has() em memória, sem query por veículo.
          //
          // TAPETE_MIN_CELULAS: piso de cobertura mínima antes de confiar em
          // "fora do tapete" como sinal. Achado ao vivo em 06/07/2026: logo
          // após aplicar a migration (tapete vazio/recém-criado), TODO
          // veículo parecia "fora de via conhecida" e virava crítico em 2
          // ciclos — ruído de cold-start, não sinal real. Sem cobertura
          // mínima, dentroTapete fica null (não modula, nunca crítico só
          // por isso).
          const TAPETE_MIN_CELULAS = 300;
          let dentroTapete: boolean | null = null;
          if (pos.fresco) {
            const tapeteCliente = await getTapeteCliente(cliente_id);
            if (tapeteCliente.size >= TAPETE_MIN_CELULAS) {
              dentroTapete = vizinhanca3x3(pos.lat, pos.lng).some((c) => tapeteCliente.has(c));
            }
          }

          // Alimentar o tapete: células do trajeto desde o ciclo anterior.
          if (pos.fresco && temAnterior && (anterior!.lat !== pos.lat || anterior!.lng !== pos.lng)) {
            for (const c of celulasDoSegmento(anterior!.lat!, anterior!.lng!, pos.lat, pos.lng)) {
              celulasCiclo.push({ cliente_id, celula: c });
            }
          }

          // Perfil de rota (baseline por destino, ver rotaperfil.ts e
          // PERFIL_ROTA_* em detectores.ts): fecha o outro lado do ponto
          // cego do trajeto perpendicular — o teto fixo de 3km não pega uma
          // rota que SEMPRE foi bem reta (ex.: ~50m de desvio) aparecer hoje
          // com 500m, ainda bem abaixo do teto global. Só amostra na
          // aproximação final (<=500m do pendente mais próximo): evita
          // precisar rastrear "início/fim de perna" entre ciclos do motor.
          let perfilRotaMedia: number | null = null;
          let perfilRotaDesvioPadrao: number | null = null;
          let perfilRotaAmostras = 0;
          if (pos.fresco && pendentes.length > 0) {
            const pendenteMaisProximo = pendentes.reduce<{ pt: PontoEntrega; dist: number } | null>(
              (melhor, pt) => {
                const dist = haversineM(pos.lat, pos.lng, pt.lat, pt.lng);
                return !melhor || dist < melhor.dist ? { pt, dist } : melhor;
              },
              null
            );
            if (pendenteMaisProximo) {
              const celula = celulaDe(pendenteMaisProximo.pt.lat, pendenteMaisProximo.pt.lng);
              const perfilRotaCliente = await getPerfilRotaCliente(cliente_id);
              const estadoAtual = perfilRotaCliente.get(celula) ?? null;
              // Le o histórico ANTES de amostrar este ciclo — comparar contra
              // uma média que já inclui a própria leitura atual enviesaria a
              // checagem (sempre pareceria "normal").
              if (estadoAtual) {
                perfilRotaMedia = estadoAtual.mediaM;
                perfilRotaDesvioPadrao = desvioPadraoDe(estadoAtual);
                perfilRotaAmostras = estadoAtual.nAmostras;
              }
              if (
                !saltoImplausivel &&
                desvioTrajetoM !== null &&
                pendenteMaisProximo.dist <= PERFIL_ROTA_PROXIMIDADE_M
              ) {
                const novoEstado = atualizarPerfilRota(estadoAtual, desvioTrajetoM);
                perfilRotaCliente.set(celula, novoEstado);
                perfilRotaTocadoCiclo.set(`${cliente_id}:${celula}`, { cliente_id, celula, estado: novoEstado });
              }
            }
          }

          // Parada no cliente (Benassi): verificar se o veiculo esta parado
          // dentro do raio de qualquer ponto da rota (feito OU pendente).
          const maisProximoQualquer = alvoMaisProximoQualquer(pos.lat, pos.lng, pontosVeiculo);
          const noCliente =
            pos.velocidade === 0 &&
            maisProximoQualquer !== null &&
            maisProximoQualquer.distM <= Math.max(maisProximoQualquer.ponto.raio, 150);

          // Rumo do movimento (ciclo anterior → posição atual) — usado pelo
          // detector de saída não autorizada (rumo até a base).
          const rumoMovimento =
            temAnterior && (anterior!.lat !== pos.lat || anterior!.lng !== pos.lng)
              ? rumoGraus(anterior!.lat!, anterior!.lng!, pos.lat, pos.lng)
              : null;
          // Condição FROUXA de permanência (anti-pisca), agora incluindo bases.
          const estaForaDeRota =
            pos.fresco && foraDeRota(pos, { menorDistDestinoM, emOperacao, foraDaBase });

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

          // Candidato a SAIDA NAO AUTORIZADA parado: tambem precisa de temPOI para
          // suprimir abastecimento/parada de apoio (so faz sentido fora ~2km da base).
          const candidatoSaidaParado =
            pos.fresco && pos.ignicao && pos.velocidade === 0 &&
            foraDaBase && !temPendentes && alvosApiOk && entregas_total === 0 &&
            (distBaseM == null || distBaseM >= 2000);

          let estavEmMovimento = false;
          let esMadrugada = false;
          let temPOI = false;
          const jaParedoNoCicloAnterior =
            anterior != null &&
            anterior.velocidade === 0 &&
            anterior.lat != null && anterior.lng != null &&
            Math.round(anterior.lat * 10000) === Math.round(pos.lat * 10000) &&
            Math.round(anterior.lng * 10000) === Math.round(pos.lng * 10000);

          // horaSP compartilhado por parada_anomala e parada_noturna_ignicao
          const horaSP = parseInt(
            new Intl.DateTimeFormat("pt-BR", {
              timeZone: "America/Sao_Paulo", hour: "numeric", hour12: false,
            }).format(agora),
            10
          );

          if (candidatoParadaAnomala) {
            estavEmMovimento = anterior != null && (anterior.velocidade ?? 0) >= 30;
            esMadrugada = horaSP >= 0 && horaSP < 5;
          }
          // POI consultado para parada anomala E saida nao autorizada parada.
          if (candidatoParadaAnomala || candidatoSaidaParado) {
            try {
              temPOI = await temPOIProximo(pos.lat, pos.lng, pool);
            } catch {
              // Overpass indisponivel: assumir POI presente (beneficio da duvida).
              // Prefere nao disparar falso positivo a criar ruido em massa durante
              // instabilidade da API (afeta todos os veiculos parados do ciclo).
              temPOI = true;
              if (!erros.some((e) => e.includes("Overpass"))) {
                erros.push("Aviso: Overpass indisponivel neste ciclo, POI assumido presente");
              }
            }
          }

          // Congestionamento: quantos OUTROS veiculos da frota estao parados num
          // raio curto. >= 2 => transito/fila, suprime a parada anomala (anti-FP).
          let vizinhosParados = 0;
          if (candidatoParadaAnomala) {
            let dentro = 0;
            for (const q of paradosFrescos) {
              if (haversineM(pos.lat, pos.lng, q.lat, q.lng) <= RAIO_CONGESTION_M) dentro++;
            }
            vizinhosParados = Math.max(0, dentro - 1); // exclui o proprio veiculo
          }

          // Score de risco de área (camada 3 do desvio, ver calcularRiscoArea):
          // combina favela + tiroteio ativo perto (já filtrado sem acaoPolicial)
          // + roubo de carga do CISP atual + corredor de rodovia de risco,
          // multiplicado pelo fator horario (Fogo Cruzado, 60 dias, aoristic).
          // Falha graciosa: sem dado resolvido (query do batch falhou ou
          // veiculo não fresco o bastante), tudo fica no "sem sinal" (0).
          const riscoLocal = riscoPorVeiculo.get(veiculo_id);
          const riscoAreaAtual = calcularRiscoArea({
            emFavela: riscoLocal?.emFavela ?? false,
            tiroteioRecentePertoM: distTiroteioM,
            rouboCargaCispTotal: riscoLocal?.cisp ? rouboCargaPorCisp.get(riscoLocal.cisp) ?? 0 : null,
            emCorredorRodoviaRisco: riscoLocal?.emCorredorRisco ?? false,
            fatorHorario: perfilHorario[horaSP] ?? 1,
          });

          let alerta: Alerta | null = alertaJammer
            ? alertaJammer
            : pos.fresco
              ? avaliar(pos, {
                  paradoMin,
                  emOperacao,
                  foraDaBase,
                  noCliente,
                  distDestinosM,
                  distDestinosAnteriorM,
                  desvioStreak,
                  afastamentoAcumuladoM,
                  dentroTapete,
                  riscoAreaAtual,
                  desvioTrajetoM,
                  desvioTrajetoAnteriorM,
                  perfilRotaMedia,
                  perfilRotaDesvioPadrao,
                  perfilRotaAmostras,
                  temPendentes,
                  entregasTotal: alvosApiOk ? entregas_total : undefined,
                  entregasFeitas: alvosApiOk ? entregas_feitas : undefined,
                  rumoMovimento,
                  distTiroteioM,
                  tiroteioIdadeMin,
                  estavEmMovimento: candidatoParadaAnomala ? estavEmMovimento : undefined,
                  esMadrugada,
                  emZonaRisco: false,
                  temPOIProximo: temPOI,
                  vizinhosParados,
                  jaParedoNoCicloAnterior,
                  rumoBase,
                  distBaseM,
                })
              : null;

          // Novos detectores: retorno_tardio, parada_noturna_ignicao, aceleracao_brusca.
          // Calculados separadamente e sobrepõem alerta principal se mais severos.
          const extras: Alerta[] = [
            detectarRetornoTardio({ entregas_feitas, entregas_total, foraDaBase, paradoMin, emOperacao }),
            detectarParadaNoturnaIgnicaoAtiva(pos, { foraDaBase, noCliente, horaSP }),
            detectarAceleracaoBrusca(pos, {
              velocidadeAnterior: anterior?.velocidade ?? null,
              foraDaBase,
            }),
          ].filter((a): a is Alerta => a !== null);

          for (const extra of extras) {
            if (!alerta) { alerta = extra; continue; }
            if (alerta.nivel === "critico" && extra.nivel !== "critico") continue;
            if (extra.nivel === "critico" && alerta.nivel !== "critico") { alerta = extra; continue; }
            if (extra.score > alerta.score) alerta = extra;
          }

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
              localVeiculo = await geocodeReverso(pos.lat, pos.lng, pool, contadorGeocodesNovos, cacheGeocode);
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

          // 5. Posicao acumulada pro batch de fim de ciclo (ver posicoesCiclo
          // acima) — nao escreve no banco aqui, so guarda em memoria.
          posicoesCiclo.push({
            veiculo_id,
            lat: pos.lat,
            lng: pos.lng,
            velocidade: pos.velocidade,
            ignicao: pos.ignicao,
            atraso_min: pos.atraso,
            panico: pos.panico,
            bau_aberto: pos.bau,
            nivel,
            motivo,
            datagps: parseDatagps(pos.datagps) ?? agora.toISOString(),
            parado_desde,
            updated_at: agora.toISOString(),
            entregas_feitas,
            entregas_total,
            local: localVeiculo,
            desvio_streak: desvioStreak,
            rumo: rumoMovimento !== null ? Math.round(rumoMovimento) : null,
            ultimo_evento: pos.evento,
            desvio_inicio: desvioInicio ? JSON.stringify(desvioInicio) : null,
          });

          // 6. Gerenciar alertas — para posicoes frescas E para jammers
          // (jammer pode ocorrer com atraso > 60, portanto !fresco, mas e critico)
          const deveGerenciarAlertas = pos.fresco || !!alertaJammer;
          if (!deveGerenciarAlertas) continue;
          if (pos.fresco) totalFrescos++;

          // Alertas EM ABERTO e tipos silenciados — pré-carregados em lote por cliente.
          const alertasAbertos = mapaAlertasAbertos.get(veiculo_id) ?? [];
          const tiposSilenciados = mapaTiposSilenciados.get(veiculo_id) ?? new Set<string>();

          // Resolucao automatica generica: todos os tipos EXCETO favela e desvio,
          // que tem ciclo de vida proprio (tratados separado).
          const alertasGerenciados = (alertasAbertos ?? []).filter(
            (a) => a.tipo !== "favela" && a.tipo !== "desvio"
          );
          const desvioAtivo = (alertasAbertos ?? []).find((a) => a.tipo === "desvio");

          if (alerta) {
            const jaExiste = (alertasAbertos ?? []).some((a) => a.tipo === alerta.tipo);
            const silenciado = tiposSilenciados.has(alerta.tipo);

            if (!silenciado) {
              // Resolver alertas genericos de OUTROS tipos quando o alerta muda de tipo
              // (ex: parada_longa vira saida_nao_autorizada). Nao resolve quando silenciado
              // para preservar o contexto enquanto o operador investiga.
              const alertasObsoletos = alertasGerenciados.filter((a) => a.tipo !== alerta.tipo);
              if (alertasObsoletos.length > 0) {
                await supabase
                  .from("alertas")
                  .update({ status: "resolvido", resolvido_em: agora.toISOString() })
                  .in("id", alertasObsoletos.map((a) => a.id));
              }

              if (!jaExiste) {
                const ehDesvio = alerta.tipo === "desvio" && desvioInicio !== null;
                await supabase.from("alertas").insert({
                  cliente_id,
                  veiculo_id,
                  nivel: alerta.nivel,
                  tipo: alerta.tipo,
                  motivo: alerta.motivo,
                  score: alerta.score,
                  status: "ativo",
                  // Desvio: lat/lng do PONTO DE INÍCIO da sequência (onde
                  // começou a se afastar), não da posição do disparo.
                  lat: ehDesvio ? desvioInicio!.lat : pos.lat,
                  lng: ehDesvio ? desvioInicio!.lng : pos.lng,
                  contexto: ehDesvio
                    ? { inicio_ts: desvioInicio!.ts, fora_tapete: dentroTapete === false }
                    : {},
                  desde: agora.toISOString(),
                });
              }
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

    // Upsert batch de posicoes_atuais (1 statement pro ciclo inteiro, em vez
    // de 1 round-trip por veiculo — ver posicoesCiclo acima). Tem que rodar
    // ANTES do detector de favela e da auto-resolucao sem-comunicacao logo
    // abaixo, que dependem de posicoes_atuais ja refletir este ciclo.
    if (posicoesCiclo.length > 0) {
      const pgPosicoes = await pool.connect();
      try {
        await pgPosicoes.query(
          `INSERT INTO posicoes_atuais
             (veiculo_id, lat, lng, geom, velocidade, ignicao, atraso_min,
              panico, bau_aberto, nivel, motivo, datagps, parado_desde, updated_at,
              entregas_feitas, entregas_total, local, desvio_streak, rumo,
              ultimo_evento, ultimo_evento_em, desvio_inicio)
           SELECT
             c.veiculo_id, c.lat, c.lng,
             ST_SetSRID(ST_MakePoint(c.lng, c.lat), 4326)::geography,
             c.velocidade, c.ignicao, c.atraso_min, c.panico, c.bau_aberto,
             c.nivel, c.motivo, c.datagps::timestamptz, c.parado_desde::timestamptz,
             c.updated_at::timestamptz, c.entregas_feitas, c.entregas_total, c.local,
             c.desvio_streak, c.rumo, c.ultimo_evento, c.updated_at::timestamptz,
             c.desvio_inicio::jsonb
           FROM unnest(
             $1::uuid[], $2::float8[], $3::float8[], $4::float8[], $5::boolean[],
             $6::integer[], $7::boolean[], $8::boolean[], $9::text[], $10::text[],
             $11::text[], $12::text[], $13::text[], $14::integer[], $15::integer[],
             $16::text[], $17::integer[], $18::integer[], $19::text[], $20::text[]
           ) AS c(veiculo_id, lat, lng, velocidade, ignicao, atraso_min, panico,
                  bau_aberto, nivel, motivo, datagps, parado_desde, updated_at,
                  entregas_feitas, entregas_total, local, desvio_streak, rumo,
                  ultimo_evento, desvio_inicio)
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
             local            = COALESCE(EXCLUDED.local, posicoes_atuais.local),
             desvio_streak    = EXCLUDED.desvio_streak,
             desvio_inicio    = EXCLUDED.desvio_inicio,
             rumo             = EXCLUDED.rumo,
             ultimo_evento    = EXCLUDED.ultimo_evento,
             ultimo_evento_em = CASE WHEN EXCLUDED.ultimo_evento IS DISTINCT FROM posicoes_atuais.ultimo_evento
                                  THEN EXCLUDED.ultimo_evento_em ELSE posicoes_atuais.ultimo_evento_em END`,
          [
            posicoesCiclo.map((p) => p.veiculo_id),
            posicoesCiclo.map((p) => p.lat),
            posicoesCiclo.map((p) => p.lng),
            posicoesCiclo.map((p) => p.velocidade),
            posicoesCiclo.map((p) => p.ignicao),
            posicoesCiclo.map((p) => p.atraso_min),
            posicoesCiclo.map((p) => p.panico),
            posicoesCiclo.map((p) => p.bau_aberto),
            posicoesCiclo.map((p) => p.nivel),
            posicoesCiclo.map((p) => p.motivo),
            posicoesCiclo.map((p) => p.datagps),
            posicoesCiclo.map((p) => p.parado_desde),
            posicoesCiclo.map((p) => p.updated_at),
            posicoesCiclo.map((p) => p.entregas_feitas),
            posicoesCiclo.map((p) => p.entregas_total),
            posicoesCiclo.map((p) => p.local),
            posicoesCiclo.map((p) => p.desvio_streak),
            posicoesCiclo.map((p) => p.rumo),
            posicoesCiclo.map((p) => p.ultimo_evento),
            posicoesCiclo.map((p) => p.desvio_inicio),
          ]
        );
      } catch (errPosicoes) {
        const msg = `Erro ao salvar posicoes_atuais em lote: ${String(errPosicoes)}`;
        console.error(msg);
        erros.push(msg);
      } finally {
        pgPosicoes.release();
      }
    }

    // Auto-resolução de alertas de rotina para veículos sem comunicação.
    // Quando o veículo para (ignição desligada, atraso > 120min), o loop principal
    // faz `continue` antes de gerenciar alertas — eles ficam presos indefinidamente.
    // Esta query resolve esses alertas para que na próxima operação o beep dispare
    // com UUIDs frescos (e não fique silenciado por IDs antigos).
    {
      const pgSemComm = await pool.connect();
      try {
        await pgSemComm.query(`
          UPDATE alertas a
          SET status = 'resolvido', resolvido_em = now()
          FROM posicoes_atuais p
          WHERE a.veiculo_id = p.veiculo_id
            AND a.status = 'ativo'
            AND a.tipo NOT IN ('favela', 'jammer', 'panico')
            AND p.atraso_min > 120
            AND p.ignicao = false
        `);
      } catch (errSemComm) {
        console.warn("Auto-resolução sem_comunicação falhou:", errSemComm);
      } finally {
        pgSemComm.release();
      }
    }

    // Upsert batch do tapete (1 statement por ciclo). O WHERE evita churn de
    // dead tuples: cada célula só é reescrita uma vez por dia.
    if (celulasCiclo.length > 0) {
      const pgCelulas = await pool.connect();
      try {
        await pgCelulas.query(
          `INSERT INTO corredor_celulas (cliente_id, celula, ultimo_visto)
           SELECT DISTINCT c.cid::uuid, c.cel, current_date
           FROM unnest($1::uuid[], $2::text[]) AS c(cid, cel)
           ON CONFLICT (cliente_id, celula) DO UPDATE
             SET ultimo_visto = EXCLUDED.ultimo_visto
             WHERE corredor_celulas.ultimo_visto < EXCLUDED.ultimo_visto`,
          [celulasCiclo.map((c) => c.cliente_id), celulasCiclo.map((c) => c.celula)]
        );
      } catch (errCelulas) {
        const msg = `Aviso: erro ao salvar corredor_celulas: ${String(errCelulas)}`;
        console.warn(msg);
        erros.push(msg);
      } finally {
        pgCelulas.release();
      }
    }

    // Upsert batch do perfil de rota (1 statement por ciclo, so quando algum
    // veiculo amostrou aproximacao final neste ciclo). Grava o estado JA
    // atualizado (EWMA calculado em JS, ver rotaperfil.ts) -- sem aritmetica
    // no SQL, so overwrite.
    if (perfilRotaTocadoCiclo.size > 0) {
      const linhas = [...perfilRotaTocadoCiclo.values()];
      const pgPerfilRota = await pool.connect();
      try {
        await pgPerfilRota.query(
          `INSERT INTO rota_perfil (cliente_id, celula, n_amostras, media_m, variancia_m2, atualizado_em)
           SELECT c.cid::uuid, c.cel, c.na::integer, c.med::float8, c.var::float8, now()
           FROM unnest($1::uuid[], $2::text[], $3::integer[], $4::float8[], $5::float8[]) AS c(cid, cel, na, med, var)
           ON CONFLICT (cliente_id, celula) DO UPDATE SET
             n_amostras = EXCLUDED.n_amostras,
             media_m = EXCLUDED.media_m,
             variancia_m2 = EXCLUDED.variancia_m2,
             atualizado_em = EXCLUDED.atualizado_em`,
          [
            linhas.map((l) => l.cliente_id),
            linhas.map((l) => l.celula),
            linhas.map((l) => l.estado.nAmostras),
            linhas.map((l) => l.estado.mediaM),
            linhas.map((l) => l.estado.varianciaM2),
          ]
        );
      } catch (errPerfilRota) {
        const msg = `Aviso: erro ao salvar rota_perfil: ${String(errPerfilRota)}`;
        console.warn(msg);
        erros.push(msg);
      } finally {
        pgPerfilRota.release();
      }
    }

    // Linha do tempo: grava em lote os eventos nativos notaveis detectados neste ciclo.
    if (eventosNovos.length > 0) {
      const { error: erroEventos } = await supabase.from("eventos").insert(eventosNovos);
      if (erroEventos) {
        const msg = `Aviso: erro ao salvar eventos: ${erroEventos.message}`;
        console.warn(msg);
        erros.push(msg);
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
          velocidade: number;
          panico: boolean;
          nome_favela: string;
          geofence_geojson: GeoJSONGeom;
        }>(
          `SELECT
             p.veiculo_id,
             v.cliente_id,
             p.lat,
             p.lng,
             COALESCE(p.velocidade, 0) AS velocidade,
             COALESCE(p.panico, false) AS panico,
             g.nome AS nome_favela,
             ST_AsGeoJSON(g.geom::geometry)::json AS geofence_geojson
           FROM posicoes_atuais p
           JOIN veiculos v ON v.id = p.veiculo_id
           JOIN geofences g
             ON g.tipo = 'favela'
             AND ST_Intersects(g.geom, p.geom)
           WHERE p.atraso_min <= 60`
        );

        // Alertas de favela ATIVOS de uma vez (1 query pra todo mundo, nao 1
        // maybeSingle() por veiculo em favela) — achado 07/07/2026 junto com
        // o resto da investigacao de CPU da Vercel. Reaproveitado tambem no
        // passo de resolucao logo abaixo.
        const { data: alertasFavelaAtivosPre } = clientesComSucesso.size > 0
          ? await supabase
              .from("alertas")
              .select("id, veiculo_id")
              .eq("tipo", "favela")
              .eq("status", "ativo")
              .in("cliente_id", [...clientesComSucesso])
          : { data: [] as { id: string; veiculo_id: string }[] };
        const alertaFavelaPorVeiculo = new Map(
          (alertasFavelaAtivosPre ?? []).map((a) => [a.veiculo_id, a.id])
        );

        for (const vf of veiculosEmFavela) {
          try {
            // Suprimir alerta se o proprio ponto de entrega pendente esta dentro
            // da mesma comunidade — o caminhao esta la para entregar, nao e suspeito.
            // Panico ativo nunca e suprimido por entrega pendente.
            const alvosVeiculo = veiculoIdToAlvos.get(vf.veiculo_id) ?? [];
            const temEntregaNaFavela = alvosVeiculo
              .filter((a) => !a.feito)
              .some((a) => pontoEmGeo(a.lng, a.lat, vf.geofence_geojson));
            if (temEntregaNaFavela && !vf.panico) continue;

            // Nivel "atencao"/amarelo eliminado (pedido do cliente 06/07): tudo
            // vira critico/vermelho. Score ainda diferencia em transito de
            // parado, so a severidade exibida que deixou de escalonar.
            const emMovimento = vf.velocidade > 0 && !vf.panico;
            const nivelAlerta: "critico" | "atencao" = "critico";
            const nivelDb = "vermelho";
            const scoreFavela = emMovimento ? 60 : 95;
            const motivoFavela = emMovimento
              ? `Em transito pela comunidade: ${vf.nome_favela}`
              : `Parado na comunidade: ${vf.nome_favela}`;

            // Nao rebaixar nivel vermelho ja existente (outro detector pode ter setado).
            await pgClient.query(
              `UPDATE posicoes_atuais SET nivel = CASE
                 WHEN nivel = 'vermelho' THEN 'vermelho'
                 ELSE $2 END
               WHERE veiculo_id = $1`,
              [vf.veiculo_id, nivelDb]
            );

            // Idempotente: so inserir alerta favela se nao houver um ativo
            const alertaFavelaAtivo = alertaFavelaPorVeiculo.has(vf.veiculo_id);

            if (!alertaFavelaAtivo) {
              await supabase.from("alertas").insert({
                cliente_id: vf.cliente_id,
                veiculo_id: vf.veiculo_id,
                nivel: nivelAlerta,
                tipo: "favela",
                motivo: motivoFavela,
                score: scoreFavela,
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

        // Resolver alertas favela de veiculos que saíram da area de risco.
        // Reaproveita o snapshot de alertaFavelaPorVeiculo buscado ANTES do
        // loop (ver acima) -- ja e o mesmo escopo de clientesComSucesso, e um
        // alerta novo criado neste ciclo pra um veiculo que segue em favela
        // nunca entraria aqui de qualquer forma (idsEmFavela ja exclui ele).
        if (clientesComSucesso.size > 0) {
          const idsEmFavela = new Set(veiculosEmFavela.map((vf) => vf.veiculo_id));

          const parasResolver = [...alertaFavelaPorVeiculo.entries()].filter(
            ([veiculoId]) => !idsEmFavela.has(veiculoId)
          );

          if (parasResolver.length > 0) {
            const ids = parasResolver.map(([, id]) => id);
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

    // Limpeza periódica — janela de 5 min para tolerar variacao de cold-start do Vercel.
    // A query de fim de expediente ja e idempotente, entao rodar em :00-:05 nao causa dano.
    if (agora.getMinutes() <= 5) {
      const pgClean = await pool.connect();
      try {
        // Fim de expediente (20h SP): resolve alertas de rotina que ficaram
        // abertos durante o dia. Garante que na abertura do turno seguinte
        // o beep dispara com IDs frescos.
        const horaSP_cleanup = parseInt(
          new Intl.DateTimeFormat("pt-BR", {
            timeZone: "America/Sao_Paulo", hour: "numeric", hour12: false,
          }).format(agora), 10
        );
        if (horaSP_cleanup === 20) {
          await pgClean.query(`
            UPDATE alertas SET status='resolvido', resolvido_em=now()
            WHERE status='ativo'
              AND tipo IN ('saida_nao_autorizada','parada_longa','parada_anomala',
                           'parada_cliente','excesso','desvio')
              AND created_at < now() - interval '30 minutes'
          `);
        }

        // Campos pesados (geom, lat, lng, contexto) — zeramos logo que resolve;
        // o motor pode ter resolvido sem limpar, então varremos aqui também.
        await pgClean.query(
          `UPDATE alertas
           SET geom = NULL, lat = NULL, lng = NULL, contexto = '{}'
           WHERE status IN ('resolvido', 'falso_positivo')
             AND geom IS NOT NULL`
        );
        // Alertas resolvidos > 30 dias: apenas texto necessário para o dashboard.
        await pgClean.query(
          `DELETE FROM alertas
           WHERE status IN ('resolvido', 'falso_positivo')
             AND COALESCE(resolvido_em, created_at) < now() - interval '30 days'`
        );
        await pgClean.query(
          `DELETE FROM poi_cache WHERE atualizado_em < now() - interval '7 days'`
        );
        await pgClean.query(
          `DELETE FROM eventos WHERE ts < now() - interval '7 days'`
        );
        // geocode_cache nunca tinha limpeza — crescia pra sempre (achado em
        // varredura de uso: 40k+ linhas em 14 dias). Endereço não fica
        // desatualizado, mas a tabela precisa de teto; 90 dias é folgado o
        // bastante pra não gerar re-geocode de local ainda em uso frequente.
        await pgClean.query(
          `DELETE FROM geocode_cache WHERE criado < now() - interval '90 days'`
        );
        // Tapete: células sem visita há mais de 30 dias saem do corredor.
        await pgClean.query(
          `DELETE FROM corredor_celulas WHERE ultimo_visto < current_date - 30`
        );
      } catch (errClean) {
        console.warn("Limpeza periódica falhou (não crítico):", errClean);
      } finally {
        pgClean.release();
      }
    }

    // Tick via Realtime broadcast: avisa as telas abertas que o ciclo
    // terminou e ha dado novo. As telas buscam /api/mapa e /api/alertas SO
    // quando o tick chega (1x/min) em vez de pollar as cegas a cada 10-15s.
    // Payload vazio de proposito (canal publico, nenhum dado sensivel).
    // 1 mensagem HTTP por ciclo; falha e silenciosa (fallback: as telas
    // mantem um poll lento de seguranca).
    try {
      await fetch(`${process.env.NEXT_PUBLIC_SUPABASE_URL}/realtime/v1/api/broadcast`, {
        method: "POST",
        headers: {
          apikey: process.env.SUPABASE_SERVICE_ROLE_KEY ?? "",
          Authorization: `Bearer ${process.env.SUPABASE_SERVICE_ROLE_KEY ?? ""}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          messages: [{ topic: "motor-tick", event: "tick", payload: {} }],
        }),
        signal: AbortSignal.timeout(3000),
      });
    } catch { /* nao critico: fallback de poll lento cobre */ }

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
