// Motor de detecção de alertas — POST /api/motor
// Rota protegida por x-motor-key (MOTOR_SECRET). Nunca use em client.

import pg from "pg";
import { createAdminClient } from "@/lib/supabase/admin";
import { configPoolContabo } from "@/lib/supabase/contabo-ca";
import { RAIO_ESCALA_M } from "@/lib/escala-geocode";
import {
  agruparAlvosPorPlaca,
  agruparPontosPorPlaca,
  alvoMaisProximoQualquer,
  rumoGraus,
  haversineM,
  normalizar,
  centroideGeo,
  distanciaAoSegmentoM,
  suspenderPorChegada,
  RAIO_CHEGADA_MIN_M,
  corrigirComPontoAprendido,
  PONTO_APRENDIDO_ATIVO,
} from "@/lib/unitrac";
import type { EntregasPlaca, PontoEntrega } from "@/lib/unitrac";
import {
  montarCandidatosCore,
  detectarJammer,
  emHorarioOperacao,
  detectarRetornoTardio,
  detectarParadaNoturnaIgnicaoAtiva,
  detectarAceleracaoBrusca,
  calcularRiscoArea,
  detectarBypassEntrega,
  detectarParadaSemMarcacao,
  PARADA_SEM_MARCACAO_RAIO_EXTRA_M,
  BYPASS_ENTREGA_DWELL_MINIMO_SEGUNDOS,
  detectarAnomaliaBaseline,
  arbitrarCandidatos,
  reduzirPorTransitoInferido,
  PARADA_FORA_TAPETE_MIN,
  TIPOS_NAO_GERENCIADOS,
  temCoordenadaValida,
  contaComoEventoDeSilenciamento,
  BONUS_CORROBORACAO_POR_SINAL,
  type Alerta,
} from "@/lib/detectores";
import { temPOIProximo } from "@/lib/overpass";
import { verificarCorredorFora, aplicarCorroboracaoCorredor } from "@/lib/corredor-confirmacao";
import {
  melhorClasse,
  avaliarQuedaClasseViaria,
  avaliarSaiuParadaConfirmadaRecentemente,
  aplicarCorroboracaoClasseViaria,
  type ClasseViaria,
} from "@/lib/classe-viaria-confirmacao";
import { celulasDoSegmento, vizinhanca3x3, celulaDe } from "@/lib/celulas";
import { buscarTiroteiosRJ, obterPerfilHorario } from "@/lib/fogocruzado";
import type { Tiroteio } from "@/lib/fogocruzado";
import { manterSessaoViva } from "@/lib/unitrac-comandos";
import { obterRouboCarga } from "@/lib/roubocarga";
import { atualizarBaselineWelford, classificarTipoViagem, decidirAdmissaoBaseline, BASELINE_FROTA_N_MAXIMO, BASELINE_MIN_AMOSTRAS_PROPRIO, type Baseline } from "@/lib/baseline-veiculo";
import { buscarDistanciasReais } from "@/lib/distancia-real";
import { corrigirPosicoesComMatch } from "@/lib/osrm-match";
import { avaliarAfastandoDeTudo, avaliarRuaRara, montarAlertaDesvio, LIMIAR_CARENCIA_BASE_M } from "@/lib/desvio";
import { segmentoCalibracaoPreferido, aplicarFatorCalibrado } from "@/lib/calibracao-desvio";

type PontoComId = { id: string; lat: number; lng: number };

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

// Teto de correcoes via /match (OSRM) BEM-SUCEDIDAS por ciclo do motor
// (achado real 13/08, revisao final de branch). Cada chamada individual ja
// tem timeout de 5s (AbortSignal.timeout, ver osrm-match.ts), mas sem um
// teto agregado, um ciclo com muitos veiculos com afastandoStreak>0 ao
// mesmo tempo poderia gastar minutos so' em correcoes seriais, arriscando
// estourar maxDuration=60s (a Vercel mata a funcao no meio do ciclo,
// deixando os UPSERTs em lote do fim do ciclo sem rodar pra frota inteira).
// motor_lease ja serializa ciclos (protecao existente contra dois ciclos
// simultaneos), mas isso nao limita quanto tempo UM ciclo pode levar. Acima
// do teto, os veiculos excedentes simplesmente pulam a correcao neste ciclo
// e usam o fallback bruto de sempre (sem erro) -- mesmo raciocinio do
// comentario sobre LIMIAR_CONFIANCA_MATCH mais abaixo: o pior efeito e'
// atrasar/distorcer um alerta que ja estava se formando, nunca perde
// deteccao. Valor generoso (afastandoStreak>0 simultaneo em muitos veiculos
// e' incomum -- e' um sinal por veiculo ja em formacao, nao o estado normal
// da frota inteira).
const MAX_CORRECOES_MATCH_POR_CICLO = 40;

// ─── Cache em memória da frota por cliente (best-effort entre ciclos) ──────
// A frota (quais veículos existem/estão ativos) muda raríssimo — não faz
// sentido reler do banco toda vez que o motor roda (a cada 1 min, pra sempre).
// Cache de módulo: sobrevive entre invocações enquanto a instância serverless
// ficar "quente" (comum rodando a cada 1 min); se der cold start, só refaz a
// consulta normalmente — sem risco de dado errado, só menos cache-hit.
type VeiculoCache = { veiculos: { id: string; cv: string; grupo: string | null }[]; expiraEm: number };
const CACHE_FROTA_MS = 3 * 60_000; // 3 min: renova rápido o bastante pra pegar veículo novo/desativado sem demora perceptível
const cacheFrotaPorCliente = new Map<string, VeiculoCache>();

// Pontos de entrega vindos do romaneio de HOJE, por cliente -- ver
// docs/superpowers/specs/2026-07-15-romaneio-pontos-entrega-design.md.
// Mesmo padrao de cache do resto do motor (frota, bases): renova a cada 3
// min, nao precisa reconsultar todo ciclo de 30s. Se nao existir romaneio de
// hoje pro veiculo, o motor cai no caminho 100% Unitrac de sempre (rede de
// seguranca, sem regressao de cobertura).
type RomaneioCache = { pontosPorPlaca: Map<string, { nf: string; clienteNome: string; lat: number; lng: number; presencaConfirmadaEm: string | null }[]>; expiraEm: number };
const CACHE_ROMANEIO_MS = 3 * 60_000;
const cacheRomaneioPorCliente = new Map<string, RomaneioCache>();
const cacheEscalaPorCliente = new Map<string, { pontosPorPlaca: Map<string, { lat: number; lng: number; raioM: number }[]>; expiraEm: number }>();

// Achado real 13/08 (pesquisa + auditoria: circuito de aprendizado morto --
// recalibrar-desvio/route.ts calcula e grava calibracao_desvio toda semana,
// mas nada aqui NUNCA lia de volta pra ajustar o score ao vivo, apesar do
// comentario antigo em recalibrar-desvio afirmar o contrario. Cache global
// (nao por cliente, tabela pequena) com o mesmo TTL dos outros caches deste
// arquivo -- so' ajusta o SCORE final do alerta (prioridade/severidade
// exibida), nunca decide se dispara nem mexe no streak/limiar -- efeito
// seguro pra recall: taxa alta so' deprioriza, nunca suprime.
let cacheCalibracaoDesvio: { taxas: Map<string, number>; expiraEm: number } | null = null;
async function getTaxasCalibracaoDesvio(pool: pg.Pool): Promise<Map<string, number>> {
  if (cacheCalibracaoDesvio && cacheCalibracaoDesvio.expiraEm > Date.now()) {
    return cacheCalibracaoDesvio.taxas;
  }
  const { rows } = await pool.query<{ segmento: string; taxa_falso_positivo: number }>(
    `SELECT segmento, taxa_falso_positivo FROM calibracao_desvio`
  );
  const taxas = new Map(rows.map((r) => [r.segmento, Number(r.taxa_falso_positivo)]));
  cacheCalibracaoDesvio = { taxas, expiraEm: Date.now() + CACHE_ROMANEIO_MS };
  return taxas;
}

// ─── Fallback de alvos pro detector de desvio quando a Unitrac falha ──────
// (achado real 29/07): detectarDesvio() bloqueava TODA deteccao
// comportamental (afastando de tudo, rumo-diverge, classe viaria, virada
// errada) quando buscarAlvos falhava neste ciclo (alvosApiOk===false, fail
// CLOSED) -- diferente da cerca virtual, que falha ABERTO ("indisponivel:
// tenta de novo"). Cliente Nutry Max tem falha RECORRENTE de rede na
// Unitrac (TypeError: fetch failed, ver descreverErroFetch) -- cada falha
// desligava desvio pra frota inteira (108 veiculos) ate o proximo fetch
// bem-sucedido: uma janela real em que um roubo em andamento nao dispararia
// NENHUM alerta de desvio.
//
// Fix: guarda o ultimo fetch bem-sucedido por cliente; quando o fetch do
// ciclo falha, cai pro ultimo conhecido (se dentro do teto de idade).
// CORRECAO (revisao independente 29/07, achado Importante -- versao
// anterior deste comentario dizia o oposto do que o codigo faz): o fallback
// NAO fica restrito a detectarDesvio -- pontosVeiculo (route.ts, mais
// abaixo) usa pontosPorPlacaFallback direto, entao bypass_entrega,
// parada_sem_marcacao (a CONTENTE, nao o gate -- ver leituraAlvosConfiavel),
// noCliente e suspensoPorChegada TAMBEM veem o fallback quando a Unitrac
// falha, em vez de mapas vazios. Decisao deliberada apos analise da
// revisao: dado velho de coordenada+feito e estritamente melhor que dado
// vazio pra esses consumidores (ex.: bypass_entrega hoje ja default pra
// entregaConfirmada=false numa falha -- feito e monotono, false->true, entao
// cache velho so pode errar pro lado de "ainda nao confirmado", nunca o
// inverso; dwell>=120s de bypass_entrega ja exclui entrega genuina de
// qualquer forma). alvosApiOk (a flag ESTRITA, live-only) continua gating,
// sem mudanca, exatamente os consumidores que exigem confirmacao FRESCA:
// entregasTotal/entregasFeitas (saida_nao_autorizada) e
// leituraAlvosConfiavel/deveMarcarSaidaParadaConfirmada (o gate de
// parada_sem_marcacao/rua-estreita, que continua congelando o dwell numa
// falha, mesmo com pontosVeiculo agora populado pelo fallback).
type AlvosFallbackCache = { pontosPorPlaca: Map<string, PontoEntrega[]>; capturadoEm: number };
const ALVOS_FALLBACK_MAX_MS = 30 * 60_000; // teto: nao usa fallback com mais de 30min
const cacheAlvosFallbackPorCliente = new Map<string, AlvosFallbackCache>();

// Tapete histórico (Camada 2 do desvio): células que a frota já percorreu nos
// últimos 30 dias, por cliente. É o sinal PRIMÁRIO e precisa estar disponível
// desde o 1º ciclo suspeito.
//
// Achado real 08/07: a versão anterior buscava a TABELA INTEIRA por cliente
// (150k+ células acumuladas) a cada expiração do cache de 3min. O cache de
// FREQUÊNCIA não ajuda quando o PAYLOAD de cada busca já é gigante —
// confirmado no pg_stat_statements: 169 MILHÕES de linhas retornadas só
// nessa query, ~12GB de egress, estourando o free tier do Supabase em 286%.
// Fix: busca só as células CANDIDATAS (vizinhança 3x3 dos veículos frescos
// deste ciclo, poucos milhares de chaves) via `celula = ANY($2)`, não a
// tabela inteira. A contagem total (só pro piso TAPETE_MIN_CELULAS, que
// decide se o tapete do cliente já tem cobertura mínima) fica num cache
// separado e minúsculo (1 inteiro por cliente).
type ContagemTapeteCache = { contagem: number; expiraEm: number };
const CACHE_TAPETE_MS = 3 * 60_000;
const cacheContagemTapetePorCliente = new Map<string, ContagemTapeteCache>();

// ─── Parada no local conta como entregue (usuario, 01/08) ─────────────
// "os pontos de entrega, se tem parada no local, conta como entregue".
//
// A Unitrac so marca entrega como feita quando alguem aponta no aparelho.
// Entrega feita e nao apontada segue "pendente" pro motor, entao o
// caminhao saindo dali -- inclusive voltando pra base no fim do dia --
// parece se AFASTAR de um destino, que e o gatilho da regra principal de
// desvio. Achado real 01/08: TUL-1H29 voltando pra base (87,9km -> 85,3km
// em 12min, se aproximando) disparou desvio carregando 9 pendentes
// fantasma.
//
// Regra: ficou parado dentro do raio do ponto por
// ENTREGA_PRESENCA_MIN_SEG -> grava em entregas_presenca e o ponto sai da
// lista de pendentes do dia. false = comportamento anterior (so pt.feito
// da Unitrac decide).
const ENTREGA_PRESENCA_ATIVA = true;
const ENTREGA_PRESENCA_MIN_SEG = 120;

// Log de snapshot de pendentes por ciclo -- ver
// docs/superpowers/specs/2026-08-09-snapshot-pendentes-log-design.md.
// Achado real 09/08: investigacao de 3 misses reportados no grupo bateu
// num limite estrutural -- a lista de pendentes da Unitrac e efemera,
// nunca persistida, entao nao da pra provar retroativamente se havia
// destino perto da posicao real no momento de um miss. Throttle de 5min
// por veiculo (nao grava todo ciclo de 30s) -- granularidade de minutos
// ja basta pra investigacao, sem custo de escrita desnecessario.
const ultimoSnapshotPendentesPorVeiculo = new Map<string, number>();
const SNAPSHOT_PENDENTES_INTERVALO_MS = 5 * 60 * 1000;

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
    ...configPoolContabo(process.env.DATABASE_URL),
    max: 3,
  });
}

// Trava de execução única do ciclo do motor. O cron dispara o POST a cada 30s
// via pg_net com timeout de 5000ms (default) — pg_net desiste de esperar a
// resposta bem antes do ciclo terminar (maxDuration=60), mas a execução na
// Vercel continua rodando. Sem essa trava, um ciclo lento (Unitrac + Google
// Geocode + OSRM + Fogo Cruzado) ainda em andamento aos 30s colide com o
// próximo disparo: as duas execuções leem o mesmo snapshot de alertas abertos
// e de desvio_streak/desvio_inicio, cada uma insere seu próprio alerta de
// desvio (duplicado, "desde" a poucos ms de diferença) e o upsert em lote de
// posicoes_atuais no fim de cada execução se sobrescreve (last-write-wins),
// corrompendo o streak e disparando o ciclo criar/resolver repetidas vezes por
// veículo (visto em produção: até 34 alertas de desvio/dia pro mesmo veículo).
//
// IMPLEMENTACAO: lease com expiracao na tabela motor_lease (migration 016),
// adquirido/liberado no handler. NUNCA usar pg_try_advisory_lock aqui de
// novo: atraves do pooler Supavisor + Vercel Fluid (funcao congelada mantem
// o socket vivo), o advisory lock ficava preso por tempo INDETERMINADO --
// 64-88% dos ciclos pulados, stalls de 20+ min, e muito provavelmente o
// apagao de ~20h de 01-02/07 (achado 10-11/07).

