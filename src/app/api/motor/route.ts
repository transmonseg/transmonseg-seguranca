// Motor de detecção de alertas — POST /api/motor
// Rota protegida por x-motor-key (MOTOR_SECRET). Nunca use em client.

import pg from "pg";
import { createAdminClient } from "@/lib/supabase/admin";
import { configPoolContabo } from "@/lib/supabase/contabo-ca";
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
  divergenciaRumoMinima,
  divergenciaRumoGraus,
  divergenciaRumoAcimaDoLimiar,
  divergenciaRumoDispara,
} from "@/lib/unitrac";
import type { EntregasPlaca, PontoEntrega } from "@/lib/unitrac";
import {
  montarCandidatosCore,
  detectarJammer,
  afastouDeTudo,
  avancarStreaksDesvio,
  devAvancarStreaksDesvio,
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
  montarContextoDesvio,
  desvioInicioEfetivoParaContexto,
  zerarStreakDaOrigemVencedora,
  reancorarOrigemVencedora,
  razaoRetidaoRumo,
  limiarRazaoRetidaoRumo,
  rumoCoerenteComDestino,
  RUA_ESTRANHA_LIMIAR_RUMO_COERENTE_GRAUS,
  PARADA_FORA_TAPETE_MIN,
  TIPOS_NAO_GERENCIADOS,
  temCoordenadaValida,
  contaComoEventoDeSilenciamento,
  deveAutoResolverAfastandoRotaConcluida,
  elegivelParaAutoResolveAfastando,
  BASE_AREA_MAX_M2_AUTORESOLVE_AFASTANDO,
  saiuParadaConfirmadaHaMenosDe,
  deveMarcarSaidaParadaConfirmada,
  type Alerta,
  type DesvioInicio,
} from "@/lib/detectores";
import { temPOIProximo } from "@/lib/overpass";
import { celulasDoSegmento, vizinhanca3x3, celulaDe } from "@/lib/celulas";
import { melhorClasse } from "@/lib/classificacao-viaria";
import { buscarTiroteiosRJ, obterPerfilHorario } from "@/lib/fogocruzado";
import type { Tiroteio } from "@/lib/fogocruzado";
import { manterSessaoViva } from "@/lib/unitrac-comandos";
import { obterRouboCarga } from "@/lib/roubocarga";
import { verificarCorredor, dentroDoCorredor, bufferPorVelocidade, ordenarPendentesPorDistancia, ordenarPorPrioridadeVerificacao, deveVerificarRecuperacao, paradaLongaInvalidaCache } from "@/lib/corredor-verificacao";
import { atualizarBaselineWelford, classificarTipoViagem, decidirAdmissaoBaseline, BASELINE_FROTA_N_MAXIMO, BASELINE_MIN_AMOSTRAS_PROPRIO, type Baseline } from "@/lib/baseline-veiculo";
import { aplicarFatorCalibrado, segmentoCalibracaoPreferido } from "@/lib/calibracao-desvio";
import {
  atualizarPlacar,
  paradaRecentePertoDeEntrega,
  padraoEntrega,
  destinoAlinhadoAproximando,
  PLACAR_AMARELO,
  PLACAR_AMARELO_DESLIGA,
  PLACAR_VERMELHO,
  S5_ESTAGNADO_MIN,
  type SinaisPlacar,
  type PontoJanela as PontoJanelaPlacar,
  type DestinoPlacar,
} from "@/lib/placar-desvio";

// Estado persistido do placar de desvio (Fase 1, sombra) -- jsonb em
// posicoes_atuais.placar_desvio_estado (migration 024). Ver Task 3 de
// docs/superpowers/plans/2026-08-01-placar-desvio-fase1-plano.md.
// distPorCodigo: dist_m por destino (codigo estavel) do ciclo anterior,
// pra D3 (destinoAlinhadoAproximando) saber se a distancia esta caindo.
// entregasFeitasRef/entregasFeitasDesde: ancora de S5 (dia estagnado).
// amareloAtivo: histerese do limiar amarelo (liga >=40, desliga <25).
type EstadoPlacarDesvio = {
  distPorCodigo: Record<string, number>;
  entregasFeitasRef: number;
  entregasFeitasDesde: string;
  amareloAtivo: boolean;
};

// Código estável do destino pro placar de desvio (chave de
// distPorCodigo/rumoDivergenciaPorDestino, precisa ser consistente entre
// ciclos) -- alvocodigo quando existe, fallback pra coordenada. Mesmo
// padrão já usado pela cerca virtual (ver "codigo estavel p/ a cerca
// virtual" em destinosCerca, mais abaixo no arquivo).
function codigoDestinoPlacar(pt: PontoEntrega): string {
  return String(pt.codigo ?? `${pt.lat},${pt.lng}`);
}

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

// Pontos de entrega vindos do romaneio de HOJE, por cliente -- ver
// docs/superpowers/specs/2026-07-15-romaneio-pontos-entrega-design.md.
// Mesmo padrao de cache do resto do motor (frota, bases): renova a cada 3
// min, nao precisa reconsultar todo ciclo de 30s. Se nao existir romaneio de
// hoje pro veiculo, o motor cai no caminho 100% Unitrac de sempre (rede de
// seguranca, sem regressao de cobertura).
type RomaneioCache = { pontosPorPlaca: Map<string, { nf: string; clienteNome: string; lat: number; lng: number; presencaConfirmadaEm: string | null }[]>; expiraEm: number };
const CACHE_ROMANEIO_MS = 3 * 60_000;
const cacheRomaneioPorCliente = new Map<string, RomaneioCache>();

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

type ContagemFamiliaridadeCache = { contagens: Map<string, number>; expiraEm: number };
const cacheContagemFamiliaridadePorCliente = new Map<string, ContagemFamiliaridadeCache>();

// ─── Verificação por corredor real (ver lib/corredor-verificacao.ts) ────
// REDESENHADA 10/07 apos incidente (ver docs/analise-deteccao.md secao 7.6):
// versao original tracava a rota da POSICAO ATUAL ate o destino e depois
// checava se a posicao atual estava perto dessa mesma rota -- tautologico,
// SEMPRE "dentro" (a rota comeca onde o veiculo esta). Suprimiu quase todo
// desvio real por 11h+ (108 veiculos/332 alertas em 09/07 sem o corredor
// rodando full-day vs so 15 alertas, todos num unico burst de ~3min, em
// 10/07 com o corredor ativo o dia todo). Fix: a rota agora sai de
// desvioInicio (ponto FIXO, ultima posicao confirmada ANTES da suspeita de
// desvio comecar), nunca da posicao atual -- ver verificarCorredor().
const CAMADA_CORREDOR_ATIVA = true;
// ─── Filtro comportamental de rumo-diverge (achado real 30/07) ────────────
// Ver docs/superpowers/specs/2026-07-30-filtro-comportamental-rumo-diverge-design.md.
// SOMBRA (false): so loga contexto.retidao_rumo_sombra, nao muda nada no
// alerta. Depois de alguns dias de dado real confirmando que nenhum
// desvio genuino cai em "veredito_suprimiria: true", vira true (mesmo
// padrao sombra->ativa ja usado por CERCA_VIRTUAL_MODO).
const RUMO_DIVERGE_FILTRO_COMPORTAMENTAL_ATIVO = false;
// SOMBRA (false): so loga contexto.rumo_coerente_sombra, nao muda nada no
// comportamento real ainda. Ver
// docs/superpowers/specs/2026-07-31-classe-viaria-coerencia-rumo-design.md.
const CLASSE_VIARIA_FILTRO_RUMO_ATIVO = false;
// Corredor "vencedor" por veículo: enquanto o veículo seguir dentro dele,
// suprime o desvio SEM novas chamadas de API. ultimoDentro = último ponto
// confirmado dentro (vira o desvio_inicio REAL se ele sair e o alerta
// confirmar — conserta o marcador de início errado reportado pela operação).
// origemTs amarra o cache a UM episodio de desvio (desvioInicio.ts) -- um
// novo episodio (novo desvioInicio) nunca reaproveita a polilinha antiga.
type CorredorCache = {
  polilinha: { lat: number; lng: number }[];
  ultimoDentro: { lat: number; lng: number };
  pendentesChave: string;
  origemTs: string;
  expiraEm: number;
};
const CORREDOR_CACHE_MS = 15 * 60_000;
const cacheCorredorPorVeiculo = new Map<string, CorredorCache>();
// Achado real 22/07 (auditoria): unificado de 2 orcamentos separados
// (CERCA_SEEDS_POR_CICLO=3 + MAX_VERIFICACOES_POR_CICLO=3, ate 7 chamadas
// seriais sem teto coordenado) pra 1 orcamento compartilhado. Pior caso
// cai de ~7,7s pra ~6,6s por ciclo. A ordem do codigo (cerca antes do
// comportamental, por veiculo) NAO protege o comportamental sozinha --
// ela so vale DENTRO de um mesmo veiculo, e a semeadura da cerca roda pra
// MUITOS veiculos por ciclo (warmup da frota inteira, cache expirando a
// cada CERCA_CACHE_MS). Por isso ha reserva explicita (achado real 22/07,
// revisao final de whole-branch): ver RESERVA_COMPORTAMENTAL_POR_CICLO
// logo abaixo, que garante um piso pro comportamental mesmo se a cerca
// consumisse o orcamento inteiro em veiculos anteriores no mesmo ciclo.
const ORCAMENTO_CORREDOR_POR_CICLO = 6;
// Achado real 22/07 (revisao final de whole-branch): sem reserva, a
// semeadura da cerca virtual (que roda pra MUITOS veiculos em cenarios de
// warmup -- frota inteira de manha, ou toda vez que CERCA_CACHE_MS=20min
// expira / pendentes mudam) podia consumir o orcamento compartilhado
// inteiro antes de qualquer veiculo chegar na verificacao comportamental
// no mesmo ciclo -- zerando a garantia que a verificacao comportamental
// tinha antes da unificacao (pote proprio, MAX_VERIFICACOES_POR_CICLO=3).
// Reserva minima: cerca (semeadura+recuperacao juntas) fica limitada a
// ORCAMENTO_CORREDOR_POR_CICLO - RESERVA_COMPORTAMENTAL_POR_CICLO = 4 (o
// mesmo teto que ja tinha antes da unificacao), garantindo que sempre
// sobrem pelo menos 2 pro comportamental.
const RESERVA_COMPORTAMENTAL_POR_CICLO = 2;

// ─── CERCA VIRTUAL de rota (Fase 1 do plano de 10/07) -- ATIVA (11/07) ───
// Achado real 10/07: o gatilho comportamental ("afastar de TODOS os N
// destinos") e geometricamente cego quando o veiculo tem muitas entregas --
// 83% dos alertas de 7 dias dispararam com so 2 destinos restantes, sendo
// que a frota trabalha com mediana de 11. A cerca inverte o sinal primario:
// corredor PROATIVO por veiculo (rota real da posicao atual ate os pendentes
// mais proximos, calculada quando o conjunto de pendentes muda), e a cada
// ciclo uma checagem de geometria pura (zero API). Saiu do corredor: tenta
// recuperar via verificarCorredor (ancora = ultimo ponto DENTRO, nunca a
// posicao atual -- mesma licao do bug tautologico); "fora" confirmado vira
// Alerta de verdade JA na 1a leitura fora (score 75, escala 85 na 2a). Rodou
// em modo sombra 10-11/07, validado com um dia inteiro de operacao real
// (44+ veiculos, 300+ momentos "fora" confirmados) -- ativado 11/07 por
// diretiva explicita do usuario (falso positivo aceitavel, prioridade total
// e nunca perder desvio real). cerca_sombra continua gravando em paralelo
// (auditoria/historico), agora refletindo alerta real, nao mais hipotetico.
const CERCA_VIRTUAL_MODO: "desligada" | "sombra" | "ativa" = "ativa";
// Semeaduras (calculo inicial de corredor) por ciclo -- warmup da frota
// inteira leva alguns ciclos de manha, com o gatilho comportamental cobrindo
// ate la. Compartilha o throttle global de 1 req/s do modulo de corredor.
// (ORCAMENTO_CORREDOR_POR_CICLO unificado, ver acima)
const CERCA_CACHE_MS = 20 * 60_000;
type CercaCache = {
  polilinha: { lat: number; lng: number }[];
  ultimoDentro: { lat: number; lng: number };
  pendentesChave: string;
  calculadoEm: number;
  foraStreak: number;
};
const cacheCercaPorVeiculo = new Map<string, CercaCache>();