// Achado real 29/07: as falhas de buscarPosicoes/buscarAlvos (Nutry Max e
// Benassi, recorrentes o dia todo) so apareciam no log como "TypeError:
// fetch failed" -- a mensagem generica que o fetch() do Node/undici usa pra
// QUALQUER falha de rede (timeout de conexao, DNS, TLS, conexao resetada,
// etc). A causa real fica em err.cause (AggregateError/erro especifico do
// undici), que String(err) nao inclui -- log generico demais pra
// diagnosticar de verdade qual dessas e' a causa real. Extrai o cause
// explicitamente quando existir.
function descreverErroFetch(err: unknown): string {
  const base = String(err);
  const cause = err instanceof Error ? err.cause : undefined;
  if (cause === undefined) return base;
  return `${base} (cause: ${cause instanceof Error ? `${cause.name}: ${cause.message}` : String(cause)})`;
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

// ─── Cache em memoria de geocode_cache (por ciclo, restrito a candidatos) ──
// Achado 07/07/2026 investigando estouro de CPU da Vercel: geocodeReverso
// fazia 1 pool.connect()+SELECT por veiculo parado/em alerta -- num ciclo
// tipico isso e ~170 dos ~300 veiculos. A 1a correcao trocou isso por 1
// busca da TABELA INTEIRA (cacheada por TTL) -- so que a tabela cresceu pra
// ~48k linhas/5MB, e junto com o tapete (ver ContagemTapeteCache acima) isso
// gerou o estouro de egress de 08/07 (286% do free tier do Supabase).
// Fix: mesma ideia do tapete -- busca so os candidatos (posicoes frescas)
// DESTE ciclo via join com unnest, nao a tabela inteira. cacheGeocode agora
// e um Map comum (nao module-level), populado por cliente e reusado dentro
// do mesmo ciclo -- sem TTL entre ciclos, porque o payload ja e pequeno.
function chaveGeocode(lat: number, lng: number): string {
  const latR = Math.round(lat * 10000) / 10000;
  const lngR = Math.round(lng * 10000) / 10000;
  return `${latR}:${lngR}`;
}

async function preencherGeocodeCacheCandidatos(
  pool: pg.Pool,
  cacheGeocode: Map<string, string>,
  chavesCandidatas: Set<string>
): Promise<void> {
  if (chavesCandidatas.size === 0) return;
  const lats: number[] = [];
  const lngs: number[] = [];
  for (const chave of chavesCandidatas) {
    const [la, lo] = chave.split(":").map(Number);
    lats.push(la);
    lngs.push(lo);
  }
  const pgClient = await pool.connect();
  try {
    const { rows } = await pgClient.query<{ lat: number; lng: number; endereco: string }>(
      `SELECT g.lat, g.lng, g.endereco
       FROM geocode_cache g
       JOIN (SELECT unnest($1::float8[]) AS lat, unnest($2::float8[]) AS lng) c
         ON g.lat = c.lat AND g.lng = c.lng`,
      [lats, lngs]
    );
    for (const r of rows) cacheGeocode.set(chaveGeocode(r.lat, r.lng), r.endereco);
  } catch {
    /* nao-critico: cache miss vira nova chamada externa (Nominatim/Google), como sempre */
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
// Tipo importado de lib/detectores.ts (era definido localmente aqui; task 3
// da Fase 2 consolidou -- montarContextoDesvio usa o mesmo tipo).

// ─── Handler principal ───────────────────────────────────────────────────────

export async function POST(request: Request) {
  // 1. Segurança
  const chave = request.headers.get("x-motor-key");
  if (!chave || chave !== process.env.MOTOR_SECRET) {
    return Response.json({ erro: "Nao autorizado" }, { status: 401 });
  }

  const supabase = createAdminClient();
  const pool = criaPgPool();

  // 2. Trava: só um ciclo do motor roda por vez -- LEASE com expiracao
  // (migration 016), NAO advisory lock. Achado real 10-11/07: advisory lock
  // atraves do pooler Supavisor + Vercel Fluid (funcao congelada mantem o
  // socket vivo) deixava o lock preso por tempo INDETERMINADO -- 64-88% dos
  // ciclos pulados o dia todo, stalls de 20+ min, e muito provavelmente o
  // apagao de ~20h de 01-02/07. O lease e um UPDATE atomico: se o ciclo
  // dono morrer, expira sozinho em 90s (> maxDuration=60, entao nunca ha
  // dois ciclos rodando de verdade ao mesmo tempo).
  let leaseToken: string | null = null;
  {
    const lockClient = await pool.connect();
    try {
      const { rows: leaseRows } = await lockClient.query<{ token: string }>(
        `update motor_lease
         set expira_em = now() + interval '90 seconds',
             token = gen_random_uuid(),
             adquirido_em = now()
         where id = 1 and expira_em < now()
         returning token`
      );
      leaseToken = leaseRows[0]?.token ?? null;
    } finally {
      lockClient.release();
    }
  }
  if (!leaseToken) {
    await pool.end();
    return Response.json({
      pulado: true,
      motivo: "ciclo anterior do motor ainda em execucao",
    });
  }

  const agora = new Date();
  const erros: string[] = [];
  const emOperacao = emHorarioOperacao(agora);
  // Sabado diurno (SP): o desvio tambem roda aos sabados 6h-20h QUANDO o
  // veiculo tem rota carregada de HOJE na Unitrac (achado 10/07: movimento
  // real de sabado sem nenhuma cobertura de desvio). dataHojeSP filtra rota
  // velha de sexta que a Unitrac ainda nao limpou.
  const ehSabadoSP =
    new Intl.DateTimeFormat("en-US", { timeZone: "America/Sao_Paulo", weekday: "short" }).format(agora) === "Sat";
  const dataHojeSP = new Intl.DateTimeFormat("en-CA", { timeZone: "America/Sao_Paulo" }).format(agora);
  const desde2h = new Date(agora.getTime() - 2 * 60 * 60 * 1000).toISOString();

  // Contador de geocodes novos consumidos neste ciclo
  const contadorGeocodesNovos = { valor: 0 };
  // Contador de correcoes via /match BEM-SUCEDIDAS neste ciclo (ver
  // MAX_CORRECOES_MATCH_POR_CICLO acima) -- checado antes de tentar a
  // proxima correcao, incrementado so' quando corrigirPosicoesComMatch
  // retorna um resultado usavel (confidence acima do piso).
  const contadorCorrecoesMatch = { valor: 0 };
  // Populado por cliente (candidatos deste ciclo, ver preencherGeocodeCacheCandidatos
  // e a pre-passada de cada cliente) — nao busca a tabela inteira (ver comentario ali).
  const cacheGeocode = new Map<string, string>();

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
    // Estrutura: cliente_id -> lista de { nome, geom (GeoJSON), areaM2 }
    // areaM2 (revisao independente 27/07, achado severo): calculado UMA VEZ
    // aqui no load (bases raramente mudam), nao por veiculo/ciclo -- evita
    // adicionar uma query nova por veiculo so pra checar tamanho. Usado
    // exclusivamente pelo gate de auto-resolve de "afastando rota concluida"
    // abaixo (ver BASE_AREA_MAX_M2_AUTORESOLVE_AFASTANDO em detectores.ts);
    // baseOcupada continua com o MESMO significado de sempre em qualquer
    // outro uso neste arquivo (localVeiculo, foraDaBase, cerca virtual etc).
    const mapaBasesCliente = new Map<
      string,
      { nome: string; geom: GeoJSONGeom | null; areaM2: number | null }[]
    >();

    {
      const pgBases = await pool.connect();
      try {
        const { rows: basesRows } = await pgBases.query<{
          cliente_id: string;
          nome: string;
          geojson: string;
          area_m2: number | null;
        }>(
          `SELECT cliente_id, nome, ST_AsGeoJSON(geom::geometry) AS geojson, ST_Area(geom::geography) AS area_m2 FROM bases`
        );
        for (const b of basesRows) {
          const lista = mapaBasesCliente.get(b.cliente_id) ?? [];
          let geom: GeoJSONGeom | null = null;
          try { geom = JSON.parse(b.geojson) as GeoJSONGeom; } catch { /* ignora */ }
          const areaM2Bruta = b.area_m2 != null ? Number(b.area_m2) : NaN;
          const areaM2 = Number.isFinite(areaM2Bruta) ? areaM2Bruta : null;
          lista.push({ nome: b.nome, geom, areaM2 });
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

    // 3a-bis. Carregar pontos_aprendidos (correcao de posicao aprendida por
    // ponto de entrega, ver corrigirComPontoAprendido em src/lib/unitrac.ts).
    // Carregado 1x por ciclo aqui, mesmo padrao de mapaBasesCliente acima --
    // so o carregamento. A correcao e aplicada mais abaixo, em
    // `pontosVeiculo` (procure `const pontosVeiculo = (pontosVeiculoBruto ?? []).map(`)
    // logo depois do carregamento de pontosVeiculoBruto -- corrigirComPontoAprendido
    // roda por veiculo/ponto la, nao aqui no carregamento em lote.
    const mapaPontosAprendidos = new Map<
      string,
      Map<number, { lat: number; lng: number; fonte: "aprendido" | "manual" }>
    >();

    {
      const pgAprendidos = await pool.connect();
      try {
        const { rows: pontosAprendidosRows } = await pgAprendidos.query<{
          cliente_id: string;
          // Achado real 10/08 (revisao independente do Task 3): ponto_codigo
          // e' bigint no Postgres, e o driver `pg` retorna bigint/int8 como
          // string por padrao (sem setTypeParser custom neste projeto) --
          // tipar como number aqui era uma asserção não verificada que o
          // tsc não pegava, e fazia o Map usar chave string ("563321") nunca
          // batendo com o number de verdade em pt.pontoCodigo (unitrac.ts).
          // Convertendo explicitamente com Number() abaixo.
          ponto_codigo: string;
          lat: number;
          lng: number;
          fonte: "aprendido" | "manual";
        }>(`SELECT cliente_id, ponto_codigo, lat, lng, fonte FROM pontos_aprendidos`);
        for (const r of pontosAprendidosRows) {
          const porCliente = mapaPontosAprendidos.get(r.cliente_id) ?? new Map();
          porCliente.set(Number(r.ponto_codigo), { lat: r.lat, lng: r.lng, fonte: r.fonte });
          mapaPontosAprendidos.set(r.cliente_id, porCliente);
        }
      } catch (errAprendidos) {
        const msg = `Aviso: erro ao carregar pontos_aprendidos (${String(errAprendidos)})`;
        console.warn(msg);
        erros.push(msg);
      } finally {
        pgAprendidos.release();
      }
    }

    // 3. Carregar posicoes_atuais atuais para calcular parado_desde
    //
    // Achado real 29/07 (apontado por 4 revisoes independentes distintas
    // ao longo do dia anterior, sempre adiado ate agora): sem capturar
    // `error`, um select que falha (deploy rodou antes de alguma migration
    // aplicar, ou o cache de schema do PostgREST ainda nao recarregou)
    // retorna data=null -- mapaPosAtual fica vazio, TODO veiculo cai no
    // fallback de cold-start (streaks, parado_desde, todos os acumuladores
    // novos de hoje zerados), e o UPSERT em lote mais abaixo GRAVA esse
    // estado zerado de volta, apagando o historico real da frota inteira
    // num ciclo so. Mesmo padrao ja usado pra baseline_veiculo/frota nesta
    // sessao: captura o erro aqui, e o bloco que faz o UPSERT (mais abaixo,
    // "Upsert batch de posicoes_atuais") pula a escrita se este read falhou
    // -- so a escrita que corromperia o estado e' pulada, nao o ciclo
    // inteiro (deteccao ainda roda, so com anterior=undefined pra este
    // ciclo, degradacao aceitavel e temporaria; nao persistente).
    const { data: posatuaisRows, error: erroLeituraPosAtuais } = await supabase
      .from("posicoes_atuais")
      .select("veiculo_id, lat, lng, velocidade, parado_desde, ultimo_evento, no_raio_alvo_codigo, no_raio_desde, no_raio_dwell_segundos, perto_sem_marcacao_codigo, perto_sem_marcacao_segundos");
    if (erroLeituraPosAtuais) {
      const msg = `CRITICO: falha ao ler posicoes_atuais (estado por veiculo perdido neste ciclo, UPSERT sera pulado pra nao gravar cold-start por engano): ${erroLeituraPosAtuais.message}`;
      console.error(msg);
      erros.push(msg);
    }

    const mapaPosAtual = new Map<
      string,
      {
        lat: number | null; lng: number | null; velocidade: number | null;
        parado_desde: string | null;
        ultimo_evento: string | null;
        no_raio_alvo_codigo: number | null; no_raio_desde: string | null; no_raio_dwell_segundos: number;
        // Achado real 28/07 (cliente Nutry Max, TTM-7C13/TUS-1A47) -- ver
        // detectarParadaSemMarcacao em lib/detectores.ts. Colunas PROPRIAS
        // (migration 016), mesmo padrao de no_raio_alvo_codigo/no_raio_dwell_segundos.
        perto_sem_marcacao_codigo: number | null;
        perto_sem_marcacao_segundos: number;
      }
    >();

    for (const row of posatuaisRows ?? []) {
      mapaPosAtual.set(row.veiculo_id, {
        lat: row.lat,
        lng: row.lng,
        velocidade: row.velocidade,
        parado_desde: row.parado_desde,
        ultimo_evento: row.ultimo_evento ?? null,
        no_raio_alvo_codigo: row.no_raio_alvo_codigo ?? null,
        no_raio_desde: row.no_raio_desde ?? null,
        no_raio_dwell_segundos: row.no_raio_dwell_segundos ?? 0,
        perto_sem_marcacao_codigo: row.perto_sem_marcacao_codigo ?? null,
        perto_sem_marcacao_segundos: row.perto_sem_marcacao_segundos ?? 0,
      });
    }

    // Detector de desvio v2: prefetch do estado (streaks) de todos os
    // veiculos de uma vez -- ver docs/superpowers/specs/2026-08-12-desvio-de-rota-v2-design.md.
    const desvioEstadoPorVeiculo = new Map<string, {
      afastandoStreak: number;
      ruaRaraStreak: number;
    }>();
    try {
      const { rows } = await pool.query<{
        veiculo_id: string;
        afastando_streak: number;
        rua_rara_streak: number;
      }>(
        `SELECT veiculo_id, afastando_streak, rua_rara_streak FROM desvio_estado`
      );
      for (const r of rows) {
        desvioEstadoPorVeiculo.set(r.veiculo_id, {
          afastandoStreak: r.afastando_streak,
          ruaRaraStreak: r.rua_rara_streak,
        });
      }
    } catch (errDesvioEstado) {
      erros.push(`Aviso: desvio v2 indisponivel neste ciclo (estado): ${String(errDesvioEstado)}`);
    }

    // Classe viaria (ultima_via_principal_em/saiu_parada_confirmada_em) --
    // ver docs/superpowers/specs/2026-08-15-classe-viaria-corroboracao-design.md.
    // Query PROPRIA e independente da de cima (mesma tabela desvio_estado,
    // mas SELECT e catch separados). Achado da revisao final da leva de
    // correcao (15/08, Important): antes essas 2 colunas eram lidas na
    // MESMA query que afastando_streak/rua_rara_streak -- se so a parte
    // NOVA falhasse (ex: deploy rodando antes da migration destas colunas,
    // ou ambiente sem elas ainda), o catch generico zerava TAMBEM o streak
    // do detector principal (afastando_geral) pra frota inteira, nao so a
    // classe viaria. Com a query separada, uma falha aqui so degrada a
    // classe viaria (fail-open normal, sem estado decaindo) -- o streak do
    // afastando_geral (bloco acima) nunca e afetado. Mesmo raciocinio ja
    // aplicado a query de vias_celulas (try/catch proprio, separado do
    // catch geral do veiculo).
    const classeViariaEstadoPorVeiculo = new Map<string, {
      ultimaViaPrincipalEm: Date | null;
      saiuParadaConfirmadaEm: Date | null;
    }>();
    try {
      const { rows } = await pool.query<{
        veiculo_id: string;
        ultima_via_principal_em: Date | null;
        saiu_parada_confirmada_em: Date | null;
      }>(
        `SELECT veiculo_id, ultima_via_principal_em, saiu_parada_confirmada_em FROM desvio_estado`
      );
      for (const r of rows) {
        classeViariaEstadoPorVeiculo.set(r.veiculo_id, {
          ultimaViaPrincipalEm: r.ultima_via_principal_em,
          saiuParadaConfirmadaEm: r.saiu_parada_confirmada_em,
        });
      }
    } catch (errClasseViariaEstado) {
      erros.push(`Aviso: classe viaria indisponivel neste ciclo (estado): ${String(errClasseViariaEstado)}`);
    }

    // Baseline comportamental por veiculo/frota (Fase 3 do redesenho de
    // 11/07) -- carregado uma vez pra todos os veiculos, mesmo padrao de
    // mapaPosAtual acima (tabelas pequenas, nao precisa filtrar por cliente).
    // Achado CRITICO da revisao independente 28/07: se este select falhar
    // (ex: deploy rodou antes da migration 008, ou antes do PostgREST
    // recarregar o schema cache), data vem null/vazio -- leitura vazia e
    // segura (cai no fallback de cold-start), mas o UPSERT no fim do ciclo
    // NAO pode gravar de volta um estado derivado dessa leitura falha
    // (trataria todo veiculo como cold-start e apagaria o historico real).
    // erroLeituraBaselineVeiculo/Frota controla isso mais abaixo, nos
    // blocos de escrita.
    const { data: baselineVeiculoRows, error: erroLeituraBaselineVeiculo } = await supabase
      .from("baseline_veiculo")
      .select("veiculo_id, tipo_viagem, feature, n_amostras, media, variancia, excluida_desde");
    if (erroLeituraBaselineVeiculo) {
      console.warn(`Aviso: erro ao ler baseline_veiculo, pulando gravacao de baseline neste ciclo: ${erroLeituraBaselineVeiculo.message}`);
    }
    const mapaBaselineVeiculo = new Map<string, Baseline & { excluidaDesde: string | null }>();
    for (const r of baselineVeiculoRows ?? []) {
      mapaBaselineVeiculo.set(`${r.veiculo_id}:${r.tipo_viagem}:${r.feature}`, {
        n: Number(r.n_amostras), media: r.media, variancia: r.variancia,
        excluidaDesde: r.excluida_desde ?? null,
      });
    }

    const { data: baselineFrotaRows, error: erroLeituraBaselineFrota } = await supabase
      .from("baseline_frota")
      .select("cliente_id, tipo_viagem, feature, n_amostras, media, variancia");
    if (erroLeituraBaselineFrota) {
      console.warn(`Aviso: erro ao ler baseline_frota, pulando gravacao de baseline neste ciclo: ${erroLeituraBaselineFrota.message}`);
    }
    const mapaBaselineFrota = new Map<string, Baseline>();
    for (const r of baselineFrotaRows ?? []) {
      mapaBaselineFrota.set(`${r.cliente_id}:${r.tipo_viagem}:${r.feature}`, {
        n: Number(r.n_amostras), media: r.media, variancia: r.variancia,
      });
    }

    // Acumula amostras deste ciclo (veiculo + cliente) pra atualizar os
    // dois baselines em lote no fim, fora do loop de deteccao (mesmo
    // principio ja usado pra geocodesPendentes: nao bloquear o caminho
    // critico com round-trips extras por veiculo).
    const amostrasBaselineCiclo: { veiculo_id: string; cliente_id: string; tipoViagem: "urbano" | "rodoviario"; velocidade: number }[] = [];
    // Achado real 28/07: quando uma leitura e excluida (parece anomala), o
    // baseline nao ganha amostra nova neste ciclo, mas ainda precisamos
    // marcar o INICIO da exclusao continua (ver BASELINE_EXCLUSAO_MAX_MS em
    // baseline-veiculo.ts) -- guardado a parte porque aqui nao ha
    // n_amostras/media/variancia novos pra gravar, so o timestamp. So
    // marca o INICIO (nao reescreve se ja estava marcado): resetar pra
    // null acontece automaticamente no bloco de amostrasBaselineCiclo
    // sempre que uma amostra e admitida (normal ou forcada).
    const baselineExclusaoCiclo = new Map<string, string>(); // chave veiculo:tipo -> excluida_desde novo
    // Presenca confirmada por permanencia (romaneio) -- ver
    // docs/superpowers/specs/2026-07-15-presenca-confirmada-romaneio-design.md.
    // Coleta candidatos durante o loop, grava em lote no fim do ciclo (mesmo
    // padrao de amostrasBaselineCiclo acima).
    const presencaConfirmadaCiclo: { veiculo_id: string; nf: string }[] = [];
    // Parada no local conta como entregue (usuario, 01/08) -- coletado por
    // veiculo, gravado em UM insert no fim do ciclo (ver ENTREGA_PRESENCA_ATIVA).
    const presencaEntregaCiclo: {
      veiculo_id: string; ponto_codigo: number; parado_seg: number;
      lat: number; lng: number; cliente_id: string;
    }[] = [];
    // Anotacao de proximidade em alertas de desvio ATIVOS -- achado real
    // 18/07 (analise pedida pelo usuario, ver
    // docs/superpowers/specs/2026-07-18-anotacao-proximidade-desvio-design.md):
    // desvio nunca fecha sozinho (11/07), entao um alerta que disparou longe
    // do destino e o veiculo chegou perto minutos depois fica parecendo
    // "fresco e grave" pro operador indefinidamente. So INFORMACAO no
    // contexto (nunca muda nivel/status/fecha o alerta).
    const proximidadeDesvioCiclo: { alerta_id: string; pontoNome: string; dwellSegundos: number }[] = [];

    // Anotacao de "rota concluida" em alertas de desvio ATIVOS -- ver
    // docs/superpowers/specs/2026-07-21-anotacao-rota-concluida-desvio-design.md.
    // Complementar a proximidadeDesvioCiclo: fica verdadeiro mesmo depois do
    // veiculo sair de perto de qualquer ponto especifico (proximidade zera
    // nesse caso, isso continua). Reusa entregas_feitas/entregas_total, ja
    // computados por veiculo todo ciclo (mesmos valores que
    // detectarRetornoTardio ja usa pra outro alerta). So INFORMACAO no
    // contexto -- nunca muda nivel/status, nunca fecha o alerta.
    const rotaConcluidaCiclo: { alerta_id: string; entregasFeitas: number; entregasTotal: number }[] = [];

    // Snapshot de pendentes por ciclo (throttled) -- ver
    // docs/superpowers/specs/2026-08-09-snapshot-pendentes-log-design.md.
    // Puramente auditoria, nunca lido por nenhum detector.
    // latBruta/lngBruta (achado real 10/08, revisao final de branch,
    // Finding 3): guarda a posicao CRUA da Unitrac (pre-correcao de
    // pontos_aprendidos) lado a lado com lat/lng (ja corrigidos, que
    // continuam sendo os campos "principais" deste log). Antes da correcao
    // de pontos_aprendidos entrar em producao, este log gravava so a
    // posicao crua -- a spec desta feature usou justamente esse historico
    // pra medir a divergencia real Unitrac-vs-aprendido (mediana 56m, max
    // 232m). Sem o campo bruto, o log vira tautologico (corrigido comparado
    // com ele mesmo) e essa medicao fica impossivel de refazer; tambem
    // usado pelo harness de backtest de desvio (scripts/backtest-desvio/
    // carregar-corpus.mjs), que precisa saber qual geometria e' qual numa
    // janela de dias que atravessa o deploy desta feature.
    const pendentesSnapshotCiclo: {
      veiculo_id: string;
      temPendentes: boolean;
      alvosApiOk: boolean;
      pendentes: {
        lat: number; lng: number; raio: number; codigo: number | null; nome: string;
        latBruta: number | null; lngBruta: number | null;
      }[];
    }[] = [];

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
    const riscoPorVeiculo = new Map<string, { emFavela: boolean; cisp: string | null; emCorredorRisco: boolean; emAreaRiscoCliente: boolean; emPontoSeguro: boolean }>();
    try {
      const { rows } = await pool.query<{ veiculo_id: string; em_favela: boolean; cisp: string | null; em_corredor_risco: boolean; em_area_risco_cliente: boolean; em_ponto_seguro: boolean }>(
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
         ),
         area_cliente AS (
           -- Area de risco cadastrada pelo PROPRIO cliente (ex.: Caixotaria
           -- do Ceasa, Benassi, 16/07/2026) -- escopada por cliente_id
           -- (diferente de favela/cisp/risco, que sao globais).
           SELECT DISTINCT p.veiculo_id
           FROM posicoes_atuais p
           JOIN veiculos v ON v.id = p.veiculo_id
           JOIN geofences g ON g.tipo = 'area_risco_cliente' AND g.cliente_id = v.cliente_id AND ST_Intersects(g.geom, p.geom)
           WHERE p.atraso_min <= 60
         )
         SELECT
           p.veiculo_id,
           EXISTS (SELECT 1 FROM geofences g WHERE g.tipo = 'favela' AND ST_Intersects(g.geom, p.geom)) AS em_favela,
           cisp.cisp,
           (corredor.veiculo_id IS NOT NULL) AS em_corredor_risco,
           (area_cliente.veiculo_id IS NOT NULL) AS em_area_risco_cliente,
           EXISTS (SELECT 1 FROM geofences g WHERE g.tipo = 'ponto_seguro' AND ST_DWithin(g.geom, p.geom, 0)) AS em_ponto_seguro
         FROM posicoes_atuais p
         LEFT JOIN cisp ON cisp.veiculo_id = p.veiculo_id
         LEFT JOIN corredor ON corredor.veiculo_id = p.veiculo_id
         LEFT JOIN area_cliente ON area_cliente.veiculo_id = p.veiculo_id
         WHERE p.atraso_min <= 60`
      );
      for (const r of rows) {
        riscoPorVeiculo.set(r.veiculo_id, { emFavela: r.em_favela, cisp: r.cisp, emCorredorRisco: r.em_corredor_risco, emAreaRiscoCliente: r.em_area_risco_cliente, emPontoSeguro: r.em_ponto_seguro });
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
    const celulasCiclo: { cliente_id: string; celula: string; origem: string | null; destino: string | null }[] = [];

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
      entregas_total: number; local: string | null; rumo: number | null;
      ultimo_evento: string | null;
      no_raio_alvo_codigo: number | null; no_raio_desde: string | null; no_raio_dwell_segundos: number;
      // Achado real 28/07 (cliente Nutry Max, TTM-7C13/TUS-1A47) -- ver
      // detectarParadaSemMarcacao em lib/detectores.ts.
      perto_sem_marcacao_codigo: number | null;
      perto_sem_marcacao_segundos: number;
    };
    const posicoesCiclo: LinhaPosicaoCiclo[] = [];

    // Geocodes que deram cache-miss no loop principal -- resolvidos em
    // PARALELO depois do upsert de posicoes (fora do caminho critico da
    // deteccao; o rotulo chega ao banco segundos depois, via UPDATE proprio).
    const geocodesPendentes: { veiculo_id: string; lat: number; lng: number }[] = [];

    // Contagem total de células do tapete do cliente — só pro piso
    // TAPETE_MIN_CELULAS (nunca fica gigante: é 1 inteiro, cacheado por
    // CACHE_TAPETE_MS, igual antes). Ver comentário completo acima
    // (ContagemTapeteCache) do porquê isso NÃO busca as células em si.
    async function getContagemTapeteCliente(clienteId: string): Promise<number> {
      const cache = cacheContagemTapetePorCliente.get(clienteId);
      if (cache && cache.expiraEm > Date.now()) return cache.contagem;
      const pgTapete = await pool.connect();
      try {
        const { rows } = await pgTapete.query<{ n: string }>(
          `SELECT count(*)::bigint AS n FROM corredor_celulas WHERE cliente_id = $1`,
          [clienteId]
        );
        const contagem = Number(rows[0]?.n ?? 0);
        cacheContagemTapetePorCliente.set(clienteId, { contagem, expiraEm: Date.now() + CACHE_TAPETE_MS });
        return contagem;
      } catch {
        return cache?.contagem ?? 0;
      } finally {
        pgTapete.release();
      }
    }

    // Busca só as células CANDIDATAS (vizinhança 3x3 dos veículos frescos
    // deste ciclo — poucos milhares de chaves, não os 150k+ do cliente
    // inteiro) que de fato existem no tapete. Sem TTL: o conjunto de
    // candidatas muda a cada ciclo (posições diferentes), cachear não
    // ajudaria — o payload já é pequeno por construção.
    async function buscarCelulasTapeteCandidatas(
      clienteId: string,
      candidatas: string[]
    ): Promise<Set<string>> {
      if (candidatas.length === 0) return new Set();
      const pgTapete = await pool.connect();
      try {
        const { rows } = await pgTapete.query<{ celula: string }>(
          `SELECT celula FROM corredor_celulas WHERE cliente_id = $1 AND celula = ANY($2::text[])`,
          [clienteId, candidatas]
        );
        return new Set(rows.map((r) => r.celula));
      } catch {
        return new Set();
      } finally {
        pgTapete.release();
      }
    }

    // Presenca de entrega (decisao do usuario 01/08): "os pontos de entrega,
    // se tem parada no local, conta como entregue".
    //
    // Motivo real: a Unitrac so marca entrega como feita quando alguem aponta
    // no aparelho. Entrega feita e nao apontada continua "pendente" pro motor,
    // entao o caminhao saindo dali (inclusive voltando pra base no fim do dia)
    // parece estar se AFASTANDO de um destino -- o gatilho da regra principal.
    // Achado real 01/08 que motivou: TUL-1H29 voltando pra base (87,9km ->
    // 85,3km em 12min, se APROXIMANDO) disparou desvio porque ainda carregava
    // 9 pendentes fantasma de entregas ja realizadas.
    //
    // Chave do Set: "${veiculo_id}:${ponto_codigo}" (so o dia de hoje).
    async function buscarPresencaEntregaCliente(veiculoIds: string[]): Promise<Set<string>> {
      if (veiculoIds.length === 0) return new Set();
      const pgPresenca = await pool.connect();
      try {
        // dataHojeSP, NAO current_date: o servidor roda em +02 e Sao Paulo
        // e -03, entao das 19h as 23h59 (horario de SP) o current_date do
        // Postgres JA e o dia seguinte. Com current_date, a presenca gravava
        // e procurava em dias diferentes justamente no fim do turno --
        // feature morria em silencio toda tarde. Mesmo cuidado que o resto
        // do motor ja tinha com romaneio_data.
        const { rows } = await pgPresenca.query<{ veiculo_id: string; ponto_codigo: string }>(
          `SELECT veiculo_id, ponto_codigo
             FROM entregas_presenca
            WHERE dia = $2::date AND veiculo_id = ANY($1::uuid[])`,
          [veiculoIds, dataHojeSP]
        );
        return new Set(rows.map((r) => `${r.veiculo_id}:${r.ponto_codigo}`));
      } catch {
        // Falha de leitura -> Set vazio = nenhum ponto sai de pendente =
        // comportamento de antes desta feature. Fail-safe.
        return new Set();
      } finally {
        pgPresenca.release();
      }
    }

    for (const cliente of clientes) {
      // Obter CVs deste cliente
      const cvsCliente = [...mapaCv.entries()]
        .filter(([, v]) => v.cliente_id === cliente.id)
        .map(([cv]) => cv);
      const veiculoIdsCliente = [...mapaCv.entries()]
        .filter(([, v]) => v.cliente_id === cliente.id)
        .map(([, v]) => v.veiculo_id);

      if (cvsCliente.length === 0) continue;

      // Posicoes: exclui grupos que nunca reportam GPS (ver GRUPOS_SEM_GPS acima).
      const cvsParaPosicoes = [...mapaCv.entries()]
        .filter(([, v]) => v.cliente_id === cliente.id && !(v.grupo && GRUPOS_SEM_GPS.has(v.grupo)))
        .map(([cv]) => cv);

      // 4a/4b. Buscar posicoes E alvos do cliente EM PARALELO -- achado real
      // 10/07 (investigacao de lentidao do ciclo): as duas chamadas sao
      // independentes uma da outra, mas rodavam em sequencia (ate 20s de
      // timeout CADA uma), contribuindo pro ciclo estourar 30s e o proximo
      // disparo ser pulado ("ciclo anterior ainda em execucao"). Promise.
      // allSettled roda as duas ao mesmo tempo -- corta essa parte do ciclo
      // por cliente pela metade no pior caso, sem mudar nenhuma logica de
      // deteccao. NAO mexe no throttle do corredor (esse e limite real da
      // politica publica do OSRM, 1 req/s -- acelerar quebraria o servico).
      const [posicoesResultado, alvosResultado] = await Promise.allSettled([
        buscarPosicoesComTimeout(cvsParaPosicoes),
        buscarAlvosComTimeout(cvsCliente),
      ]);

      // Trata alvos ANTES do 'continue' de posicoes logo abaixo (achado
      // revisao independente 29/07, Minor): as duas chamadas sao
      // independentes (Promise.allSettled) -- se so buscarPosicoes falhar
      // neste ciclo, um alvos bem-sucedido nao pode ser descartado sem
      // alimentar cacheAlvosFallbackPorCliente, senao o fallback envelhece
      // sem necessidade toda vez que so a OUTRA chamada falha.
      let entregasPorPlaca = new Map<string, EntregasPlaca>();
      let pontosPorPlaca = new Map<string, PontoEntrega[]>();
      let alvosApiOk = false;
      // Fallback pro detector de desvio (e, rio abaixo, bypass_entrega/
      // parada_sem_marcacao/noCliente -- ver comentario de
      // cacheAlvosFallbackPorCliente acima). alvosApiOk (a flag estrita)
      // continua refletindo so o fetch DESTE ciclo, sem mudanca.
      let pontosPorPlacaFallback: Map<string, PontoEntrega[]> = new Map();
      let alvosDestinosDisponiveis = false;
      if (alvosResultado.status === "fulfilled") {
        entregasPorPlaca = alvosResultado.value.entregas;
        pontosPorPlaca = alvosResultado.value.pontos;
        alvosApiOk = true;
        alvosDestinosDisponiveis = true;
        pontosPorPlacaFallback = pontosPorPlaca;
        // Guard (achado Minor): Unitrac pode responder HTTP 200 com lista
        // vazia numa falha parcial do lado dela -- nao sobrescreve um
        // snapshot BOM ja em cache com um vazio (senao o fallback morre bem
        // antes do teto de 30min, justo quando mais precisaria dele). Sem
        // cache anterior, grava vazio mesmo (nada melhor pra guardar ainda).
        if (pontosPorPlaca.size > 0 || !cacheAlvosFallbackPorCliente.has(cliente.id)) {
          cacheAlvosFallbackPorCliente.set(cliente.id, { pontosPorPlaca, capturadoEm: Date.now() });
        }
      } else {
        // Nao-critico: mantemos os mapas vazios; alvosApiOk=false impede o
        // detector saida_nao_autorizada de disparar (evita falsos criticos em massa).
        const msg = `Aviso: buscarAlvos falhou para cliente ${cliente.id}: ${descreverErroFetch(alvosResultado.reason)}`;
        console.warn(msg);
        erros.push(msg);

        const fallback = cacheAlvosFallbackPorCliente.get(cliente.id);
        if (fallback && Date.now() - fallback.capturadoEm <= ALVOS_FALLBACK_MAX_MS) {
          pontosPorPlacaFallback = fallback.pontosPorPlaca;
          alvosDestinosDisponiveis = true;
          console.warn(
            `Usando cache de alvos (~${Math.round((Date.now() - fallback.capturadoEm) / 60000)}min atras) pro detector de desvio do cliente ${cliente.id} -- deteccao comportamental segue ativa com destinos ligeiramente desatualizados.`
          );
        }
      }

      let posicoesRaw: unknown[];
      if (posicoesResultado.status === "fulfilled") {
        posicoesRaw = posicoesResultado.value;
      } else {
        const err = posicoesResultado.reason;
        const isTimeout = err instanceof Error && err.name === "AbortError";
        const msg = isTimeout
          ? `Timeout (${TIMEOUT_UNITRAC_MS / 1000}s) ao buscar posicoes do cliente ${cliente.id}`
          : `buscarPosicoes falhou para cliente ${cliente.id}: ${descreverErroFetch(err)}`;
        console.error(msg);
        erros.push(msg);
        continue;
      }

      // Cliente processou posicoes com sucesso — marcar para filtro de favela.
      clientesComSucesso.add(cliente.id);

      // veiculo_id do cliente: mapaCv e global (todos os clientes), filtra
      // pelo mesmo padrao ja usado acima nesse loop pra cvsCliente -- nao
      // existe uma lista "veiculos" local nesse escopo (essa so existe no
      // loop de cima, que so preenche cacheFrotaPorCliente/mapaCv). Hoisted
      // pra fora dos blocos de cache abaixo (romaneio/escala) pra ficar no
      // escopo dos dois -- calculado sempre (barato: so filter+map sobre um
      // Map ja em memoria), mesmo quando os dois caches estao quentes e nao
      // seria usado.
      const veiculoIdsDoCliente = [...mapaCv.values()]
        .filter((v) => v.cliente_id === cliente.id)
        .map((v) => v.veiculo_id);

      // Pontos do romaneio de HOJE pro cliente -- ver
      // docs/superpowers/specs/2026-07-15-romaneio-pontos-entrega-design.md.
      // Cache de 3min (mesmo padrao de bases/frota); so consulta o banco de
      // novo quando expira.
      const cacheRomaneio = cacheRomaneioPorCliente.get(cliente.id);
      let romaneioPontosPorPlaca: Map<string, { nf: string; clienteNome: string; lat: number; lng: number; presencaConfirmadaEm: string | null }[]>;
      if (cacheRomaneio && cacheRomaneio.expiraEm > Date.now()) {
        romaneioPontosPorPlaca = cacheRomaneio.pontosPorPlaca;
      } else {
        romaneioPontosPorPlaca = new Map();
        const { data: linhasRomaneio } = await supabase
          .from("romaneio_pontos")
          .select("placa, nf, cliente_nome, lat, lng, presenca_confirmada_em")
          .eq("romaneio_data", dataHojeSP)
          .eq("modo_teste", false)
          .not("lat", "is", null)
          .not("lng", "is", null)
          .in("veiculo_id", veiculoIdsDoCliente);
        for (const l of linhasRomaneio ?? []) {
          const lista = romaneioPontosPorPlaca.get(l.placa) ?? [];
          lista.push({ nf: l.nf, clienteNome: l.cliente_nome, lat: l.lat, lng: l.lng, presencaConfirmadaEm: l.presenca_confirmada_em });
          romaneioPontosPorPlaca.set(l.placa, lista);
        }
        cacheRomaneioPorCliente.set(cliente.id, { pontosPorPlaca: romaneioPontosPorPlaca, expiraEm: Date.now() + CACHE_ROMANEIO_MS });
      }

      // Pontos de escala de HOJE pro cliente -- ver
      // docs/superpowers/specs/2026-08-09-escala-rota-design.md. Mesmo
      // padrao de cache 3min do romaneio acima.
      const cacheEscala = cacheEscalaPorCliente.get(cliente.id);
      let escalaPontosPorPlaca: Map<string, { lat: number; lng: number; raioM: number }[]>;
      if (cacheEscala && cacheEscala.expiraEm > Date.now()) {
        escalaPontosPorPlaca = cacheEscala.pontosPorPlaca;
      } else {
        escalaPontosPorPlaca = new Map();
        const { data: linhasEscala } = await supabase
          .from("escala_pontos")
          .select("placa, lat, lng, raio_m")
          .eq("escala_data", dataHojeSP)
          .not("lat", "is", null)
          .not("lng", "is", null)
          .in("veiculo_id", veiculoIdsDoCliente);
        for (const l of linhasEscala ?? []) {
          const lista = escalaPontosPorPlaca.get(l.placa) ?? [];
          lista.push({ lat: l.lat, lng: l.lng, raioM: l.raio_m ?? RAIO_ESCALA_M });
          escalaPontosPorPlaca.set(l.placa, lista);
        }
        cacheEscalaPorCliente.set(cliente.id, { pontosPorPlaca: escalaPontosPorPlaca, expiraEm: Date.now() + CACHE_ROMANEIO_MS });
      }

      // Pre-passada: coleta os veiculos PARADOS e frescos do cliente. Usado para
      // detectar congestionamento — varios parados na mesma area = transito/fila,
      // nao roubo. Comparar veiculos entre si mata o falso positivo de parada anomala.
      // Tambem coleta a vizinhanca 3x3 de TODA posicao fresca — candidatas pra
      // busca restrita do tapete logo abaixo (ver buscarCelulasTapeteCandidatas) —
      // e a chave de geocode de cada posicao fresca, candidata pra busca restrita
      // do geocode_cache (ver preencherGeocodeCacheCandidatos). Superset seguro:
      // inclui veiculo fresco em movimento sem alerta, que na real nao precisa de
      // geocode — so deixa a lista de candidatas um pouco maior, nunca erra.
      // Generalizado 12/07 (era so p.velocidade===0) pra tambem alimentar
      // vizinhosLentos (transito inferido pela propria frota) -- guarda
      // TODO veiculo fresco com sua velocidade, nao so os parados.
      const posicoesFrescasComVelocidade: { lat: number; lng: number; velocidade: number }[] = [];
      const celulasCandidatasTapete = new Set<string>();
      const chavesCandidatasGeocode = new Set<string>();
      for (const raw of posicoesRaw) {
        try {
          const p = normalizar(raw as Record<string, unknown>);
          if (p.fresco && p.lat != null && p.lng != null) {
            posicoesFrescasComVelocidade.push({ lat: p.lat, lng: p.lng, velocidade: p.velocidade });
            for (const c of vizinhanca3x3(p.lat, p.lng)) celulasCandidatasTapete.add(c);
            chavesCandidatasGeocode.add(chaveGeocode(p.lat, p.lng));
          }
        } catch { /* posicao malformada: ignora na pre-passada */ }
      }
      const RAIO_CONGESTION_M = 250;

      // Tapete restrito deste ciclo (ver comentario em ContagemTapeteCache) +
      // contagem total cacheada — 1 busca por cliente, payload proporcional
      // aos veiculos do ciclo, nao a tabela inteira.
      const contagemTapeteCliente = await getContagemTapeteCliente(cliente.id);
      const celulasTapeteCliente = await buscarCelulasTapeteCandidatas(
        cliente.id,
        [...celulasCandidatasTapete]
      );
      // Detector de desvio v2: frequencia historica de celulas do cliente
      // (frota inteira), pro Sinal B (rua rara). 1 query batched por cliente.
      const celulasFrequenciaCliente = new Map<string, number>();
      try {
        const { rows: rowsFreqCelula } = await pool.query<{ celula: string; n_visitas: number }>(
          `SELECT celula, n_visitas FROM celula_frequencia_cliente WHERE cliente_id = $1`,
          [cliente.id]
        );
        for (const r of rowsFreqCelula) celulasFrequenciaCliente.set(r.celula, r.n_visitas);
      } catch (errFreqCelula) {
        erros.push(`Aviso: desvio v2 indisponivel neste ciclo (frequencia de celula): ${String(errFreqCelula)}`);
      }
      // Classe viaria (queda de via principal/intermediaria pra rua
      // estreita) como sinal de CORROBORACAO -- ver
      // docs/superpowers/specs/2026-08-15-classe-viaria-corroboracao-design.md.
      // Classifica em LOTE, 1 query por cliente por ciclo, mesmo padrao das
      // outras buscas restritas acima (buscarCelulasTapeteCandidatas,
      // celula_frequencia_cliente): reusa celulasCandidatasTapete (vizinhanca
      // 3x3 de TODA posicao fresca da frota deste cliente, ja coletada na
      // pre-passada acima) em vez de rodar 1 query POR VEICULO A CADA CICLO
      // (~30s) como antes -- achado Important da revisao final (15/08),
      // custava query redundante ate pra veiculo parado na base o dia
      // inteiro. Mapa celula->classe; o loop por veiculo mais abaixo so
      // dobra melhorClasse sobre a vizinhanca de cada posicao, sem I/O.
      const classePorCelula = new Map<string, ClasseViaria>();
      try {
        const { rows: classesRows } = await pool.query<{ celula: string; classe: ClasseViaria }>(
          `SELECT celula, classe FROM vias_celulas WHERE celula = ANY($1::text[])`,
          [[...celulasCandidatasTapete]]
        );
        for (const r of classesRows) classePorCelula.set(r.celula, r.classe);
      } catch (errClasseViariaBatch) {
        erros.push(`Aviso: falha ao classificar classe viaria em lote pro cliente ${cliente.id}: ${String(errClasseViariaBatch)}`);
      }
      // Presenca de entrega (decisao do usuario 01/08): pontos onde o
      // veiculo JA ficou parado o tempo minimo hoje contam como entregues,
      // mesmo sem marcacao na Unitrac. 1 query batched por cliente.
      const presencaEntregaCliente = await buscarPresencaEntregaCliente(veiculoIdsCliente);
      // Geocode restrito deste ciclo (ver comentario acima de preencherGeocodeCacheCandidatos).
      await preencherGeocodeCacheCandidatos(pool, cacheGeocode, chavesCandidatasGeocode);

      // Batch: carregar alertas do cliente de uma vez (2 queries por ciclo em vez de N por veículo).
      // contexto incluido (achado Important 1, fix round 1 do progresso ao
      // destino, 06/08): origemMenorDistDestinoM precisa ler
      // contexto.dist_destinos_m do alerta especifico pra ter uma origem
      // ESTAVEL do delta -- ver comentario completo no bloco de coleta de
      // progressoDestinoCiclo mais abaixo, e em origemMenorDistDestinoM
      // (detectores.ts).
      const { data: todosAlertasAbertos } = await supabase
        .from("alertas")
        .select("id, tipo, veiculo_id, nivel, motivo, status, contexto, desde")
        .eq("cliente_id", cliente.id)
        .eq("modo_teste", false)
        .in("status", ["ativo", "reconhecido"]);

      const mapaAlertasAbertos = new Map<string, { id: string; tipo: string; nivel: string; motivo: string; status: string; contexto: unknown; desde: string }[]>();
      for (const ab of todosAlertasAbertos ?? []) {
        const lista = mapaAlertasAbertos.get(ab.veiculo_id) ?? [];
        lista.push({ id: ab.id, tipo: ab.tipo, nivel: ab.nivel, motivo: ab.motivo, status: ab.status, contexto: ab.contexto, desde: ab.desde });
        mapaAlertasAbertos.set(ab.veiculo_id, lista);
      }

      // BLOCKER 1 (revisao independente 27/07): esta query alimenta
      // mapaTiposSilenciados, que foi desenhada em torno de uma acao HUMANA
      // deliberada ("marcar falso positivo" na UI, ver acoes-alertas.ts) --
      // "ensinar o sistema" a ignorar aquele tipo pro veiculo por 2h.
      // Auto-resolves (ver contaComoEventoDeSilenciamento em detectores.ts
      // -- hoje so o de "afastando de tudo" quando rota concluida) reusam o
      // mesmo status='falso_positivo' mas NAO sao decisao humana; sem o
      // filtro abaixo silenciariam o tipo fleet-wide so por terem marcado
      // varios casos como resolvidos sozinhos. contexto precisa vir junto
      // pra dar pra distinguir.
      const { data: todosFalsosRecentes } = await supabase
        .from("alertas")
        .select("tipo, veiculo_id, contexto")
        .eq("cliente_id", cliente.id)
        .eq("modo_teste", false)
        .eq("status", "falso_positivo")
        .gte("resolvido_em", desde2h);

      const mapaTiposSilenciados = new Map<string, Set<string>>();
      for (const fp of todosFalsosRecentes ?? []) {
        if (!contaComoEventoDeSilenciamento(fp.contexto)) continue;
        const set = mapaTiposSilenciados.get(fp.veiculo_id) ?? new Set<string>();
        set.add(fp.tipo);
        mapaTiposSilenciados.set(fp.veiculo_id, set);
      }

      // Normalizar e processar cada posicao. Reordenado por prioridade de
      // verificação de corredor (ver Task 2 do plano de 21/07) -- so muda a
      // ORDEM da iteração, nao materializa novos objetos de posição nem
      // chama normalizar() antecipadamente (evitaria duplicar totalProcessados
      // e outros efeitos colaterais que já acontecem dentro do loop).
      const posicoesComVeiculoId = posicoesRaw.map((raw) => ({
        raw,
        veiculo_id: mapaCv.get(String((raw as Record<string, unknown> | null)?.veicucodigo))?.veiculo_id ?? "",
      }));
      for (const { raw } of posicoesComVeiculoId) {
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

          // Verificar se ficou no mesmo lugar (lat/lng arredondados a 4 casas).
          // Hoisted pra fora do bloco de parado_desde abaixo (Task 5, 28/07)
          // porque o novo acumulador tolerante-a-blip (paradaTolerante*
          // abaixo) tambem precisa desse mesmo sinal, independente da
          // velocidade da leitura atual -- mesma logica exata de antes, so
          // mudou de lugar.
          const mesmoPonto =
            anterior &&
            anterior.lat !== null &&
            anterior.lng !== null &&
            Math.round(anterior.lat * 10000) === Math.round(pos.lat * 10000) &&
            Math.round(anterior.lng * 10000) === Math.round(pos.lng * 10000);

          // Calcular parado_desde
          let parado_desde: string | null = null;
          let paradoMin = 0;

          if (pos.velocidade === 0) {
            const estavParado = anterior && anterior.velocidade === 0;

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
          // Rede de seguranca (decisao da spec): se existe romaneio de HOJE
          // pra esse veiculo, ele vira a fonte da lista/coordenada; o status
          // (feito/pendente) continua vindo da Unitrac (pontosPorPlacaFallback
          // -- normalmente deste ciclo, ou do ultimo fetch bem-sucedido numa
          // falha, ver cacheAlvosFallbackPorCliente acima -- ver
          // montarPontosDeRomaneio). Sem romaneio de hoje pro veiculo, cai no
          // caminho 100% Unitrac de sempre.
          // Achado real 31/07 (cliente Nutry Max): a Central NAO PODE MAIS
          // ser afetada pelo romaneio -- decisao revertida (era 15/07: usar
          // romaneio quando existisse pro veiculo). Motivo: usuario quer o
          // romaneio isolado numa tela/motor proprios, ver
          // docs/superpowers/specs/2026-07-31-central-romaneio-paralela-design.md.
          // pontosVeiculo agora e SEMPRE Unitrac (pontosPorPlacaFallback),
          // igual era antes de 15/07.
          const romaneioDoVeiculo = romaneioPontosPorPlaca.get(pos.placa);
          // pontosPorPlacaFallback (nao pontosPorPlaca direto): quando o
          // fetch de alvos deste ciclo falhou, cai pro ultimo conhecido
          // (ver cacheAlvosFallbackPorCliente acima) em vez de ficar vazio.
          // Beneficia toda a cadeia rio abaixo de uma vez so (desvio
          // comportamental, suspensoPorChegada, foraTapeteStreak,
          // parada_sem_marcacao, e o entregaConfirmada de bypass_entrega,
          // que ate aqui SEMPRE lia false numa falha de fetch -- ver
          // alvoQueSaiu abaixo -- em vez do ultimo status real conhecido).
          const pontosVeiculoBruto = pontosPorPlacaFallback.get(pos.placa);
          // Achado real 10/08 (revisao independente do Task 3, "ativar
          // pontos_aprendidos"): a correcao de posicao aprendida precisa
          // entrar aqui, na origem de pontosVeiculo, e nao so depois no
          // filtro de pendentes -- senao bypass_entrega/alvoNoRaioAgora e a
          // corroboracao D1/D3 do placar (pontosVeiculoParaCorroboracao),
          // que leem pontosVeiculo direto, ficariam com a geometria crua
          // enquanto pendentes usa a corrigida (assimetria "chegou" vs "nao
          // esta no raio" pro mesmo ponto). Corrigindo aqui, tudo que le
          // pontosVeiculo dai pra frente (pendentes incluso) ja herda.
          const pontosAprendidosCliente = mapaPontosAprendidos.get(cliente_id);
          const pontosVeiculo = (pontosVeiculoBruto ?? []).map((pt) =>
            PONTO_APRENDIDO_ATIVO && pt.pontoCodigo != null
              ? corrigirComPontoAprendido(pt, pontosAprendidosCliente?.get(pt.pontoCodigo))
              : pt
          );
          veiculoIdToAlvos.set(veiculo_id, pontosVeiculo ?? []);
          // "Parada no local conta como entregue" (usuario, 01/08): alem do
          // pt.feito da Unitrac, tira da lista de pendentes todo ponto onde
          // este veiculo ja ficou parado o tempo minimo HOJE (ver
          // buscarPresencaEntregaCliente + a gravacao mais abaixo).
          const pendentes = (pontosVeiculo ?? []).filter(
            (pt) =>
              !pt.feito &&
              temCoordenadaValida(pt) &&
              !(
                ENTREGA_PRESENCA_ATIVA &&
                pt.pontoCodigo != null &&
                presencaEntregaCliente.has(`${veiculo_id}:${pt.pontoCodigo}`)
              )
          );
          const temPendentes = pendentes.length > 0;
          // Snapshot throttled de pendentes -- ver declaração do Map acima.
          const ultimoSnapshot = ultimoSnapshotPendentesPorVeiculo.get(veiculo_id) ?? 0;
          if (Date.now() - ultimoSnapshot >= SNAPSHOT_PENDENTES_INTERVALO_MS) {
            ultimoSnapshotPendentesPorVeiculo.set(veiculo_id, Date.now());
            pendentesSnapshotCiclo.push({
              veiculo_id,
              temPendentes,
              alvosApiOk: alvosDestinosDisponiveis,
              pendentes: pendentes.map((pt) => {
                // latBruta/lngBruta (achado real 10/08, Finding 3): busca o
                // ponto correspondente em pontosVeiculoBruto (pre-correcao)
                // por pontoCodigo, pra gravar a posicao crua da Unitrac lado
                // a lado com a ja corrigida -- ver comentario na declaracao
                // de pendentesSnapshotCiclo acima.
                const ptBruto = pontosVeiculoBruto?.find((b) => b.pontoCodigo === pt.pontoCodigo);
                return {
                  lat: pt.lat, lng: pt.lng, raio: pt.raio, codigo: pt.pontoCodigo, nome: pt.nome,
                  latBruta: ptBruto?.lat ?? null,
                  lngBruta: ptBruto?.lng ?? null,
                };
              }),
            });
          }
          // Corroboração D1/D3 do placar (classeViariaSuprimidaPorEntrega):
          // usa TODOS os pontos válidos do dia deste veículo, não só
          // `pendentes`. Achado real 03/08 (caso UBO-5E01, "SENDAS BARRA
          // I"): entregas_presenca marca o ponto como feito ~2min depois do
          // veículo parar (ver acima), tirando-o de `pendentes` -- e D1/D3
          // usavam SO pendentes, então um caminhão que fica 3h+ parado no
          // MESMO local de entrega perde toda corroboração assim que a
          // entrega é marcada feita, mesmo continuando fisicamente no mesmo
          // lugar. Estar parado em cima de um ponto JÁ entregue é prova
          // AINDA MAIS forte de atividade de entrega, não mais fraca --
          // então aqui NÃO filtra feito/presença, só coordenada válida.
          const pontosVeiculoParaCorroboracao = (pontosVeiculo ?? []).filter(temCoordenadaValida);
          const temPontosParaCorroboracao = pontosVeiculoParaCorroboracao.length > 0;
          const distDestinosCorroboracaoM = pontosVeiculoParaCorroboracao.map((pt) =>
            haversineM(pos.lat, pos.lng, pt.lat, pt.lng)
          );
          const centroidesBases = basesCliente
            .map((b) => centroideGeo(b.geom))
            .filter((c): c is { lat: number; lng: number } => c !== null);
          // Mesmas bases, com codigo estavel p/ a cerca virtual (chave de
          // cache + lista de destinos do verificarCorredor) -- ver uso em
          // "CERCA VIRTUAL" abaixo.
          const basesComoDestinoCerca = basesCliente
            .map((b) => {
              const c = centroideGeo(b.geom);
              return c ? { lat: c.lat, lng: c.lng, codigo: `base:${b.nome}` } : null;
            })
            .filter((x): x is { lat: number; lng: number; codigo: string } => x !== null);
          const escalaDoVeiculo = escalaPontosPorPlaca.get(pos.placa) ?? [];
          // codigo (achado real 11/08): identificador estavel por destino,
          // so pra pendentes (unico caso onde o destino pode sumir do
          // conjunto no meio de um streak, por entrega confirmada) -- usado
          // em afastamentoAcumuladoM abaixo pra rastrear o MESMO destino
          // ciclo a ciclo. Bases/escala ficam com codigo null (nao mudam de
          // conjunto no meio de um streak, nao e' o bug que motivou isso).
          const destinos: { lat: number; lng: number; codigo: string | null }[] = [
            ...pendentes.map((pt) => ({
              lat: pt.lat,
              lng: pt.lng,
              codigo: pt.pontoCodigo != null ? `pt:${pt.pontoCodigo}` : null,
            })),
            ...centroidesBases.map((b) => ({ ...b, codigo: null })),
            ...escalaDoVeiculo.map((e) => ({ lat: e.lat, lng: e.lng, codigo: null })),
          ];

          // Achado CRITICO da revisao final de branch (docs/superpowers/plans/2026-08-09-escala-rota.md):
          // destinos de escala (raio ~10km, coordenada aproximada -- centro
          // de cidade) NAO podem contar como "chegada" (chegouEmDestinoConhecido
          // AUTO-RESOLVE alertas ja abertos), nem alimentar o corredor OSRM
          // nem a divergencia de rumo -- so o calculo de afastamento v4
          // (distDestinosM/afastouDeTudo, que continua usando `destinos`
          // completo, incluindo escala) e' o unico consumidor pretendido
          // pra escala, por design (ver Nao-objetivos em
          // docs/superpowers/specs/2026-08-09-escala-rota-design.md).
          // NAO_ESCALA_LEN e' o comprimento do prefixo de `destinos` que
          // exclui escala -- usado em todo consumidor de "chegada"/corredor/
          // rumo abaixo neste bloco.
          const NAO_ESCALA_LEN = pendentes.length + centroidesBases.length;
          const temAnterior = !!anterior && anterior.lat != null && anterior.lng != null;
          const distDestinosM = destinos.map((d) => haversineM(pos.lat, pos.lng, d.lat, d.lng));
          const distDestinosAnteriorM = temAnterior
            ? destinos.map((d) => haversineM(anterior!.lat!, anterior!.lng!, d.lat, d.lng))
            : [];
          const menorDistDestinoM = distDestinosM.length > 0 ? Math.min(...distDestinosM) : null;

          // Guarda anti-teleporte: salto implausível entre ciclos (>2,5km em
          // ~1min, ou seja >150km/h implícitos) congela o streak.
          const saltoImplausivel =
            temAnterior && haversineM(anterior!.lat!, anterior!.lng!, pos.lat, pos.lng) > 2500;

          // Achado real 11/08 (TOS-2B69, falso positivo ao vivo minutos
          // depois do deploy do pct80): veiculo se deslocou 80m dentro do
          // Camada 2 (tapete): sinal PRIMÁRIO, calculado TODO ciclo (não só
          // quando já suspeito) — precisa estar pronto desde o 1º ciclo pra
          // decidir a severidade rápido. celulasTapeteCliente já veio restrita
          // às candidatas deste ciclo (ver pre-passada acima), então isso
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
          if (pos.fresco && contagemTapeteCliente >= TAPETE_MIN_CELULAS) {
            dentroTapete = vizinhanca3x3(pos.lat, pos.lng).some((c) => celulasTapeteCliente.has(c));
          }

          // Alimentar o tapete: células do trajeto desde o ciclo anterior.
          // origem/destino: par O-D da migration 014 (só coleta, ver design)
          // — destino = célula do pendente mais próximo no momento.
          if (pos.fresco && temAnterior && (anterior!.lat !== pos.lat || anterior!.lng !== pos.lng)) {
            let destinoCelula: string | null = null;
            if (pendentes.length > 0) {
              let maisPerto = pendentes[0];
              let menor = haversineM(pos.lat, pos.lng, maisPerto.lat, maisPerto.lng);
              for (const pt of pendentes) {
                const d = haversineM(pos.lat, pos.lng, pt.lat, pt.lng);
                if (d < menor) { menor = d; maisPerto = pt; }
              }
              destinoCelula = celulaDe(maisPerto.lat, maisPerto.lng);
            }
            for (const c of celulasDoSegmento(anterior!.lat!, anterior!.lng!, pos.lat, pos.lng)) {
              celulasCiclo.push({ cliente_id, celula: c, origem: null, destino: destinoCelula });
            }
          }

          // Parada no cliente (Benassi): verificar se o veiculo esta parado
          // dentro do raio de qualquer ponto da rota (feito OU pendente).
          // Nota (revisao independente 29/07, achado Importante): pontosVeiculo
          // agora pode vir do fallback de alvos (cache, ver acima) numa falha
          // da Unitrac -- noCliente passa a reconhecer parada em cliente
          // CONHECIDO mesmo sem fetch fresco. So usa coordenada+raio (ignora
          // feito/pendente), entao staleness aqui e inofensiva; efeito
          // colateral aceito e desejado: outros detectores de parada
          // (parada_longa/parada_anomala/parada_fora_tapete, que hoje
          // dependem de noCliente=false pra disparar) ficam MENOS propensos a
          // falso positivo numa falha de Unitrac, na mesma direcao da
          // diretiva do usuario (FP aceitavel, nunca perder desvio real).
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

          // Suspensao por chegada (achado 25/07): substitui a antiga
          // heuristica de "distancia cancela". Usa o destino mais proximo
          // (menor distDestinosM) + seu raio real.
          // Restrito ao prefixo NAO_ESCALA_LEN de proposito -- ver comentario
          // acima de onde NAO_ESCALA_LEN e' declarado. distDestinosM[idxMaisProximo]
          // mais abaixo continua valido: e' so um slice do prefixo do mesmo array.
          const distDestinosSemEscalaM = distDestinosM.slice(0, NAO_ESCALA_LEN);
          const idxMaisProximo = distDestinosSemEscalaM.length > 0
            ? distDestinosSemEscalaM.indexOf(Math.min(...distDestinosSemEscalaM))
            : -1;
          const raioDestinoMaisProximo = idxMaisProximo >= 0 && pendentes[idxMaisProximo]
            ? pendentes[idxMaisProximo].raio
            : 250; // base nao tem raio proprio -- usa o mesmo default de bases.raio_m
          const emPontoSeguroBruto = riscoPorVeiculo.get(veiculo_id)?.emPontoSeguro ?? false;
          // Achado real 10/08 (varredura completa de regras de desvio, motivada
          // pelos relatos de TTM-7C13/TTH-0G95 no grupo "DESVIO DE ROTA"): sem o
          // `pos.velocidade === 0`, um veiculo em desvio real que so PASSA (em
          // movimento) perto de qualquer um dos ~1.115 postos de gasolina do RJ
          // (geofence estatica, scripts/ingerir-pontos-seguros.mjs, sem relacao com
          // a rota) tinha a checagem de desvio inteira suspensa naquele ciclo. A
          // intencao original (achado 25/07, ver suspenderPorChegada em unitrac.ts)
          // era so nao confundir motorista ABASTECENDO com desvio -- exigir parado
          // preserva essa intencao sem a brecha. Mesmo criterio ja usado em
          // `noCliente` poucas linhas acima. Achado critico da revisao independente
          // 03/08 ja tinha corrigido isso so pro auto-resolve (chegouEmDestinoConhecido,
          // abaixo) -- este e' o mesmo fix pro suspensoPorChegada bruto, que nunca
          // tinha recebido.
          const emPontoSeguro = emPontoSeguroBruto && pos.velocidade === 0;
          const suspensoPorChegada = idxMaisProximo >= 0
            ? suspenderPorChegada(distDestinosM[idxMaisProximo], raioDestinoMaisProximo, emPontoSeguro)
            : emPontoSeguro;

          // Achado CRITICO da revisao independente 03/08 (mesma classe do
          // achado do CEASA-RJ em 27/07): suspensoPorChegada da true tambem
          // quando emPontoSeguro=true (curto-circuito em suspenderPorChegada,
          // unitrac.ts), e emPontoSeguro cobre TODO posto de gasolina do
          // estado do RJ (scripts/ingerir-pontos-seguros.mjs, ~1.115
          // geofences, ~22km2 total) -- nada a ver com destino/base da rota.
          // Verificado com dado real: veiculo SRQ-9F05 se afastou 52km de
          // todos os destinos e teria fechado o alerta sozinho por parar
          // 3min num posto a 124km da base. chegouEmDestinoConhecido e' a
          // MESMA geofence de chegada, mas SEM o curto-circuito de ponto
          // seguro -- so usada pelo auto-resolve por chegada parcial
          // (deveAutoResolverAfastandoChegadaReal), abaixo. suspensoPorChegada
          // (com ponto seguro) continua exatamente como era em todo resto do
          // arquivo -- nao mexe em nenhum outro consumidor.
          const chegouEmDestinoConhecido =
            idxMaisProximo >= 0 &&
            suspenderPorChegada(distDestinosM[idxMaisProximo], raioDestinoMaisProximo, false);

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

          // Candidato a PARADA FORA DO TAPETE: gatilho RAPIDO complementar,
          // achado real 27/07 (caso TTK-4D14) -- ver
          // docs/superpowers/specs/2026-07-27-parada-fora-tapete-e-fix-lat-escalacao-design.md.
          // devAvancarStreaksDesvio (detectores.ts) exige velocidade>0 pra
          // avancar QUALQUER streak de desvio (comportamental, tapete,
          // divergencia de rumo) -- correto e intencional (anti-jitter de
          // GPS parado, achado 10/07), MAS tem como consequencia que um
          // veiculo que desvia e PARA antes de acumular streak>=2 nunca
          // dispara nada por aquela familia inteira de regras.
          // candidatoParadaAnomala (acima) so cobre paradas de 12-89min --
          // uma parada curta (3-10min) ja fora do tapete/rua conhecida cai
          // no buraco: curta demais pra parada suspeita, parada demais pra
          // qualquer streak de movimento. Piso de 3min deliberadamente baixo
          // comparado ao piso de 12min acima -- a condicao extra
          // (dentroTapete===false, que ja exige TAPETE_MIN_CELULAS de
          // cobertura minima confirmada, ver ~linha 1345) e' uma
          // corroboracao espacial forte o bastante pra justificar confirmar
          // mais rapido.
          const candidatoParadaForaTapete =
            pos.fresco &&
            pos.velocidade === 0 &&
            paradoMin >= PARADA_FORA_TAPETE_MIN &&
            dentroTapete === false &&
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
          // POI consultado para parada anomala, saida nao autorizada parada,
          // parada fora do tapete (mesma supressao anti-FP).
          if (candidatoParadaAnomala || candidatoSaidaParado || candidatoParadaForaTapete) {
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
          // raio curto. >= 2 => transito/fila, suprime a parada anomala e a
          // parada fora do tapete (mesmo sinal, mesma supressao, anti-FP).
          let vizinhosParados = 0;
          if (candidatoParadaAnomala || candidatoParadaForaTapete) {
            let dentro = 0;
            for (const q of posicoesFrescasComVelocidade) {
              if (q.velocidade === 0 && haversineM(pos.lat, pos.lng, q.lat, q.lng) <= RAIO_CONGESTION_M) dentro++;
            }
            vizinhosParados = Math.max(0, dentro - 1); // exclui o proprio veiculo
          }
          // Transito inferido pela propria frota (12/07): quantos OUTROS
          // veiculos estao LENTOS (nao parados) por perto -- corrobora
          // congestionamento real em vez de desvio suspeito.
          // Custo O(frota) por veiculo: so vale a pena calcular quando ha de
          // fato um alerta pra reduzir (uso unico, ver reduzirPorTransitoInferido
          // mais abaixo) -- por isso fica adiado pra la em vez de rodar aqui
          // incondicionalmente pra todo veiculo fresco todo ciclo (14/07:
          // era o maior consumidor de CPU do motor no Vercel).
          let vizinhosLentos = 0;

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
            emAreaRiscoCliente: riscoLocal?.emAreaRiscoCliente ?? false,
            fatorHorario: perfilHorario[horaSP] ?? 1,
          });

          // Baseline comportamental por veiculo (Fase 3). velocidade
          // instantanea do ciclo como proxy de "velocidade media da
          // viagem" -- simplificacao de primeira versao, nao ha boundaries
          // de viagem definidos ainda; cada ciclo de 30s vira 1 amostra.
          const tipoViagem = classificarTipoViagem(pos.velocidade);
          const baselineProprio = mapaBaselineVeiculo.get(`${veiculo_id}:${tipoViagem}:velocidade_media_kmh`)
            ?? { n: 0, media: 0, variancia: 0, excluidaDesde: null };
          const baselineFrotaAtual = mapaBaselineFrota.get(`${cliente_id}:${tipoViagem}:velocidade_media_kmh`)
            ?? { n: 0, media: 0, variancia: 0 };
          const alertaBaseline = pos.fresco && pos.velocidade > 0
            ? detectarAnomaliaBaseline({
                velocidadeMediaViagemKmh: pos.velocidade,
                baselineProprio,
                baselineFrota: baselineFrotaAtual,
                minAmostrasProprio: BASELINE_MIN_AMOSTRAS_PROPRIO,
              })
            : null;
          // Achado real 12/07 (autopoluicao confirmada com dado de producao,
          // TTH-6G37: z-score caiu de 14.5 pra 3.5 em 10min na MESMA
          // velocidade): uma leitura sinalizada como anomala neste ciclo NAO
          // entra no baseline -- ele "congela" durante o evento suspeito e
          // volta a incorporar amostras normais assim que a leitura deixar
          // de ser anomala. Sem isso, o evento anomalo sustentado acabava
          // "acostumando" o proprio baseline com ele mesmo.
          //
          // Achado real 28/07: sem teto de tempo, essa mesma protecao trava
          // um baseline que ja ficou estreito demais (variancia ~0) PRA
          // SEMPRE -- toda leitura normal futura passa a parecer anomala e
          // e excluida, entao nada nunca mais entra. Se ja faz
          // BASELINE_EXCLUSAO_MAX_MS que este veiculo/tipo vem sendo
          // excluido, forca a readmissao mesmo que ainda pareca anomalo.
          //
          // Achado IMPORTANTE da revisao independente 28/07: essa exclusao
          // so pode ser aplicada quando a anomalia foi medida contra o
          // baseline PROPRIO do veiculo (n>=20, mesmo limiar de
          // minAmostrasProprio acima) -- uma leitura que parece anomala so
          // contra o fallback da frota (cold start, n<20) nao diz nada
          // sobre autopoluicao do baseline deste veiculo, e a linha dele
          // nem existe ainda em baseline_veiculo (o UPDATE de marcacao
          // afetaria 0 linhas silenciosamente), entao excluir aqui travava
          // o veiculo novo pra sempre. Logica extraida pra
          // decidirAdmissaoBaseline (baseline-veiculo.ts) -- a mais
          // arriscada deste fix, agora testavel isoladamente.
          const chaveBaselineVeiculo = `${veiculo_id}:${tipoViagem}`;
          const usaBaselineProprio = baselineProprio.n >= BASELINE_MIN_AMOSTRAS_PROPRIO;
          const decisaoBaseline = decidirAdmissaoBaseline({
            usaBaselineProprio,
            ehAnomalia: alertaBaseline !== null,
            excluidaDesde: baselineProprio.excluidaDesde,
            agora,
          });
          if (pos.fresco && pos.velocidade > 0 && decisaoBaseline.admitir) {
            amostrasBaselineCiclo.push({ veiculo_id, cliente_id, tipoViagem, velocidade: pos.velocidade });
          } else if (decisaoBaseline.marcarExclusaoAgora) {
            baselineExclusaoCiclo.set(chaveBaselineVeiculo, agora.toISOString());
          }

          // Bypass de entrega sem parar (achado do audio do cliente).
          // Achado da auditoria 11/07: buscar em `pendentes` (filtrado por
          // !feito) fazia o ponto "desaparecer" no exato ciclo em que a
          // Unitrac confirmava a entrega, mesmo com o veiculo ainda parado
          // no mesmo lugar -- lido como "saiu do raio" e podia disparar
          // bypass_entrega justamente numa entrega bem-sucedida. Busca
          // agora em `pontosVeiculo` (sem o filtro), que mantem o mesmo
          // ponto rastreavel independente de feito virar true no meio do
          // dwell, e permite detectarBypassEntrega enxergar a confirmacao
          // de verdade quando o veiculo realmente sai do raio.
          // Achado real 12/07: identificar o alvo por `codigo` (NF) fazia
          // varias NFs pendentes no MESMO ENDERECO resetarem o cronometro
          // de dwell so porque uma NF especifica foi confirmada, mesmo sem
          // o veiculo ter saido fisicamente do lugar. `pontoCodigo` (endereco
          // fisico) e estavel entre NFs diferentes do mesmo ponto.
          // Limitacao residual aceita: dois ENDERECOS FISICAMENTE DIFERENTES
          // com raio sobreposto ainda podem esconder o bypass do mais
          // distante (.find() pega o primeiro que bate) -- caso raro
          // (exigiria dois clientes de entrega a poucos metros um do
          // outro), resolver exigiria checar todos os pontos simultaneamente,
          // complexidade desproporcional pro caso.
          // temCoordenadaValida (achado auditoria 04/08): sem isto, um ponto
          // com lat/lng null vira, por coercao do JS em haversineM, um
          // "destino" a ~5.300km de distancia -- nunca bate <= pt.raio na
          // pratica (nao explorável hoje), mas o filtro estava faltando aqui
          // por inconsistencia com pendentes/pontosVeiculoParaCorroboracao
          // (que ja filtram), nao por decisao consciente.
          const alvoNoRaioAgora = (pontosVeiculo ?? []).find(
            (pt) => temCoordenadaValida(pt) && haversineM(pos.lat, pos.lng, pt.lat, pt.lng) <= pt.raio
          ) ?? null;
          const codigoAnteriorNoRaio = anterior?.no_raio_alvo_codigo ?? null;
          const desdeAnterior = anterior?.no_raio_desde ?? null;
          const dwellAnterior = anterior?.no_raio_dwell_segundos ?? 0;

          const mesmoAlvoQueAntes = alvoNoRaioAgora !== null && alvoNoRaioAgora.pontoCodigo === codigoAnteriorNoRaio;
          const LIMIAR_VELOCIDADE_DWELL_KMH = 5;

          let noRaioAlvoCodigo: number | null = alvoNoRaioAgora?.pontoCodigo ?? null;
          let noRaioDesde: string | null = desdeAnterior;
          let noRaioDwellSegundos = dwellAnterior;

          if (alvoNoRaioAgora === null) {
            // Fora de qualquer raio: zera (o proximo bloco decide se dispara
            // ANTES de zerar, usando os valores capturados acima).
            noRaioAlvoCodigo = null;
            noRaioDesde = null;
            noRaioDwellSegundos = 0;
          } else if (!mesmoAlvoQueAntes) {
            // Entrou num raio novo (ou pela primeira vez).
            noRaioDesde = agora.toISOString();
            noRaioDwellSegundos = pos.velocidade <= LIMIAR_VELOCIDADE_DWELL_KMH ? 30 : 0;
          } else {
            // Continua no mesmo raio: acumula dwell so quando devagar/parado.
            noRaioDwellSegundos = dwellAnterior + (pos.velocidade <= LIMIAR_VELOCIDADE_DWELL_KMH ? 30 : 0);
          }

          // Presenca confirmada por permanencia (romaneio) -- ver
          // docs/superpowers/specs/2026-07-15-presenca-confirmada-romaneio-design.md.
          // Mesmo limiar que ja diferencia "parou de verdade" de "so passou"
          // no bypass_entrega (120s). So se aplica a pontos vindos do
          // romaneio (romaneioDoVeiculo, ja calculado acima nesta mesma
          // iteracao) -- sem romaneio, o motor ja confia direto na
          // coordenada da Unitrac, nao ha o problema de coordenada errada
          // afetando a propria confirmacao. Idempotente na escrita (WHERE
          // presenca_confirmada_em IS NULL no flush) -- pode coletar o
          // mesmo par repetidas vezes sem problema.
          if (romaneioDoVeiculo && romaneioDoVeiculo.length > 0 && alvoNoRaioAgora?.documento && noRaioDwellSegundos >= BYPASS_ENTREGA_DWELL_MINIMO_SEGUNDOS) {
            presencaConfirmadaCiclo.push({ veiculo_id, nf: alvoNoRaioAgora.documento });
          }

          // Parada no local conta como entregue (usuario, 01/08 -- ver
          // ENTREGA_PRESENCA_ATIVA no topo). Diferente do bloco de romaneio
          // acima, este vale pra QUALQUER ponto da Unitrac (com ou sem
          // romaneio) e alimenta a lista de pendentes do proximo ciclo.
          // Idempotente: ON CONFLICT DO NOTHING no flush.
          //
          // Correcao 01/08 (medicao dos pontos de entrega): a versao inicial
          // usava alvoNoRaioAgora, que casa pelo raio NOMINAL do ponto (50m
          // da Unitrac). Medindo os 4.441 pontos geocodificados de 31/07 e
          // 01/08 contra as paradas reais, so 46% tem parada dentro de 100m
          // -- com 50m, a presenca quase nunca dispararia justamente nos
          // casos que ela existe pra resolver (ponto no lugar errado).
          // Agora usa o mesmo piso de RAIO_CHEGADA_MIN_M (300m) da chegada,
          // e o tempo parado vem de paradoMin (relogio geral do veiculo,
          // ja persistido), nao do dwell preso ao raio nominal.
          // alvoNoRaioAgora continua intocado -- bypass_entrega e o dwell
          // dele nao mudam.
          if (ENTREGA_PRESENCA_ATIVA && pos.fresco && pos.velocidade === 0 && paradoMin * 60 >= ENTREGA_PRESENCA_MIN_SEG) {
            for (const pt of pendentes) {
              if (pt.pontoCodigo == null) continue;
              if (presencaEntregaCliente.has(`${veiculo_id}:${pt.pontoCodigo}`)) continue;
              // Achado real 10/08 (revisao final de branch, Finding 4):
              // comparar contra `pt` corrigido tinha risco teorico de loop
              // fechado se o endereco real do cliente mudasse (o gate ficaria
              // preso no aprendido antigo, nunca veria a parada nova). Decisao
              // explicita do usuario no mesmo dia: clientes desta operacao sao
              // fixos, endereco nao muda sozinho -- se mudar, e' aviso manual
              // (nao autocorrecao via Unitrac). Revertido pra usar o ponto
              // CORRIGIDO aqui tambem -- objetivo real da feature era
              // reduzir entregas que ficam sem confirmar por causa da
              // coordenada errada da Unitrac (piso de RAIO_CHEGADA_MIN_M ja
              // existia pra isso, mas nao adianta se o CENTRO do raio ta
              // errado por 100+m).
              const distM = haversineM(pos.lat, pos.lng, pt.lat, pt.lng);
              if (distM <= Math.max(pt.raio, RAIO_CHEGADA_MIN_M)) {
                presencaEntregaCiclo.push({
                  veiculo_id,
                  ponto_codigo: pt.pontoCodigo,
                  parado_seg: paradoMin * 60,
                  // lat/lng/cliente_id (01/08): alimenta o aprendizado do
                  // local real de entrega por acumulo de visitas (migration
                  // 028, pontos_aprendidos) -- SO coleta, nao afeta alerta.
                  lat: pos.lat,
                  lng: pos.lng,
                  cliente_id: cliente.id,
                });
              }
            }
          }

          const saiuDoRaioAgora = codigoAnteriorNoRaio !== null && alvoNoRaioAgora === null;
          const alvoQueSaiu = (pontosVeiculo ?? []).find((pt) => pt.pontoCodigo === codigoAnteriorNoRaio) ?? null;

          // Classe viaria (queda de via principal/intermediaria pra rua
          // estreita) como sinal de CORROBORACAO -- ver
          // docs/superpowers/specs/2026-08-15-classe-viaria-corroboracao-design.md.
          // Classifica a celula atual (vizinhanca 3x3, mesma tolerancia a
          // GPS na beirada da via que o sistema antigo usava) lendo do mapa
          // classePorCelula (batch em lote, 1x por cliente por ciclo --
          // calculado acima, antes deste loop por veiculo; ver comentario
          // la). So classifica quando fresco -- posicao velha nao deve
          // contaminar o estado decaindo. Sem I/O aqui: so dobra
          // melhorClasse sobre as 9 celulas da vizinhanca lendo do Map ja
          // carregado -- por isso classeViaAtual so vira "estreita" quando
          // NENHUMA das 9 celulas tiver via principal/intermediaria (a
          // melhor classe encontrada em qualquer uma das 9 ja venceria);
          // provavel motivo mecanico da taxa de deteccao baixa (~11%)
          // medida pelo script de validacao.
          //
          // Calculado aqui (junto de saiuDoRaioAgora) porque nao depende de
          // estadoDesvioAnterior -- essa variavel so e' declarada mais
          // abaixo (perto da avaliacao de desvio v2). deveMarcarSaidaParadaConfirmada
          // tambem so usa variaveis ja disponiveis neste ponto do ciclo
          // (pos, alvosApiOk, saiuDoRaioAgora, dwellAnterior); a parte que
          // de fato depende de estadoDesvioAnterior (ultimaViaPrincipalAnteriorEm/
          // ultimaViaPrincipalEmNova/saiuParadaConfirmadaEmNova) fica logo
          // apos a declaracao dele, mais abaixo.
          let classeViaAtual: ClasseViaria | null = null;
          if (pos.fresco) {
            for (const cel of vizinhanca3x3(pos.lat, pos.lng)) {
              classeViaAtual = melhorClasse(classeViaAtual, classePorCelula.get(cel) ?? null);
            }
          }

          // Achado real 28/07 (sistema antigo): "confirmada" = parou tempo
          // suficiente pra nao ser so uma passagem -- mesmo limiar que
          // detectarBypassEntrega ja usa (BYPASS_ENTREGA_DWELL_MINIMO_SEGUNDOS).
          const deveMarcarSaidaParadaConfirmada =
            pos.fresco && alvosApiOk && saiuDoRaioAgora && dwellAnterior >= BYPASS_ENTREGA_DWELL_MINIMO_SEGUNDOS;

          // mesmoAlvoCodigo: por construcao deste fluxo, saiuDoRaioAgora so
          // fica true quando NADA e encontrado no raio atual (alvoNoRaioAgora
          // null) -- a unica identidade em jogo no momento da saida e
          // sempre codigoAnteriorNoRaio, entao esta checagem e tautologica
          // aqui (protecao generica da funcao pura contra integracao
          // futura que computasse saiuDoRaioAgora de outra forma).
          const alertaBypass = pos.fresco
            ? detectarBypassEntrega({
                saiuDoRaioAgora,
                mesmoAlvoCodigo: codigoAnteriorNoRaio !== null,
                dwellSegundosAcumulados: dwellAnterior,
                entregaConfirmada: alvoQueSaiu?.feito ?? false,
              })
            : null;

          // Achado real 28/07 (cliente Nutry Max, TTM-7C13/TUS-1A47) -- ver
          // detectarParadaSemMarcacao em detectores.ts. Mesmo padrao EXATO
          // de no_raio_alvo_codigo/no_raio_desde/no_raio_dwell_segundos
          // (bypass_entrega, logo acima), so que pra faixa "perto mas fora
          // do raio" em vez de "dentro do raio".
          //
          // Achados CRITICOS da revisao independente (round 2, apos o
          // redesenho de transicao ja ter corrigido o achado da round 1):
          //
          // C1: inferir "saiu da faixa" so por faixaPertoAgora virar null
          // confundia DOIS eventos opostos -- o veiculo pode ter saido de
          // verdade (afastou), OU pode ter ENTRADO no raio confirmado
          // (chegou de verdade, exatamente o caso de sucesso que este
          // detector existe pra NAO capturar). Fix: so conta como saida se
          // a distancia FISICA atual ao MESMO ponto rastreado excede
          // raio+extra -- entrar no raio (distancia <= raio) nunca conta
          // como saida.
          //
          // C2: se buscarAlvos falhar neste ciclo (alvosApiOk=false),
          // pontosVeiculo/pendentes ficam vazios -- sem gate, TODO veiculo
          // parado ha 8+min num ponto proximo perderia o rastreio de
          // uma vez (faixaPertoAgora vira null por FALTA de dado, nao por
          // ter saido de verdade) e disparava em massa. Mesmo achado ja
          // corrigido nesta sessao pra saiu_parada_confirmada_em
          // (deveMarcarSaidaParadaConfirmada exige alvosApiOk). Fix: sem
          // leitura confiavel de alvos, CONGELA o estado (nao atualiza nem
          // avalia), em vez de resetar.
          //
          // I1: pos.fresco protegia so o alerta, nao o acumulador -- uma
          // posicao travada (sinal perdido, ainda "fresca" por ate 59min)
          // continuava somando dwell pelo relogio de parede. Fix: exige
          // pos.atraso<=5 (leitura recente de verdade, nao so "nao expirou
          // ainda") antes de acumular.
          //
          // emOperacao REMOVIDO (achado da mesma revisao): causava
          // descarte SILENCIOSO de transicoes reais fora do horario
          // (inclusive sabado, que tem rota real pra esta frota,
          // ver sabadoDiurnoComRota abaixo) -- mesmo padrao de
          // bypass_entrega, que tambem nao tem esse gate.
          const leituraAlvosConfiavel = pos.fresco && pos.atraso <= 5 && alvosApiOk;
          const faixaPertoAgora = leituraAlvosConfiavel && alvoNoRaioAgora === null
            ? pendentes.find((pt, i) => {
                const d = distDestinosM[i];
                return d > pt.raio && d <= pt.raio + PARADA_SEM_MARCACAO_RAIO_EXTRA_M;
              }) ?? null
            : null;
          const codigoAnteriorFaixaPerto = anterior?.perto_sem_marcacao_codigo ?? null;
          const dwellFaixaPertoAnterior = anterior?.perto_sem_marcacao_segundos ?? 0;

          // C1: ponto rastreado ANTES deste ciclo (pode ja nao estar mais
          // em pendentes, se foi confirmado -- por isso busca no
          // pontosVeiculo cheio, mesmo padrao de alvoQueSaiu acima).
          const pontoRastreadoAntes = codigoAnteriorFaixaPerto !== null
            ? (pontosVeiculo ?? []).find((pt) => pt.pontoCodigo === codigoAnteriorFaixaPerto) ?? null
            : null;
          const distanciaAoPontoRastreadoM = pontoRastreadoAntes
            ? haversineM(pos.lat, pos.lng, pontoRastreadoAntes.lat, pontoRastreadoAntes.lng)
            : null;
          const saiuDeVerdadeDaFaixa =
            leituraAlvosConfiavel &&
            pontoRastreadoAntes !== null &&
            distanciaAoPontoRastreadoM !== null &&
            distanciaAoPontoRastreadoM > pontoRastreadoAntes.raio + PARADA_SEM_MARCACAO_RAIO_EXTRA_M;

          let pertoSemMarcacaoCodigo: number | null = codigoAnteriorFaixaPerto;
          let pertoSemMarcacaoSegundos = dwellFaixaPertoAnterior;
          if (!leituraAlvosConfiavel) {
            // C2: sem leitura confiavel, congela o estado (nem reseta nem
            // acumula) -- proxima leitura confiavel decide.
          } else if (faixaPertoAgora !== null && faixaPertoAgora.pontoCodigo === codigoAnteriorFaixaPerto) {
            pertoSemMarcacaoCodigo = faixaPertoAgora.pontoCodigo;
            pertoSemMarcacaoSegundos = dwellFaixaPertoAnterior + (pos.velocidade <= LIMIAR_VELOCIDADE_DWELL_KMH ? 30 : 0);
          } else if (faixaPertoAgora !== null) {
            // Entrou na faixa de um ponto NOVO (troca de alvo mais
            // proximo em-faixa) -- comeca contagem nova, nao herda a de
            // outro ponto.
            pertoSemMarcacaoCodigo = faixaPertoAgora.pontoCodigo;
            pertoSemMarcacaoSegundos = pos.velocidade <= LIMIAR_VELOCIDADE_DWELL_KMH ? 30 : 0;
          } else if (saiuDeVerdadeDaFaixa) {
            // Saida FISICA confirmada do ponto rastreado -- zera (o
            // detector abaixo ja capturou dwellFaixaPertoAnterior antes
            // deste reset).
            pertoSemMarcacaoCodigo = null;
            pertoSemMarcacaoSegundos = 0;
          } else if (codigoAnteriorFaixaPerto !== null && pontoRastreadoAntes === null) {
            // Achado IMPORTANTE da revisao independente (round 3): leitura
            // confiavel, mas o ponto rastreado sumiu de pontosVeiculo (rota
            // do dia trocou, veiculo ficou sem rota) -- sem isso, o estado
            // ficava congelado indefinidamente (nenhum branch acima cobre
            // esse caso) e podia disparar DIAS depois com dwell de outro
            // dia, na primeira vez que o MESMO pontoCodigo reaparecesse
            // numa rota futura (cliente recorrente). Descarta sem avaliar
            // -- nao da pra saber se aquela entrega foi confirmada.
            pertoSemMarcacaoCodigo = null;
            pertoSemMarcacaoSegundos = 0;
          }
          // Nenhum dos casos acima (ex: entrou no RAIO CONFIRMADO do ponto
          // rastreado, C1): mantem o estado como estava, sem zerar --
          // "chegou de verdade" nao e' saida, e o detector nao deve
          // disparar (saiuDeVerdadeDaFaixa fica false nesse caso).

          const alvoQueSaiuFaixaPerto = pontoRastreadoAntes;
          const alertaParadaSemMarcacao = leituraAlvosConfiavel
            ? detectarParadaSemMarcacao({
                saiuDaFaixaAgora: saiuDeVerdadeDaFaixa,
                mesmoAlvoCodigo: codigoAnteriorFaixaPerto !== null,
                dwellSegundosAcumulados: dwellFaixaPertoAnterior,
                entregaConfirmada: alvoQueSaiuFaixaPerto?.feito ?? false,
              })
            : null;

          const sabadoDiurnoComRota =
            ehSabadoSP &&
            horaSP >= 6 &&
            horaSP < 20 &&
            pendentes.some((pt) => pt.dataInicio != null && pt.dataInicio.startsWith(dataHojeSP));

          // Achado real 12/07: avaliar() JA incluia detectarJammer(p) como um
          // dos seus proprios candidatos (arbitrados junto com desvio pela
          // mesma arbitrarCandidatos) -- pular avaliar() inteira quando ha
          // jammer impedia esse combo (o de maior confianca segundo a
          // pesquisa) de ser sequer calculado. Bug real 12/07 (achado na
          // auditoria adversarial pre-merge): so trocar avaliar() por
          // "sempre roda" NAO bastava -- route.ts arbitrava o resultado JA
          // ARBITRADO de avaliar() de novo junto com os extras (cerca,
          // bypass, baseline), e quando o mesmo tipo (ex: "desvio", vindo de
          // detectarDesvio aqui E de alertaCerca como extra, fontes
          // diferentes) aparecia nas duas arbitragens em cadeia, o bonus de
          // corroboracao era somado 2x. Fix: montarCandidatosCore() retorna
          // os candidatos CRUS (sem arbitrar); guardamos essa lista e so
          // arbitramos UMA VEZ, mais abaixo, junto com os extras.
          const candidatosCore: Alerta[] = pos.fresco
            ? montarCandidatosCore(pos, {
                  paradoMin,
                  emOperacao,
                  foraDaBase,
                  noCliente,
                  dentroTapete,
                  riscoAreaAtual,
                  temPendentes,
                  entregasTotal: alvosApiOk ? entregas_total : undefined,
                  entregasFeitas: alvosApiOk ? entregas_feitas : undefined,
                  alvosApiOk: alvosDestinosDisponiveis,
                  sabadoDiurnoComRota,
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
            // jammer continua valendo mesmo com atraso > 60min (caso que
            // montarCandidatosCore() nao cobre, ja que so roda com fresco).
            : (alertaJammer ? [alertaJammer] : []);

          // ─── Detector de desvio v2 (spec 2026-08-12-desvio-de-rota-v2-design.md) ──
          // Distancia REAL de rua (nunca linha reta) contra pendentes+base,
          // suspenso perto de chegada (mesmo gate suspensoPorChegada de
          // sempre). Dois sinais independentes: afastando de TODOS os
          // destinos, ou entrando em celula rara no historico da frota (e
          // nao aproximando de nada no mesmo ciclo).
          const estadoDesvioAnterior = desvioEstadoPorVeiculo.get(veiculo_id) ?? {
            afastandoStreak: 0,
            ruaRaraStreak: 0,
          };
          const estadoClasseViariaAnterior = classeViariaEstadoPorVeiculo.get(veiculo_id) ?? {
            ultimaViaPrincipalEm: null,
            saiuParadaConfirmadaEm: null,
          };
          let afastandoStreakNovo = 0;
          let ruaRaraStreakNovo = 0;
          let alertaDesvioV2: Alerta | null = null;

          // Continuacao do bloco de classe viaria (ver comentario acima, perto
          // de saiuDoRaioAgora) -- agora que estadoClasseViariaAnterior existe.
          const ultimaViaPrincipalAnteriorEm = estadoClasseViariaAnterior.ultimaViaPrincipalEm;
          const ultimaViaPrincipalEmNova =
            pos.fresco && classeViaAtual === "principal" ? agora : ultimaViaPrincipalAnteriorEm;
          const saiuParadaConfirmadaEmNova = deveMarcarSaidaParadaConfirmada
            ? agora
            : estadoClasseViariaAnterior.saiuParadaConfirmadaEm;

          // Achado real 12/08 (simulação do dia inteiro): ~40% dos disparos
          // de "afastando de tudo" acontecem a <1,2km de alguma base --
          // manobra de manter/sair do pátio (virar, dar ré, fazer o contorno
          // do quarteirão) produz 2-3 leituras seguidas se afastando de tudo
          // sem ser desvio de verdade. distBaseM já vem calculado acima.
          const emCarenciaDeBase = foraDaBase && distBaseM != null && distBaseM < LIMIAR_CARENCIA_BASE_M;

          // Achado real 13/08 (caso real TTM-7C13, reportado no grupo
          // "DESVIO DE ROTA"): caminhao parado 13min na porta do cliente
          // (no_raio_dwell_segundos=780), entrega confirmada durante a
          // parada -- o ponto SAI da lista de pendentes (`destinos`) nesse
          // exato ciclo, o pendente mais proximo pula pro proximo (689m
          // longe), e o sistema disparou "rua rara"/"afastando" mesmo o
          // veiculo NAO TENDO SE MOVIDO NEM UM METRO. suspensoPorChegada so
          // olha o pendente mais proximo ATUAL -- quando a lista muda sob o
          // veiculo parado, ele "afasta" sem se mexer. Se o veiculo esta
          // parado e no MESMO ponto do ciclo anterior (`mesmoPonto`, ja
          // calculado acima pra parado_desde), qualquer "afastamento" so
          // pode ser artefato da lista de destinos mudando, nunca movimento
          // real -- suspende os 2 sinais nesse caso, independente de
          // suspensoPorChegada (que ja nao cobre mais o pendente que acabou
          // de ser confirmado).
          //
          // Achado real 13/08 (caso TUS-1A47 e TOS-3C21, capturados pelo
          // novo desvio_disparo_log): a condicao original exigia
          // `pos.velocidade === 0`, mas o rastreador de alguns veiculos
          // repete a MESMA posicao (lat/lng identicos, nao so arredondados)
          // por 2-3 leituras seguidas enquanto ainda reporta uma velocidade
          // instantanea diferente de zero (ex: 13km/h, 10km/h) -- artefato
          // do proprio hardware/protocolo de rastreamento, nao movimento
          // real. Nessas leituras, distAtualM bate EXATAMENTE com
          // distAnteriorM pra TODO destino (confirmado no log de disparo),
          // ou seja, aproximandoAlgum sempre da false por posicao repetida,
          // nao por afastamento de verdade -- alimentando rua_rara sem o
          // veiculo ter se movido nem 1m. `mesmoPonto` ja e' a fonte de
          // verdade sobre "a posicao mudou" (independente do campo
          // velocidade, que pode ser ruidoso) -- exigir tambem
          // velocidade===0 so cria um buraco onde o sensor de velocidade
          // discorda da propria posicao GPS. Removido: agora basta a
          // posicao ser identica ao ciclo anterior, sem exigir velocidade
          // exatamente zero -- so' pode suprimir um UNICO ciclo onde a
          // posicao provadamente nao mudou, nunca custa recall de um desvio
          // real (que exige movimento em varios ciclos seguidos).
          const paradoSemSeMover = !!mesmoPonto;

          // Achado real 13/08 (4 casos no mesmo dia: RBG-5G18, TTH-6G37,
          // RQU-2H61, TOS-2B69, todos capturados pelo desvio_disparo_log):
          // em TODOS, o delta de distancia (atual - anterior) era
          // PRATICAMENTE IDENTICO pra TODOS os destinos simultaneamente,
          // mesmo entre destinos a 6,9km e a 287km de distancia um do
          // outro (delta=35m pros dois; noutro caso, delta=98m tanto pro
          // destino a 7,2km quanto pro de 90km). Isso e' matematicamente
          // impossivel pra divergencia real de rota -- movimento real na
          // direcao de destinos diferentes produz deltas DIFERENTES,
          // proporcionais a geometria de cada rota. O padrao bate com
          // ruido de snap-to-road do OSRM: quando o veiculo malmove entre
          // duas leituras (saindo de uma parada, manobrando, GPS com
          // poucos metros de jitter), os dois pontos (anterior/atual)
          // podem colar em nos diferentes da malha viaria local, e essa
          // pequena diferenca de "ultima milha" se propaga quase igual
          // pra TODAS as rotas adiante, porque compartilham o mesmo
          // corredor. Conferido com posicoes_historico: o deslocamento
          // real (haversine) entre as duas leituras nesses casos ficava
          // na faixa de 5-155m -- bem abaixo do que um veiculo em transito
          // real cobre entre leituras (~30s de intervalo). Se o
          // deslocamento real entre a leitura atual e a anterior for
          // pequeno demais pra confiar na distancia de rota do OSRM,
          // suspende a avaliacao desse ciclo -- mesmo raciocinio de
          // paradoSemSeMover, só que tolerante a um pouco de movimento
          // real (nao exige posicao identica). Nao custa recall de desvio
          // real: um veiculo genuinamente se afastando cobre bem mais que
          // isso por leitura, e o streak so' precisa de leituras
          // consecutivas validas, nao de TODAS as leituras.
          const LIMIAR_MOVIMENTO_MINIMO_M = 50;
          const movimentoRealM =
            anterior && anterior.lat != null && anterior.lng != null
              ? haversineM(anterior.lat, anterior.lng, pos.lat, pos.lng)
              : null;
          const movimentoInsignificante = movimentoRealM != null && movimentoRealM < LIMIAR_MOVIMENTO_MINIMO_M;

          // Achado real 13/08 (analise do dia inteiro via desvio_disparo_log):
          // metade dos disparos de "afastando de tudo" tinha pelo menos 1
          // destino a mais de 50km de distancia -- tipicamente a OUTRA base
          // do cliente (ex: Nutry tem base em Penha e em Campos dos
          // Goytacazes, ~300km uma da outra) ou ponto de escala de rota
          // longa. Um destino tao distante quase nunca reflete comportamento
          // LOCAL do motorista: pode disparar por coincidencia (irrelevante)
          // OU, pior, BLOQUEAR uma divergencia local real, porque
          // avaliarAfastandoDeTudo exige que TODOS os destinos divirjam --
          // se a direcao geral do veiculo aproxima de leve da base distante
          // enquanto ele desvia de verdade localmente, o desvio real nunca
          // dispara. Filtra (linha reta, sem custo de OSRM) os destinos
          // acima de 50km ANTES de avaliar o sinal -- so' pra essa avaliacao,
          // nao mexe no `destinos` usado por chegada/corredor/corroboracao.
          const LIMIAR_DESTINO_RELEVANTE_M = 50_000;
          const destinosRelevantes = destinos.filter(
            (d) => haversineM(pos.lat, pos.lng, d.lat, d.lng) <= LIMIAR_DESTINO_RELEVANTE_M
          );

          if (pos.fresco && !suspensoPorChegada && !emCarenciaDeBase && !paradoSemSeMover && !movimentoInsignificante && destinosRelevantes.length > 0) {
            // Achado real 13/08 (4 falsos positivos no mesmo dia com delta de
            // distancia identico entre destinos completamente diferentes -- ver
            // docs/superpowers/specs/2026-08-13-osrm-match-desvio-design.md): /table
            // encaixa cada ponto independentemente na malha viaria, sem contexto de
            // trajeto. Quando ja ha um possivel desvio se formando
            // (afastandoStreak>0), corrige a posicao atual/anterior via /match
            // (Hidden Markov Model sobre os ultimos 5min de trajeto) antes de medir
            // distancia -- so' entra em acao quando ja' ha streak, entao o pior
            // cenario de bug aqui e' atrasar/distorcer um alerta que ja estava se
            // formando, nunca cria um do zero. Piso de confianca calibrado (Task 3,
            // scripts/calibrar-piso-confianca-match.mjs) contra os 4 casos reais de
            // falso positivo do 13/08 (RBG-5G18, TTH-6G37, RQU-2H61, TOS-2B69): 3
            // deles (confidence 0.98/0.81/0.96) ficam acima do piso e usam a posicao
            // corrigida. O 4o (TTH-6G37) veio com confidence=0 exato -- quirk
            // conhecido do algoritmo de confidence do /match do OSRM em trajetos com
            // muitos pontos parados/duplicados na janela (o encaixe geometrico em si
            // era bom, so' a metrica de confianca degenerou pra zero por causa do
            // padrao de pontos parados, nao por match ruim). Decisao consciente:
            // esse caso fica de fora da correcao e continua usando o fallback bruto
            // de sempre, ja protegido por LIMIAR_MOVIMENTO_MINIMO_M acima.
            const LIMIAR_CONFIANCA_MATCH = 0.5;

            let posParaAvaliar = { lat: pos.lat, lng: pos.lng };
            let anteriorParaAvaliar = anterior && anterior.lat != null && anterior.lng != null
              ? { lat: anterior.lat, lng: anterior.lng }
              : null;
            let posicaoFoiCorrigida = false;

            // Achado real 13/08 (revisao final, Importante): a correcao via
            // /match so' pode entrar em acao quando ja' existe um `anterior`
            // BRUTO valido (lido de posicoes_atuais no inicio do ciclo) --
            // senao ela "fabricaria" um anteriorParaAvaliar que na pratica
            // nao deveria existir. O motor trata anterior==null como caso
            // legitimo de "sem dado suficiente ainda" (gates como
            // paradoSemSeMover/movimentoInsignificante acima dependem disso).
            // Sem esta checagem, o bloco de /match poderia rodar so' com a
            // janela do banco + o ponto atual e devolver um "anterior"
            // corrigido mesmo num ciclo em que o motor deveria estar tratando
            // este veiculo como cold-start.
            if (estadoDesvioAnterior.afastandoStreak > 0 && anteriorParaAvaliar !== null && contadorCorrecoesMatch.valor < MAX_CORRECOES_MATCH_POR_CICLO) {
              try {
                const { rows: janelaRecente } = await pool.query<{ lat: number; lng: number; criado_em: Date }>(
                  `SELECT lat, lng, criado_em FROM posicoes_historico
                    WHERE veiculo_id = $1 AND criado_em > now() - interval '5 minutes'
                    ORDER BY criado_em ASC`,
                  [veiculo_id]
                );
                const pontosMatch = janelaRecente.map((p) => ({ lat: p.lat, lng: p.lng, timestamp: p.criado_em }));
                // A leitura fresca deste ciclo (`pos`) so' e' persistida em
                // posicoes_historico/posicoes_atuais no INSERT em lote, DEPOIS que
                // o loop por veiculo termina -- a query acima nunca a enxerga, entao
                // sem isto o /match corrigiria com base em 1-2 ciclos atras,
                // dessincronizado do resto da avaliacao (que usa pos.lat/pos.lng
                // frescos, ex. pra filtrar destinosRelevantes). Adiciona o ponto
                // atual em memoria, usando `agora` (o timestamp de INICIO do
                // processamento deste veiculo neste ciclo) -- NAO e' o mesmo
                // valor que vai parar em posicoes_historico.criado_em: aquela
                // coluna e' DEFAULT now(), calculado pelo Postgres no momento do
                // INSERT em lote (que roda DEPOIS, so' no fim do ciclo inteiro),
                // entao os dois timestamps divergem por segundos a mais.
                pontosMatch.push({ lat: pos.lat, lng: pos.lng, timestamp: agora });
                const corrigido = await corrigirPosicoesComMatch(pontosMatch);
                if (corrigido && corrigido.confidence >= LIMIAR_CONFIANCA_MATCH) {
                  posParaAvaliar = corrigido.atual;
                  anteriorParaAvaliar = corrigido.anterior;
                  posicaoFoiCorrigida = true;
                  contadorCorrecoesMatch.valor += 1;
                }
              } catch (errMatch) {
                // Mesmo padrao defensivo do resto do arquivo (ex. calibracao/
                // desvio_disparo_log acima): um erro aqui (timeout, pool
                // esgotado, blip de rede) nao pode abortar o veiculo INTEIRO --
                // so' significa que a correcao de posicao fica indisponivel
                // neste ciclo, seguindo com o fallback bruto (posParaAvaliar/
                // anteriorParaAvaliar ja inicializados com pos/anterior).
                erros.push(`Aviso: falha ao corrigir posicao via /match pro veiculo ${veiculo_id}: ${String(errMatch)}`);
              }
            }

            const distAtuaisReais = await buscarDistanciasReais(posParaAvaliar, destinosRelevantes);
            const distAnterioresReais =
              anteriorParaAvaliar && distAtuaisReais
                ? await buscarDistanciasReais(anteriorParaAvaliar, destinosRelevantes)
                : null;

            if (distAtuaisReais && distAnterioresReais) {
              const afastando = avaliarAfastandoDeTudo(distAtuaisReais, distAnterioresReais, estadoDesvioAnterior.afastandoStreak);
              afastandoStreakNovo = afastando.streak;

              const celulaAtualDesvio = celulaDe(pos.lat, pos.lng);
              const nVisitasHistorico = celulasFrequenciaCliente.get(celulaAtualDesvio) ?? 0;
              const ruaRara = avaliarRuaRara(nVisitasHistorico, afastando.aproximandoAlgum, estadoDesvioAnterior.ruaRaraStreak);
              ruaRaraStreakNovo = ruaRara.streak;

              // Decisao real 13/08 (pedido explicito do usuario, apos ver o
              // volume de falso positivo do dia): sinal B ("rua rara") DESLIGADO
              // -- so' o sinal A (afastando de tudo) dispara alerta. Continua
              // calculando/gravando o streak (desvio_estado.rua_rara_streak)
              // pra nao perder a serie historica caso volte a ser religado,
              // so' forca disparou=false na hora de montar o alerta.
              alertaDesvioV2 = montarAlertaDesvio(afastando, { ...ruaRara, disparou: false, celula: celulaAtualDesvio, nVisitas: nVisitasHistorico });

              // Achado real 13/08 (pesquisa + auditoria: circuito de
              // aprendizado morto -- ver comentario de getTaxasCalibracaoDesvio
              // acima). Reconecta aqui: pega a taxa de falso positivo
              // calibrada do segmento deste sinal especifico (fallback pro
              // balde generico tipo:desvio se o segmento fino ainda nao tem
              // amostra), e SO' ajusta o score (prioridade exibida) -- nunca
              // decide se o alerta dispara, nunca mexe em streak/limiar.
              if (alertaDesvioV2) {
                try {
                  const taxas = await getTaxasCalibracaoDesvio(pool);
                  const segmento = segmentoCalibracaoPreferido(
                    { tipo: alertaDesvioV2.tipo, origemDesvio: alertaDesvioV2.origemDesvio },
                    null
                  );
                  const taxa = (segmento ? taxas.get(segmento) : undefined) ?? taxas.get(`tipo:${alertaDesvioV2.tipo}`);
                  if (taxa != null) {
                    alertaDesvioV2 = { ...alertaDesvioV2, score: aplicarFatorCalibrado(alertaDesvioV2.score, taxa) };
                  }
                } catch (errCalibracao) {
                  erros.push(`Aviso: falha ao aplicar calibracao de desvio pro veiculo ${veiculo_id}: ${String(errCalibracao)}`);
                }
              }

              // Corredor real via OSRM como sinal de CORROBORACAO (nunca
              // supressao) -- ver
              // docs/superpowers/specs/2026-08-14-desvio-corredor-corroboracao-design.md.
              // So roda quando o alerta ja vai disparar (nunca decide SE
              // dispara), ancorado na posicao de quando o streak atual
              // COMECOU (nunca a posicao atual -- checagem tautologica
              // senao), buscada em posicoes_historico pela janela
              // equivalente ao streak em ciclos de 30s (motor-tick-30s no
              // pg_cron). Qualquer falha (sem ancora, OSRM indisponivel,
              // erro de rede) cai em fail-open silencioso -- sem bonus, o
              // alerta grava do mesmo jeito.
              //
              // Interacao com reduzirPorTransitoInferido (decisao explicita
              // da revisao final 14/08, documentada aqui e nao mudada): o
              // bonus do corredor (+15, aplicado aqui) e o mitigador de
              // transito inferido (-20 com piso 30, aplicado bem mais abaixo
              // sobre `alerta` ja arbitrado) PODEM compor no mesmo alerta.
              // Isso e intencional, nao um bug nao percebido -- os dois
              // sinais respondem perguntas independentes: o corredor
              // responde "esse trajeto bate com alguma rota real conhecida
              // ate os destinos pendentes?", o mitigador de transito
              // responde "tem gente da frota andando devagar perto daqui
              // agora?". Um veiculo pode estar genuinamente fora de
              // qualquer rota conhecida (corredor confirma, +15) E
              // coincidentemente ter vizinhos lentos por perto (transito
              // reduz, -20 com piso 30) -- os dois cenarios nao sao
              // mutuamente exclusivos, entao a composicao aditiva (soma o
              // bonus aqui, na ORIGEM do candidato; reduz depois, na
              // arbitragem final) e o comportamento correto por design.
              let corredorConfirmou = false;
              if (alertaDesvioV2) {
                try {
                  // Achado real da revisao final (14/08): sem teto, o streak
                  // nunca decai a zero enquanto o desvio persiste (so decai
                  // por 1 quando aproxima de algum destino, ver desvio.ts) --
                  // um desvio de horas gerava uma ancora de horas atras,
                  // quase garantindo "fora de rota" por definicao (o veiculo
                  // ja andou tanto que qualquer rota daquele ponto antigo
                  // parece nao bater), nao porque o corredor esteja
                  // discriminando desvio real de falso. Teto de 20 ciclos
                  // (10min) mantem a ancora recente o suficiente pra ainda
                  // ser um sinal de geometria de trajeto, nao so um artefato
                  // do tamanho do streak.
                  const segundosStreak = Math.min(afastandoStreakNovo, 20) * 30;
                  const { rows: ancoraRows } = await pool.query<{ lat: number; lng: number }>(
                    `SELECT lat, lng FROM posicoes_historico
                      WHERE veiculo_id = $1 AND criado_em <= now() - ($2 || ' seconds')::interval
                      ORDER BY criado_em DESC LIMIT 1`,
                    [veiculo_id, String(segundosStreak)]
                  );
                  const ancora = ancoraRows[0];
                  if (ancora) {
                    const { confirmaFora } = await verificarCorredorFora(
                      { lat: ancora.lat, lng: ancora.lng },
                      { lat: pos.lat, lng: pos.lng, velocidade: pos.velocidade },
                      destinosRelevantes
                    );
                    if (confirmaFora) {
                      corredorConfirmou = true;
                      alertaDesvioV2 = aplicarCorroboracaoCorredor(alertaDesvioV2, confirmaFora, BONUS_CORROBORACAO_POR_SINAL);
                    }
                  }
                } catch (errCorredor) {
                  erros.push(`Aviso: falha ao verificar corredor pro veiculo ${veiculo_id}: ${String(errCorredor)}`);
                }
              }

              // Classe viaria como corroboracao (nunca supressao) -- roda
              // no mesmo ponto e com a mesma disciplina do corredor acima:
              // so ajusta score de um alerta que ja existe, fail-open
              // silencioso em qualquer falha.
              //
              // Achado da revisao final da leva de correcao (15/08, Minor
              // x2): (1) o gate de supressao usava
              // estadoDesvioAnterior.saiuParadaConfirmadaEm (valor de 1
              // ciclo ATRAS) em vez de saiuParadaConfirmadaEmNova (valor
              // DESTE ciclo, que ja reflete uma saida de parada confirmada
              // agora mesmo) -- o sistema antigo usava o valor novo; corrigido
              // pra cobrir a supressao desde o ciclo exato da saida, nao so
              // a partir do ciclo seguinte. (2) classeViariaConfirmou
              // re-derivava `quedaDetectada && !saiuParadaRecente`, a MESMA
              // condicao ja dentro de aplicarCorroboracaoClasseViaria --
              // duplicacao que podia divergir se um dos dois mudasse, e
              // escondia a diferenca entre "sem queda" e "teve queda mas foi
              // suprimida por saida de parada recente". Corrigido pra
              // observar o resultado real (score mudou -> a funcao pura
              // decidiu corroborar) em vez de reimplementar a condicao.
              let classeViariaConfirmou = false;
              if (alertaDesvioV2) {
                try {
                  const { quedaDetectada } = avaliarQuedaClasseViaria(classeViaAtual, ultimaViaPrincipalAnteriorEm, agora);
                  const saiuParadaRecente = avaliarSaiuParadaConfirmadaRecentemente(saiuParadaConfirmadaEmNova, agora);
                  // Compara motivo (nao score): aplicarCorroboracaoClasseViaria
                  // sempre concatena o motivo quando corrobora, mesmo quando o
                  // score ja estava no teto de 100 (Math.min) e portanto nao
                  // muda -- comparar score subestimaria a confirmacao nesse caso.
                  const motivoAntes = alertaDesvioV2.motivo;
                  alertaDesvioV2 = aplicarCorroboracaoClasseViaria(
                    alertaDesvioV2,
                    quedaDetectada,
                    saiuParadaRecente,
                    BONUS_CORROBORACAO_POR_SINAL
                  );
                  classeViariaConfirmou = alertaDesvioV2.motivo !== motivoAntes;
                } catch (errClasseViaria) {
                  erros.push(`Aviso: falha ao avaliar classe viaria pro veiculo ${veiculo_id}: ${String(errClasseViaria)}`);
                }
              }

              // Achado real 13/08 (casos TTH-3C94 e RQU-1G17, "falso
              // positivo" reportados no grupo -- ver comentario da migration
              // 045/047_desvio_disparo_log.sql): reconstruir o disparo via
              // posicoes_historico + pendentes_snapshot_log depois do fato
              // nao reproduziu o gatilho real (snapshot e' throttled, perde o
              // ciclo exato). Grava aqui, ATOMICO com a decisao, o snapshot
              // completo que decidiu -- tabela imune a STRIP_PESADO.
              if (alertaDesvioV2) {
                try {
                  await pool.query(
                    `INSERT INTO desvio_disparo_log
                       (veiculo_id, tipo_disparo, destinos, streak_afastando, streak_rua_rara, celula, n_visitas_celula, posicao_corrigida, corredor_confirmou, classe_viaria_confirmou)
                     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)`,
                    [
                      veiculo_id,
                      alertaDesvioV2.origemDesvio,
                      JSON.stringify(
                        destinosRelevantes.map((d, i) => ({
                          codigo: d.codigo,
                          lat: d.lat,
                          lng: d.lng,
                          distAtualM: distAtuaisReais[i],
                          distAnteriorM: distAnterioresReais[i],
                        }))
                      ),
                      afastandoStreakNovo,
                      ruaRara.streak,
                      celulaAtualDesvio,
                      nVisitasHistorico,
                      posicaoFoiCorrigida,
                      corredorConfirmou,
                      classeViariaConfirmou,
                    ]
                  );
                } catch (errDisparoLog) {
                  erros.push(`Aviso: falha ao gravar desvio_disparo_log pro veiculo ${veiculo_id}: ${String(errDisparoLog)}`);
                }
              }
            } else {
              afastandoStreakNovo = estadoDesvioAnterior.afastandoStreak;
              ruaRaraStreakNovo = estadoDesvioAnterior.ruaRaraStreak;
            }
          }
          if (alertaDesvioV2) candidatosCore.push(alertaDesvioV2);

          try {
            await pool.query(
              `INSERT INTO desvio_estado (veiculo_id, afastando_streak, rua_rara_streak, ultima_via_principal_em, saiu_parada_confirmada_em, atualizado_em)
               VALUES ($1, $2, $3, $4, $5, now())
               ON CONFLICT (veiculo_id) DO UPDATE SET
                 afastando_streak = EXCLUDED.afastando_streak,
                 rua_rara_streak = EXCLUDED.rua_rara_streak,
                 -- COALESCE (achado da revisao final, 15/08, Important):
                 -- estas 2 colunas nunca sao INTENCIONALMENTE setadas de
                 -- volta a null pelo JS -- so ficam null quando o app nao
                 -- sabe o valor real (falha de leitura da query de estado
                 -- acima, ou o evento nunca aconteceu pra este veiculo).
                 -- Sobrescrever incondicionalmente com EXCLUDED (como era
                 -- antes) fazia uma falha PONTUAL de leitura da classe
                 -- viaria zerar esse estado da frota inteira no UPSERT
                 -- seguinte -- COALESCE preserva o valor ja gravado quando
                 -- o novo e null, so atualiza quando o evento de fato
                 -- aconteceu neste ciclo.
                 ultima_via_principal_em = COALESCE(EXCLUDED.ultima_via_principal_em, desvio_estado.ultima_via_principal_em),
                 saiu_parada_confirmada_em = COALESCE(EXCLUDED.saiu_parada_confirmada_em, desvio_estado.saiu_parada_confirmada_em),
                 atualizado_em = now()`,
              [veiculo_id, afastandoStreakNovo, ruaRaraStreakNovo, ultimaViaPrincipalEmNova, saiuParadaConfirmadaEmNova]
            );
            if (pos.fresco) {
              const celulaAgoraDesvio = celulaDe(pos.lat, pos.lng);
              await pool.query(
                `INSERT INTO celula_frequencia_cliente (cliente_id, celula, n_visitas, primeira_vez, ultima_vez)
                 VALUES ($1, $2, 1, current_date, current_date)
                 ON CONFLICT (cliente_id, celula) DO UPDATE SET
                   n_visitas = celula_frequencia_cliente.n_visitas + 1,
                   ultima_vez = current_date`,
                [cliente_id, celulaAgoraDesvio]
              );
            }
          } catch (errDesvioV2Gravacao) {
            erros.push(`Aviso: falha ao gravar desvio v2 pro veiculo ${veiculo_id}: ${String(errDesvioV2Gravacao)}`);
          }

          // Decisao intermediaria (so os candidatos core, sem os extras
          // ainda) -- usada pela verificacao de corredor logo abaixo, que
          // precisa saber SE o vencedor atual e um desvio comportamental
          // antes de decidir se suprime ou confirma.
          let alerta: Alerta | null = arbitrarCandidatos(candidatosCore);

          // Novos detectores: retorno_tardio, parada_noturna_ignicao, aceleracao_brusca.
          // Calculados separadamente e sobrepõem alerta principal se mais severos.
          const extras: Alerta[] = [
            detectarRetornoTardio({ entregas_feitas, entregas_total, foraDaBase, paradoMin, emOperacao }),
            detectarParadaNoturnaIgnicaoAtiva(pos, { foraDaBase, noCliente, horaSP }),
            detectarAceleracaoBrusca(pos, {
              velocidadeAnterior: anterior?.velocidade ?? null,
              foraDaBase,
            }),
            alertaBypass,
            alertaBaseline,
            alertaParadaSemMarcacao,
          ].filter((a): a is Alerta => a !== null);

          // Arbitragem FINAL, unica: candidatos core + extras. Ver comentario
          // acima de candidatosCore -- e essa uniao numa unica chamada de
          // arbitrarCandidatos que evita o bug do bonus duplicado.
          alerta = arbitrarCandidatos([...candidatosCore, ...extras]);
          if (alerta) {
            if (pos.fresco) {
              let dentroLento = 0;
              for (const q of posicoesFrescasComVelocidade) {
                if (q.velocidade > 0 && q.velocidade <= 20 && haversineM(pos.lat, pos.lng, q.lat, q.lng) <= RAIO_CONGESTION_M) dentroLento++;
              }
              vizinhosLentos = Math.max(0, dentroLento - (pos.velocidade > 0 && pos.velocidade <= 20 ? 1 : 0));
            }
            alerta = reduzirPorTransitoInferido(alerta, {
              emRodovia: pos.velocidade >= 60,
              vizinhosLentos,
            });
          }

          // Determinar nivel da posicao atual. `alerta` aqui ja reflete
          // qualquer supressao de classe_viaria: essa decisao acontece la
          // atras, na DETECCAO (classeViariaSuprimidaPorEntrega, antes de
          // montarCandidatosCore) -- se suprimido, detectarDesvio ja caiu
          // pro proximo branch ou retornou null, entao nivel/motivo abaixo
          // refletem o resultado real da arbitragem, sem pin fantasma.
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
          // Achado real 10/07 (investigacao de lentidao do ciclo): o geocode
          // reverso rodava AQUI, sequencial, um veiculo por vez (ate 30
          // chamadas de ate 4s cada por ciclo) -- era o maior custo do
          // caminho critico da DETECCAO, sendo que o endereco e so rotulo de
          // exibicao. Agora: cache sincrono aqui (hit = usa na hora); miss =
          // vira null (o upsert usa COALESCE, entao o rotulo ANTERIOR fica na
          // tela) e entra na fila geocodesPendentes, processada em PARALELO
          // depois do upsert de posicoes, fora do caminho da deteccao.
          let localVeiculo: string | null = null;
          if (baseOcupada) {
            localVeiculo = baseOcupada.nome;
          } else if (pos.fresco) {
            const emAlerta = nivel === "vermelho" || nivel === "amarelo";
            if (pos.velocidade === 0 || emAlerta) {
              const emCache = cacheGeocode.get(chaveGeocode(pos.lat, pos.lng));
              if (emCache !== undefined) {
                localVeiculo = emCache;
              } else {
                geocodesPendentes.push({ veiculo_id, lat: pos.lat, lng: pos.lng });
              }
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
            rumo: rumoMovimento !== null ? Math.round(rumoMovimento) : null,
            ultimo_evento: pos.evento,
            no_raio_alvo_codigo: noRaioAlvoCodigo,
            no_raio_desde: noRaioDesde,
            no_raio_dwell_segundos: noRaioDwellSegundos,
            perto_sem_marcacao_codigo: pertoSemMarcacaoCodigo,
            perto_sem_marcacao_segundos: pertoSemMarcacaoSegundos,
          });

          // 6. Gerenciar alertas — para posicoes frescas E para jammers
          // (jammer pode ocorrer com atraso > 60, portanto !fresco, mas e critico)
          const deveGerenciarAlertas = pos.fresco || !!alertaJammer;
          if (!deveGerenciarAlertas) continue;
          if (pos.fresco) totalFrescos++;

          // Alertas EM ABERTO e tipos silenciados — pré-carregados em lote por cliente.
          const alertasAbertos = mapaAlertasAbertos.get(veiculo_id) ?? [];
          const tiposSilenciados = mapaTiposSilenciados.get(veiculo_id) ?? new Set<string>();

          // Anota proximidade atual num alerta de desvio JA ATIVO -- ver
          // achado real 18/07 (analise pedida pelo usuario): desvio nunca
          // fecha sozinho, entao um alerta que disparou longe do destino e
          // o veiculo chegou perto minutos depois fica parecendo "fresco e
          // grave" indefinidamente pro operador, sem nenhuma pista visivel
          // de que ja chegou. So informacao no contexto -- nunca muda
          // nivel/status, nunca fecha o alerta (reusa alvoNoRaioAgora, ja
          // calculado mais acima pro bypass_entrega -- zero custo extra).
          if (alvoNoRaioAgora) {
            for (const d of alertasAbertos.filter((a) => a.tipo === "desvio")) {
              proximidadeDesvioCiclo.push({
                alerta_id: d.id,
                pontoNome: alvoNoRaioAgora.nome,
                dwellSegundos: noRaioDwellSegundos,
              });
            }
          }

          // Anota "rota concluida" num alerta de desvio JA ATIVO -- ver
          // docs/superpowers/specs/2026-07-21-anotacao-rota-concluida-desvio-design.md.
          // Mesma condicao que detectarRetornoTardio ja usa (linha acima na
          // chamada de avaliarAlertasGerais/detectores), so que aqui e so
          // anotacao, nunca gera/fecha alerta.
          if (entregas_total > 0 && entregas_feitas >= entregas_total) {
            for (const d of alertasAbertos.filter((a) => a.tipo === "desvio")) {
              rotaConcluidaCiclo.push({
                alerta_id: d.id,
                entregasFeitas: entregas_feitas,
                entregasTotal: entregas_total,
              });
            }
          }

          // Anota progresso ao destino num alerta "afastando de tudo" JA
          // ATIVO -- ver docs/superpowers/specs/2026-08-06-progresso-destino-desvio-design.md.
          // Mesmo predicado que o auto-resolve ja usa pra saber quais
          // alertas sao "afastando de tudo" -- so anotacao, nunca
          // gera/fecha/muda severidade de alerta.
          //
          // FIX ROUND 1 (achado Important 1, revisao independente 06/08):
          // NAO reusa mais afastamentoAcumuladoM (calculado a partir do
          // desvioInicio volatil em memoria, que zera assim que o veiculo
          // aproxima de forma sustentada -- mentia em 78% dos casos ativos
          // verificados em producao, ver comentario em
          // origemMenorDistDestinoM/detectores.ts). Cada alerta usa sua
          // PROPRIA origem persistida (d.contexto.dist_destinos_m), nao a
          // ancora em memoria do veiculo -- correto mesmo se o alerta for
          // de um episodio de streak anterior ao atual. menorDistDestinoM
          // (posicao ATUAL, ja calculado acima, ~linha 1783) e comum aos
          // alertas deste veiculo neste ciclo.
          //
          // FIX ROUND 1 (achado Important 2, mesma revisao): so anota com
          // posicao confiavel -- sem isso, um teleporte de GPS
          // (saltoImplausivel) ou uma leitura obsoleta (!pos.fresco,
          // alcancavel via jammer) rumo a um destino podia fazer o card
          // mostrar "aproximando" bem na hora de uma anomalia de GPS, a
          // mesma assinatura que o resto do sistema ja trata com
          // desconfianca.
          // Resolucao automatica generica: todos os tipos EXCETO os listados
          // em TIPOS_NAO_GERENCIADOS (favela, desvio, bypass_entrega).
          // Achado real 11/07 (usuario pediu remocao explicita do
          // fechamento automatico de desvio, apos o bug de churn da cerca
          // virtual): desvio e bypass_entrega NUNCA sao resolvidos pelo
          // motor, so por acao manual do operador (Resolver/Falso positivo
          // na UI). bypass_entrega e sinal de seguranca (possivel furto de
          // carga). parada_fora_tapete (achado real 27/07, revisao
          // adversarial, caso TTK-4D14) foi DELIBERADAMENTE deixado FORA
          // desta lista -- ao contrario do design original (que reusava
          // tipo="desvio" e por isso ficava preso aqui por acidente), esse
          // gatilho e' fundamentalmente um sinal de PARADA (mesma familia de
          // parada_anomala, que tambem nunca esteve nesta lista) e deve
          // fechar sozinho quando a condicao deixa de valer.
          const alertasGerenciados = (alertasAbertos ?? []).filter(
            (a) => !TIPOS_NAO_GERENCIADOS.has(a.tipo)
          );

          if (alerta) {
            const alertaExistente = (alertasAbertos ?? []).find((a) => a.tipo === alerta.tipo);
            const jaExiste = alertaExistente !== undefined;
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

              // Achado real 27/07 (investigando um caso real de falso
              // positivo, TTH-0G95): origemDesvio="classe_viaria" dispara
              // no branch de detectarDesvio ANTES de qualquer streak de
              // afastamento existir (so exige !afastandoDeTudo) -- entao
              // desvioInicio normalmente esta null quando ela e' a causa
              // primaria do alerta, e `ehDesvio` (definido so por
              // tipo==="desvio" && desvioInicio!==null) ficava true por
              // coincidencia rara (streak antigo ainda nao zerado) ou false
              // (caso comum). Resultado real: contexto SEMPRE `{}` pra
              // classe_viaria, e o segmento proprio "origem:classe_viaria"
              // (pedido explicito do usuario pra recalibrar-desvio aprender
              // sozinha a taxa de falso positivo desta regra) nunca
              // recebia um unico dado desde que a regra foi criada hoje.
              // Fix: origemClasseViaria tem prioridade sobre ehDesvio pra
              // decidir lat/lng/contexto -- sempre posicao ATUAL (mesma
              // logica de parada_fora_tapete: nao ha "inicio de desvio"
              // por movimento pra essa regra, so classificacao de via
              // ATUAL) e contexto proprio com o segmento de calibracao.
              //
              // Mesmo bug, mesma causa, achado no MESMO dia (27/07) pra
              // origemDesvio="saida_parada" (viradaErradaSaindoDeParada,
              // ver detectores.ts): tambem dispara com 1 leitura so, ANTES
              // de qualquer streak de afastamento (so exige
              // saiuDoRaioAgora + divergencia de rumo alta), entao
              // desvioInicio tambem fica null quando ela e' a causa
              // primaria -- mesmo `{}` silencioso, mesmo segmento proprio
              // ("origem:saida_parada", ja existente em
              // segmentoCalibracaoPreferido) nunca alimentado. Mesmo fix:
              // origemSaidaParada tambem exclui ehDesvio, tambem sempre
              // posicao ATUAL (o ponto exato onde saiu do raio e virou
              // errado, sem "inicio de desvio" por movimento separado).
              const ehParadaForaTapete = alerta.tipo === "parada_fora_tapete";
              const contextoParadaForaTapete = {
                parado_min: paradoMin,
                dentro_tapete: dentroTapete,
                risco_area_atual: riscoAreaAtual,
              };
              // Detector de desvio v2: sempre posicao ATUAL (sem conceito de
              // "inicio do desvio" por movimento -- os 2 sinais novos sao
              // stateless quanto a posicao, so o streak persiste).
              const contextoDesvioV2 = { origem_desvio: alerta.origemDesvio };
              const contextoAlerta = ehParadaForaTapete
                ? contextoParadaForaTapete
                : alerta.tipo === "desvio"
                  ? contextoDesvioV2
                  : {};
              if (!jaExiste) {
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
                  contexto: contextoAlerta,
                  desde: agora.toISOString(),
                });
              } else if (alertaExistente.nivel !== "critico" && alerta.nivel === "critico") {
                // Achado real 22/07 (revisao final de whole-branch, sub-projeto
                // C): o alerta FRACO de desvio (nivel atencao, teto de 300km)
                // nunca fecha sozinho -- sem este escalation, ele bloqueava
                // silenciosamente a insercao de um desvio CRITICO real do
                // mesmo tipo que surgisse depois (jaExiste=true). Agora, se o
                // novo alerta e mais severo que o existente do mesmo tipo,
                // escala a linha existente (preserva id/desde) em vez de
                // descartar o sinal mais grave.
                await supabase
                  .from("alertas")
                  .update({
                    nivel: alerta.nivel,
                    motivo: alerta.motivo,
                    score: alerta.score,
                    contexto: contextoAlerta,
                  })
                  .eq("id", alertaExistente.id);
              }
            }
          } else if (alertasGerenciados.length > 0) {
            // Sem alerta de maior prioridade — resolver os genericos em aberto.
            await supabase
              .from("alertas")
              .update({ status: "resolvido", resolvido_em: agora.toISOString() })
              .in("id", alertasGerenciados.map((a) => a.id));
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
    //
    // Achado real 29/07: pulado inteiro se a leitura no inicio do ciclo
    // falhou (erroLeituraPosAtuais) -- posicoesCiclo foi montado com
    // anterior=undefined pra todo mundo nesse caso (cold-start), e gravar
    // isso de volta apagaria o estado real da frota inteira. Detector ainda
    // roda neste ciclo (com anterior ausente, degradacao aceitavel/pontual);
    // so a ESCRITA que persistiria o dano e' pulada.
    if (!erroLeituraPosAtuais && posicoesCiclo.length > 0) {
      const pgPosicoes = await pool.connect();
      try {
        await pgPosicoes.query(
          `INSERT INTO posicoes_atuais
             (veiculo_id, lat, lng, geom, velocidade, ignicao, atraso_min,
              panico, bau_aberto, nivel, motivo, datagps, parado_desde, updated_at,
              entregas_feitas, entregas_total, local, rumo,
              ultimo_evento, ultimo_evento_em,
              no_raio_alvo_codigo, no_raio_desde, no_raio_dwell_segundos,
              perto_sem_marcacao_codigo, perto_sem_marcacao_segundos)
           SELECT
             c.veiculo_id, c.lat, c.lng,
             ST_SetSRID(ST_MakePoint(c.lng, c.lat), 4326)::geography,
             c.velocidade, c.ignicao, c.atraso_min, c.panico, c.bau_aberto,
             c.nivel, c.motivo, c.datagps::timestamptz, c.parado_desde::timestamptz,
             c.updated_at::timestamptz, c.entregas_feitas, c.entregas_total, c.local,
             c.rumo, c.ultimo_evento, c.updated_at::timestamptz,
             c.no_raio_alvo_codigo,
             c.no_raio_desde::timestamptz, c.no_raio_dwell_segundos,
             c.perto_sem_marcacao_codigo, c.perto_sem_marcacao_segundos
           FROM unnest(
             $1::uuid[], $2::float8[], $3::float8[], $4::float8[], $5::boolean[],
             $6::integer[], $7::boolean[], $8::boolean[], $9::text[], $10::text[],
             $11::text[], $12::text[], $13::text[], $14::integer[], $15::integer[],
             $16::text[], $17::integer[], $18::text[], $19::integer[], $20::text[],
             $21::integer[], $22::integer[], $23::integer[]
           ) AS c(veiculo_id, lat, lng, velocidade, ignicao, atraso_min, panico,
                  bau_aberto, nivel, motivo, datagps, parado_desde, updated_at,
                  entregas_feitas, entregas_total, local, rumo,
                  ultimo_evento, no_raio_alvo_codigo, no_raio_desde,
                  no_raio_dwell_segundos, perto_sem_marcacao_codigo,
                  perto_sem_marcacao_segundos)
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
             rumo             = EXCLUDED.rumo,
             ultimo_evento    = EXCLUDED.ultimo_evento,
             ultimo_evento_em = CASE WHEN EXCLUDED.ultimo_evento IS DISTINCT FROM posicoes_atuais.ultimo_evento
                                  THEN EXCLUDED.ultimo_evento_em ELSE posicoes_atuais.ultimo_evento_em END,
             no_raio_alvo_codigo = EXCLUDED.no_raio_alvo_codigo,
             no_raio_desde       = EXCLUDED.no_raio_desde,
             no_raio_dwell_segundos = EXCLUDED.no_raio_dwell_segundos,
             perto_sem_marcacao_codigo = EXCLUDED.perto_sem_marcacao_codigo,
             perto_sem_marcacao_segundos = EXCLUDED.perto_sem_marcacao_segundos`,
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
            posicoesCiclo.map((p) => p.rumo),
            posicoesCiclo.map((p) => p.ultimo_evento),
            posicoesCiclo.map((p) => p.no_raio_alvo_codigo),
            posicoesCiclo.map((p) => p.no_raio_desde),
            posicoesCiclo.map((p) => p.no_raio_dwell_segundos),
            posicoesCiclo.map((p) => p.perto_sem_marcacao_codigo),
            posicoesCiclo.map((p) => p.perto_sem_marcacao_segundos),
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

    // Historico de posicao -- ver
    // docs/superpowers/specs/2026-07-21-historico-posicao-veiculo-design.md.
    // Reaproveita o MESMO array posicoesCiclo (zero query nova de leitura) --
    // so um INSERT em lote a mais. Nao-critico: mesmo padrao defensivo de
    // cerca_sombra logo abaixo, falha aqui nunca derruba o motor.
    if (posicoesCiclo.length > 0) {
      const pgHistorico = await pool.connect();
      try {
        await pgHistorico.query(
          `INSERT INTO posicoes_historico (veiculo_id, lat, lng, velocidade, ignicao, atraso_min)
           SELECT c.veiculo_id, c.lat, c.lng, c.velocidade, c.ignicao, c.atraso_min
           FROM unnest($1::uuid[], $2::float8[], $3::float8[], $4::integer[], $5::boolean[], $6::integer[])
             AS c(veiculo_id, lat, lng, velocidade, ignicao, atraso_min)`,
          [
            posicoesCiclo.map((p) => p.veiculo_id),
            posicoesCiclo.map((p) => p.lat),
            posicoesCiclo.map((p) => p.lng),
            posicoesCiclo.map((p) => p.velocidade),
            posicoesCiclo.map((p) => p.ignicao),
            posicoesCiclo.map((p) => p.atraso_min),
          ]
        );
      } catch (errHistorico) {
        console.warn(`Aviso: erro ao gravar posicoes_historico em lote: ${String(errHistorico)}`);
      } finally {
        pgHistorico.release();
      }
    }


    // Atualiza baseline_veiculo e baseline_frota incrementalmente (Welford)
    // com as amostras deste ciclo. Roda depois do loop de deteccao, mesmo
    // principio do processamento de geocodesPendentes: nao e critico pra
    // este ciclo, so alimenta a calibracao dos proximos.
    // Achado da auditoria 11/07: o UPSERT sobrescreve com o valor calculado
    // a partir do snapshot lido no INICIO do ciclo, sem reler antes de
    // escrever -- se dois ciclos rodarem sobrepostos pro mesmo veiculo
    // (ja aconteceu antes, ver motor_lease acima), o ultimo a escrever
    // vence e a amostra do outro ciclo se perde (lost update). Aceito por
    // ora: e um sinal estatistico que se autocorrige a cada ciclo novo,
    // nao um valor de seguranca como desvio_streak (que tem o lease).
    if (amostrasBaselineCiclo.length > 0) {
      const porVeiculo = new Map<string, Baseline>();
      const porFrota = new Map<string, Baseline>();
      for (const a of amostrasBaselineCiclo) {
        const chaveVeiculo = `${a.veiculo_id}:${a.tipoViagem}`;
        const atualVeiculo = porVeiculo.get(chaveVeiculo)
          ?? mapaBaselineVeiculo.get(`${chaveVeiculo}:velocidade_media_kmh`)
          ?? { n: 0, media: 0, variancia: 0, excluidaDesde: null };
        porVeiculo.set(chaveVeiculo, atualizarBaselineWelford(atualVeiculo, a.velocidade));

        // baseline_frota usa um teto bem maior (BASELINE_FROTA_N_MAXIMO):
        // acumula ~1 amostra POR VEICULO ATIVO por ciclo (nao 1 por ciclo
        // como baseline_veiculo) -- achado da revisao 28/07, ver
        // BASELINE_FROTA_N_MAXIMO em baseline-veiculo.ts.
        const chaveFrota = `${a.cliente_id}:${a.tipoViagem}`;
        const atualFrota = porFrota.get(chaveFrota)
          ?? mapaBaselineFrota.get(`${chaveFrota}:velocidade_media_kmh`)
          ?? { n: 0, media: 0, variancia: 0 };
        porFrota.set(chaveFrota, atualizarBaselineWelford(atualFrota, a.velocidade, BASELINE_FROTA_N_MAXIMO));
      }

      // Achado CRITICO da revisao independente 28/07: so grava de volta se
      // a leitura correspondente no INICIO do ciclo teve sucesso -- senao
      // porVeiculo/porFrota foram computados a partir de um fallback de
      // cold-start (mapa vazio por causa do erro), e o UPSERT sobrescreveria
      // o historico real de todo mundo com esse estado falso.
      if (!erroLeituraBaselineVeiculo) {
        const resultadosVeiculo = await Promise.allSettled(
          [...porVeiculo].map(([chave, b]) => {
            const [veiculo_id, tipoViagem] = chave.split(":");
            // Amostra admitida neste ciclo -- sempre zera excluida_desde
            // (readmissao normal ou forcada, ver BASELINE_EXCLUSAO_MAX_MS).
            return pool.query(
              `insert into baseline_veiculo (veiculo_id, tipo_viagem, feature, n_amostras, media, variancia, excluida_desde, atualizado_em)
               values ($1, $2, 'velocidade_media_kmh', $3, $4, $5, null, now())
               on conflict (veiculo_id, tipo_viagem, feature)
               do update set n_amostras = $3, media = $4, variancia = $5, excluida_desde = null, atualizado_em = now()`,
              [veiculo_id, tipoViagem, b.n, b.media, b.variancia]
            );
          })
        );
        const falhasVeiculo = resultadosVeiculo.filter((r) => r.status === "rejected").length;
        if (falhasVeiculo > 0) console.warn(`Aviso: ${falhasVeiculo} falha(s) ao gravar baseline_veiculo neste ciclo`);
      }

      // Achado MENOR da revisao independente 28/07 (round 2): gate tambem
      // em erroLeituraBaselineVeiculo, nao so erroLeituraBaselineFrota --
      // se a leitura de baseline_veiculo falhar, mapaBaselineVeiculo fica
      // vazio, TODO veiculo cai no ramo cold-start de decidirAdmissaoBaseline
      // (admite sempre, mesmo leitura anomala), e amostrasBaselineCiclo
      // fica poluido com leituras que deveriam ter sido excluidas -- gravar
      // isso em baseline_frota (mesmo com a leitura DELA ok) desativaria a
      // protecao anti-autopoluicao pra frota inteira enquanto durar o erro.
      if (!erroLeituraBaselineFrota && !erroLeituraBaselineVeiculo) {
        const resultadosFrota = await Promise.allSettled(
          [...porFrota].map(([chave, b]) => {
            const [cliente_id, tipoViagem] = chave.split(":");
            return pool.query(
              `insert into baseline_frota (cliente_id, tipo_viagem, feature, n_amostras, media, variancia, atualizado_em)
               values ($1, $2, 'velocidade_media_kmh', $3, $4, $5, now())
               on conflict (cliente_id, tipo_viagem, feature)
               do update set n_amostras = $3, media = $4, variancia = $5, atualizado_em = now()`,
              [cliente_id, tipoViagem, b.n, b.media, b.variancia]
            );
          })
        );
        const falhasFrota = resultadosFrota.filter((r) => r.status === "rejected").length;
        if (falhasFrota > 0) console.warn(`Aviso: ${falhasFrota} falha(s) ao gravar baseline_frota neste ciclo`);
      }
    }

    // Marca excluida_desde pra veiculo/tipo que NAO tiveram amostra admitida
    // neste ciclo (ver BASELINE_EXCLUSAO_MAX_MS em baseline-veiculo.ts) --
    // separado do bloco acima porque aqui nao ha n_amostras/media/variancia
    // novos pra gravar, so o timestamp de inicio da exclusao. Tambem pulado
    // se a leitura de baseline_veiculo falhou (mesmo motivo do bloco acima:
    // sem leitura confiavel, nao sabemos se ja estava marcado).
    if (!erroLeituraBaselineVeiculo && baselineExclusaoCiclo.size > 0) {
      const resultadosExclusao = await Promise.allSettled(
        [...baselineExclusaoCiclo].map(([chave, valor]) => {
          const [veiculo_id, tipoViagem] = chave.split(":");
          // Achado MENOR da revisao independente 28/07: "and excluida_desde
          // is null" torna "marca so uma vez" atomico a nivel de banco (nao
          // so no snapshot lido no inicio do ciclo) -- protege contra
          // ciclos sobrepostos do motor (ja documentado acima, motor_lease).
          return pool.query(
            `update baseline_veiculo set excluida_desde = $3
             where veiculo_id = $1 and tipo_viagem = $2 and feature = 'velocidade_media_kmh' and excluida_desde is null`,
            [veiculo_id, tipoViagem, valor]
          );
        })
      );
      const falhasExclusao = resultadosExclusao.filter((r) => r.status === "rejected").length;
      if (falhasExclusao > 0) console.warn(`Aviso: ${falhasExclusao} falha(s) ao gravar excluida_desde em baseline_veiculo`);
    }

    // Presenca confirmada por permanencia (romaneio) -- ver
    // docs/superpowers/specs/2026-07-15-presenca-confirmada-romaneio-design.md.
    // Flush em lote (mesmo padrao do baseline acima), dedupe por par
    // veiculo+NF antes de gravar (o mesmo par pode ter sido coletado em
    // varios veiculos/ciclos seguidos enquanto o dwell continua acima do
    // limiar). Idempotente (WHERE presenca_confirmada_em IS NULL).
    if (presencaConfirmadaCiclo.length > 0) {
      const paresUnicos = [...new Map(presencaConfirmadaCiclo.map((p) => [`${p.veiculo_id}:${p.nf}`, p])).values()];
      const resultadosPresenca = await Promise.allSettled(
        paresUnicos.map((p) =>
          pool.query(
            `update romaneio_pontos set presenca_confirmada_em = now()
             where veiculo_id = $1 and nf = $2 and romaneio_data = $3 and presenca_confirmada_em is null`,
            [p.veiculo_id, p.nf, dataHojeSP]
          )
        )
      );
      const falhasPresenca = resultadosPresenca.filter((r) => r.status === "rejected").length;
      if (falhasPresenca > 0) console.warn(`Aviso: ${falhasPresenca} falha(s) ao gravar presenca_confirmada_em neste ciclo`);
    }

    // Parada no local conta como entregue (usuario, 01/08 -- ver
    // ENTREGA_PRESENCA_ATIVA). UM insert multi-row por ciclo, nunca um por
    // veiculo. ON CONFLICT DO NOTHING: a primeira gravacao do dia manda, e
    // ciclos seguintes no mesmo ponto nao fazem nada.
    if (presencaEntregaCiclo.length > 0) {
      const presencaUnica = [
        ...new Map(
          presencaEntregaCiclo.map((p) => [`${p.veiculo_id}:${p.ponto_codigo}`, p])
        ).values(),
      ];
      try {
        await pool.query(
          // $4 = dataHojeSP (ver comentario em buscarPresencaEntregaCliente):
          // current_date do servidor (+02) vira o dia seguinte as 19h de SP.
          // lat/lng/cliente_id (01/08): alimenta pontos_aprendidos (migration
          // 028) -- SO coleta, recalculo noturno via pg_cron, nao afeta
          // alerta nenhum ainda.
          `INSERT INTO entregas_presenca (veiculo_id, ponto_codigo, dia, parado_seg, lat, lng, cliente_id)
           SELECT v, p, $4::date, s, la, ln, c
             FROM unnest($1::uuid[], $2::bigint[], $3::int[], $5::double precision[], $6::double precision[], $7::uuid[])
                  AS t(v, p, s, la, ln, c)
           ON CONFLICT DO NOTHING`,
          [
            presencaUnica.map((p) => p.veiculo_id),
            presencaUnica.map((p) => p.ponto_codigo),
            presencaUnica.map((p) => p.parado_seg),
            dataHojeSP,
            presencaUnica.map((p) => p.lat),
            presencaUnica.map((p) => p.lng),
            presencaUnica.map((p) => p.cliente_id),
          ]
        );
      } catch (e) {
        console.warn(`Aviso: falha ao gravar entregas_presenca neste ciclo: ${String(e)}`);
      }
    }

    // Anotacao de proximidade em alertas de desvio ativos -- ver
    // docs/superpowers/specs/2026-07-18-anotacao-proximidade-desvio-design.md.
    // Flush em lote (mesmo padrao acima), dedupe por alerta_id (o mesmo
    // alerta pode ser coletado 1x por veiculo no ciclo -- na pratica sempre
    // 1, um veiculo so tem 1 desvio ativo por vez, mas o dedupe protege
    // contra qualquer cenario com mais de um). SO ADICIONA campo no
    // contexto (jsonb ||) -- nunca muda nivel/status, nunca fecha o alerta.
    if (proximidadeDesvioCiclo.length > 0) {
      const porAlerta = new Map(proximidadeDesvioCiclo.map((p) => [p.alerta_id, p]));
      const resultadosProximidade = await Promise.allSettled(
        [...porAlerta.values()].map((p) =>
          pool.query(
            `update alertas set contexto = contexto || $2::jsonb where id = $1`,
            [
              p.alerta_id,
              JSON.stringify({
                proximidade_atual: {
                  ponto: p.pontoNome,
                  dwell_segundos: p.dwellSegundos,
                  atualizado_em: new Date().toISOString(),
                },
              }),
            ]
          )
        )
      );
      const falhasProximidade = resultadosProximidade.filter((r) => r.status === "rejected").length;
      if (falhasProximidade > 0) console.warn(`Aviso: ${falhasProximidade} falha(s) ao anotar proximidade de desvio neste ciclo`);
    }

    // Anotacao de "rota concluida" em alertas de desvio ativos -- ver
    // docs/superpowers/specs/2026-07-21-anotacao-rota-concluida-desvio-design.md.
    // Mesmo padrao de flush em lote + dedupe por alerta_id. SO ADICIONA
    // campo no contexto (jsonb ||) -- nunca muda nivel/status, nunca fecha
    // o alerta.
    if (rotaConcluidaCiclo.length > 0) {
      const porAlertaRota = new Map(rotaConcluidaCiclo.map((p) => [p.alerta_id, p]));
      const resultadosRotaConcluida = await Promise.allSettled(
        [...porAlertaRota.values()].map((p) =>
          pool.query(
            `update alertas set contexto = contexto || $2::jsonb where id = $1`,
            [
              p.alerta_id,
              JSON.stringify({
                rota_concluida: {
                  entregas_feitas: p.entregasFeitas,
                  entregas_total: p.entregasTotal,
                  atualizado_em: new Date().toISOString(),
                },
              }),
            ]
          )
        )
      );
      const falhasRotaConcluida = resultadosRotaConcluida.filter((r) => r.status === "rejected").length;
      if (falhasRotaConcluida > 0) console.warn(`Aviso: ${falhasRotaConcluida} falha(s) ao anotar rota concluida neste ciclo`);
    }

    // Flush do snapshot de pendentes -- mesmo padrao de flush em lote,
    // tolerante a falha parcial, dos outros logs de sombra.
    if (pendentesSnapshotCiclo.length > 0) {
      const resultadosSnapshot = await Promise.allSettled(
        pendentesSnapshotCiclo.map((p) =>
          pool.query(
            `insert into pendentes_snapshot_log (veiculo_id, tem_pendentes, alvos_api_ok, pendentes) values ($1, $2, $3, $4::jsonb)`,
            [p.veiculo_id, p.temPendentes, p.alvosApiOk, JSON.stringify(p.pendentes)]
          )
        )
      );
      const falhasSnapshot = resultadosSnapshot.filter((r) => r.status === "rejected").length;
      if (falhasSnapshot > 0) console.warn(`Aviso: ${falhasSnapshot} falha(s) ao gravar snapshot de pendentes neste ciclo`);
    }

    // REMOVIDO (achado real 31/07, cliente Nutry Max): o flush de
    // auto-resolucao de "rua estranha" fechava sozinho, em 1-4min, casos
    // confirmados pelo cliente como desvio REAL (RQV-6C22, TUC-1D15 --
    // motorista sem saber a rota, mesma assinatura de "parou pouco depois,
    // area sem risco" que o desenho original assumia ser sempre falso
    // positivo). Diretiva explicita do usuario: nunca mais fechar sozinho,
    // igual todo outro tipo de desvio ja nao fecha -- ver comentario em
    // detectores.ts. classe_viaria continua disparando normalmente, so o
    // fechamento automatico foi removido.

    // Flush da auto-resolucao retroativa de "afastando-se de todos os
    // destinos" quando rota concluida + chegou na base -- ver
    // Geocodes pendentes (cache-miss do loop): resolvidos AGORA, em paralelo
    // (lotes de 8), fora do caminho critico da deteccao -- ver comentario na
    // fila geocodesPendentes. Mesmo orcamento de sempre (LIMITE_GEOCODES_NOVOS
    // via contadorGeocodesNovos, aplicado dentro de geocodeReverso). O rotulo
    // chega via UPDATE proprio; ate la a tela mostra o rotulo anterior
    // (COALESCE no upsert acima).
    if (geocodesPendentes.length > 0) {
      const TAMANHO_LOTE_GEOCODE = 8;
      const resolvidos: { veiculo_id: string; local: string }[] = [];
      for (let i = 0; i < geocodesPendentes.length; i += TAMANHO_LOTE_GEOCODE) {
        const lote = geocodesPendentes.slice(i, i + TAMANHO_LOTE_GEOCODE);
        const resultados = await Promise.allSettled(
          lote.map((g) => geocodeReverso(g.lat, g.lng, pool, contadorGeocodesNovos, cacheGeocode))
        );
        for (let j = 0; j < lote.length; j++) {
          const r = resultados[j];
          if (r.status === "fulfilled" && r.value) {
            resolvidos.push({ veiculo_id: lote[j].veiculo_id, local: r.value });
          }
        }
        // Orcamento estourou: o resto fica pro proximo ciclo (cache do banco
        // ja vai ter parte deles preenchida pelas chamadas deste lote).
        if (contadorGeocodesNovos.valor >= LIMITE_GEOCODES_NOVOS) break;
      }
      if (resolvidos.length > 0) {
        const pgLocais = await pool.connect();
        try {
          await pgLocais.query(
            `UPDATE posicoes_atuais p
             SET local = c.local
             FROM unnest($1::uuid[], $2::text[]) AS c(veiculo_id, local)
             WHERE p.veiculo_id = c.veiculo_id`,
            [resolvidos.map((r) => r.veiculo_id), resolvidos.map((r) => r.local)]
          );
        } catch (errLocais) {
          console.warn(`Aviso: erro ao atualizar locais geocodados: ${String(errLocais)}`);
        } finally {
          pgLocais.release();
        }
      }
    }

    // Auto-resolução de alertas de rotina para veículos sem comunicação.
    // Quando o veículo para (ignição desligada, atraso > 120min), o loop principal
    // faz `continue` antes de gerenciar alertas — eles ficam presos indefinidamente.
    // Esta query resolve esses alertas para que na próxima operação o beep dispare
    // com UUIDs frescos (e não fique silenciado por IDs antigos).
    //
    // Achado IMPORTANTE da revisao independente 29/07: esta sweep decide
    // "sem comunicacao" lendo atraso_min/ignicao de posicoes_atuais -- se o
    // UPSERT deste ciclo foi pulado (erroLeituraPosAtuais, ver acima), essa
    // leitura fica com dado de ciclo(s) anteriores. bau/tiroteio NAO estao
    // na lista de exclusao abaixo (so favela/jammer/panico/desvio/
    // bypass_entrega/parada_sem_marcacao) -- um veiculo que estava
    // genuinamente offline no snapshot congelado, mas que na verdade voltou
    // a se comunicar durante a janela de falha, podia ter um alerta de bau
    // aberto/tiroteio FRESCO fechado sozinho pela mesma leitura congelada
    // que criou o alerta. Pula a sweep inteira nesse ciclo -- so um
    // ciclo de janitorial atrasado, sem custo real.
    if (!erroLeituraPosAtuais) {
      const pgSemComm = await pool.connect();
      try {
        await pgSemComm.query(`
          UPDATE alertas a
          SET status = 'resolvido', resolvido_em = now()
          FROM posicoes_atuais p
          WHERE a.veiculo_id = p.veiculo_id
            AND a.status = 'ativo'
            -- desvio adicionado 10/07, bypass_entrega adicionado na revisao
            -- final de 22/07: cortar o sinal pode ser um roubo em
            -- andamento, mesmo criterio ja usado pra favela/jammer/panico.
            -- parada_sem_marcacao adicionado 28/07 (mesmo motivo de
            -- bypass_entrega -- ver TIPOS_NAO_GERENCIADOS em detectores.ts).
            AND a.tipo NOT IN ('favela', 'jammer', 'panico', 'desvio', 'bypass_entrega', 'parada_sem_marcacao')
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
          `INSERT INTO corredor_celulas (cliente_id, celula, ultimo_visto, origem_celula, destino_celula)
           SELECT DISTINCT ON (c.cid, c.cel) c.cid::uuid, c.cel, current_date, c.ori, c.des
           FROM unnest($1::uuid[], $2::text[], $3::text[], $4::text[]) AS c(cid, cel, ori, des)
           ORDER BY c.cid, c.cel
           ON CONFLICT (cliente_id, celula) DO UPDATE
             SET ultimo_visto = EXCLUDED.ultimo_visto,
                 origem_celula = COALESCE(EXCLUDED.origem_celula, corredor_celulas.origem_celula),
                 destino_celula = COALESCE(EXCLUDED.destino_celula, corredor_celulas.destino_celula)
             WHERE corredor_celulas.ultimo_visto < EXCLUDED.ultimo_visto`,
          [
            celulasCiclo.map((c) => c.cliente_id),
            celulasCiclo.map((c) => c.celula),
            celulasCiclo.map((c) => c.origem),
            celulasCiclo.map((c) => c.destino),
          ]
        );
      } catch (errCelulas) {
        const msg = `Aviso: erro ao salvar corredor_celulas: ${String(errCelulas)}`;
        console.warn(msg);
        erros.push(msg);
      } finally {
        pgCelulas.release();
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
      .eq("status", "ativo")
      .eq("modo_teste", false);

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
          // desvio removido 10/07: fechava alertas reais so por bater 20h,
          // sem checar comportamento (achado real: 210+ alertas de desvio
          // fechados assim em 5 dias). Desvio agora NUNCA fecha sozinho (nem
          // por horario, nem por comportamento/corredor) -- so por acao
          // manual do operador (achado real 11/07, bug de churn da cerca).
          await pgClean.query(`
            UPDATE alertas SET status='resolvido', resolvido_em=now()
            WHERE status='ativo'
              AND tipo IN ('saida_nao_autorizada','parada_longa','parada_anomala',
                           'parada_cliente','excesso')
              AND created_at < now() - interval '30 minutes'
          `);
        }

        // Campos pesados (geom, lat, lng, contexto) — zeramos logo que resolve;
        // o motor pode ter resolvido sem limpar, então varremos aqui também.
        // 'limpo' incluido na lista (28/07, status novo do botao "Limpar
        // avisos" -- ver acoes-alertas.ts/limparVarios): sem isso essas
        // linhas nunca entrariam nesta varredura de privacidade nem na
        // retencao de 30 dias logo abaixo, ficando pra sempre com
        // geom/lat/lng/contexto completos. E' ortogonal a exclusao de
        // auto_resolvido/auto_expirado logo abaixo -- aquela e' sobre
        // CONTEXTO (marcador de origem automatica dentro de uma linha
        // resolvido/falso_positivo), 'limpo' e' STATUS, passa normalmente
        // assim que resolvido_em for velho o bastante.
        // CORRECAO (revisao independente round 3, 27/07, achado M2): o
        // comentario anterior aqui (round 2) afirmava que o guard `geom IS
        // NOT NULL` protegia contexto.auto_resolvido por efeito colateral --
        // FALSO, provado na revisao round 3: nada neste codebase escreve
        // `geom` em NENHUM alerta hoje (nem o insert normal, nem o flush de
        // auto-resolve -- que desde o achado L5 tambem parou de zerar
        // lat/lng), entao `geom IS NOT NULL` ja bate ZERO linhas em producao
        // -- e' guard morto, nunca foi protecao de verdade. A protecao REAL
        // do marcador auto_resolvido e' outra: contaComoEventoDeSilenciamento
        // e contaComoRotuloHumano (detectores.ts) checam esse campo
        // explicitamente nos dois lugares que importam (silenciamento em
        // motor/route.ts, calibracao em recalibrar-desvio/route.ts), e nada
        // mais neste codebase muta `contexto` de uma linha
        // resolvido/falso_positivo pra apagar o marcador. Como
        // cinto-e-suspensorio (nao so comentario corrigido): a condicao
        // explicita abaixo (`NOT (... ? 'auto_resolvido')` e o par simetrico
        // pra 'auto_expirado', mesmo marcador de "nao e veredito humano" que
        // contaComoRotuloHumano em detectores.ts protege na calibracao)
        // garante que mesmo que um editor futuro "conserte" o guard morto de
        // geom pra bater linhas de verdade, esta varredura ainda assim nunca
        // consegue apagar nenhum dos dois marcadores.
        await pgClean.query(
          `UPDATE alertas
           SET geom = NULL, lat = NULL, lng = NULL, contexto = '{}'
           WHERE status IN ('resolvido', 'falso_positivo', 'limpo')
             AND geom IS NOT NULL
             AND NOT (coalesce(contexto, '{}'::jsonb) ? 'auto_resolvido')
             AND NOT (coalesce(contexto, '{}'::jsonb) ? 'auto_expirado')`
        );
        // Alertas resolvidos > 30 dias: apenas texto necessário para o dashboard.
        // 'limpo' incluido (28/07) pelo mesmo motivo do UPDATE acima -- sem
        // isso essas linhas nunca seriam deletadas pela retencao de 30 dias.
        await pgClean.query(
          `DELETE FROM alertas
           WHERE status IN ('resolvido', 'falso_positivo', 'limpo')
             AND COALESCE(resolvido_em, created_at) < now() - interval '30 days'`
        );
        await pgClean.query(
          `DELETE FROM poi_cache WHERE atualizado_em < now() - interval '7 days'`
        );
        await pgClean.query(
          `DELETE FROM eventos WHERE ts < now() - interval '7 days'`
        );
        // Historico de posicao > 90 dias -- ver
        // docs/superpowers/specs/2026-07-21-historico-posicao-veiculo-design.md.
        await pgClean.query(
          `DELETE FROM posicoes_historico WHERE criado_em < now() - interval '90 days'`
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
    // Libera o lease SO se ainda formos o dono (token confere) -- um ciclo
    // que passou de 90s e perdeu o lease nunca derruba o lease do sucessor.
    try {
      const pgLease = await pool.connect();
      try {
        await pgLease.query(
          `update motor_lease set expira_em = now() where id = 1 and token = $1`,
          [leaseToken]
        );
      } finally {
        pgLease.release();
      }
    } catch { /* lease expira sozinho em 90s */ }
    await pool.end();
  }
}