// Rotação justa do orçamento de verificação de corredor -- ver
// docs/superpowers/specs/2026-07-21-rotacao-justa-verificacao-corredor-design.md.
// Grava quando cada veículo consumiu por último uma chamada real de
// OSRM/Valhalla (nos dois pontos onde isso acontece: semeadura/recuperação
// da cerca virtual, e confirmação do gatilho comportamental -- ambos
// competem pelo mesmo throttle global de 1 req/s).
const ultimaVerificacaoCorredorPorVeiculo = new Map<string, number>();

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
      .select("veiculo_id, lat, lng, velocidade, parado_desde, desvio_streak, desvio_inicio, ultimo_evento, fora_tapete_streak, divergencia_rumo_streak, divergencia_rumo_inicio, aproximando_streak, origem_celula, no_raio_alvo_codigo, no_raio_desde, no_raio_dwell_segundos, ultima_via_principal_em, saiu_parada_confirmada_em, perto_sem_marcacao_codigo, perto_sem_marcacao_segundos, divergencia_rumo_caminho_m, placar_desvio, placar_desvio_estado");
    if (erroLeituraPosAtuais) {
      const msg = `CRITICO: falha ao ler posicoes_atuais (estado por veiculo perdido neste ciclo, UPSERT sera pulado pra nao gravar cold-start por engano): ${erroLeituraPosAtuais.message}`;
      console.error(msg);
      erros.push(msg);
    }

    const mapaPosAtual = new Map<
      string,
      {
        lat: number | null; lng: number | null; velocidade: number | null;
        parado_desde: string | null; desvio_streak: number; desvio_inicio: DesvioInicio | null;
        ultimo_evento: string | null; fora_tapete_streak: number; divergencia_rumo_streak: number;
        // Achado CRITICO da revisao independente 28/07 (Task 4b): anchor
        // proprio da streak de divergencia de rumo -- mesmo shape/logica de
        // desvio_inicio, ver detalhe no bloco que calcula divergenciaRumoStreak.
        divergencia_rumo_inicio: DesvioInicio | null;
        // Achado real 30/07: acumulador de distancia percorrida durante a
        // streak de divergencia de rumo -- mesmo ciclo de vida de
        // divergencia_rumo_inicio (migration 017). Ver
        // docs/superpowers/specs/2026-07-30-filtro-comportamental-rumo-diverge-design.md.
        divergencia_rumo_caminho_m: number;
        aproximando_streak: number;
        origem_celula: string | null;
        no_raio_alvo_codigo: number | null; no_raio_desde: string | null; no_raio_dwell_segundos: number;
        ultima_via_principal_em: string | null;
        // Achado real 28/07 (Task 6): ver saiuParadaConfirmadaHaMenosDe em
        // lib/detectores.ts -- mesmo padrao de ultima_via_principal_em.
        saiu_parada_confirmada_em: string | null;
        // Achado real 28/07 (cliente Nutry Max, TTM-7C13/TUS-1A47) -- ver
        // detectarParadaSemMarcacao em lib/detectores.ts. Colunas PROPRIAS
        // (migration 016), mesmo padrao de no_raio_alvo_codigo/no_raio_dwell_segundos.
        perto_sem_marcacao_codigo: number | null;
        perto_sem_marcacao_segundos: number;
        // Placar de desvio (Fase 1, sombra) -- mesmo padrao dos streaks
        // acima, ver EstadoPlacarDesvio.
        placar_desvio: number;
        placar_desvio_estado: EstadoPlacarDesvio | null;
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
        fora_tapete_streak: row.fora_tapete_streak ?? 0,
        divergencia_rumo_streak: row.divergencia_rumo_streak ?? 0,
        divergencia_rumo_inicio: (row.divergencia_rumo_inicio as DesvioInicio | null) ?? null,
        divergencia_rumo_caminho_m: row.divergencia_rumo_caminho_m ?? 0,
        aproximando_streak: row.aproximando_streak ?? 0,
        origem_celula: row.origem_celula ?? null,
        no_raio_alvo_codigo: row.no_raio_alvo_codigo ?? null,
        no_raio_desde: row.no_raio_desde ?? null,
        no_raio_dwell_segundos: row.no_raio_dwell_segundos ?? 0,
        ultima_via_principal_em: row.ultima_via_principal_em ?? null,
        saiu_parada_confirmada_em: row.saiu_parada_confirmada_em ?? null,
        perto_sem_marcacao_codigo: row.perto_sem_marcacao_codigo ?? null,
        perto_sem_marcacao_segundos: row.perto_sem_marcacao_segundos ?? 0,
        placar_desvio: row.placar_desvio ?? 0,
        placar_desvio_estado: (row.placar_desvio_estado as EstadoPlacarDesvio | null) ?? null,
      });
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

    // Auto-resolucao retroativa de "afastando-se de todos os destinos"
    // quando a rota foi 100% concluida E o veiculo chegou fisicamente
    // dentro do poligono de uma base cadastrada -- ver
    // docs/superpowers/plans/2026-07-27-auto-resolucao-rota-concluida-plano.md
    // e deveAutoResolverAfastandoRotaConcluida em detectores.ts pro
    // raciocinio completo (achado real 27/07: ~15 dos 91 casos de
    // "afastando de destinos" revisados eram esse padrao). Mesmo padrao de
    // acumulador por ciclo + flush em lote ja usado por rotaConcluidaCiclo
    // acima.
    const afastandoRotaConcluidaAutoResolveCiclo: { alerta_id: string }[] = [];

    // Calibracao ao vivo (12/07): carrega uma vez por ciclo, tabela pequena,
    // mesmo padrao de mapaBaselineVeiculo/Frota acima. So aplica o fator
    // quando o segmento ja tem amostra suficiente (mesma regra de 20 ja
    // usada em baseline_veiculo).
    const { data: calibracaoRows } = await supabase
      .from("calibracao_desvio")
      .select("segmento, n_amostras, taxa_falso_positivo");
    const MIN_AMOSTRAS_CALIBRACAO = 20;
    const mapaCalibracao = new Map<string, number>();
    for (const r of calibracaoRows ?? []) {
      if (r.n_amostras >= MIN_AMOSTRAS_CALIBRACAO) {
        mapaCalibracao.set(r.segmento, r.taxa_falso_positivo);
      }
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

    // Familiaridade por veiculo (Camada 3 do desvio) -- ver
    // docs/superpowers/specs/2026-07-21-familiaridade-veiculo-desvio-design.md.
    // Mesmo dado de celulasDoSegmento que ja alimenta celulasCiclo acima, so
    // que POR VEICULO em vez de por cliente.
    const celulasVeiculoCiclo: { veiculo_id: string; celula: string }[] = [];

    // Orçamento COMPARTILHADO de chamadas ao corredor (OSRM/Valhalla) neste
    // ciclo -- ver ORCAMENTO_CORREDOR_POR_CICLO no topo. Usado tanto pela
    // cerca virtual (semeaduras + recuperacoes) quanto pela verificacao de
    // corredor comportamental (Camada 1).
    let chamadasCorredorNoCiclo = 0;
    const cercaSombraCiclo: {
      veiculo_id: string; cliente_id: string; lat: number; lng: number;
      velocidade: number; veredito: string; pendentes: number; buffer_m: number;
    }[] = [];

    // Achado real 30/07 (Task 7, apos o backtest da Task 6 revelar que o
    // veredito de sombra unico da Task 5 nao discrimina nada): log de serie
    // temporal do sinal comportamental de rumo-diverge, mesmo padrao de
    // cerca_sombra (nao-destrutivo, nunca interfere em nenhum alerta).
    const rumoDivergeSombraCiclo: {
      veiculo_id: string; cliente_id: string; streak: number; caminho_m: number;
      liquido_m: number; razao: number | null; limiar: number;
      dist_min_destino_m: number; veredito_suprimiria: boolean;
    }[] = [];

    // Placar de desvio (Fase 1, SOMBRA) -- ver
    // docs/superpowers/specs/2026-08-01-placar-desvio-design.md e
    // src/lib/placar-desvio.ts. Mesmo padrao nao-destrutivo de
    // cercaSombraCiclo/rumoDivergeSombraCiclo acima: so grava quando
    // placar > 0 (pra nao inflar a tabela com frota parada, decisao
    // explicita da spec), nunca muda nenhum alerta.
    const placarDesvioLogCiclo: {
      veiculo_id: string; placar: number; componentes: Record<string, number | boolean>;
      teria_amarelo: boolean; teria_vermelho: boolean;
    }[] = [];

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
      ultimo_evento: string | null; desvio_inicio: string | null; fora_tapete_streak: number;
      divergencia_rumo_streak: number;
      // Task 4b (revisao independente 28/07): anchor proprio da streak de
      // divergencia de rumo, mesmo shape/serializacao de desvio_inicio.
      divergencia_rumo_inicio: string | null;
      divergencia_rumo_caminho_m: number;
      aproximando_streak: number; origem_celula: string | null;
      no_raio_alvo_codigo: number | null; no_raio_desde: string | null; no_raio_dwell_segundos: number;
      ultima_via_principal_em: string | null;
      // Achado real 28/07 (Task 6): ver saiuParadaConfirmadaHaMenosDe em
      // lib/detectores.ts -- mesmo padrao de ultima_via_principal_em.
      saiu_parada_confirmada_em: string | null;
      // Achado real 28/07 (cliente Nutry Max, TTM-7C13/TUS-1A47) -- ver
      // detectarParadaSemMarcacao em lib/detectores.ts.
      perto_sem_marcacao_codigo: number | null;
      perto_sem_marcacao_segundos: number;
      // Placar de desvio (Fase 1, sombra) -- ver EstadoPlacarDesvio acima.
      // placar_desvio_estado serializado (mesmo padrao de desvio_inicio,
      // JSON.stringify -> coluna jsonb via ::jsonb no INSERT).
      placar_desvio: number;
      placar_desvio_estado: string;
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

    // Classificacao viaria (via principal x rua estreita) -- ver
    // docs/superpowers/specs/2026-07-21-classe-viaria-desvio-design.md.
    // vias_celulas NAO tem coluna de escopo (cliente_id/veiculo_id) --
    // e geografia pura, entao a query e so por celula, sem WHERE de
    // cliente. Reaproveita as MESMAS candidatas de celulasCandidatasTapete
    // (mesma vizinhanca 3x3), nao coleta de novo.
    async function buscarClassesViariasCandidatas(
      candidatas: string[]
    ): Promise<Map<string, string>> {
      if (candidatas.length === 0) return new Map();
      const pgVias = await pool.connect();
      try {
        const { rows } = await pgVias.query<{ celula: string; classe: string }>(
          `SELECT celula, classe FROM vias_celulas WHERE celula = ANY($1::text[])`,
          [candidatas]
        );
        return new Map(rows.map((r) => [r.celula, r.classe]));
      } catch {
        return new Map();
      } finally {
        pgVias.release();
      }
    }

    // Contagem de células distintas por veículo (piso de cold-start da
    // familiaridade, análogo a getContagemTapeteCliente) -- UMA query em
    // lote por cliente por ciclo (todos os veículos do cliente de uma vez),
    // nunca uma query por veículo.
    async function getContagensFamiliaridadeCliente(
      clienteId: string,
      veiculoIds: string[]
    ): Promise<Map<string, number>> {
      const cache = cacheContagemFamiliaridadePorCliente.get(clienteId);
      if (cache && cache.expiraEm > Date.now()) return cache.contagens;
      if (veiculoIds.length === 0) return new Map();
      const pgFamiliaridade = await pool.connect();
      try {
        const { rows } = await pgFamiliaridade.query<{ veiculo_id: string; n: string }>(
          `SELECT veiculo_id, count(*)::bigint AS n FROM corredor_celulas_veiculo WHERE veiculo_id = ANY($1::uuid[]) GROUP BY veiculo_id`,
          [veiculoIds]
        );
        const contagens = new Map(rows.map((r) => [r.veiculo_id, Number(r.n)]));
        cacheContagemFamiliaridadePorCliente.set(clienteId, { contagens, expiraEm: Date.now() + CACHE_TAPETE_MS });
        return contagens;
      } catch {
        return cache?.contagens ?? new Map();
      } finally {
        pgFamiliaridade.release();
      }
    }

    // Células candidatas (vizinhança 3x3) que o PRÓPRIO veículo já visitou
    // -- análogo a buscarCelulasTapeteCandidatas, mas casando (veiculo_id,
    // celula) exato via JOIN, não só a celula isolada. Chave do Set:
    // "${veiculo_id}:${celula}".
    async function buscarCelulasVeiculoCandidatas(
      candidatas: { veiculo_id: string; celula: string }[]
    ): Promise<Set<string>> {
      if (candidatas.length === 0) return new Set();
      const pgFamiliaridade = await pool.connect();
      try {
        const { rows } = await pgFamiliaridade.query<{ veiculo_id: string; celula: string }>(
          `SELECT c.veiculo_id, c.celula
           FROM corredor_celulas_veiculo c
           JOIN unnest($1::uuid[], $2::text[]) AS cand(veiculo_id, celula)
             USING (veiculo_id, celula)`,
          [candidatas.map((c) => c.veiculo_id), candidatas.map((c) => c.celula)]
        );
        return new Set(rows.map((r) => `${r.veiculo_id}:${r.celula}`));
      } catch {
        return new Set();
      } finally {
        pgFamiliaridade.release();
      }
    }

    // Janela de 10min de posicoes_historico pro placar de desvio (D1/D2 --
    // paradaRecentePertoDeEntrega/padraoEntrega, ver placar-desvio.ts) --
    // UMA query batched por CLIENTE (mesmo padrao das funcoes acima:
    // veiculoIdsCliente inteiro, nao filtrado por veiculo individual), nunca
    // uma por veiculo. Sem cache/TTL: a janela desliza a cada ciclo (mesmo
    // motivo de buscarCelulasTapeteCandidatas nao ter TTL).
    async function buscarJanelaHistoricoCliente(
      veiculoIds: string[]
    ): Promise<Map<string, PontoJanelaPlacar[]>> {
      if (veiculoIds.length === 0) return new Map();
      const pgJanela = await pool.connect();
      try {
        const { rows } = await pgJanela.query<{
          veiculo_id: string; lat: number; lng: number; velocidade: number; criado_em: Date;
        }>(
          `SELECT veiculo_id, lat, lng, velocidade, criado_em FROM posicoes_historico
           WHERE veiculo_id = ANY($1::uuid[]) AND criado_em > now() - interval '10 minutes'
           ORDER BY veiculo_id, criado_em ASC`,
          [veiculoIds]
        );
        const porVeiculo = new Map<string, PontoJanelaPlacar[]>();
        for (const r of rows) {
          const lista = porVeiculo.get(r.veiculo_id) ?? [];
          lista.push({ lat: r.lat, lng: r.lng, velocidade: r.velocidade, criadoEm: r.criado_em.toISOString() });
          porVeiculo.set(r.veiculo_id, lista);
        }
        return porVeiculo;
      } catch {
        return new Map();
      } finally {
        pgJanela.release();
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
        // veiculo_id do cliente: mapaCv e global (todos os clientes), filtra
        // pelo mesmo padrao ja usado acima nesse loop pra cvsCliente -- nao
        // existe uma lista "veiculos" local nesse escopo (essa so existe no
        // loop de cima, que so preenche cacheFrotaPorCliente/mapaCv).
        const veiculoIdsDoCliente = [...mapaCv.values()]
          .filter((v) => v.cliente_id === cliente.id)
          .map((v) => v.veiculo_id);
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
      const celulasCandidatasVeiculo: { veiculo_id: string; celula: string }[] = [];
      const chavesCandidatasGeocode = new Set<string>();
      for (const raw of posicoesRaw) {
        try {
          const p = normalizar(raw as Record<string, unknown>);
          if (p.fresco && p.lat != null && p.lng != null) {
            posicoesFrescasComVelocidade.push({ lat: p.lat, lng: p.lng, velocidade: p.velocidade });
            for (const c of vizinhanca3x3(p.lat, p.lng)) celulasCandidatasTapete.add(c);
            const veiculoIdPrepass = mapaCv.get(p.cv)?.veiculo_id;
            if (veiculoIdPrepass) {
              for (const c of vizinhanca3x3(p.lat, p.lng)) {
                celulasCandidatasVeiculo.push({ veiculo_id: veiculoIdPrepass, celula: c });
              }
            }
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
      const contagensFamiliaridadeCliente = await getContagensFamiliaridadeCliente(cliente.id, veiculoIdsCliente);
      const celulasFamiliaridadeVeiculo = await buscarCelulasVeiculoCandidatas(celulasCandidatasVeiculo);
      const classesViariasCliente = await buscarClassesViariasCandidatas([...celulasCandidatasTapete]);
      // Placar de desvio (D1/D2): janela de 10min de TODOS os veiculos do
      // cliente, 1 query batched (ver buscarJanelaHistoricoCliente acima).
      const janelaHistoricoCliente = await buscarJanelaHistoricoCliente(veiculoIdsCliente);
      // Geocode restrito deste ciclo (ver comentario acima de preencherGeocodeCacheCandidatos).
      await preencherGeocodeCacheCandidatos(pool, cacheGeocode, chavesCandidatasGeocode);

      // Batch: carregar alertas do cliente de uma vez (2 queries por ciclo em vez de N por veículo).
      const { data: todosAlertasAbertos } = await supabase
        .from("alertas")
        .select("id, tipo, veiculo_id, nivel, motivo, status")
        .eq("cliente_id", cliente.id)
        .in("status", ["ativo", "reconhecido"]);

      const mapaAlertasAbertos = new Map<string, { id: string; tipo: string; nivel: string; motivo: string; status: string }[]>();
      for (const ab of todosAlertasAbertos ?? []) {
        const lista = mapaAlertasAbertos.get(ab.veiculo_id) ?? [];
        lista.push({ id: ab.id, tipo: ab.tipo, nivel: ab.nivel, motivo: ab.motivo, status: ab.status });
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
      const posicoesOrdenadas = ordenarPorPrioridadeVerificacao(posicoesComVeiculoId, ultimaVerificacaoCorredorPorVeiculo);

      for (const { raw } of posicoesOrdenadas) {
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

          // Origem pro par O-D do tapete (migration 014, so coleta): celula
          // da ultima parada de 5+ min. Persistida em posicoes_atuais.
          // origem_celula; carrega a anterior enquanto nao houver parada nova.
          let origemCelula: string | null = anterior?.origem_celula ?? null;
          if (pos.velocidade === 0 && paradoMin >= 5) {
            origemCelula = celulaDe(pos.lat, pos.lng);
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
          const pontosVeiculo = pontosPorPlacaFallback.get(pos.placa);
          veiculoIdToAlvos.set(veiculo_id, pontosVeiculo ?? []);
          const pendentes = (pontosVeiculo ?? []).filter((pt) => !pt.feito && temCoordenadaValida(pt));
          const temPendentes = pendentes.length > 0;
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

          // Guarda anti-teleporte: salto implausível entre ciclos (>2,5km em
          // ~1min, ou seja >150km/h implícitos) congela o streak.
          const saltoImplausivel =
            temAnterior && haversineM(anterior!.lat!, anterior!.lng!, pos.lat, pos.lng) > 2500;

          // Extraído pra variável (achado Task 3 do placar de desvio,
          // 01/08): função pura, mesmos argumentos nos 3 pontos que já a
          // chamavam (streak de afastamento logo abaixo, streak de
          // fora-do-tapete, e a checagem de classe_viaria mais abaixo) — só
          // reaproveita o mesmo cálculo, não muda nenhum deles. Também
          // alimenta S1 do placar (ver bloco "Placar de desvio" mais
          // abaixo), sem recalcular de novo.
          const afastandoDeTudoAtual = afastouDeTudo(distDestinosM, distDestinosAnteriorM);

          let desvioStreak: number = anterior?.desvio_streak ?? 0;
          let desvioInicio: DesvioInicio | null = anterior?.desvio_inicio ?? null;
          // aproximandoStreak: ciclos consecutivos aproximando (sem afastar
          // de tudo) — usado pra HISTERESE do streak (avancarStreaksDesvio: 1
          // aproximação isolada congela a suspeita em vez de apagar, 2 zeram
          // — mata a detecção tardia em estrada de serra onde a linha reta
          // oscila). Achado real 11/07 (TUL-1C38 e o bug de churn da cerca):
          // NAO resolve mais alerta nenhum sozinho -- ver comentário no bloco
          // de gerenciamento de alertas mais abaixo.
          let aproximandoStreak: number = anterior?.aproximando_streak ?? 0;
          // Reaproveitado tambem pelo streak de divergencia de rumo mais
          // abaixo (achado revisao final 25/07) -- mesmo guard contra GPS
          // congelado (POSICAO_CONGELADA_M), uma unica chamada.
          const podeAvancarStreaksDesvio = devAvancarStreaksDesvio({
            fresco: pos.fresco,
            saltoImplausivel,
            distanciaAoAnteriorM: temAnterior ? haversineM(anterior!.lat!, anterior!.lng!, pos.lat, pos.lng) : null,
            velocidade: pos.velocidade,
          });
          // Achado da revisao independente 29/07 (fallback de alvos acima):
          // sem o gate extra, uma falha SUSTENTADA (>30min, cache expirado)
          // degrada destinos pra bases-only e o streak avancava/zerava com
          // geometria de "afastando so das bases" -- lixo geometrico que
          // podia poluir a streak e disparar desvio bogus assim que o
          // proximo fetch bem-sucedido reabrisse o gate de detectarDesvio.
          // Congela em vez de avancar quando nao ha dado confiavel (live ou
          // fallback de cache), mesmo espirito de leituraAlvosConfiavel.
          if (podeAvancarStreaksDesvio && alvosDestinosDisponiveis) {
            const r = avancarStreaksDesvio(
              afastandoDeTudoAtual,
              { desvioStreak, aproximandoStreak }
            );
            if (r.desvioStreak === 1 && desvioStreak === 0) {
              desvioInicio = {
                lat: anterior!.lat!,
                lng: anterior!.lng!,
                ts: agora.toISOString(),
                menor_dist_m: distDestinosAnteriorM.length > 0 ? Math.min(...distDestinosAnteriorM) : 0,
              };
            }
            if (r.zerou) desvioInicio = null;
            desvioStreak = r.desvioStreak;
            aproximandoStreak = r.aproximandoStreak;
          }
          const afastamentoAcumuladoM =
            desvioInicio && menorDistDestinoM !== null
              ? menorDistDestinoM - desvioInicio.menor_dist_m
              : 0;

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

          // Familiaridade PESSOAL do veiculo com a area atual -- ver
          // docs/superpowers/specs/2026-07-21-familiaridade-veiculo-desvio-design.md.
          // Piso bem menor que TAPETE_MIN_CELULAS (300, por FROTA): por ser
          // por veiculo unico, 30 celulas distintas ja e cobertura razoavel
          // (ajustavel depois com dado real, mesmo espirito de todo outro
          // limiar deste arquivo).
          const FAMILIARIDADE_MIN_CELULAS = 30;
          let familiarVeiculo: boolean | null = null;
          const contagemFamiliaridadeVeiculo = contagensFamiliaridadeCliente.get(veiculo_id) ?? 0;
          if (pos.fresco && contagemFamiliaridadeVeiculo >= FAMILIARIDADE_MIN_CELULAS) {
            familiarVeiculo = vizinhanca3x3(pos.lat, pos.lng).some((c) =>
              celulasFamiliaridadeVeiculo.has(`${veiculo_id}:${c}`)
            );
          }

          // Classificacao viaria (via principal x rua estreita) -- ver
          // docs/superpowers/specs/2026-07-21-classe-viaria-desvio-design.md.
          // classeViaAtual = melhor classe entre as 9 celulas da vizinhanca
          // 3x3 da posicao atual (null = nenhuma celula mapeada ali).
          let classeViaAtual: string | null = null;
          if (pos.fresco) {
            for (const c of vizinhanca3x3(pos.lat, pos.lng)) {
              const classe = classesViariasCliente.get(c);
              if (classe) {
                classeViaAtual = melhorClasse(
                  classeViaAtual as "principal" | "intermediaria" | "estreita" | null,
                  classe as "principal" | "intermediaria" | "estreita"
                );
              }
            }
          }

          // Estado persistido: quando foi a ultima vez visto numa via
          // principal. Decai naturalmente pela checagem de janela abaixo
          // (JANELA_QUEDA_CLASSE_MIN), sem precisar resetar explicitamente.
          const ultimaViaPrincipalAnterior = anterior?.ultima_via_principal_em ?? null;
          const ultimaViaPrincipalEm =
            pos.fresco && classeViaAtual === "principal" ? agora.toISOString() : ultimaViaPrincipalAnterior;

          const JANELA_QUEDA_CLASSE_MIN = 10;
          const quedaClasseViaria =
            classeViaAtual === "estreita" &&
            ultimaViaPrincipalAnterior !== null &&
            agora.getTime() - new Date(ultimaViaPrincipalAnterior).getTime() <= JANELA_QUEDA_CLASSE_MIN * 60_000;

          // Streak de "aproximando mas fora do tapete" — Camada 3 do desvio
          // (ver detectarDesvio em detectores.ts). So incrementa com
          // cobertura minima confirmada (mesmo piso do dentroTapete acima) —
          // sem tapete confiavel ainda, fica 0 (nunca dispara por cold-start,
          // mesma protecao de sempre).
          let foraTapeteStreak: number = anterior?.fora_tapete_streak ?? 0;
          // alvosDestinosDisponiveis: mesmo achado da revisao 29/07 acima
          // (desvioStreak) -- sem isso, falha sustentada de alvos degrada
          // distDestinosM pra bases-only e polui esta streak tambem.
          if (pos.fresco && !saltoImplausivel && alvosDestinosDisponiveis && contagemTapeteCliente >= TAPETE_MIN_CELULAS) {
            if (!afastandoDeTudoAtual && dentroTapete === false) {
              foraTapeteStreak += 1;
            } else {
              foraTapeteStreak = 0;
            }
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
              celulasCiclo.push({ cliente_id, celula: c, origem: origemCelula, destino: destinoCelula });
              celulasVeiculoCiclo.push({ veiculo_id, celula: c });
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
          const idxMaisProximo = distDestinosM.length > 0
            ? distDestinosM.indexOf(Math.min(...distDestinosM))
            : -1;
          const raioDestinoMaisProximo = idxMaisProximo >= 0 && pendentes[idxMaisProximo]
            ? pendentes[idxMaisProximo].raio
            : 250; // base nao tem raio proprio -- usa o mesmo default de bases.raio_m
          const emPontoSeguro = riscoPorVeiculo.get(veiculo_id)?.emPontoSeguro ?? false;
          const suspensoPorChegada = idxMaisProximo >= 0
            ? suspenderPorChegada(distDestinosM[idxMaisProximo], raioDestinoMaisProximo, emPontoSeguro)
            : emPontoSeguro;

          // Divergencia de rumo (achado 25/07): compara rumoMovimento (ja
          // calculado acima) contra o rumo esperado ate o destino mais
          // proximo. Streak persistido igual foraTapeteStreak.
          //
          // Achado revisao final 25/07: precisa do mesmo guard contra GPS
          // congelado que devAvancarStreaksDesvio ja da pro streak de desvio
          // (podeAvancarStreaksDesvio acima) -- sem ele, posicao congelada
          // entre ciclos com pos.fresco ainda true faz rumoGraus(anterior,
          // atual) com anterior===atual retornar 0 (atan2(0,0), norte fixo),
          // uma divergencia fabricada que pode passar do limiar e disparar
          // "atencao" falso a cada 2 ciclos parados.
          let divergenciaRumoStreak: number = anterior?.divergencia_rumo_streak ?? 0;
          // Achado CRITICO da revisao independente 28/07 (Task 4b): anchor
          // PROPRIO da streak de divergencia de rumo, espelhando EXATAMENTE
          // o padrao ja usado por desvioInicio/desvioStreak acima (mesmo
          // shape DesvioInicio, mesma logica de setar na transicao 0->1 e
          // limpar quando a streak zera). Sem isto, a Task 4 (ligar
          // verificarCorredor em rumo-diverge) era wiring MORTO no caso
          // exato que a motivou: rumo-diverge disparando SEM nenhum episodio
          // de "afastando de tudo" antes (desvioInicio null) -- justamente o
          // padrao rodovia-com-curva (TTK-4D14) que a Task 4 existe pra
          // cobrir -- porque o gate de verificarCorredor exigia desvioInicio
          // nao-nulo, e esse so pertence a streak de afastando-de-tudo.
          let divergenciaRumoInicio: DesvioInicio | null = anterior?.divergencia_rumo_inicio ?? null;
          let divergenciaRumoCaminhoM: number = anterior?.divergencia_rumo_caminho_m ?? 0;
          // Achado real 26/07 (Fase 2): valor CRU do ciclo atual (nao
          // acumulado em streak), exposto pra viradaErradaSaindoDeParada
          // poder decidir com 1 leitura so -- reaproveita o MESMO calculo
          // (e os mesmos guards: fresco, saltoImplausivel, suspensoPorChegada,
          // podeAvancarStreaksDesvio) ja usado pro streak geral, sem duplicar
          // a chamada de divergenciaRumoMinima.
          let divergenciaGrausAtual: number | null = null;
          // alvosDestinosDisponiveis: mesmo achado da revisao 29/07 acima --
          // sem isso, `destinos` pode ser so uma base (falha sustentada,
          // cache expirado), fabricando divergencia de rumo contra um alvo
          // que nao e o real.
          if (pos.fresco && !saltoImplausivel && !suspensoPorChegada && podeAvancarStreaksDesvio && alvosDestinosDisponiveis && destinos.length > 0) {
            // Achado real 31/07-01/08: compara contra TODOS os destinos
            // (nao so destinos[idxMaisProximo]) -- ver comentario de
            // divergenciaRumoMinima em unitrac.ts.
            const divergencia = divergenciaRumoMinima(
              anterior?.lat ?? pos.lat, anterior?.lng ?? pos.lng, pos.lat, pos.lng,
              destinos,
              pos.velocidade
            );
            divergenciaGrausAtual = divergencia;
            if (divergenciaRumoAcimaDoLimiar(divergencia)) {
              const streakAnteriorDivergencia = divergenciaRumoStreak;
              divergenciaRumoStreak += 1;
              // Achado real 30/07: acumula a distancia percorrida NESTE ciclo --
              // na transicao 0->1 (mesmo ciclo que ancora divergenciaRumoInicio em
              // anterior!), o "caminho" comeca do zero com o segmento
              // anterior->atual (nao soma em cima de um valor de um episodio
              // ANTERIOR ja encerrado); em ciclos seguintes da MESMA streak,
              // continua somando.
              const segmentoM = haversineM(anterior!.lat!, anterior!.lng!, pos.lat, pos.lng);
              divergenciaRumoCaminhoM = streakAnteriorDivergencia === 0 ? segmentoM : divergenciaRumoCaminhoM + segmentoM;
              // Transicao 0->1: mesma logica do desvioInicio acima (anterior!
              // seguro aqui -- podeAvancarStreaksDesvio so e true quando ha
              // ciclo anterior, ver devAvancarStreaksDesvio).
              if (streakAnteriorDivergencia === 0) {
                divergenciaRumoInicio = {
                  lat: anterior!.lat!,
                  lng: anterior!.lng!,
                  ts: agora.toISOString(),
                  menor_dist_m: distDestinosAnteriorM.length > 0 ? Math.min(...distDestinosAnteriorM) : 0,
                };
              }
            } else {
              divergenciaRumoStreak = 0;
              divergenciaRumoInicio = null;
              divergenciaRumoCaminhoM = 0;
            }
          } else {
            divergenciaRumoStreak = 0;
            divergenciaRumoInicio = null;
            divergenciaRumoCaminhoM = 0;
          }

          // ─── Placar de desvio (Fase 1, SOMBRA) -- sinais que somam ──────
          // Ver docs/superpowers/specs/2026-08-01-placar-desvio-design.md.
          // S1/S2/S4/S5 (contribuições positivas) só somam sob os MESMOS
          // guards que os streaks de desvio já usam -- guard duplicado de
          // propósito (idêntico ao `if` de divergenciaGrausAtual logo acima)
          // em vez de reescrever aquele `if`, pra não arriscar a lógica do
          // streak já existente. Descontos (D1-D4) NÃO usam este guard --
          // aplicam sempre que computáveis, ver bloco final mais abaixo.
          const podeSomarSinaisPlacar =
            pos.fresco && !saltoImplausivel && !suspensoPorChegada &&
            podeAvancarStreaksDesvio && alvosDestinosDisponiveis && destinos.length > 0;

          // D3 (placar): divergência de rumo POR DESTINO PENDENTE -- não só
          // o mínimo agregado que divergenciaGrausAtual acima já calcula.
          // destinoAlinhadoAproximando (lib) precisa da divergência e
          // distância de CADA entrega individualmente. distDestinosM[i]
          // alinha 1:1 com pendentes[i] (mesma ordem de construção de
          // `destinos` acima: pendentes primeiro, bases depois) -- reusa a
          // distância já calculada, não recalcula. Bases ficam de fora (D3 é
          // sobre destino alinhado com uma ENTREGA, não retorno à base).
          const rumoDivergenciaPorDestinoPlacar: { codigo: string; divergenciaGraus: number; distM: number }[] = [];
          if (podeSomarSinaisPlacar) {
            for (let i = 0; i < pendentes.length; i++) {
              const pt = pendentes[i];
              const divergenciaPt = divergenciaRumoGraus(
                anterior?.lat ?? pos.lat, anterior?.lng ?? pos.lng, pos.lat, pos.lng,
                pt.lat, pt.lng, pos.velocidade
              );
              if (divergenciaPt === null) continue;
              rumoDivergenciaPorDestinoPlacar.push({
                codigo: codigoDestinoPlacar(pt),
                divergenciaGraus: divergenciaPt,
                distM: distDestinosM[i],
              });
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
          // POI consultado para parada anomala, saida nao autorizada parada
          // E parada fora do tapete (mesma supressao anti-FP das outras).
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
          // raio curto. >= 2 => transito/fila, suprime a parada anomala E a
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

          // ─── CERCA VIRTUAL (ver CERCA_VIRTUAL_MODO no topo) ──────────────
          // Mantem o corredor proativo por veiculo. Em modo "ativa" (11/07,
          // diretiva explicita do usuario: falso positivo aceitavel,
          // prioridade total e nunca perder desvio real), "fora" vira um
          // Alerta de verdade (alertaCerca, mesclado nos "extras" mais
          // abaixo) A PARTIR DA SEGUNDA leitura fora consecutiva -- aguarda confirmacao. Sempre
          // grava em cerca_sombra tambem (auditoria/historico). Semeadura
          // usa a POSICAO ATUAL como origem de rota (correto aqui: a rota
          // semeada e checada contra posicoes FUTURAS, nunca contra a
          // propria origem -- diferente do bug tautologico de 10/07, onde
          // origem e ponto checado eram o mesmo).
          let alertaCerca: Alerta | null = null;
          if (
            CERCA_VIRTUAL_MODO !== "desligada" &&
            pos.fresco &&
            pos.velocidade > 0 &&
            pendentes.length > 0 &&
            !saltoImplausivel &&
            // Achado revisao final 25/07: a cerca virtual e um caminho de
            // alerta SEPARADO de detectarDesvio (nunca passa por ele), entao
            // nao herdava a suspensao por chegada aplicada la (linha ~672 em
            // detectores.ts). A Task 8 removeu o alargamento de buffer perto
            // da chegada assumindo que suspensoPorChegada cobria o mesmo
            // caso -- so que so cobria o lado comportamental. Sem este guard,
            // clientes com doca/portaria recuada da via publica (corredor
            // OSRM nao alcanca) reintroduziam o falso positivo documentado
            // no achado 15/07 (caso 3C94).
            !suspensoPorChegada
          ) {
            // Achado real 15/07: a cerca so testava rota ate os PENDENTES,
            // nunca ate a base -- veiculo com entrega ainda em aberto que
            // volta pra base (fim de turno, recarga, decisao do motorista)
            // nunca batia com nenhuma rota calculada e disparava desvio
            // critico na 1a leitura, mesmo indo pra um destino legitimo. A
            // Camada 1 (comportamental, destinos acima) ja tratava base como
            // destino legitimo -- a cerca ficou dessincronizada dela. Fix:
            // mesma lista de destinos legitimos (pendentes + bases).
            const destinosCerca = [...pendentes.map((pt) => ({ lat: pt.lat, lng: pt.lng, codigo: pt.codigo ?? `${pt.lat},${pt.lng}` })), ...basesComoDestinoCerca];
            const chaveCerca = destinosCerca.map((pt) => pt.codigo).sort().join(",");
            const cerca = cacheCercaPorVeiculo.get(veiculo_id);
            const cercaValida =
              cerca && cerca.pendentesChave === chaveCerca && Date.now() - cerca.calculadoEm < CERCA_CACHE_MS;
            const bufferCerca = bufferPorVelocidade(pos.velocidade);
            // Achado real 11/07: nao existe ordem de entrega, o motorista
            // escolhe livremente qual pendente visitar primeiro. Cortar em
            // "3 mais proximos" presumia que o motorista ia pro mais perto,
            // o que gerava alerta em cima de gente indo legitimamente pra um
            // pendente mais distante. Agora verifica TODOS, ordenados por
            // distancia so como heuristica de prioridade dentro do
            // orcamento de chamadas (verificarCorredor ja tem deadline de
            // 5s/req e o throttle global decide quantos realmente cabem).
            // Achado real 15/07: com orcamento apertado (~4-5 candidatos
            // testaveis) e clientes com mediana de 11 pendentes, prioriza
            // por alinhamento com o rumo de deslocamento (rumoMovimento, ja
            // calculado acima) antes da distancia pura -- aumenta a chance
            // de testar o destino real do motorista.
            const todosPendentesPriorizados = () =>
              ordenarPendentesPorDistancia(pos, destinosCerca, rumoMovimento).map((pt) => ({ lat: pt.lat, lng: pt.lng }));

            if (!cercaValida) {
              // Semeadura: rota real daqui ate o pendente mais proximo.
              // Pressupoe veiculo em rota legitima NESTE momento (se ja
              // estiver desviado, o gatilho comportamental cobre).
              if (chamadasCorredorNoCiclo < ORCAMENTO_CORREDOR_POR_CICLO - RESERVA_COMPORTAMENTAL_POR_CICLO) {
                chamadasCorredorNoCiclo++;
                const r = await verificarCorredor(
                  { lat: pos.lat, lng: pos.lng },
                  { lat: pos.lat, lng: pos.lng, velocidade: pos.velocidade },
                  todosPendentesPriorizados()
                );
                ultimaVerificacaoCorredorPorVeiculo.set(veiculo_id, Date.now());
                if (r.veredito === "dentro" && r.corredor) {
                  cacheCercaPorVeiculo.set(veiculo_id, {
                    polilinha: r.corredor,
                    ultimoDentro: { lat: pos.lat, lng: pos.lng },
                    pendentesChave: chaveCerca,
                    calculadoEm: Date.now(),
                    foraStreak: 0,
                  });
                }
                // "indisponivel": tenta de novo no proximo ciclo (fail-open).
              }
            } else if (cerca && dentroDoCorredor(pos, cerca.polilinha, bufferCerca)) {
              // Na rota esperada: atualiza a ancora e zera a suspeita.
              cerca.ultimoDentro = { lat: pos.lat, lng: pos.lng };
              cerca.foraStreak = 0;
            } else if (
              cerca &&
              chamadasCorredorNoCiclo < ORCAMENTO_CORREDOR_POR_CICLO - RESERVA_COMPORTAMENTAL_POR_CICLO &&
              deveVerificarRecuperacao(dentroTapete, familiarVeiculo)
            ) {
              // Saiu do corredor conhecido: tenta RECUPERAR (motorista pode
              // ter escolhido outra rota legitima pra outro pendente).
              // Ancora = ultimo ponto confirmado DENTRO (passado, nunca a
              // posicao atual).
              chamadasCorredorNoCiclo++;
              const r = await verificarCorredor(
                cerca.ultimoDentro,
                { lat: pos.lat, lng: pos.lng, velocidade: pos.velocidade },
                todosPendentesPriorizados()
              );
              ultimaVerificacaoCorredorPorVeiculo.set(veiculo_id, Date.now());
              if (r.veredito === "dentro" && r.corredor) {
                cerca.polilinha = r.corredor;
                cerca.ultimoDentro = { lat: pos.lat, lng: pos.lng };
                cerca.pendentesChave = chaveCerca;
                cerca.calculadoEm = Date.now();
                cerca.foraStreak = 0;
                cercaSombraCiclo.push({
                  veiculo_id, cliente_id, lat: pos.lat, lng: pos.lng,
                  velocidade: pos.velocidade, veredito: "recuperado",
                  pendentes: pendentes.length, buffer_m: bufferCerca,
                });
              } else if (r.veredito === "fora") {
                cerca.foraStreak++;
                // Log so nas 2 primeiras leituras fora (espelha o modelo
                // atencao->critico que a versao ativa usaria) -- evita spam.
                if (cerca.foraStreak <= 2) {
                  cercaSombraCiclo.push({
                    veiculo_id, cliente_id, lat: pos.lat, lng: pos.lng,
                    velocidade: pos.velocidade, veredito: "fora",
                    pendentes: pendentes.length, buffer_m: bufferCerca,
                  });
                }
                // Achado real 22/07 (auditoria): alerta so a partir da 2a
                // leitura "fora" consecutiva -- reduz blips que se autocorrigem
                // sozinhos (GPS oscilando, manobra) e viravam alerta completo.
                // O log de auditoria acima (cercaSombraCiclo) continua desde a
                // 1a leitura -- so o alerta de verdade espera a confirmacao.
                if (CERCA_VIRTUAL_MODO === "ativa" && cerca.foraStreak >= 2) {
                  let distCorredorM = Infinity;
                  for (let i = 0; i < cerca.polilinha.length - 1; i++) {
                    const d = distanciaAoSegmentoM(pos, cerca.polilinha[i], cerca.polilinha[i + 1]);
                    if (d < distCorredorM) distCorredorM = d;
                  }
                  const distFmt = Number.isFinite(distCorredorM) ? `${Math.round(distCorredorM)}m` : `${bufferCerca}m+`;
                  alertaCerca = {
                    nivel: "critico",
                    tipo: "desvio",
                    origemDesvio: "cerca_virtual",
                    motivo: `Fora da rota esperada (${distFmt} da estrada real até o próximo ponto, buffer ${bufferCerca}m)`,
                    score: cerca.foraStreak >= 3 ? 85 : 75,
                  };
                }
              }
              // "indisponivel": nao mexe em nada (fail-open).
            }
          } else if (pendentes.length === 0) {
            cacheCercaPorVeiculo.delete(veiculo_id);
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
          const alvoNoRaioAgora = (pontosVeiculo ?? []).find(
            (pt) => haversineM(pos.lat, pos.lng, pt.lat, pt.lng) <= pt.raio
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

          const saiuDoRaioAgora = codigoAnteriorNoRaio !== null && alvoNoRaioAgora === null;
          const alvoQueSaiu = (pontosVeiculo ?? []).find((pt) => pt.pontoCodigo === codigoAnteriorNoRaio) ?? null;
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

          // Estado persistido: quando o veiculo saiu pela ultima vez de uma
          // parada CONFIRMADA (dwell suficiente pra nao ser so uma
          // passagem, mesmo limiar BYPASS_ENTREGA_DWELL_MINIMO_SEGUNDOS que
          // ja diferencia bypass de entrega real) -- achado real 28/07
          // (Task 6, 36% dos FP manuais de rua-estreita). Mesmo padrao EXATO
          // de ultima_via_principal_em acima: seta na transicao, propaga
          // enquanto a janela abaixo nao expira, decai sozinho (sem reset
          // explicito). saiuDoRaioAgora + dwellAnterior ja calculados acima
          // pra bypass_entrega -- reaproveitados aqui, mesmo sinal.
          const saiuParadaConfirmadaAnterior = anterior?.saiu_parada_confirmada_em ?? null;
          const saiuParadaConfirmadaEm = deveMarcarSaidaParadaConfirmada({
            fresco: pos.fresco,
            alvosApiOk,
            saiuDoRaioAgora,
            dwellAnteriorSegundos: dwellAnterior,
          })
            ? agora.toISOString()
            : saiuParadaConfirmadaAnterior;
          const saiuParadaConfirmadaRecentemente = saiuParadaConfirmadaHaMenosDe(saiuParadaConfirmadaEm, agora);

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

          // Achado real 31/07 (revisao final): precisa saber ANTES de montarCandidatosCore
          // se o classe_viaria SERIA candidato neste ciclo -- movido pra antes da chamada
          // porque o ctx que entra em montarCandidatosCore precisa disso como INPUT (pra
          // detectarDesvio poder deixar de retornar cedo e continuar checando os outros
          // tipos, incluindo o critico "caminho nunca percorrido" -- suprimir So DEPOIS
          // que detectarDesvio ja tinha retornado esse alerta mascarava esse critico sem
          // deixar ele aparecer). Ver docs/superpowers/specs/2026-07-31-classe-viaria-coerencia-rumo-design.md.
          let classeViariaRumoSombra: { divergenciaGraus: number | null; limiar: number; suprimiria: boolean } | null = null;
          const classeViariaSeriaCandidata = !afastandoDeTudoAtual && quedaClasseViaria && !saiuParadaConfirmadaRecentemente;
          if (classeViariaSeriaCandidata) {
            const suprimiria = rumoCoerenteComDestino(divergenciaGrausAtual, RUA_ESTRANHA_LIMIAR_RUMO_COERENTE_GRAUS);
            classeViariaRumoSombra = { divergenciaGraus: divergenciaGrausAtual, limiar: RUA_ESTRANHA_LIMIAR_RUMO_COERENTE_GRAUS, suprimiria };
          }
          const classeViariaSuprimidaPorRumo = CLASSE_VIARIA_FILTRO_RUMO_ATIVO && (classeViariaRumoSombra?.suprimiria ?? false);

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
                  distDestinosM,
                  distDestinosAnteriorM,
                  desvioStreak,
                  afastamentoAcumuladoM,
                  dentroTapete,
                  familiarVeiculo,
                  quedaClasseViaria,
                  saiuParadaConfirmadaRecentemente,
                  classeViariaSuprimidaPorRumo,
                  riscoAreaAtual,
                  foraTapeteStreak,
                  suspensoPorChegada,
                  divergenciaRumoStreak,
                  saiuDoRaioAgora,
                  divergenciaGrausAtual,
                  temPendentes,
                  entregasTotal: alvosApiOk ? entregas_total : undefined,
                  entregasFeitas: alvosApiOk ? entregas_feitas : undefined,
                  // Achado real 29/07: SO pro gate de detectarDesvio, usa
                  // alvosDestinosDisponiveis (true com fallback de cache
                  // tambem, ver cacheAlvosFallbackPorCliente acima) -- nao a
                  // flag estrita alvosApiOk. entregasTotal/entregasFeitas
                  // acima continuam estritos de proposito (saida_nao_autorizada
                  // nao deve usar contagem de entregas desatualizada).
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

          // Decisao intermediaria (so os candidatos core, sem os extras
          // ainda) -- usada pela verificacao de corredor logo abaixo, que
          // precisa saber SE o vencedor atual e um desvio comportamental
          // antes de decidir se suprime ou confirma.
          let alerta: Alerta | null = arbitrarCandidatos(candidatosCore);
          // Hoisted (Task 3 da Fase 2): precisam sobreviver ate o bloco de
          // gerenciamento de alertas mais abaixo, que monta o contexto
          // expandido do desvio via montarContextoDesvio -- calculados so
          // quando ha alerta (ver bloco `if (alerta)` logo apos a
          // calibracao/arbitragem final).
          let segmentoEspecifico: string | null = null;
          let taxaFp: number | undefined = undefined;
          // Quando o corredor confirma legitimidade (ou exige confirmacao
          // que nao veio), o desvio comportamental precisa ser removido dos
          // candidatos CRUS tambem -- senao ele reaparece na arbitragem
          // final mais abaixo (junto com os extras) mesmo depois de
          // suprimido aqui.
          let desvioSuprimidoPorCorredor = false;

          // ─── Verificação por corredor real (Camada 1 do desvio) ─────────
          // Intercepta desvio comportamental ("Afastando-se...") E, desde a
          // Task 4 (achado 28/07), rumo-diverge tambem -- nunca panico/
          // jammer/etc. A rota SEMPRE sai de um ponto FIXO do PASSADO (nunca
          // da posicao atual, ver comentario em verificarCorredor sobre o
          // incidente de 10/07) ate o destino. Sem esse ponto ainda gravado,
          // nao da pra verificar: deixa passar como hoje (fail-open). Fluxo:
          // cache primeiro (zero API); sem cache ou fora dele, verifica com
          // OSRM/Valhalla (throttled, orçamento por ciclo). "dentro" = a
          // posição atual está numa estrada real que sai de onde a suspeita
          // começou e leva a um destino legítimo: suprime e zera o streak.
          // "fora" = confirma, e o início real do desvio é onde saiu do
          // corredor. "indisponivel" = comporta exatamente como hoje
          // (fail-open).
          //
          // Achado CRITICO da revisao independente 28/07 (Task 4b): ate
          // aqui, o gate e os efeitos "dentro"/"fora" so conheciam
          // desvioInicio/desvioStreak (o anchor/streak de "afastando de
          // tudo") -- rumo-diverge (Task 4) dispara justamente quando NAO ha
          // afastamento de tudo, entao desvioInicio fica null exatamente no
          // caso que motivou a Task 4 (rodovia com curva, TTK-4D14), e o
          // wiring nunca rodava pra esse caso. Fix: qual anchor/streak usar
          // -- pra decidir SE roda a verificacao, qual origem passar pro
          // OSRM/Valhalla, e quais campos os vereditos "dentro"/"fora"
          // reescrevem -- passa a depender de QUAL regra e' a vencedora
          // atual (origemRumoDivergeGanhou), nao mais de um unico
          // desvioInicio compartilhado. Isso tambem resolve o achado
          // IMPORTANTE da mesma revisao: um alerta FRACO de rumo-diverge
          // (nivel "atencao") nao pode zerar/reescrever a streak CRITICA de
          // afastando-de-tudo de outro episodio em andamento (e vice-versa)
          // -- os dois streaks sao independentes e nao podem compartilhar o
          // mesmo efeito colateral.
          // Precisa ficar calculado ANTES de qualquer `alerta = null` mais
          // abaixo (veredito "dentro" some com o alerta) -- os 3 pontos que
          // usam esta const (zerarStreakDaOrigemVencedora/
          // reancorarOrigemVencedora) dependem de capturar QUEM venceu
          // antes do alerta ser potencialmente zerado; inline nesses pontos
          // leria sempre false e devolveria o efeito colateral pro streak
          // errado (afastando-de-tudo em vez de rumo-diverge).
          const origemRumoDivergeGanhou = alerta?.tipo === "desvio" && alerta.origemDesvio === "rumo_diverge";
          // Mesma funcao usada pra Task 3 (contexto persistido) -- a
          // escolha de qual anchor usar (Step 3b) e' identica nos dois
          // lugares, ver desvioInicioEfetivoParaContexto em detectores.ts.
          const anchorCorredor = desvioInicioEfetivoParaContexto(desvioInicio, origemRumoDivergeGanhou, divergenciaRumoInicio);
          let corredorInfo: { veredito: "dentro" | "fora" | "indisponivel" | "orcamento_estourado"; bufferM: number } | null = null;
          if (
            CAMADA_CORREDOR_ATIVA &&
            alerta?.tipo === "desvio" &&
            alerta.precisaVerificacaoCorredor === true &&
            pos.fresco &&
            anchorCorredor
          ) {
            const origem = { lat: anchorCorredor.lat, lng: anchorCorredor.lng };
            const pendentesChave = pendentes.map((pt) => pt.codigo ?? `${pt.lat},${pt.lng}`).sort().join(",");
            const cache = cacheCorredorPorVeiculo.get(veiculo_id);
            const cacheValido =
              cache &&
              cache.expiraEm > Date.now() &&
              cache.pendentesChave === pendentesChave &&
              cache.origemTs === anchorCorredor.ts &&
              !paradaLongaInvalidaCache(anterior?.velocidade ?? null, anterior?.parado_desde ?? null, agora.getTime());

            if (cacheValido && cache && dentroDoCorredor(pos, cache.polilinha, bufferPorVelocidade(pos.velocidade))) {
              // Continua na estrada já confirmada: suprime sem API.
              cache.ultimoDentro = { lat: pos.lat, lng: pos.lng };
              corredorInfo = { veredito: "dentro", bufferM: bufferPorVelocidade(pos.velocidade) };
              // Suprime a criacao de um NOVO alerta/reinicia o streak
              // comportamental -- nao fecha nenhum alerta ja aberto no banco
              // (achado real 11/07: fechamento automatico de desvio REMOVIDO
              // de vez, so operador humano resolve/marca falso positivo).
              alerta = null;
              desvioSuprimidoPorCorredor = true;
              ({ desvioStreak, desvioInicio, divergenciaRumoStreak, divergenciaRumoInicio } = zerarStreakDaOrigemVencedora(
                origemRumoDivergeGanhou,
                { desvioStreak, desvioInicio, divergenciaRumoStreak, divergenciaRumoInicio }
              ));
              if (origemRumoDivergeGanhou) divergenciaRumoCaminhoM = 0;
            } else if (chamadasCorredorNoCiclo < ORCAMENTO_CORREDOR_POR_CICLO) {
              chamadasCorredorNoCiclo++;
              const bufferAtual = bufferPorVelocidade(pos.velocidade);
              const candidatos = [...destinos]
                .map((d) => ({ d, dist: haversineM(pos.lat, pos.lng, d.lat, d.lng) }))
                .sort((a, b) => a.dist - b.dist)
                .slice(0, 3)
                .map((x) => x.d);
              const r = await verificarCorredor(origem, { lat: pos.lat, lng: pos.lng, velocidade: pos.velocidade }, candidatos);
              ultimaVerificacaoCorredorPorVeiculo.set(veiculo_id, Date.now());
              corredorInfo = { veredito: r.veredito, bufferM: bufferAtual };
              if (r.veredito === "dentro" && r.corredor) {
                cacheCorredorPorVeiculo.set(veiculo_id, {
                  polilinha: r.corredor,
                  ultimoDentro: { lat: pos.lat, lng: pos.lng },
                  pendentesChave,
                  origemTs: anchorCorredor.ts,
                  expiraEm: Date.now() + CORREDOR_CACHE_MS,
                });
                alerta = null;
                desvioSuprimidoPorCorredor = true;
                ({ desvioStreak, desvioInicio, divergenciaRumoStreak, divergenciaRumoInicio } = zerarStreakDaOrigemVencedora(
                  origemRumoDivergeGanhou,
                  { desvioStreak, desvioInicio, divergenciaRumoStreak, divergenciaRumoInicio }
                ));
                if (origemRumoDivergeGanhou) divergenciaRumoCaminhoM = 0;
              } else if (r.veredito === "fora") {
                // Confirma o desvio. Início REAL: onde saiu do corredor.
                if (cacheValido && cache) {
                  const novoAnchor: DesvioInicio = {
                    lat: cache.ultimoDentro.lat,
                    lng: cache.ultimoDentro.lng,
                    ts: agora.toISOString(),
                    menor_dist_m: anchorCorredor.menor_dist_m,
                  };
                  ({ desvioStreak, desvioInicio, divergenciaRumoStreak, divergenciaRumoInicio } = reancorarOrigemVencedora(
                    origemRumoDivergeGanhou,
                    { desvioStreak, desvioInicio, divergenciaRumoStreak, divergenciaRumoInicio },
                    novoAnchor
                  ));
                }
                cacheCorredorPorVeiculo.delete(veiculo_id);
              }
              // "indisponivel": deixa o alerta seguir como hoje (fail-open).
            } else {
              // Orçamento estourado: deixa o alerta seguir como hoje (fail-open),
              // so registra que aconteceu (achado real 10/07: antes disso nao
              // ficava nenhum rastro de que o alerta passou sem verificacao).
              // Achado IMPORTANTE da revisao independente 28/07 (Task 4b,
              // Step 5): rumo-diverge agora disputa o MESMO orcamento
              // compartilhado (ORCAMENTO_CORREDOR_POR_CICLO) que
              // afastando-de-tudo (alertas CRITICOS). Aceito por ora -- o
              // fail-open ja existente cobre o caso de orcamento estourado
              // (o alerta sobrevive normalmente, so sem corroboracao) -- mas
              // documentado explicitamente aqui pra nao ser "descoberta" de
              // novo numa auditoria futura como se fosse um bug novo.
              corredorInfo = { veredito: "orcamento_estourado", bufferM: bufferPorVelocidade(pos.velocidade) };
            }
          }

          // S3/D4 (placar de desvio, Fase 1 sombra): reaproveita o MESMO
          // veredito da Camada 1 do corredor calculado logo acima
          // (corredorInfo) -- nunca chama dentroDoCorredor/verificarCorredor
          // de novo. "dentro" desconta D4 (false), "fora" soma S3 (true),
          // sem verificação neste ciclo ("indisponivel"/"orcamento_estourado")
          // ou corredorInfo ainda null vira null (nem soma nem desconta, ver
          // SinaisPlacar em placar-desvio.ts).
          const s3ForaDoCorredorPlacar: boolean | null =
            corredorInfo === null || corredorInfo.veredito === "indisponivel" || corredorInfo.veredito === "orcamento_estourado"
              ? null
              : corredorInfo.veredito === "fora";

          // Achado real 30/07: veredito de sombra do filtro comportamental --
          // so calcula quando rumo-diverge foi a regra vencedora E o corredor
          // confirmou "fora" (as duas condicoes que a spec exige pra sequer
          // considerar suprimir). Ver
          // docs/superpowers/specs/2026-07-30-filtro-comportamental-rumo-diverge-design.md.
          let retidaoRumoSombra: {
            caminhoM: number; liquidoM: number | null; razao: number | null; limiar: number; veredito_suprimiria: boolean;
          } | null = null;
          if (origemRumoDivergeGanhou && corredorInfo?.veredito === "fora" && divergenciaRumoInicio && menorDistDestinoM !== null) {
            // CORRIGIDO na revisao da Task 4 (achado Important): NAO usar
            // haversineM(divergenciaRumoInicio.lat/lng, pos) -- esse lat/lng e'
            // REESCRITO pelo reancorarOrigemVencedora sempre que o corredor
            // confirma "fora" (exatamente os 25/27 casos reais que este filtro
            // existe pra pegar), desalinhando numerador (caminho, que conta desde
            // o INICIO real) e denominador (que passaria a contar so desde a
            // reancora). Fix: usar a MESMA formula ja empregada por
            // afastamentoAcumuladoM pro streak irmao (diferenca de menor_dist_m,
            // nao haversine de posicao) -- menor_dist_m E' preservado atraves do
            // reancor (confirmado na revisao: reancorarOrigemVencedora so reescreve
            // lat/lng, novoAnchor.menor_dist_m vem de anchorCorredor.menor_dist_m,
            // que foi capturado ANTES de qualquer reescrita neste ciclo). Bonus:
            // essa formula mede progresso real rumo ao destino, nao so forma da
            // trajetoria -- pega tambem o caso de um veiculo andando muito em linha
            // reta mas PERPENDICULAR a qualquer destino (caminho grande, progresso
            // ~0), que a versao com haversine de posicao deixaria passar.
            const liquidoM = Math.abs(menorDistDestinoM - divergenciaRumoInicio.menor_dist_m);
            const razao = razaoRetidaoRumo(divergenciaRumoCaminhoM, liquidoM);
            const limiar = limiarRazaoRetidaoRumo(menorDistDestinoM);
            // razao === null: sem deslocamento liquido suficiente pra confiar no
            // sinal -- erra pro lado de NAO suprimir (diretiva do usuario: falso
            // positivo aceitavel, nunca perder desvio real).
            const veredito_suprimiria = razao !== null && razao < limiar;
            retidaoRumoSombra = { caminhoM: divergenciaRumoCaminhoM, liquidoM, razao, limiar, veredito_suprimiria };
            if (RUMO_DIVERGE_FILTRO_COMPORTAMENTAL_ATIVO && veredito_suprimiria) {
              alerta = null;
              desvioSuprimidoPorCorredor = true;
            }
          }

          // Achado real 30/07 (Task 7): diferente do bloco acima (Task 5, so
          // roda quando rumo-diverge venceu a arbitragem E o corredor ja
          // confirmou "fora"), este grava TODO ciclo em que o episodio de
          // divergencia esta ativo -- da a serie temporal completa (streak
          // 1, 2, 3... ate o episodio zerar), nao so o instante frio de
          // criacao do alerta.
          if (pos.fresco && divergenciaRumoInicio && menorDistDestinoM !== null) {
            const liquidoSombraM = Math.abs(menorDistDestinoM - divergenciaRumoInicio.menor_dist_m);
            const razaoSombra = razaoRetidaoRumo(divergenciaRumoCaminhoM, liquidoSombraM);
            const limiarSombra = limiarRazaoRetidaoRumo(menorDistDestinoM);
            rumoDivergeSombraCiclo.push({
              veiculo_id,
              cliente_id,
              streak: divergenciaRumoStreak,
              caminho_m: divergenciaRumoCaminhoM,
              liquido_m: liquidoSombraM,
              razao: razaoSombra,
              limiar: limiarSombra,
              dist_min_destino_m: menorDistDestinoM,
              veredito_suprimiria: razaoSombra !== null && razaoSombra < limiarSombra,
            });
          }

          // Achado real 11/07: alerta "sem historico de comportamento" (0
          // entregas feitas) so pode sobreviver com confirmacao EXPLICITA do
          // corredor que a rota esta "dentro". Supressao so acontece em
          // confirmacao POSITIVA (veredito === "dentro"), nao mais em qualquer
          // coisa que nao seja "fora". Agora "indisponivel"/orcamento estourado
          // fazem fail-open igual ao resto do detector, corrigindo a inversao
          // de politica encontrada na auditoria de 22/07. Sem isso, o gate
          // antigo (bloqueio total pre-1a-entrega) segue sendo necessario;
          // com isso, a estrada real supre a falta de historico sem abrir mao
          // de cautela quando a API estiver fora.
          if (alerta?.tipo === "desvio" && alerta.exigeConfirmacaoCorredor === true && corredorInfo?.veredito === "dentro") {
            alerta = null;
            desvioSuprimidoPorCorredor = true;
          }

          // Novos detectores: retorno_tardio, parada_noturna_ignicao, aceleracao_brusca.
          // Calculados separadamente e sobrepõem alerta principal se mais severos.
          const extras: Alerta[] = [
            detectarRetornoTardio({ entregas_feitas, entregas_total, foraDaBase, paradoMin, emOperacao }),
            detectarParadaNoturnaIgnicaoAtiva(pos, { foraDaBase, noCliente, horaSP }),
            detectarAceleracaoBrusca(pos, {
              velocidadeAnterior: anterior?.velocidade ?? null,
              foraDaBase,
            }),
            alertaCerca,
            alertaBypass,
            alertaBaseline,
            alertaParadaSemMarcacao,
          ].filter((a): a is Alerta => a !== null);

          // Arbitragem FINAL, unica: candidatos core CRUS (sem o desvio
          // comportamental, se o corredor ja suprimiu) + extras. Ver
          // comentario acima de candidatosCore -- e essa uniao numa unica
          // chamada de arbitrarCandidatos que evita o bug do bonus
          // duplicado.
          const candidatosCoreFinal = desvioSuprimidoPorCorredor
            ? candidatosCore.filter((c) => c.tipo !== "desvio")
            : candidatosCore;
          alerta = arbitrarCandidatos([...candidatosCoreFinal, ...extras]);
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
          if (alerta) {
            segmentoEspecifico = segmentoCalibracaoPreferido(alerta, corredorInfo?.veredito);
            taxaFp = (segmentoEspecifico !== null ? mapaCalibracao.get(segmentoEspecifico) : undefined)
              ?? mapaCalibracao.get(`tipo:${alerta.tipo}`);
            if (taxaFp !== undefined) {
              alerta = { ...alerta, score: aplicarFatorCalibrado(alerta.score, taxaFp) };
            }
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

          // ─── Placar de desvio (Fase 1, SOMBRA) -- cálculo final ─────────
          // Ver docs/superpowers/specs/2026-08-01-placar-desvio-design.md e
          // src/lib/placar-desvio.ts. Só calcula, persiste (junto dos
          // streaks, mesmo UPSERT) e loga -- NUNCA muda alerta/nível/UI.
          const placarAnterior = anterior?.placar_desvio ?? 0;
          const estadoPlacarAnterior = anterior?.placar_desvio_estado ?? null;

          // distPorCodigo do ciclo ATUAL (pra D3 do PRÓXIMO ciclo comparar
          // "distância caindo") -- construído sempre que há pendente,
          // independente dos guards de soma (é só um registro de estado).
          const distPorCodigoPlacar: Record<string, number> = {};
          for (let i = 0; i < pendentes.length; i++) {
            distPorCodigoPlacar[codigoDestinoPlacar(pendentes[i])] = distDestinosM[i];
          }

          let sinaisPlacar: SinaisPlacar;
          let entregasFeitasRefPlacar: number;
          let entregasFeitasDesdePlacar: string;

          if (!pos.fresco || !temPendentes) {
            // Guard 7 (Task 3 do plano): sem posição fresca OU sem destino
            // pendente -- placar só decai (nenhum sinal soma nem desconta
            // neste ciclo, sem novo cálculo de D1/D2/D3 pra este veículo).
            // entregasFeitasRef/Desde carregam do ciclo anterior sem
            // alteração (nada confiável pra comparar agora).
            sinaisPlacar = {
              s1AfastandoDeTudo: false, s2RumoDivergente: false, s3ForaDoCorredor: null,
              s4CelulaDesconhecida: false, s5DiaEstagnado: false,
              d1ParadaPertoDeEntrega: false, d2PadraoEntrega: false, d3DestinoAlinhadoAproximando: false,
            };
            entregasFeitasRefPlacar = estadoPlacarAnterior?.entregasFeitasRef ?? entregas_feitas;
            entregasFeitasDesdePlacar = estadoPlacarAnterior?.entregasFeitasDesde ?? agora.toISOString();
          } else {
            // S5: entregas_feitas mudou desde o ciclo anterior? Se sim,
            // reancora a referência (nova contagem, novo relógio). Se não,
            // mantém a referência/timestamp antigos -- é essa persistência
            // que mede "estagnado há quanto tempo".
            const refAnteriorPlacar = estadoPlacarAnterior?.entregasFeitasRef;
            const mudouEntregasFeitasPlacar = refAnteriorPlacar === undefined || refAnteriorPlacar !== entregas_feitas;
            entregasFeitasRefPlacar = mudouEntregasFeitasPlacar ? entregas_feitas : (refAnteriorPlacar ?? entregas_feitas);
            entregasFeitasDesdePlacar = mudouEntregasFeitasPlacar
              ? agora.toISOString()
              : (estadoPlacarAnterior?.entregasFeitasDesde ?? agora.toISOString());
            const minutosEstagnadoPlacar = (agora.getTime() - new Date(entregasFeitasDesdePlacar).getTime()) / 60000;

            const celulaAtualPlacar = celulaDe(pos.lat, pos.lng);
            const destinosPlacarD1: DestinoPlacar[] = pendentes.map((pt) => ({
              lat: pt.lat, lng: pt.lng, raio: pt.raio, codigo: codigoDestinoPlacar(pt),
            }));
            const janelaVeiculoPlacar = janelaHistoricoCliente.get(veiculo_id) ?? [];

            sinaisPlacar = {
              s1AfastandoDeTudo: podeSomarSinaisPlacar && afastandoDeTudoAtual,
              s2RumoDivergente: divergenciaGrausAtual !== null && divergenciaGrausAtual > 100,
              s3ForaDoCorredor: s3ForaDoCorredorPlacar,
              // S4: célula atual não visitada por ESTE veículo antes --
              // celulasFamiliaridadeVeiculo já é a MESMA query batched por
              // cliente que alimenta familiarVeiculo acima (vizinhança 3x3
              // inclui a célula exata, ver celulas.ts), zero query nova.
              s4CelulaDesconhecida:
                podeSomarSinaisPlacar && !celulasFamiliaridadeVeiculo.has(`${veiculo_id}:${celulaAtualPlacar}`),
              s5DiaEstagnado:
                podeSomarSinaisPlacar && pendentes.length >= 2 && pos.velocidade > 0 &&
                minutosEstagnadoPlacar >= S5_ESTAGNADO_MIN,
              d1ParadaPertoDeEntrega: paradaRecentePertoDeEntrega(janelaVeiculoPlacar, destinosPlacarD1),
              d2PadraoEntrega: padraoEntrega(janelaVeiculoPlacar),
              d3DestinoAlinhadoAproximando: destinoAlinhadoAproximando(
                { lat: pos.lat, lng: pos.lng },
                rumoDivergenciaPorDestinoPlacar,
                estadoPlacarAnterior?.distPorCodigo ?? {}
              ),
            };
          }

          const { placar: placarNovo, componentes: componentesPlacar } = atualizarPlacar(
            placarAnterior,
            sinaisPlacar,
            suspensoPorChegada
          );

          // Histerese do amarelo (só pro LOG na Fase 1 -- não afeta UI/alerta
          // nenhum): liga a partir de PLACAR_AMARELO, só desliga abaixo de
          // PLACAR_AMARELO_DESLIGA. Vermelho não tem histerese (Fase 1).
          const amareloAtivoAnteriorPlacar = estadoPlacarAnterior?.amareloAtivo ?? false;
          const amareloAtivoPlacar =
            placarNovo >= PLACAR_AMARELO ? true : placarNovo < PLACAR_AMARELO_DESLIGA ? false : amareloAtivoAnteriorPlacar;
          const teriaVermelhoPlacar = placarNovo >= PLACAR_VERMELHO;

          const estadoPlacarNovo: EstadoPlacarDesvio = {
            distPorCodigo: distPorCodigoPlacar,
            entregasFeitasRef: entregasFeitasRefPlacar,
            entregasFeitasDesde: entregasFeitasDesdePlacar,
            amareloAtivo: amareloAtivoPlacar,
          };

          // Log sombra: só grava quando placar > 0 (não inflar a tabela com
          // frota parada, decisão explícita da spec).
          if (placarNovo > 0) {
            placarDesvioLogCiclo.push({
              veiculo_id,
              placar: placarNovo,
              componentes: componentesPlacar,
              teria_amarelo: amareloAtivoPlacar,
              teria_vermelho: teriaVermelhoPlacar,
            });
          }

          // Sombra no contexto dos alertas de desvio emitidos pelos 3
          // detectores atuais (mesmo padrão de rumo_coerente_sombra, ver uso
          // mais abaixo) -- nunca lido por nenhum detector, só auditoria.
          const placarDesvioSombraContexto = { placar: placarNovo, componentes: componentesPlacar };

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
            fora_tapete_streak: foraTapeteStreak,
            divergencia_rumo_streak: divergenciaRumoStreak,
            divergencia_rumo_inicio: divergenciaRumoInicio ? JSON.stringify(divergenciaRumoInicio) : null,
            divergencia_rumo_caminho_m: divergenciaRumoCaminhoM,
            aproximando_streak: aproximandoStreak,
            origem_celula: origemCelula,
            no_raio_alvo_codigo: noRaioAlvoCodigo,
            no_raio_desde: noRaioDesde,
            no_raio_dwell_segundos: noRaioDwellSegundos,
            ultima_via_principal_em: ultimaViaPrincipalEm,
            saiu_parada_confirmada_em: saiuParadaConfirmadaEm,
            perto_sem_marcacao_codigo: pertoSemMarcacaoCodigo,
            perto_sem_marcacao_segundos: pertoSemMarcacaoSegundos,
            placar_desvio: placarNovo,
            placar_desvio_estado: JSON.stringify(estadoPlacarNovo),
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

          // Auto-resolucao retroativa de "afastando-se de todos os
          // destinos" quando a rota foi 100% concluida E o veiculo chegou
          // fisicamente dentro do poligono de uma base cadastrada -- ver
          // deveAutoResolverAfastandoRotaConcluida em detectores.ts pro
          // raciocinio completo. NAO usa so "rota concluida" (mesma
          // condicao do bloco acima) -- esse sinal sozinho e' exatamente o
          // que um cenario de entrega forcada sob coacao tambem produziria;
          // por isso exige TAMBEM baseOcupada (ja calculado mais acima
          // nesta mesma iteracao por veiculo, ~linha 1247, via
          // pontoEmGeo contra o poligono real da base -- reusado aqui, nao
          // recalculado). Sem janela de tempo (diferente da rua estranha):
          // "afastando de tudo" pode legitimamente levar bem mais tempo pra
          // voltar fisicamente ate a base, entao o check roda enquanto o
          // alerta continuar ativo, sem prazo.
          //
          // FIX 1+2 (revisao independente 27/07): "dentro do poligono" por
          // si so nao e' garantia de instalacao segura (Base Benassi —
          // CEASA-RJ e' um mercado publico de 739 mil m² com vias reais e
          // 96 veiculos distintos passando por dentro) e o check original
          // nao exigia parada de verdade nem posicao fresca (transitar pela
          // base a qualquer velocidade, ou usar uma posicao de GPS obsoleta
          // durante jammer ativo, bastava). baseElegivelAutoResolve exige
          // que a base ocupada seja pequena o suficiente (ver
          // BASE_AREA_MAX_M2_AUTORESOLVE_AFASTANDO em detectores.ts,
          // calculado uma vez no load de mapaBasesCliente, sem query nova
          // por veiculo). pos.fresco && pos.velocidade===0 no gate externo +
          // paradoMin no ctx exigem parada de verdade e leitura fresca antes
          // de sequer considerar o auto-resolve.
          //
          // !alertaJammer (revisao independente, rodada 2): pos.fresco so
          // exige atraso<60min, mas detectarJammer ja dispara critico a
          // partir de 30min (ignicao ligada) -- sem este guard, uma posicao
          // CONGELADA (jammer ativo, ~85% dos roubos de carga documentados
          // correlacionam com essa assinatura, ver detectarJammer) dentro
          // de uma base pequena podia acumular paradoMin so pelo relogio de
          // parede e auto-resolver o desvio bem no meio da janela em que o
          // veiculo pode estar sendo sequestrado agora.
          if (
            pos.fresco &&
            !alertaJammer &&
            pos.velocidade === 0 &&
            entregas_total > 0 &&
            entregas_feitas >= entregas_total &&
            baseOcupada
          ) {
            const baseElegivelAutoResolve =
              baseOcupada.areaM2 != null && baseOcupada.areaM2 < BASE_AREA_MAX_M2_AUTORESOLVE_AFASTANDO;
            for (const a of alertasAbertos.filter(elegivelParaAutoResolveAfastando)) {
              if (
                deveAutoResolverAfastandoRotaConcluida({
                  rotaConcluida: true,
                  baseOcupada: true,
                  baseElegivelAutoResolve,
                  paradoMin,
                })
              ) {
                afastandoRotaConcluidaAutoResolveCiclo.push({ alerta_id: a.id });
              }
            }
          }

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
              const origemClasseViaria = alerta.origemDesvio === "classe_viaria";
              const origemSaidaParada = alerta.origemDesvio === "saida_parada";
              // Achado real 28/07 (Task 3, REFEITO no Task 4b apos revisao
              // independente -- BLOCK na 1a rodada): rumo_diverge (ver
              // detectores.ts) dispara com !afastandoDeTudo -- desvioInicio
              // (ancorado pelo streak de "afastando de tudo") normalmente
              // esta null quando ELA e' a causa primaria do alerta.
              // DIFERENTE de classe_viaria/saida_parada (que sao EXCLUIDAS
              // de ehDesvio, sempre posicao ATUAL, contexto simples sem
              // dist_destinos_m): rumo_diverge especificamente PRECISA do
              // contexto RICO de montarContextoDesvio (dist_destinos_m/
              // dist_destinos_anterior_m/divergencia_rumo_streak -- exatamente
              // o dado que a Task 3 existe pra parar de perder) -- por isso
              // ela e' INCLUIDA em ehDesvio via desvioInicioEfetivoParaContexto,
              // que agora usa o anchor PROPRIO e sempre-real da streak de
              // divergencia de rumo (divergenciaRumoInicio, Task 4b -- ja
              // nao sintetiza mais nada da posicao atual, ver detectores.ts).
              // Esse MESMO anchor tambem alimenta a verificacao de corredor
              // da Task 4 (bloco mais acima) quando rumo_diverge e' a regra
              // vencedora -- um so anchor real, usado nos dois lugares, sem
              // ambiguidade sintetico-vs-real.
              const origemRumoDiverge = alerta.origemDesvio === "rumo_diverge";
              const desvioInicioParaContexto = desvioInicioEfetivoParaContexto(
                desvioInicio,
                origemRumoDiverge,
                divergenciaRumoInicio
              );
              const ehDesvio = alerta.tipo === "desvio" && desvioInicioParaContexto !== null && !origemClasseViaria && !origemSaidaParada;
              const ehParadaForaTapete = alerta.tipo === "parada_fora_tapete";
              const contextoParadaForaTapete = {
                parado_min: paradoMin,
                dentro_tapete: dentroTapete,
                risco_area_atual: riscoAreaAtual,
                ...(segmentoEspecifico !== null || taxaFp !== undefined
                  ? { calibracao: { segmento: segmentoEspecifico, taxa_falso_positivo: taxaFp ?? -1 } }
                  : {}),
              };
              const contextoClasseViaria = {
                classe_via_atual: classeViaAtual,
                queda_classe_viaria: quedaClasseViaria,
                dentro_tapete: dentroTapete,
                risco_area_atual: riscoAreaAtual,
                ...(classeViariaRumoSombra
                  ? {
                      rumo_coerente_sombra: {
                        divergencia_graus: classeViariaRumoSombra.divergenciaGraus,
                        limiar: classeViariaRumoSombra.limiar,
                        suprimiria: classeViariaRumoSombra.suprimiria,
                      },
                    }
                  : {}),
                ...(segmentoEspecifico !== null || taxaFp !== undefined
                  ? { calibracao: { segmento: segmentoEspecifico, taxa_falso_positivo: taxaFp ?? -1 } }
                  : {}),
                // Placar de desvio (Fase 1, SOMBRA) -- mesmo padrao de
                // rumo_coerente_sombra acima, nunca lido por nenhum
                // detector.
                placar_desvio_sombra: placarDesvioSombraContexto,
              };
              const contextoSaidaParada = {
                divergencia_graus_atual: divergenciaGrausAtual,
                dentro_tapete: dentroTapete,
                risco_area_atual: riscoAreaAtual,
                ...(segmentoEspecifico !== null || taxaFp !== undefined
                  ? { calibracao: { segmento: segmentoEspecifico, taxa_falso_positivo: taxaFp ?? -1 } }
                  : {}),
                placar_desvio_sombra: placarDesvioSombraContexto,
              };
              if (!jaExiste) {
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
                  // parada_fora_tapete, classe_viaria e saida_parada:
                  // sempre a posição ATUAL (pos.lat/lng) -- nenhuma das
                  // tres tem conceito de "início do desvio" por movimento
                  // separado da posição atual do veículo.
                  lat: ehDesvio ? desvioInicioParaContexto!.lat : pos.lat,
                  lng: ehDesvio ? desvioInicioParaContexto!.lng : pos.lng,
                  contexto: ehDesvio
                    ? {
                        ...montarContextoDesvio({
                          desvioInicio: desvioInicioParaContexto!,
                          dentroTapete,
                          corredorInfo,
                          distDestinosM,
                          distDestinosAnteriorM,
                          desvioStreak,
                          foraTapeteStreak,
                          divergenciaRumoStreak,
                          riscoAreaAtual,
                          familiarVeiculo,
                          classeViaAtual,
                          quedaClasseViaria,
                          segmentoEspecifico,
                          taxaFp,
                          retidaoRumoSombra,
                        }),
                        // Placar de desvio (Fase 1, SOMBRA) -- mesmo padrao
                        // de rumo_coerente_sombra, ver contextoClasseViaria
                        // acima. Nunca lido por nenhum detector.
                        placar_desvio_sombra: placarDesvioSombraContexto,
                      }
                    : ehParadaForaTapete
                      ? contextoParadaForaTapete
                      : origemClasseViaria
                        ? contextoClasseViaria
                        : origemSaidaParada
                          ? contextoSaidaParada
                          : {},
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
                    ...(ehDesvio
                      ? {
                          lat: desvioInicioParaContexto!.lat,
                          lng: desvioInicioParaContexto!.lng,
                          // Achado real 27/07 (caso TTK-4D14): sem isto, `desde`
                          // ficava preso no valor da criacao ORIGINAL do alerta
                          // enquanto lat/lng/contexto ja refletiam o NOVO
                          // desvioInicio deste episodio de streak -- o alerta
                          // escalado descrevia dois momentos diferentes do
                          // "mesmo" evento (idade exibida vs posicao exibida).
                          // Efeito colateral aceito: a idade exibida pode
                          // "encolher" ao escalar bem depois de criado -- correto
                          // (reflete o inicio real do episodio atual), nao um bug
                          // novo. Nao mexe no "preserva id" da escalacao (existe
                          // pra evitar spam de alerta duplicado, achado 22/07).
                          // rumo_diverge nunca chega aqui na pratica (nivel
                          // sempre "atencao", hardcoded em detectores.ts --
                          // este branch exige "critico") -- desvioInicioParaContexto!
                          // usado por consistencia/seguranca de tipos, mesmo
                          // padrao do bloco de insert acima.
                          desde: desvioInicioParaContexto!.ts,
                          contexto: {
                            ...montarContextoDesvio({
                              desvioInicio: desvioInicioParaContexto!,
                              dentroTapete,
                              corredorInfo,
                              distDestinosM,
                              distDestinosAnteriorM,
                              desvioStreak,
                              foraTapeteStreak,
                              divergenciaRumoStreak,
                              riscoAreaAtual,
                              familiarVeiculo,
                              classeViaAtual,
                              quedaClasseViaria,
                              segmentoEspecifico,
                              taxaFp,
                              retidaoRumoSombra,
                            }),
                            placar_desvio_sombra: placarDesvioSombraContexto,
                          },
                        }
                      : ehParadaForaTapete
                        ? { contexto: contextoParadaForaTapete }
                        // origemClasseViaria e origemSaidaParada caem aqui
                        // (contexto intocado na escalacao) DE PROPOSITO, nao
                        // por descuido -- verificado explicitamente (nao só
                        // assumido) ao adicionar o fix de saida_parada
                        // (27/07): tanto detectarDesvio's branch de
                        // quedaClasseViaria quanto o de
                        // viradaErradaSaindoDeParada retornam
                        // `nivel: "atencao"` HARDCODED (sem depender de
                        // score), e nem arbitrarCandidatos nem
                        // reduzirPorTransitoInferido nem
                        // aplicarBonusClasseViaria jamais reescrevem o campo
                        // `nivel` de um alerta (so score/motivo) -- entao um
                        // alerta destas origens NUNCA chega com
                        // `alerta.nivel === "critico"`, e este branch de
                        // escalacao (que exige exatamente isso) e
                        // estruturalmente inalcancavel pra ambas. Se um dia
                        // alguem mudar o nivel hardcoded de uma dessas
                        // regras pra tambem poder ser "critico", este
                        // comentario e o gatilho pra adicionar aqui o mesmo
                        // tratamento de contexto que o insert acima ja tem
                        // (contextoClasseViaria / contextoSaidaParada) --
                        // senao a escalacao voltaria a gravar contexto
                        // desatualizado (o antigo, da criacao original) em
                        // vez do contexto do episodio que causou a
                        // escalacao, reintroduzindo silenciosamente o mesmo
                        // bug de perda de dado corrigido aqui.
                        //
                        // rumo_diverge (Task 3, achado 28/07): mesma logica
                        // se aplica (nivel "atencao" HARDCODED em
                        // detectores.ts, branch nunca alcancavel aqui), mas
                        // ela NAO cai neste `: {}` -- diferente de
                        // classe_viaria/saida_parada, rumo_diverge e'
                        // INCLUIDA em ehDesvio (via
                        // desvioInicioEfetivoParaContexto), entao already
                        // cai no branch `ehDesvio` acima, nao aqui.
                        : {}),
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
              entregas_feitas, entregas_total, local, desvio_streak, rumo,
              ultimo_evento, ultimo_evento_em, desvio_inicio, fora_tapete_streak,
              divergencia_rumo_streak, aproximando_streak, origem_celula,
              no_raio_alvo_codigo, no_raio_desde, no_raio_dwell_segundos,
              ultima_via_principal_em, divergencia_rumo_inicio, saiu_parada_confirmada_em,
              perto_sem_marcacao_codigo, perto_sem_marcacao_segundos,
              divergencia_rumo_caminho_m, placar_desvio, placar_desvio_estado)
           SELECT
             c.veiculo_id, c.lat, c.lng,
             ST_SetSRID(ST_MakePoint(c.lng, c.lat), 4326)::geography,
             c.velocidade, c.ignicao, c.atraso_min, c.panico, c.bau_aberto,
             c.nivel, c.motivo, c.datagps::timestamptz, c.parado_desde::timestamptz,
             c.updated_at::timestamptz, c.entregas_feitas, c.entregas_total, c.local,
             c.desvio_streak, c.rumo, c.ultimo_evento, c.updated_at::timestamptz,
             c.desvio_inicio::jsonb, c.fora_tapete_streak, c.divergencia_rumo_streak,
             c.aproximando_streak, c.origem_celula, c.no_raio_alvo_codigo,
             c.no_raio_desde::timestamptz, c.no_raio_dwell_segundos,
             c.ultima_via_principal_em::timestamptz, c.divergencia_rumo_inicio::jsonb,
             c.saiu_parada_confirmada_em::timestamptz,
             c.perto_sem_marcacao_codigo, c.perto_sem_marcacao_segundos,
             c.divergencia_rumo_caminho_m, c.placar_desvio, c.placar_desvio_estado::jsonb
           FROM unnest(
             $1::uuid[], $2::float8[], $3::float8[], $4::float8[], $5::boolean[],
             $6::integer[], $7::boolean[], $8::boolean[], $9::text[], $10::text[],
             $11::text[], $12::text[], $13::text[], $14::integer[], $15::integer[],
             $16::text[], $17::integer[], $18::integer[], $19::text[], $20::text[],
             $21::integer[], $22::integer[], $23::integer[], $24::text[], $25::integer[],
             $26::text[], $27::integer[], $28::text[], $29::text[], $30::text[],
             $31::integer[], $32::integer[], $33::float8[], $34::numeric[], $35::text[]
           ) AS c(veiculo_id, lat, lng, velocidade, ignicao, atraso_min, panico,
                  bau_aberto, nivel, motivo, datagps, parado_desde, updated_at,
                  entregas_feitas, entregas_total, local, desvio_streak, rumo,
                  ultimo_evento, desvio_inicio, fora_tapete_streak, divergencia_rumo_streak,
                  aproximando_streak, origem_celula, no_raio_alvo_codigo, no_raio_desde,
                  no_raio_dwell_segundos, ultima_via_principal_em, divergencia_rumo_inicio,
                  saiu_parada_confirmada_em, perto_sem_marcacao_codigo,
                  perto_sem_marcacao_segundos, divergencia_rumo_caminho_m,
                  placar_desvio, placar_desvio_estado)
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
                                  THEN EXCLUDED.ultimo_evento_em ELSE posicoes_atuais.ultimo_evento_em END,
             fora_tapete_streak = EXCLUDED.fora_tapete_streak,
             divergencia_rumo_streak = EXCLUDED.divergencia_rumo_streak,
             aproximando_streak = EXCLUDED.aproximando_streak,
             origem_celula      = EXCLUDED.origem_celula,
             no_raio_alvo_codigo = EXCLUDED.no_raio_alvo_codigo,
             no_raio_desde       = EXCLUDED.no_raio_desde,
             no_raio_dwell_segundos = EXCLUDED.no_raio_dwell_segundos,
             ultima_via_principal_em = EXCLUDED.ultima_via_principal_em,
             divergencia_rumo_inicio = EXCLUDED.divergencia_rumo_inicio,
             saiu_parada_confirmada_em = EXCLUDED.saiu_parada_confirmada_em,
             perto_sem_marcacao_codigo = EXCLUDED.perto_sem_marcacao_codigo,
             perto_sem_marcacao_segundos = EXCLUDED.perto_sem_marcacao_segundos,
             divergencia_rumo_caminho_m = EXCLUDED.divergencia_rumo_caminho_m,
             placar_desvio = EXCLUDED.placar_desvio,
             placar_desvio_estado = EXCLUDED.placar_desvio_estado`,
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
            posicoesCiclo.map((p) => p.fora_tapete_streak),
            posicoesCiclo.map((p) => p.divergencia_rumo_streak),
            posicoesCiclo.map((p) => p.aproximando_streak),
            posicoesCiclo.map((p) => p.origem_celula),
            posicoesCiclo.map((p) => p.no_raio_alvo_codigo),
            posicoesCiclo.map((p) => p.no_raio_desde),
            posicoesCiclo.map((p) => p.no_raio_dwell_segundos),
            posicoesCiclo.map((p) => p.ultima_via_principal_em),
            posicoesCiclo.map((p) => p.divergencia_rumo_inicio),
            posicoesCiclo.map((p) => p.saiu_parada_confirmada_em),
            posicoesCiclo.map((p) => p.perto_sem_marcacao_codigo),
            posicoesCiclo.map((p) => p.perto_sem_marcacao_segundos),
            posicoesCiclo.map((p) => p.divergencia_rumo_caminho_m),
            posicoesCiclo.map((p) => p.placar_desvio),
            posicoesCiclo.map((p) => p.placar_desvio_estado),
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

    // Cerca virtual (modo sombra): grava em batch o que TERIA alertado neste
    // ciclo. Nao-critico: falha aqui nunca derruba o motor.
    if (cercaSombraCiclo.length > 0) {
      const { error: erroSombra } = await supabase.from("cerca_sombra").insert(cercaSombraCiclo);
      if (erroSombra) console.warn(`Aviso: erro ao gravar cerca_sombra: ${erroSombra.message}`);
    }

    // Rumo-diverge (modo sombra, serie temporal): mesmo padrao nao-critico
    // de cercaSombraCiclo -- falha aqui nunca derruba o motor.
    if (rumoDivergeSombraCiclo.length > 0) {
      const { error: erroRumoDivergeSombra } = await supabase.from("rumo_diverge_sombra").insert(rumoDivergeSombraCiclo);
      if (erroRumoDivergeSombra) console.warn(`Aviso: erro ao gravar rumo_diverge_sombra: ${erroRumoDivergeSombra.message}`);
    }

    // Placar de desvio (Fase 1, SOMBRA, log): mesmo padrao nao-critico de
    // cercaSombraCiclo/rumoDivergeSombraCiclo -- falha aqui nunca derruba o
    // motor. Ver docs/superpowers/specs/2026-08-01-placar-desvio-design.md.
    if (placarDesvioLogCiclo.length > 0) {
      const { error: erroPlacarDesvioLog } = await supabase.from("placar_desvio_log").insert(placarDesvioLogCiclo);
      if (erroPlacarDesvioLog) console.warn(`Aviso: erro ao gravar placar_desvio_log: ${erroPlacarDesvioLog.message}`);
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
    // docs/superpowers/plans/2026-07-27-auto-resolucao-rota-concluida-plano.md.
    // Mesmo padrao das outras auto-resolucoes deste arquivo: dedupe por
    // alerta_id, SQL cru com merge de contexto (coalesce+||, nunca
    // overwrite -- preserva lat/lng/geom/tudo que montarContextoDesvio
    // gravou no insert original, so ACRESCENTA o marcador auto_resolvido),
    // status='ativo' como guarda de corrida (nao pisa em cima de uma acao
    // do operador no meio do ciclo), try/catch isolado (nao derruba o
    // ciclo inteiro se o UPDATE falhar). SEM chamar registrarCasosDesvioRevisao
    // -- nao poluir calibracao com veredito de maquina; contaComoRotuloHumano
    // (detectores.ts), usado em recalibrar-desvio/route.ts, ja exclui essas
    // linhas da calibracao so pelo marcador auto_resolvido, sem precisar de
    // mudanca la. Tambem nao precisa de mudanca em mapaTiposSilenciados:
    // contaComoEventoDeSilenciamento (detectores.ts) ja checa
    // contexto.auto_resolvido===true de forma generica.
    if (afastandoRotaConcluidaAutoResolveCiclo.length > 0) {
      const porAlertaAfastando = new Map(afastandoRotaConcluidaAutoResolveCiclo.map((r) => [r.alerta_id, r]));
      const idsAfastando = [...porAlertaAfastando.keys()];
      try {
        await pool.query(
          `UPDATE alertas
           SET status = 'falso_positivo',
               resolvido_em = $3,
               contexto = coalesce(contexto, '{}'::jsonb) || $2::jsonb
           WHERE id = ANY($1::uuid[])
             AND status = 'ativo'`,
          [
            idsAfastando,
            JSON.stringify({
              auto_resolvido: true,
              motivo: "rota concluida e chegou na base",
            }),
            agora.toISOString(),
          ]
        );
      } catch (erroAutoResolveAfastando) {
        console.warn(`Aviso: erro ao auto-resolver afastando-de-destinos (rota concluida): ${String(erroAutoResolveAfastando)}`);
      }
    }

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

    // Upsert batch da familiaridade por veiculo -- mesmo padrao de
    // corredor_celulas acima, so chaveado por veiculo_id. DISTINCT ON evita
    // "ON CONFLICT DO UPDATE command cannot affect row a second time" quando
    // o mesmo veiculo cruza a mesma celula 2x no mesmo ciclo (segmentos
    // interpolados adjacentes).
    if (celulasVeiculoCiclo.length > 0) {
      const pgCelulasVeiculo = await pool.connect();
      try {
        await pgCelulasVeiculo.query(
          `INSERT INTO corredor_celulas_veiculo (veiculo_id, celula, ultimo_visto)
           SELECT DISTINCT ON (c.vid, c.cel) c.vid::uuid, c.cel, current_date
           FROM unnest($1::uuid[], $2::text[]) AS c(vid, cel)
           ORDER BY c.vid, c.cel
           ON CONFLICT (veiculo_id, celula) DO UPDATE
             SET ultimo_visto = EXCLUDED.ultimo_visto
             WHERE corredor_celulas_veiculo.ultimo_visto < EXCLUDED.ultimo_visto`,
          [
            celulasVeiculoCiclo.map((c) => c.veiculo_id),
            celulasVeiculoCiclo.map((c) => c.celula),
          ]
        );
      } catch (errCelulasVeiculo) {
        const msg = `Aviso: erro ao salvar corredor_celulas_veiculo: ${String(errCelulasVeiculo)}`;
        console.warn(msg);
        erros.push(msg);
      } finally {
        pgCelulasVeiculo.release();
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
        // Familiaridade por veiculo: mesma janela de 30 dias do tapete de
        // frota -- ver docs/superpowers/specs/2026-07-21-familiaridade-veiculo-desvio-design.md.
        await pgClean.query(
          `DELETE FROM corredor_celulas_veiculo WHERE ultimo_visto < current_date - 30`
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
