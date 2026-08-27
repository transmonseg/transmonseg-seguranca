// Motor de desvio de rota ALIMENTADO PELO ROMANEIO -- POST /api/motor-romaneio
//
// Por que existe: o motor principal (/api/motor) só enxerga como "destino"
// os alvos vindos da Unitrac. Em 21/08/2026, 14 veículos da Nutry Max
// tinham romaneio do dia mas ZERO alvo na Unitrac (10 deles são a "Escala
// do Pão", cujo romaneio é um documento separado que nunca entra na
// Unitrac) -- sem destino contra o qual medir "afastando de tudo", esses
// carros disparavam desvio o dia inteiro. Esta rota roda A MESMA detecção
// de desvio (mesmas funções puras, mesma sequência, mesmos limiares),
// alimentada pelos pontos do romaneio em vez dos alvos da Unitrac.
//
// REGRA DE OURO (repetida pelo usuário no planejamento): "é tudo igual, só
// muda a fonte dos pontos". Este arquivo IMPORTA as funções de regra da
// Central (@/lib/desvio, @/lib/corredor-confirmacao,
// @/lib/classe-viaria-confirmacao) e as chama na MESMA ordem/com os mesmos
// argumentos -- nunca reimplementa nem ajusta uma regra de desvio. Escreve
// SOMENTE nas tabelas próprias criadas pela Task 1 (romaneio_desvio_estado,
// alertas_romaneio -- ver scripts/migrations/contabo/055_motor_romaneio.sql)
// -- nunca em alertas/desvio_estado/posicoes_atuais/desvio_disparo_log
// (tabelas da Central), só LEITURA nessas. Ver
// docs/superpowers/specs/2026-07-31-central-romaneio-paralela-design.md
// (decisão original de isolar o romaneio da Central) e
// .superpowers/sdd/2026-08-22-motor-romaneio-paralelo/ (task-2-brief.md).
//
// Revisão de 22/08 (task-2-report.md, "fix" section): base e pontos de
// escala ENTRAM na lista de destinos do Sinal A (não são "fonte de ponto de
// entrega" que esta task troca -- são a mesma composição da Central,
// route.ts:1682-1690), o streak zera quando o ciclo é bloqueado (não
// sobrevive indefinidamente), o gate de chegada (suspenderPorChegada) e a
// correção de posição via OSRM /match foram adicionados, os alertas se
// auto-resolvem quando o sinal para, e há uma checagem de idempotência por
// leitura de GPS.
//
// Fix de produção 22/08 (mesmo dia, achado ao vivo): a checagem de
// idempotência comparava datagps (relógio da Unitrac, deslocado ~3h pro
// passado por um bug de fuso em parseDatagps da Central, ver comentário no
// gate abaixo) contra atualizado_em (relógio real do Postgres) -- nunca
// passava depois do primeiro ciclo, o motor parava de vez. Corrigido pra
// comparar datagps-contra-datagps (nova coluna ultimo_datagps, migration
// 056) -- mesmo offset dos dois lados, deixa de importar.

// Revisão final de 22/08 (task-6, findings da revisão ampla que olhou as
// interações entre as partes). O que mudou aqui, tudo copiando a solução que
// a Central já tinha pro mesmo problema: (1) o motor NUNCA fecha alerta de
// desvio -- TIPOS_NAO_GERENCIADOS, com contexto.auto_resolvido no que sobrar
// de auto-resolve; (2) lease de execução única em linha própria de
// motor_lease (id=2), porque os 2 crons por minuto se sobrepõem; (3) timeout
// de 20s na Unitrac; (4) datagps implausível não vira marco de idempotência;
// (5) silenciamento de 2h depois de "falso positivo"; (6) dedup lê
// ativo+reconhecido; (7) streak não atravessa o dia; (8) a posição anterior
// é escolhida por corte de tempo, não por OFFSET. Migration 058 acompanha
// (linha do lease + expiração/retenção de alertas_romaneio).

import pg from "pg";
import { createAdminClient } from "@/lib/supabase/admin";
import { configPoolContabo } from "@/lib/supabase/contabo-ca";
import {
  haversineM,
  agruparPontosPorPlaca,
  suspenderPorChegada,
  alvoMaisProximoQualquer,
  RAIO_CHEGADA_MIN_M,
  type AlvoUnitrac,
  type PontoEntrega,
} from "@/lib/unitrac";
import {
  temCoordenadaValida,
  BONUS_CORROBORACAO_POR_SINAL,
  TIPOS_NAO_GERENCIADOS,
  contaComoEventoDeSilenciamento,
  emHorarioOperacao,
  detectarParadaLonga,
  detectarParadaAnomala,
  detectarParadaForaTapete,
  deveSuprimirRedisparoParada,
  calcularRiscoArea,
  PARADA_FORA_TAPETE_MIN,
  type Alerta,
} from "@/lib/detectores";
import { temPOIProximo } from "@/lib/overpass";
import { obterRouboCarga } from "@/lib/roubocarga";
import { buscarTiroteiosRJ, obterPerfilHorario, type Tiroteio } from "@/lib/fogocruzado";
import { montarPontosDeRomaneio, type LinhaRomaneioGeocodificada } from "@/lib/romaneio";
import { buscarDistanciasReais } from "@/lib/distancia-real";
import { avaliarAfastandoDeTudo, avaliarRuaRara, montarAlertaDesvio, LIMIAR_CARENCIA_BASE_M } from "@/lib/desvio";
import { verificarCorredorFora, aplicarCorroboracaoCorredor } from "@/lib/corredor-confirmacao";
import {
  melhorClasse,
  avaliarQuedaClasseViaria,
  avaliarSaiuParadaConfirmadaRecentemente,
  aplicarCorroboracaoClasseViaria,
  type ClasseViaria,
} from "@/lib/classe-viaria-confirmacao";
import { celulaDe, vizinhanca3x3 } from "@/lib/celulas";
import { dataSP, datagpsPlausivelComoMarco, estadoEhDeOutroDiaSP } from "@/lib/motor-romaneio-estado";
import { corrigirPosicoesComMatch, type ResultadoMatch } from "@/lib/osrm-match";

// Função serverless -- pode levar tempo com OSRM/Unitrac, mesmo teto que a Central.
export const maxDuration = 60;

// Mesmos limiares da Central (route.ts) -- não são "regra de desvio", são
// filtros de qualidade de dado sobre a MESMA função pura (ver comentário de
// cada um em desvio.ts / route.ts).
const LIMIAR_DESTINO_RELEVANTE_M = 50_000;
const LIMIAR_MOVIMENTO_MINIMO_M = 50;
// Mesmo limiar de "fresco" usado por normalizar() em lib/unitrac.ts (atraso
// em minutos desde a última leitura de GPS aceita como válida).
const LIMIAR_ATRASO_FRESCO_MIN = 60;
// Mesmo piso de confiança do /match que a Central usa (route.ts:2551).
const LIMIAR_CONFIANCA_MATCH = 0.5;
// Mesmo timeout de Unitrac da Central (motor/route.ts:72). As falhas de rede
// da Unitrac na Nutry Max são recorrentes o dia todo (comentário da Central
// em 266-273).
const TIMEOUT_UNITRAC_MS = 20_000;
// Mesmo teto de correções via /match por ciclo que a Central usa
// (route.ts:99, constante local não exportada -- mesmo valor, orçamento de
// custo/latência, não regra de desvio).
const MAX_CORRECOES_MATCH_POR_CICLO = 40;

// ─── Detectores de parada (task B1, 27/08) ────────────────────────────────
// Piso do raio pra decidir "o veículo está NO cliente".
//
// USA RAIO_CHEGADA_MIN_M (300m, @/lib/unitrac), NÃO os 150m da Central
// (motor/route.ts:1815-1818). Corrigido na revisão da task B1 -- a versão
// anterior deste comentário citava o comentário de suspenderPorChegada como
// fonte dos 150m, e ele diz exatamente o contrário: 150 é o valor REJEITADO.
// Medição real de 01/08 documentada em unitrac.ts:467-486, cruzando os 4.441
// pontos de entrega geocodificados de 31/07+01/08 contra as paradas reais dos
// caminhões -- com piso de 150m METADE das entregas nunca registrava chegada
// (a faixa 100-300m, 19% do total, é exatamente a que se perde). Foi por isso
// que a constante virou 300.
//
// Por que 150 pode estar certo lá e errado aqui: na Central o piso é aplicado
// a ALVO DA UNITRAC (geofence cadastrado, coordenada conferida pela operação);
// aqui é aplicado a ENDEREÇO GEOCODIFICADO do romaneio -- justamente a fonte
// de menor precisão que aquela medição mediu. Com 150m, caminhão de verdade
// parado no cliente mas a 150-300m do ponto geocodificado vira noCliente=false
// e dispara parada_anomala aos 12min: o MESMO falso positivo que motivou
// desligar esses 3 detectores pra este cliente em 26/08 (e um detector que
// inunda acaba desligado, o que zera o recall de vez -- foi o que aconteceu).
//
// Consequência aceita e consciente: dentro da bolha de 300m em torno de um
// ponto do romaneio os 3 detectores de parada ficam mudos. É a mesma bolha
// que suspenderPorChegada (mesma constante) já usa NESTE arquivo pra suspender
// o Sinal A -- antes desta correção a rota respondia "tá no cliente?" com dois
// números diferentes (300 no desvio, 150 na parada).
const PISO_RAIO_NO_CLIENTE_M = RAIO_CHEGADA_MIN_M;
// Raio de congestionamento -- mesmo valor da Central (route.ts:1339,
// constante local não exportada lá): 2+ outros veículos parados dentro dele
// é trânsito/fila, não roubo.
const RAIO_CONGESTION_M = 250;
// Piso de cobertura do tapete antes de confiar em "fora de via conhecida" --
// mesmo valor e mesmo motivo da Central (route.ts:1777): tapete recém-criado
// faz TODO veículo parecer fora de via conhecida (ruído de cold-start).
const TAPETE_MIN_CELULAS = 300;
// Cooldown de re-disparo por episódio de parada (deveSuprimirRedisparoParada,
// @/lib/detectores) -- só conta tratamento INDIVIDUAL do operador, nunca ação
// em massa. Mesmos valores da Central (route.ts:1437-1447).
const ORIGENS_TRATAMENTO_INDIVIDUAL = ["resolver_individual", "falso_individual"];
const LOOKBACK_PARADAS_TRATADAS_MS = 6 * 60 * 60 * 1000;
// Tipos de parada que têm cooldown por episódio na Central -- parada_fora_tapete
// fica de fora lá (route.ts:3207-3208) e fica de fora aqui, pela mesma razão.
const TIPOS_PARADA_COM_COOLDOWN = new Set(["parada_anomala", "parada_longa"]);
// Os 3 tipos que esta rota passou a produzir na task B1 -- usados pra decidir
// quais alertas em aberto este ciclo tem autoridade pra FECHAR (ver
// podeFecharParadas no loop).
const TIPOS_PARADA = new Set(["parada_anomala", "parada_longa", "parada_fora_tapete"]);

// "O veículo está parado NO cliente?" -- calculado EXCLUSIVAMENTE com os
// pontos do romaneio geocodificado deste veículo (a mesma lista que alimenta
// o Sinal A). Decisão de produto explícita e definitiva do dono (27/08): a
// Central Romaneio NUNCA lê marcação/alvo da Unitrac; da Unitrac só vem o
// rastro (lat/lng/velocidade), que é o que entra aqui como `pos`.
//
// Mesma fórmula da Central (motor/route.ts:1814-1818) -- só a FONTE dos
// pontos muda, a regra é idêntica de propósito. Considera ponto feito E
// pendente (alvoMaisProximoQualquer): a pergunta é "estou dentro do raio de
// algum cliente da minha rota", não "tenho entrega pendente aqui".
export function calcularNoClienteRomaneio(
  pos: { lat: number; lng: number; velocidade: number | null },
  pontosRomaneio: PontoEntrega[]
): boolean {
  if (pos.velocidade !== 0) return false;
  // temCoordenadaValida: sem esse filtro um ponto (0,0) (geocode que falhou e
  // não teve fallback) viraria um "cliente" a ~5.300km -- ver o comentário da
  // função em detectores.ts.
  const maisProximo = alvoMaisProximoQualquer(pos.lat, pos.lng, pontosRomaneio.filter(temCoordenadaValida));
  if (maisProximo === null) return false;
  return maisProximo.distM <= Math.max(maisProximo.ponto.raio, PISO_RAIO_NO_CLIENTE_M);
}

// Roda os 3 detectores de parada de @/lib/detectores (funções PURAS, já
// testadas em detectores.test.ts -- esta função NUNCA reimplementa a decisão
// deles, só liga o contexto da Central Romaneio na assinatura de cada um).
//
// Diferença deliberada em relação à Central: NÃO passa entregasFeitas/
// entregasTotal pra detectarParadaLonga. Lá esses campos calam o alerta
// quando a rota acabou, porque lá detectarRetornoTardio cobre esse caso;
// aqui não existe retorno_tardio, então passá-los seria falso negativo puro
// (ver [[feedback_desvio_priorizar_recall]]).
export function avaliarParadasRomaneio(ctx: {
  paradoMin: number;
  emOperacao: boolean;
  foraDaBase: boolean;
  noCliente: boolean;
  estavEmMovimento: boolean;
  esMadrugada: boolean;
  temPOIProximo: boolean;
  jaParedoNoCicloAnterior: boolean;
  vizinhosParados: number;
  dentroTapete: boolean | null;
  riscoAreaAtual: number;
}): Alerta[] {
  return [
    detectarParadaLonga({
      paradoMin: ctx.paradoMin,
      emOperacao: ctx.emOperacao,
      foraDaBase: ctx.foraDaBase,
      noCliente: ctx.noCliente,
      temPOIProximo: ctx.temPOIProximo,
    }),
    detectarParadaAnomala({
      paradoMin: ctx.paradoMin,
      emOperacao: ctx.emOperacao,
      foraDaBase: ctx.foraDaBase,
      noCliente: ctx.noCliente,
      estavEmMovimento: ctx.estavEmMovimento,
      esMadrugada: ctx.esMadrugada,
      // Mesma decisão da Central (route.ts:2438): o sinal de área de risco
      // entra pelo riscoAreaAtual (parada_fora_tapete), não por este flag.
      emZonaRisco: false,
      temPOIProximo: ctx.temPOIProximo,
      jaParedoNoCicloAnterior: ctx.jaParedoNoCicloAnterior,
      vizinhosParados: ctx.vizinhosParados,
    }),
    detectarParadaForaTapete({
      paradoMin: ctx.paradoMin,
      emOperacao: ctx.emOperacao,
      foraDaBase: ctx.foraDaBase,
      noCliente: ctx.noCliente,
      dentroTapete: ctx.dentroTapete,
      temPOIProximo: ctx.temPOIProximo,
      vizinhosParados: ctx.vizinhosParados,
      riscoAreaAtual: ctx.riscoAreaAtual,
    }),
  ].filter((a): a is Alerta => a !== null);
}

// dentroTapete de UM veículo -- `null` significa "não sei" e NUNCA dispara
// parada_fora_tapete (nem autoriza fechar um em aberto). Dois motivos
// diferentes produzem null de propósito: cobertura abaixo de
// TAPETE_MIN_CELULAS (cold-start, mesma cautela da Central) e leitura do
// tapete não confiável neste ciclo (`confiavel=false`, ver as duas queries de
// corredor_celulas). Sem o segundo caso, uma falha só na query de células
// deixaria a contagem alta com o conjunto vazio e TODO veículo candidato
// pareceria "fora do tapete" -- flood fleet-wide (achado da revisão da B1).
export function avaliarDentroTapete(ctx: {
  confiavel: boolean;
  contagemCelulasCliente: number;
  celulasCliente: Set<string>;
  lat: number;
  lng: number;
}): boolean | null {
  if (!ctx.confiavel) return null;
  if (ctx.contagemCelulasCliente < TAPETE_MIN_CELULAS) return null;
  return vizinhanca3x3(ctx.lat, ctx.lng).some((c) => ctx.celulasCliente.has(c));
}

// Este ciclo tem autoridade pra FECHAR (auto-resolve pela máquina) um alerta
// gerenciado que está em aberto? Achado da revisão da B1: antes da task nada
// nesta tabela era gerenciado e este caminho nunca executava; agora ele roda
// todo ciclo, e "o detector não disparou" pode significar tanto "a condição
// acabou" (fechar é o certo) quanto "não deu pra avaliar" -- Overpass fora do
// ar, congestionamento não lido, parado_desde ausente, GPS atrasado. Fechar
// no segundo caso apaga da tela um alerta antirroubo real, sem ninguém ter
// tratado. Só fecha o que foi de fato avaliado.
export function deveResolverAlertaGerenciado(ctx: {
  tipo: string;
  disparouNesteCiclo: boolean;
  silenciado: boolean;
  podeFecharParadas: boolean;
  podeFecharForaTapete: boolean;
}): boolean {
  if (ctx.disparouNesteCiclo || ctx.silenciado) return false;
  if (ctx.tipo === "parada_fora_tapete") return ctx.podeFecharForaTapete;
  if (TIPOS_PARADA.has(ctx.tipo)) return ctx.podeFecharParadas;
  // Qualquer outro tipo gerenciado que venha a existir nesta tabela:
  // comportamento de antes da task B1, inalterado.
  return true;
}

// Trava de execução única deste ciclo -- MESMO mecanismo da Central
// (motor/route.ts:497-528): lease com expiração por UPDATE atômico em
// motor_lease. Motivo medido na Central (comentário dela em 247-264): sem
// trava, dois ciclos sobrepostos leem o mesmo snapshot de alertas abertos,
// ambos inserem, e o UPSERT de estado vira last-write-wins -- até 34
// alertas de desvio por dia pro mesmo veículo. Esta rota tem exatamente a
// mesma exposição: os 2 jobs de pg_cron (057) disparam no mesmo minuto (um
// na hora exata, outro com pg_sleep(30)), então basta um ciclo passar de
// 30s pra eles se sobreporem.
//
// NUNCA trocar por pg_try_advisory_lock: na Central o advisory lock ficava
// preso por tempo indeterminado (64-88% dos ciclos pulados, achado de
// 10-11/07).
//
// LINHA PRÓPRIA (id = 2, criada pela migration 058). A id = 1 é da Central
// -- usar a mesma linha faria um motor bloquear o outro, e os dois PRECISAM
// rodar ao mesmo tempo pros mesmos carros (o produto da entrega é comparar
// os dois pipelines no mesmo dia).
const MOTOR_ROMANEIO_LEASE_ID = 2;
// 90s > maxDuration=60s: mesmo raciocínio (e mesmo número) da Central. O
// lease tem que sobreviver ao ciclo mais longo possível -- se expirasse
// antes, um ciclo ainda vivo perderia a trava e o disparo seguinte entraria
// em paralelo com ele, que é exatamente o que a trava existe pra impedir. E
// como é lease (não lock), um ciclo que morra no meio libera sozinho em 90s.
const LEASE_EXPIRACAO_SQL = "90 seconds";

// Data de HOJE em São Paulo. NUNCA trocar por current_date do Postgres: o
// servidor roda em CEST (UTC+2) e o Brasil é UTC-3 -- o dia do banco vira 5h
// antes do dia brasileiro. Implementação compartilhada com
// estadoEhDeOutroDiaSP (@/lib/motor-romaneio-estado) pra que "o dia" seja
// literalmente a mesma conta nos dois lugares.
function hojeSP(): string {
  return dataSP(new Date());
}

function criaPgPool() {
  return new pg.Pool({ ...configPoolContabo(process.env.DATABASE_URL), max: 3 });
}

// buscarAlvos COM timeout -- cópia local do padrão da Central
// (motor/route.ts:308-336, buscarAlvosComTimeout). A Central nunca usa a
// função crua no motor, e por um motivo concreto: buscarAlvos de
// @/lib/unitrac faz fetch SEM signal, então uma Unitrac que aceita a conexão
// e não responde deixa o fetch pendurado até o headersTimeout default do
// undici (~300s). Nesses 5 minutos o ciclo não termina, o
// `finally { pool.end() }` não roda, e o cron dispara ~10 ciclos novos --
// cada um também pendurado, cada um segurando seu pool. (Com o lease do
// commit anterior os ciclos novos agora só pulam, mas o ciclo travado
// continua segurando pool e lease até o undici desistir -- o timeout é o
// que fecha esse buraco de verdade.)
//
// DELIBERADAMENTE local, não um fix em @/lib/unitrac: mudar buscarAlvos lá
// afetaria TODOS os chamadores, inclusive a Central em produção -- mudança
// de comportamento da Central, proibida nesta entrega. Mesmo argumento que a
// Central usou pra reescrever o fetch inline em vez de mexer no módulo.
async function buscarAlvosComTimeout(cvs: string[]): Promise<AlvoUnitrac[]> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TIMEOUT_UNITRAC_MS);
  try {
    const res = await fetch("https://datalayer.portalunitrac.com/mapa_servicos/alvos", {
      method: "POST",
      headers: { accept: "application/json", "content-type": "application/json" },
      body: JSON.stringify(cvs),
      signal: controller.signal,
    });
    if (!res.ok) throw new Error(`buscarAlvos HTTP ${res.status}`);
    const data = (await res.json()) as { alvos?: AlvoUnitrac[] };
    return data.alvos ?? [];
  } finally {
    clearTimeout(timer);
  }
}

type Ponto = { lat: number; lng: number };

type LinhaRomaneioPontoDb = {
  veiculo_id: string;
  placa: string;
  nf: string;
  cliente_nome: string;
  // Nulos quando o geocode desta linha falhou -- fallback pra coordenada da
  // Unitrac fica por conta de montarPontosDeRomaneio (@/lib/romaneio).
  lat: number | null;
  lng: number | null;
  presenca_confirmada_em: string | null;
};

type VeiculoInfo = { id: string; placa: string; cv: string; cliente_id: string };

type EstadoAnterior = {
  afastando_streak: number;
  rua_rara_streak: number;
  ultima_via_principal_em: Date | null;
  saiu_parada_confirmada_em: Date | null;
  atualizado_em: Date | null;
  ultimo_datagps: Date | null;
};

type AlertaAtivoRow = {
  id: string;
  tipo: string;
  nivel: "critico" | "atencao";
  // Lido pra poder PRESERVAR o contexto existente ao marcar auto_resolvido
  // (ver resolverPelaMaquina) -- sobrescrever com {"auto_resolvido":true}
  // apagaria origem_desvio, que é o insumo da comparação entre os dois
  // pipelines.
  contexto: Record<string, unknown> | null;
};

// Fecha alertas_romaneio POR AÇÃO DA MÁQUINA, marcando contexto.auto_resolvido.
// Mesma semântica do marcador que a Central usa (contexto.auto_expirado no cron
// 'expirar-alertas-ativos-esquecidos', 002_retencao.sql; contexto.auto_resolvido
// lido por contaComoEventoDeSilenciamento/contaComoRotuloHumano em
// src/lib/detectores.ts:580-625): sem ele, uma contagem futura não distingue
// "a máquina fechou" de "o operador clicou Resolver" -- e comparar os dois
// pipelines por essa contagem é justamente o produto desta entrega.
//
// Update por linha (e não um único .in("id", ...)): o merge do contexto é
// por linha, e o PostgREST não faz `contexto || '{...}'::jsonb` num update em
// lote. Custo irrelevante -- hoje esta função nunca recebe nada (ver
// TIPOS_NAO_GERENCIADOS no Step 9).
async function resolverPelaMaquina(
  admin: ReturnType<typeof createAdminClient>,
  alertas: AlertaAtivoRow[],
  agoraIso: string
): Promise<string | null> {
  for (const a of alertas) {
    const { error } = await admin
      .from("alertas_romaneio")
      .update({
        status: "resolvido",
        resolvido_em: agoraIso,
        contexto: { ...(a.contexto ?? {}), auto_resolvido: true },
      })
      .eq("id", a.id);
    if (error) return error.message;
  }
  return null;
}

export async function POST(request: Request) {
  const chave = request.headers.get("x-motor-key");
  if (!chave || chave !== process.env.MOTOR_SECRET) {
    return Response.json({ erro: "nao autorizado" }, { status: 401 });
  }

  const admin = createAdminClient();
  const pool = criaPgPool();

  // Lease (ver MOTOR_ROMANEIO_LEASE_ID acima). Adquirido ANTES de qualquer
  // leitura: o ciclo inteiro é uma sequência ler-decidir-escrever, e ler
  // fora da trava já basta pra duas execuções verem o mesmo "zero alertas
  // ativos" e inserirem duas vezes.
  let leaseToken: string | null = null;
  {
    const lockClient = await pool.connect();
    try {
      const { rows: leaseRows } = await lockClient.query<{ token: string }>(
        `update motor_lease
            set expira_em = now() + interval '${LEASE_EXPIRACAO_SQL}',
                token = gen_random_uuid(),
                adquirido_em = now()
          where id = $1 and expira_em < now()
        returning token`,
        [MOTOR_ROMANEIO_LEASE_ID]
      );
      leaseToken = leaseRows[0]?.token ?? null;
    } finally {
      lockClient.release();
    }
  }
  if (!leaseToken) {
    // Duas causas produzem EXATAMENTE o mesmo UPDATE de 0 linhas: (a) o
    // ciclo anterior ainda está rodando -- normal, esperado; (b) a linha
    // id=2 não existe porque a migration 058 nunca foi aplicada -- e aí o
    // motor fica inerte PRA SEMPRE, 100% dos ciclos pulados. Sem distinguir
    // as duas, (b) se disfarça de (a): HTTP 200, 'succeeded' no
    // cron.job_run_details, nada em erros[], e um motivo que manda o
    // investigador procurar um ciclo travado que não existe -- string
    // indistinguível, ainda por cima, do `pulado` legítimo da Central que
    // fica na mesma net._http_response. Uma query a mais, só neste caminho.
    let leaseExiste = true;
    try {
      const { rows } = await pool.query(`select 1 from motor_lease where id = $1`, [
        MOTOR_ROMANEIO_LEASE_ID,
      ]);
      leaseExiste = rows.length > 0;
    } catch {
      // Falha de leitura não é prova de ausência -- mantém o diagnóstico
      // conservador (assume que a linha existe e o ciclo está só ocupado).
    }
    // Fecha o pool antes de sair, igual à Central (route.ts:522-528) -- sem
    // isso cada ciclo pulado deixaria um pool de até 3 conexões pendurado.
    await pool.end();
    if (!leaseExiste) {
      const msg =
        `CRITICO: a linha ${MOTOR_ROMANEIO_LEASE_ID} de motor_lease nao existe -- ` +
        `a migration 058 (058_motor_romaneio_lease_e_retencao.sql) nao foi aplicada neste banco. ` +
        `O motor-romaneio NAO esta rodando: todo ciclo e pulado por falta da linha de lease, nao por ciclo em andamento.`;
      console.error(msg);
      return Response.json({ pulado: true, motivo: msg });
    }
    return Response.json({
      pulado: true,
      motivo: "ciclo anterior do motor-romaneio ainda em execucao",
    });
  }

  const agora = new Date();
  const erros: string[] = [];
  let veiculosProcessados = 0;
  let alertasGerados = 0;
  // Orçamento de correção via /match compartilhado pelo ciclo inteiro --
  // mesmo padrão de contadorCorrecoesMatch em route.ts:548.
  const contadorCorrecoesMatch = { valor: 0 };

  try {
    const hoje = hojeSP();

    // Só veículos com romaneio utilizável de hoje (ver task-2-brief.md, Step 3).
    // NÃO filtra por geocode_status/lat/lng aqui (removido na task-5, ver
    // task-5-brief.md): uma NF cujo geocode falhou ainda entra na lista --
    // montarPontosDeRomaneio (@/lib/romaneio) resolve a coordenada dela via
    // fallback pelo alvo da Unitrac que casa por NF, ou descarta a linha se
    // nem isso existir. Filtrar geocode_status aqui faria a NF sumir ANTES
    // desse fallback rodar, reabrindo o buraco que esta task fecha.
    const { rows: linhasRomaneio } = await pool.query<LinhaRomaneioPontoDb>(
      `SELECT veiculo_id, placa, nf, cliente_nome, lat, lng, presenca_confirmada_em
         FROM romaneio_pontos
        WHERE romaneio_data = $1::date
          AND modo_teste = false
          AND veiculo_id IS NOT NULL`,
      [hoje]
    );

    if (linhasRomaneio.length === 0) {
      return Response.json({ veiculosProcessados: 0, alertasGerados: 0, erros });
    }

    const romaneioPorVeiculo = new Map<string, LinhaRomaneioPontoDb[]>();
    for (const l of linhasRomaneio) {
      const lista = romaneioPorVeiculo.get(l.veiculo_id) ?? [];
      lista.push(l);
      romaneioPorVeiculo.set(l.veiculo_id, lista);
    }
    const veiculoIds = [...romaneioPorVeiculo.keys()];

    const { data: veiculosData, error: erroVeiculos } = await admin
      .from("veiculos")
      .select("id, placa, cv, cliente_id")
      .in("id", veiculoIds);
    if (erroVeiculos) {
      return Response.json({ erro: `falha ao ler veiculos: ${erroVeiculos.message}` }, { status: 500 });
    }
    const veiculoInfoPorId = new Map<string, VeiculoInfo>(
      ((veiculosData ?? []) as VeiculoInfo[]).map((v) => [v.id, v])
    );

    // Status feito/pendente por NF continua vindo da Unitrac (ver brief Step 2) --
    // o romaneio só dá a lista/coordenada. Falha aqui não impede o ciclo: sem
    // status Unitrac, montarPontosDeRomaneio trata tudo como pendente (fail-open
    // pró-recall, nunca esconde um desvio real).
    const cvsUnicos = [...new Set(
      [...veiculoInfoPorId.values()].map((v) => v.cv).filter((cv): cv is string => !!cv)
    )];
    let pontosUnitracPorPlaca = new Map<string, PontoEntrega[]>();
    if (cvsUnicos.length > 0) {
      try {
        // Com timeout de 20s (ver buscarAlvosComTimeout acima). O catch
        // abaixo continua fail-open pró-recall: sem alvos, o ciclo segue só
        // com o romaneio, tratando tudo como pendente.
        const alvos = await buscarAlvosComTimeout(cvsUnicos);
        pontosUnitracPorPlaca = agruparPontosPorPlaca(alvos);
      } catch (errUnitrac) {
        erros.push(`Aviso: falha ao buscar alvos Unitrac (segue so com romaneio, tudo pendente): ${String(errUnitrac)}`);
      }
    }

    // posicoes_atuais -- mesma fonte da Central, SOMENTE LEITURA. datagps
    // entra pra idempotência (ver I3 do fix de 22/08): sem isso não dá pra
    // saber se esta leitura já foi avaliada num ciclo anterior.
    const { data: posAtuaisRows, error: erroPosAtuais } = await admin
      .from("posicoes_atuais")
      .select("veiculo_id, lat, lng, velocidade, atraso_min, datagps, updated_at, parado_desde")
      .in("veiculo_id", veiculoIds);
    if (erroPosAtuais) {
      erros.push(`Erro ao ler posicoes_atuais: ${erroPosAtuais.message}`);
    }
    type PosAtual = {
      veiculo_id: string; lat: number | null; lng: number | null;
      velocidade: number | null; atraso_min: number | null; datagps: string | null;
      // Início do episódio de parada, calculado e gravado pela Central a cada
      // ciclo (motor/route.ts:1559-1575) -- SOMENTE LEITURA aqui. É a única
      // fonte de "há quanto tempo este veículo está parado" que existe hoje;
      // esta rota não mantém acumulador próprio. Null (veículo em movimento,
      // ou Central ainda não escreveu) => paradoMin fica 0 e nenhum detector
      // de parada dispara -- nunca inventa tempo parado.
      parado_desde: string | null;
      // Quando a Central gravou ESTA leitura (relógio do Postgres). Usado só
      // pra achar a posição ANTERIOR sem ambiguidade -- ver a query de
      // `anterior` no loop.
      updated_at: string | null;
    };
    const posAtualPorVeiculo = new Map<string, PosAtual>(
      ((posAtuaisRows ?? []) as PosAtual[]).map((p) => [p.veiculo_id, p])
    );

    // Estado anterior -- tabela PRÓPRIA (romaneio_desvio_estado, migration 055
    // + 056). ultimo_datagps entra pra idempotência (I3, revisado 22/08 --
    // ver comentário no gate mais abaixo pro motivo de NÃO usar atualizado_em).
    const { rows: estadoRows } = await pool.query<{ veiculo_id: string } & EstadoAnterior>(
      `SELECT veiculo_id, afastando_streak, rua_rara_streak, ultima_via_principal_em, saiu_parada_confirmada_em, atualizado_em, ultimo_datagps
         FROM romaneio_desvio_estado
        WHERE veiculo_id = ANY($1::uuid[])`,
      [veiculoIds]
    );
    const estadoPorVeiculo = new Map(estadoRows.map((r) => [r.veiculo_id, r]));

    // Frequência de célula por cliente (Sinal B, rua rara) -- tabela da
    // Central (celula_frequencia_cliente), SOMENTE LEITURA: já é alimentada
    // pelo motor principal a cada ciclo pra TODA a frota (inclusive estes
    // veículos, que continuam sendo processados por /api/motor pros outros
    // detectores) -- esta rota não precisa (nem deve) escrever nela de novo.
    const clienteIdsUnicos = [...new Set([...veiculoInfoPorId.values()].map((v) => v.cliente_id))];
    const freqCelulaPorCliente = new Map<string, Map<string, number>>();
    if (clienteIdsUnicos.length > 0) {
      try {
        const { rows } = await pool.query<{ cliente_id: string; celula: string; n_visitas: number }>(
          `SELECT cliente_id, celula, n_visitas FROM celula_frequencia_cliente WHERE cliente_id = ANY($1::uuid[])`,
          [clienteIdsUnicos]
        );
        for (const r of rows) {
          const mapa = freqCelulaPorCliente.get(r.cliente_id) ?? new Map<string, number>();
          mapa.set(r.celula, r.n_visitas);
          freqCelulaPorCliente.set(r.cliente_id, mapa);
        }
      } catch (errFreq) {
        erros.push(`Aviso: falha ao ler celula_frequencia_cliente: ${String(errFreq)}`);
      }
    }

    // Classificação viária por célula (corroboração) -- tabela da Central
    // (vias_celulas), SOMENTE LEITURA. Batched pela vizinhança 3x3 de toda
    // posição válida deste ciclo, mesmo padrão da Central.
    let classePorCelula = new Map<string, ClasseViaria>();
    try {
      const celulasCandidatas = new Set<string>();
      for (const p of posAtualPorVeiculo.values()) {
        if (p.lat != null && p.lng != null) {
          for (const c of vizinhanca3x3(p.lat, p.lng)) celulasCandidatas.add(c);
        }
      }
      if (celulasCandidatas.size > 0) {
        const { rows } = await pool.query<{ celula: string; classe: ClasseViaria }>(
          `SELECT celula, classe FROM vias_celulas WHERE celula = ANY($1::text[])`,
          [[...celulasCandidatas]]
        );
        classePorCelula = new Map(rows.map((r) => [r.celula, r.classe]));
      }
    } catch (errClasse) {
      erros.push(`Aviso: falha ao classificar via em lote: ${String(errClasse)}`);
    }

    // Bases do cliente (centróide) -- entram tanto no gate de carência de
    // base (LIMIAR_CARENCIA_BASE_M) quanto na lista de destinos do Sinal A
    // (ver C2 do fix de 22/08 -- mesma composição de route.ts:1682-1690:
    // pendentes + bases + escala). Leitura direta do centróide via PostGIS
    // -- não precisa da malha completa do polígono (basesCliente/pontoEmGeo/
    // foraDaBase da Central), só distância/ponto.
    const centroideBasePorCliente = new Map<string, Ponto[]>();
    if (clienteIdsUnicos.length > 0) {
      try {
        const { rows } = await pool.query<{ cliente_id: string; lat: number; lng: number }>(
          `SELECT cliente_id, ST_Y(ST_Centroid(geom::geometry)) AS lat, ST_X(ST_Centroid(geom::geometry)) AS lng
             FROM bases WHERE cliente_id = ANY($1::uuid[])`,
          [clienteIdsUnicos]
        );
        for (const r of rows) {
          const lista = centroideBasePorCliente.get(r.cliente_id) ?? [];
          lista.push({ lat: r.lat, lng: r.lng });
          centroideBasePorCliente.set(r.cliente_id, lista);
        }
      } catch (errBases) {
        erros.push(`Aviso: falha ao ler bases: ${String(errBases)}`);
      }
    }

    // ─── Insumos dos 3 detectores de parada (task B1) ────────────────────
    // Tudo abaixo é LEITURA de tabela própria do cliente/da Central -- nada
    // aqui é marcação/alvo da Unitrac (o único dado da Unitrac que a Central
    // Romaneio usa continua sendo o rastro em posicoes_atuais).

    // foraDaBase de VERDADE (point-in-polygon contra o perímetro real da
    // base), não distância ao centróide -- mesma pergunta que a Central faz
    // com pontoEmGeo (route.ts:1581). Batch único pra todo o ciclo. Falha de
    // leitura => ninguém fica marcado como "dentro", ou seja, foraDaBase=true
    // pra todos: MESMO fail-open da Central ("sem bases = foraDaBase=true
    // para todos", route.ts:660) e o lado certo do erro pro nosso domínio
    // (alerta a mais, nunca desvio real perdido).
    const veiculosDentroDeBase = new Set<string>();
    {
      const idsComPos: string[] = [];
      const latsPos: number[] = [];
      const lngsPos: number[] = [];
      for (const p of posAtualPorVeiculo.values()) {
        if (p.lat != null && p.lng != null) {
          idsComPos.push(p.veiculo_id);
          latsPos.push(p.lat);
          lngsPos.push(p.lng);
        }
      }
      if (idsComPos.length > 0) {
        try {
          const { rows } = await pool.query<{ veiculo_id: string }>(
            `SELECT DISTINCT p.veiculo_id
               FROM unnest($1::uuid[], $2::float8[], $3::float8[]) AS p(veiculo_id, lat, lng)
               JOIN veiculos v ON v.id = p.veiculo_id
               JOIN bases b ON b.cliente_id = v.cliente_id
              WHERE ST_Contains(b.geom::geometry, ST_SetSRID(ST_MakePoint(p.lng, p.lat), 4326))`,
            [idsComPos, latsPos, lngsPos]
          );
          for (const r of rows) veiculosDentroDeBase.add(r.veiculo_id);
        } catch (errBase) {
          erros.push(`Aviso: falha ao checar veiculo dentro de base (segue como fora da base): ${String(errBase)}`);
        }
      }
    }

    // Tapete do cliente (corredor_celulas, tabela da Central, SOMENTE
    // LEITURA) -- alimenta dentroTapete de detectarParadaForaTapete. Mesma
    // mecânica da Central: contagem total por cliente pro piso
    // TAPETE_MIN_CELULAS + só as células candidatas (a mesma vizinhança 3x3
    // já montada acima pra vias_celulas), nunca o tapete inteiro.
    //
    // tapeteConfiavel (achado da revisão da task B1): as DUAS queries abaixo
    // têm que ter dado certo pro sinal valer. Se só a segunda falhasse, a
    // contagem ficaria >= TAPETE_MIN_CELULAS com o conjunto de células VAZIO,
    // e aí `dentroTapete` viraria FALSE (não null) pra TODO veículo candidato
    // do ciclo -- ou seja, toda parada fora do cliente dispararia
    // parada_fora_tapete de uma vez, um flood fleet-wide disfarçado de
    // fail-open. Com a flag, falha em QUALQUER uma das duas degrada pro
    // comportamento que o comentário promete: dentroTapete=null, detector
    // mudo naquele ciclo.
    const contagemTapetePorCliente = new Map<string, number>();
    const celulasTapetePorCliente = new Map<string, Set<string>>();
    let tapeteConfiavel = true;
    if (clienteIdsUnicos.length > 0) {
      try {
        const { rows } = await pool.query<{ cliente_id: string; n: string }>(
          `SELECT cliente_id, count(*)::bigint AS n FROM corredor_celulas
            WHERE cliente_id = ANY($1::uuid[]) GROUP BY cliente_id`,
          [clienteIdsUnicos]
        );
        for (const r of rows) contagemTapetePorCliente.set(r.cliente_id, Number(r.n));

        const candidatasTapete = new Set<string>();
        for (const p of posAtualPorVeiculo.values()) {
          if (p.lat != null && p.lng != null) {
            for (const c of vizinhanca3x3(p.lat, p.lng)) candidatasTapete.add(c);
          }
        }
        if (candidatasTapete.size > 0) {
          const { rows: rowsCel } = await pool.query<{ cliente_id: string; celula: string }>(
            `SELECT cliente_id, celula FROM corredor_celulas
              WHERE cliente_id = ANY($1::uuid[]) AND celula = ANY($2::text[])`,
            [clienteIdsUnicos, [...candidatasTapete]]
          );
          for (const r of rowsCel) {
            const set = celulasTapetePorCliente.get(r.cliente_id) ?? new Set<string>();
            set.add(r.celula);
            celulasTapetePorCliente.set(r.cliente_id, set);
          }
        }
      } catch (errTapete) {
        // Falha em qualquer uma das duas queries => dentroTapete fica null =>
        // parada_fora_tapete não dispara (mesma cautela de cold-start da
        // Central). Os outros 2 detectores seguem normalmente.
        tapeteConfiavel = false;
        erros.push(`Aviso: falha ao ler corredor_celulas (parada_fora_tapete fica inativa neste ciclo): ${String(errTapete)}`);
      }
    }

    // Cooldown de re-disparo por episódio de parada (achado real 21/08 na
    // Central, caso TUG-9D18: 17 alertas em 2h pro MESMO episódio). Sem isto,
    // um caminhão legitimamente parado por horas reabre parada_longa/
    // parada_anomala a cada ciclo de 30s assim que o operador resolve -- o
    // silenciamento de 2h que esta rota já tem só conta 'falso_positivo',
    // nunca 'resolvido'. Só tratamento INDIVIDUAL arma o cooldown (ação em
    // massa não olhou o caso), mesmo critério de route.ts:1437-1447.
    const paradasTratadasPorVeiculoTipo = new Map<string, { resolvidoEm: string }[]>();
    {
      const desdeLookback = new Date(agora.getTime() - LOOKBACK_PARADAS_TRATADAS_MS).toISOString();
      const { data: paradasTratadas, error: erroTratadas } = await admin
        .from("alertas_romaneio")
        .select("tipo, veiculo_id, resolvido_em")
        .in("veiculo_id", veiculoIds)
        .in("tipo", [...TIPOS_PARADA_COM_COOLDOWN])
        .in("origem_acao", ORIGENS_TRATAMENTO_INDIVIDUAL)
        .not("operador_id", "is", null)
        .gte("resolvido_em", desdeLookback);
      if (erroTratadas) {
        erros.push(`Aviso: falha ao ler paradas ja tratadas (cooldown inativo neste ciclo): ${erroTratadas.message}`);
      }
      for (const pt of (paradasTratadas ?? []) as { tipo: string; veiculo_id: string; resolvido_em: string }[]) {
        const chave = `${pt.veiculo_id}:${pt.tipo}`;
        const lista = paradasTratadasPorVeiculoTipo.get(chave) ?? [];
        lista.push({ resolvidoEm: pt.resolvido_em });
        paradasTratadasPorVeiculoTipo.set(chave, lista);
      }
    }

    // Posições PARADAS da frota destes clientes (congestionamento) e score de
    // risco de área -- os dois só interessam quando existe candidato a parada
    // neste ciclo, então são carregados sob demanda (memoizados), não em todo
    // ciclo. Num ciclo sem ninguém parado fora do cliente, custo zero.
    let paradosFrotaCache: { lat: number; lng: number }[] | null = null;
    // Falha na leitura => vizinhosParados=0 (não suprime nada, mais alerta) MAS
    // também não pode servir de base pra FECHAR alerta em aberto -- ver
    // podeFecharParadas no loop.
    let paradosFrotaFalhou = false;
    async function paradosDaFrota(): Promise<{ lat: number; lng: number }[]> {
      if (paradosFrotaCache) return paradosFrotaCache;
      try {
        const { rows } = await pool.query<{ lat: number; lng: number }>(
          `SELECT p.lat, p.lng FROM posicoes_atuais p
             JOIN veiculos v ON v.id = p.veiculo_id
            WHERE v.cliente_id = ANY($1::uuid[]) AND p.velocidade = 0
              AND p.atraso_min <= $2 AND p.lat IS NOT NULL AND p.lng IS NOT NULL`,
          [clienteIdsUnicos, LIMIAR_ATRASO_FRESCO_MIN]
        );
        paradosFrotaCache = rows;
      } catch (errParados) {
        // Sem a lista, vizinhosParados fica 0 => nenhuma supressão por
        // congestionamento => mais alerta, nunca menos.
        erros.push(`Aviso: falha ao ler paradas da frota (congestionamento nao suprime neste ciclo): ${String(errParados)}`);
        paradosFrotaFalhou = true;
        paradosFrotaCache = [];
      }
      return paradosFrotaCache;
    }

    // Score de risco de área por veículo -- MESMA query batch e MESMA função
    // pura (calcularRiscoArea) da Central (route.ts:966-1032). Só decide o
    // NÍVEL de parada_fora_tapete (crítico vs atenção), nunca se o alerta
    // sai. Falha graciosa em qualquer camada => risco 0 => nível 'atencao'.
    let riscoCache: Map<string, number> | null = null;
    async function riscoAreaPorVeiculo(): Promise<Map<string, number>> {
      if (riscoCache) return riscoCache;
      const mapa = new Map<string, number>();
      try {
        let tiroteios: Tiroteio[] = [];
        try {
          tiroteios = (await buscarTiroteiosRJ(1)).filter((t) => t.recente && !t.acaoPolicial);
        } catch { /* sem tiroteio: camada não soma */ }
        const rouboPorCisp = new Map<string, number>();
        try {
          const dados = await obterRouboCarga();
          for (const item of dados?.ranking ?? []) rouboPorCisp.set(item.cisp, item.total);
        } catch { /* sem ISP: camada fica null */ }
        let perfilHorario: number[] = new Array(24).fill(1);
        try {
          perfilHorario = await obterPerfilHorario();
        } catch { /* neutro */ }
        const horaSP = parseInt(
          new Intl.DateTimeFormat("pt-BR", { timeZone: "America/Sao_Paulo", hour: "numeric", hour12: false }).format(agora),
          10
        );

        const { rows } = await pool.query<{
          veiculo_id: string; em_favela: boolean; cisp: string | null;
          em_corredor_risco: boolean; em_area_risco_cliente: boolean;
        }>(
          `WITH cisp AS (
             SELECT p.veiculo_id, g.meta->>'cisp' as cisp
             FROM posicoes_atuais p
             JOIN geofences g ON g.tipo = 'cisp' AND ST_Intersects(g.geom, p.geom)
             WHERE p.veiculo_id = ANY($1::uuid[])
           ),
           corredor AS (
             SELECT DISTINCT p.veiculo_id
             FROM posicoes_atuais p
             JOIN geofences g ON g.tipo = 'risco' AND ST_DWithin(g.geom, p.geom, 250)
             WHERE p.veiculo_id = ANY($1::uuid[])
           ),
           area_cliente AS (
             SELECT DISTINCT p.veiculo_id
             FROM posicoes_atuais p
             JOIN veiculos v ON v.id = p.veiculo_id
             JOIN geofences g ON g.tipo = 'area_risco_cliente' AND g.cliente_id = v.cliente_id AND ST_Intersects(g.geom, p.geom)
             WHERE p.veiculo_id = ANY($1::uuid[])
           )
           SELECT
             p.veiculo_id,
             EXISTS (SELECT 1 FROM geofences g WHERE g.tipo = 'favela' AND ST_Intersects(g.geom, p.geom)) AS em_favela,
             cisp.cisp,
             (corredor.veiculo_id IS NOT NULL) AS em_corredor_risco,
             (area_cliente.veiculo_id IS NOT NULL) AS em_area_risco_cliente
           FROM posicoes_atuais p
           LEFT JOIN cisp ON cisp.veiculo_id = p.veiculo_id
           LEFT JOIN corredor ON corredor.veiculo_id = p.veiculo_id
           LEFT JOIN area_cliente ON area_cliente.veiculo_id = p.veiculo_id
           WHERE p.veiculo_id = ANY($1::uuid[])`,
          [veiculoIds]
        );
        for (const r of rows) {
          const pos = posAtualPorVeiculo.get(r.veiculo_id);
          let distTiroteioM: number | null = null;
          if (pos?.lat != null && pos.lng != null) {
            for (const t of tiroteios) {
              const d = haversineM(pos.lat, pos.lng, t.lat, t.lng);
              if (distTiroteioM === null || d < distTiroteioM) distTiroteioM = d;
            }
          }
          mapa.set(
            r.veiculo_id,
            calcularRiscoArea({
              emFavela: r.em_favela,
              tiroteioRecentePertoM: distTiroteioM,
              rouboCargaCispTotal: r.cisp ? rouboPorCisp.get(r.cisp) ?? 0 : null,
              emCorredorRodoviaRisco: r.em_corredor_risco,
              emAreaRiscoCliente: r.em_area_risco_cliente,
              fatorHorario: perfilHorario[horaSP] ?? 1,
            })
          );
        }
      } catch (errRisco) {
        erros.push(`Aviso: score de risco de area indisponivel neste ciclo: ${String(errRisco)}`);
      }
      riscoCache = mapa;
      return mapa;
    }

    // Pontos de escala de hoje (route.ts:1683-1691 inclui escala na lista de
    // destinos do Sinal A -- não é ponto de entrega, é a mesma composição da
    // Central, ver C2 do fix de 22/08).
    const escalaPorPlaca = new Map<string, Ponto[]>();
    try {
      const { rows } = await pool.query<{ placa: string; lat: number; lng: number }>(
        `SELECT placa, lat, lng FROM escala_pontos
          WHERE escala_data = $1::date AND veiculo_id = ANY($2::uuid[])
            AND lat IS NOT NULL AND lng IS NOT NULL`,
        [hoje, veiculoIds]
      );
      for (const r of rows) {
        const lista = escalaPorPlaca.get(r.placa) ?? [];
        lista.push({ lat: r.lat, lng: r.lng });
        escalaPorPlaca.set(r.placa, lista);
      }
    } catch (errEscala) {
      erros.push(`Aviso: falha ao ler escala_pontos: ${String(errEscala)}`);
    }

    // Alertas EM ABERTO de alertas_romaneio, tabela PRÓPRIA -- id/nivel entram
    // pra poder resolver/escalar (ver I2 do fix de 22/08), não só deduplicar.
    const { data: alertasAbertosRows } = await admin
      .from("alertas_romaneio")
      .select("id, veiculo_id, tipo, nivel, contexto")
      .in("veiculo_id", veiculoIds)
      .in("status", ["ativo", "reconhecido"]);
    const alertasAbertosPorVeiculo = new Map<string, AlertaAtivoRow[]>();
    for (const a of (alertasAbertosRows ?? []) as (AlertaAtivoRow & { veiculo_id: string })[]) {
      const lista = alertasAbertosPorVeiculo.get(a.veiculo_id) ?? [];
      lista.push({ id: a.id, tipo: a.tipo, nivel: a.nivel, contexto: a.contexto });
      alertasAbertosPorVeiculo.set(a.veiculo_id, lista);
    }

    // Tipos SILENCIADOS por 2h depois de um "falso positivo" marcado pelo
    // operador -- mesmo mecanismo da Central (motor/route.ts:1452-1466 e
    // 3086-3088). Sem isso: o operador marca falso, o status sai de 'ativo',
    // 30s depois alertaExistente é undefined e o motor insere o MESMO alerta
    // de novo, e repete a cada ciclo enquanto o streak ≥ 2 -- é o padrão que
    // a Central precisou combater no caso TUG-9D18 (17 alertas em 2h pro
    // mesmo episódio).
    //
    // contaComoEventoDeSilenciamento (@/lib/detectores) filtra o que NÃO é
    // decisão humana: um fechamento da máquina reusa o mesmo status e
    // silenciaria o tipo sem ninguém ter julgado nada (ver o marcador
    // contexto.auto_resolvido no Step 9).
    //
    // SEM filtro de modo_teste aqui: alertas_romaneio não tem essa coluna
    // (migration 055) -- ao contrário de `alertas`, onde a Central filtra.
    // Copiar o predicado da Central sem conferir estouraria em runtime, e
    // nem tsc nem eslint pegam coluna inexistente em query.
    const desde2h = new Date(agora.getTime() - 2 * 60 * 60 * 1000).toISOString();
    const tiposSilenciadosPorVeiculo = new Map<string, Set<string>>();
    {
      const { data: falsosRecentes, error: erroFalsos } = await admin
        .from("alertas_romaneio")
        .select("tipo, veiculo_id, contexto")
        .in("veiculo_id", veiculoIds)
        .eq("status", "falso_positivo")
        .gte("resolvido_em", desde2h);
      if (erroFalsos) {
        erros.push(`Aviso: falha ao ler falsos positivos recentes de alertas_romaneio: ${erroFalsos.message}`);
      }
      for (const fp of (falsosRecentes ?? []) as { tipo: string; veiculo_id: string; contexto: unknown }[]) {
        if (!contaComoEventoDeSilenciamento(fp.contexto)) continue;
        const set = tiposSilenciadosPorVeiculo.get(fp.veiculo_id) ?? new Set<string>();
        set.add(fp.tipo);
        tiposSilenciadosPorVeiculo.set(fp.veiculo_id, set);
      }
    }

    for (const veiculoId of veiculoIds) {
      try {
        const info = veiculoInfoPorId.get(veiculoId);
        if (!info) continue;

        // Achado real 24/08 (usuário + investigação
        // docs/investigacoes/2026-08-21-marcacoes-faltantes.md, adendo "causa
        // raiz do padrão estrutural"): esta rota existe pra veículos SEM alvo
        // na Unitrac (propósito original, ver comentário de topo do arquivo:
        // "14 veículos tinham romaneio mas ZERO alvo na Unitrac") -- mas
        // processava TODO veículo com romaneio hoje, mesmo os que a Central
        // já cobre bem via Unitrac. Medido em produção no mesmo dia: 70% da
        // frota com romaneio (31/44) disparando "desvio" aqui, quase o
        // "flood" que já tinha sido corrigido no motor antigo (streak=1 ->
        // streak=2, ver desvio.ts). Causa: o "já entregue" desta rota depende
        // de casar NF por aproximação contra a Unitrac
        // (montarPontosDeRomaneio), bem mais ruidoso que o status ao vivo que
        // a Central usa -- avaliar de novo aqui um veículo que a Central já
        // cobre não soma sinal, só duplica alerta. Pula todo veículo que TEM
        // pelo menos um alvo Unitrac hoje.
        const pontosUnitracVeiculo = pontosUnitracPorPlaca.get(info.placa) ?? [];
        if (pontosUnitracVeiculo.length > 0) continue;

        // Step 1: posição atual -- mesma fonte da Central (posicoes_atuais), SOMENTE LEITURA.
        const posAtual = posAtualPorVeiculo.get(veiculoId);
        if (!posAtual || posAtual.lat == null || posAtual.lng == null) continue;
        const latAtual = posAtual.lat;
        const lngAtual = posAtual.lng;
        const fresco = posAtual.atraso_min != null && posAtual.atraso_min < LIMIAR_ATRASO_FRESCO_MIN;

        const estadoGravado: EstadoAnterior = estadoPorVeiculo.get(veiculoId) ?? {
          afastando_streak: 0,
          rua_rara_streak: 0,
          ultima_via_principal_em: null,
          saiu_parada_confirmada_em: null,
          atualizado_em: null,
          ultimo_datagps: null,
        };

        // Estado que atravessou o dia -- streak NÃO sobrevive à virada.
        // Esta rota retorna cedo quando não há romaneio do dia (fim de
        // semana, feriado), então ninguém escreve e ninguém zera: um veículo
        // que terminou a sexta com afastando_streak=1 voltaria na segunda
        // com 1, e a PRIMEIRA leitura divergente já dispararia, com metade
        // da evidência. A Central não tem mecanismo equivalente pra copiar
        // (conferido: nada toca desvio_estado fora do motor) porque ela não
        // precisa -- roda pra frota inteira em todo ciclo, 24/7, e qualquer
        // ciclo bloqueado já zera o streak dela naturalmente.
        //
        // Só o streak. ultima_via_principal_em / saiu_parada_confirmada_em
        // ficam: quem as consome já compara contra `agora` com janela de
        // 10min/5min (avaliarQuedaClasseViaria e
        // avaliarSaiuParadaConfirmadaRecentemente,
        // @/lib/classe-viaria-confirmacao), então um valor de dias atrás já
        // responde false sozinho -- zerá-las aqui não mudaria resultado
        // nenhum e só apagaria histórico.
        const estadoDeOutroDia = estadoEhDeOutroDiaSP(estadoGravado.atualizado_em, hoje);
        const estadoAnterior: EstadoAnterior = estadoDeOutroDia
          ? { ...estadoGravado, afastando_streak: 0, rua_rara_streak: 0 }
          : estadoGravado;

        // I3 (revisado 22/08 -- achado real em produção, ver task-2-report.md):
        // idempotência por leitura de GPS, mas comparando datagps-CONTRA-
        // datagps, NUNCA datagps contra now()/atualizado_em. Motivo concreto:
        // parseDatagps (src/app/api/motor/route.ts:226-237) grava o horário
        // de Brasília que a Unitrac devolve com sufixo "Z" (UTC) -- isso
        // desloca TODO datagps ~3h pro passado, sistematicamente (não é
        // atraso real; a Unitrac responde ao vivo em segundos). Pra Central
        // isso é inofensivo (ela usa atraso_min, nunca compara datagps com
        // now()); comparando esse datagps deslocado contra now()/
        // atualizado_em (relógio real do Postgres) essa checagem NUNCA
        // passava depois do primeiro ciclo -- o motor pulava TODO veículo pra
        // sempre (produção, 22/08). Guardando o ÚLTIMO datagps já processado
        // (ultimo_datagps, migration 056) e comparando datagps-contra-datagps,
        // o mesmo offset aparece dos dois lados e deixa de importar. NÃO
        // "simplificar" isso de volta pra comparar com now()/atualizado_em --
        // é exatamente o bug que já aconteceu uma vez. NÃO corrigir
        // parseDatagps em vez disso: é função da Central, em produção, mudar
        // o fuso do dado gravado lá é risco desnecessário pro que precisamos
        // aqui. Pula só quando ultimo_datagps é conhecido E a leitura atual
        // não é mais nova que ele; processa quando é mais nova ou quando
        // ultimo_datagps ainda é null (nunca processado, ou posAtual.datagps
        // ausente -- fail-open, nunca bloqueia por falta de dado).
        if (
          posAtual.datagps != null &&
          estadoAnterior.ultimo_datagps != null &&
          new Date(posAtual.datagps).getTime() <= estadoAnterior.ultimo_datagps.getTime()
        ) {
          continue;
        }

        veiculosProcessados++;

        // Posição anterior -- mesma fonte da Central (posicoes_historico),
        // SOMENTE LEITURA.
        //
        // O corte é `criado_em < posicoes_atuais.updated_at`, NÃO
        // `OFFSET 1` (como era até 22/08). Motivo: a Central grava
        // posicoes_atuais no meio do ciclo (route.ts:3222, updated_at =
        // `agora` do ciclo dela) e só depois insere a MESMA leitura em
        // posicoes_historico (route.ts:3327, criado_em = now() do momento do
        // insert). Ou seja, a linha de histórico da leitura ATUAL sempre tem
        // criado_em > updated_at, e a da leitura anterior sempre tem
        // criado_em < updated_at. Com OFFSET 1 a janela medida dependia de o
        // ciclo do romaneio ter caído antes ou depois desse insert: às vezes
        // 30s (correto), às vezes 60s (dois ciclos), variando de leitura pra
        // leitura -- e o Sinal A mede exatamente delta de distância nessa
        // janela.
        //
        // Isto alinha a janela com a que a Central usa: ela compara a
        // leitura nova contra o snapshot ANTERIOR de posicoes_atuais
        // (route.ts:1488, mapaPosAtual lido no início do ciclo), que é
        // precisamente a leitura que este SELECT devolve. Sem mecanismo
        // novo, sem coluna nova, só com dado que já existe.
        //
        // Fallback pro OFFSET 1 se updated_at vier ausente (coluna é NOT
        // NULL no schema; defensivo contra falha de leitura, não contra
        // dado real).
        //
        // velocidade entra junto (task B1): jaParedoNoCicloAnterior (anti-pisca
        // de detectarParadaAnomala) precisa saber se a leitura anterior também
        // estava com velocidade 0 no MESMO ponto -- mesma checagem da Central
        // (route.ts:1956-1961), que lá lê do snapshot anterior de
        // posicoes_atuais e aqui vem desta mesma leitura anterior.
        const corteAnterior = posAtual.updated_at;
        const { rows: anteriorRows } = corteAnterior
          ? await pool.query<{ lat: number; lng: number; velocidade: number | null }>(
              `SELECT lat, lng, velocidade FROM posicoes_historico
                WHERE veiculo_id = $1 AND criado_em < $2
                ORDER BY criado_em DESC LIMIT 1`,
              [veiculoId, corteAnterior]
            )
          : await pool.query<{ lat: number; lng: number; velocidade: number | null }>(
              `SELECT lat, lng, velocidade FROM posicoes_historico
                WHERE veiculo_id = $1
                ORDER BY criado_em DESC LIMIT 1 OFFSET 1`,
              [veiculoId]
            );
        const anterior = anteriorRows[0] ?? null;

        // Step 2: monta os pontos (romaneio + status Unitrac) -- reusa
        // montarPontosDeRomaneio como está, regra de "feito" já embutida
        // ((alvo?.feito ?? false) || presencaConfirmadaEm !== null). Nome
        // sem "Geocodificadas" (task-5): desde que a query parou de filtrar
        // geocode_status, algumas destas linhas não têm coordenada própria
        // — a Unitrac pode preencher via fallback dentro da função, ou a
        // linha ser descartada lá dentro.
        const linhasVeiculo = romaneioPorVeiculo.get(veiculoId) ?? [];
        const pontosRomaneioDoVeiculo: LinhaRomaneioGeocodificada[] = linhasVeiculo.map((l) => ({
          nf: l.nf,
          clienteNome: l.cliente_nome,
          lat: l.lat,
          lng: l.lng,
          presencaConfirmadaEm: l.presenca_confirmada_em,
        }));
        // pontosUnitracVeiculo já foi calculado acima (Step 0, gate de
        // escopo) -- sempre [] neste ponto, já que veículo com alvo Unitrac
        // é pulado antes de chegar aqui. Mantido explícito no argumento
        // (não hardcoded []) pra não esconder a dependência real da função.
        const pontos = montarPontosDeRomaneio(pontosRomaneioDoVeiculo, pontosUnitracVeiculo);

        // Step 3: mesma regra de pendentes da Central pro Sinal A
        // (pontosVeiculoParaDesvio em route.ts): !pt.feito && temCoordenadaValida(pt).
        const pendentes = pontos.filter((pt) => !pt.feito && temCoordenadaValida(pt));

        // I1: gate de chegada (suspenderPorChegada, pura, @/lib/unitrac) --
        // suspende a avaliação quando o veículo já está dentro do raio do
        // pendente mais próximo (manobra/chegada, não desvio). Sem infra de
        // "ponto seguro" (postos de gasolina) nesta rota -- mesmo argumento
        // `false` que a Central usa em chegouEmDestinoConhecido (route.ts:1830).
        let idxMaisProximoPendente = -1;
        let distMaisProximoPendenteM = Infinity;
        pendentes.forEach((pt, i) => {
          const d = haversineM(latAtual, lngAtual, pt.lat, pt.lng);
          if (d < distMaisProximoPendenteM) {
            distMaisProximoPendenteM = d;
            idxMaisProximoPendente = i;
          }
        });
        const suspensoPorChegada =
          idxMaisProximoPendente >= 0
            ? suspenderPorChegada(distMaisProximoPendenteM, pendentes[idxMaisProximoPendente].raio, false)
            : false;

        // Step 4: destinos do Sinal A -- pendentes + bases + escala, MESMA
        // composição da Central (route.ts:1682-1690). Base/escala não são
        // "fonte de ponto de entrega" que esta task troca -- entram sempre,
        // senão um caminhão voltando pra base com pendente aberto (situação
        // permanente na Escala do Pão) se afasta de "tudo" e dispara.
        const centroidesBase = centroideBasePorCliente.get(info.cliente_id) ?? [];
        const escalaDoVeiculo = escalaPorPlaca.get(info.placa) ?? [];
        const destinosBase: Ponto[] = [
          ...pendentes.map((pt) => ({ lat: pt.lat, lng: pt.lng })),
          ...centroidesBase,
          ...escalaDoVeiculo,
        ];
        const destinosRelevantes = destinosBase.filter(
          (d) => haversineM(latAtual, lngAtual, d.lat, d.lng) <= LIMIAR_DESTINO_RELEVANTE_M
        );

        // Gates que suspendem a avaliação -- mesmos da Central (brief Step 1):
        // ruído de GPS/OSRM parado ou quase parado nunca deve alimentar streak.
        const mesmoPonto =
          anterior != null &&
          Math.round(anterior.lat * 10000) === Math.round(latAtual * 10000) &&
          Math.round(anterior.lng * 10000) === Math.round(lngAtual * 10000);
        const paradoSemSeMover = mesmoPonto;

        const movimentoRealM = anterior ? haversineM(anterior.lat, anterior.lng, latAtual, lngAtual) : null;
        const movimentoInsignificante = movimentoRealM != null && movimentoRealM < LIMIAR_MOVIMENTO_MINIMO_M;

        // Carência de base (LIMIAR_CARENCIA_BASE_M, importado de @/lib/desvio,
        // mesmo valor da Central) -- manobra de saída/permanência no pátio não
        // deve contar como "afastando de tudo".
        const distBaseM = centroidesBase.length > 0
          ? Math.min(...centroidesBase.map((b) => haversineM(latAtual, lngAtual, b.lat, b.lng)))
          : null;
        const emCarenciaDeBase = distBaseM != null && distBaseM < LIMIAR_CARENCIA_BASE_M;

        // ─── Detectores de parada (task B1, 27/08) ─────────────────────────
        // Buraco de segurança REAL que este bloco fecha: desde 26/08 a Nutry
        // Max ficou SEM nenhum detector de parada anômala. Na Central Unitrac
        // os 3 foram desligados por flag (CLIENTES_COM_MOTOR_ROMANEIO_PARALELO,
        // motor/route.ts) porque lá o `noCliente` só reconhece alvo da
        // Unitrac e disparava com o caminhão parado NO cliente; aqui eles
        // nunca tinham sido implementados. A flag continua como está (fora do
        // escopo desta task) -- quem cobre este cliente agora é esta rota.
        //
        // Independente do gate do Sinal A logo abaixo: um veículo parado nunca
        // passa naquele gate (paradoSemSeMover/movimentoInsignificante), que é
        // exatamente o motivo de os detectores de parada existirem.
        const noCliente = calcularNoClienteRomaneio(
          { lat: latAtual, lng: lngAtual, velocidade: posAtual.velocidade },
          pontos
        );
        const alertasParada: Alerta[] = [];
        let paradoMinVeiculo = 0;
        let dentroTapeteVeiculo: boolean | null = null;
        let riscoAreaVeiculo = 0;
        const paradoDesdeVeiculo = posAtual.parado_desde;

        // "Este ciclo AVALIOU de verdade as paradas deste veículo?" -- achado
        // da revisão da task B1. O auto-resolve do Step 9 fecha todo tipo
        // gerenciado que não disparou neste ciclo; sem estas flags, "não
        // disparou" e "não deu pra avaliar" viram a mesma coisa, e um
        // parada_anomala/parada_longa REAL e ativo seria fechado pela máquina
        // (operador_id null, card some da tela) por causa de: GPS atrasado,
        // parado_desde ausente, Overpass fora do ar (temPOI=true suprime os 3),
        // falha na leitura de congestionamento, ou tapete parcialmente lido.
        // Reabriria no ciclo saudável seguinte (auto-resolve não arma
        // cooldown), mas a janela em que o alerta some é real. Só fecha o que
        // este ciclo de fato conseguiu avaliar.
        let podeFecharParadas = false;
        let podeFecharForaTapete = false;

        if (fresco && posAtual.velocidade !== 0 && posAtual.velocidade != null) {
          // Veículo em movimento com leitura fresca: nenhum dos 3 detectores
          // pode valer (todos exigem parada). É o caminho normal de fechamento
          // -- o carro voltou a andar, o alerta de parada morreu.
          podeFecharParadas = true;
          podeFecharForaTapete = true;
        }

        if (fresco && posAtual.velocidade === 0 && paradoDesdeVeiculo) {
          const inicioMs = new Date(paradoDesdeVeiculo).getTime();
          if (Number.isFinite(inicioMs)) {
            paradoMinVeiculo = Math.round((agora.getTime() - inicioMs) / 60000);
          }
          const emOperacao = emHorarioOperacao(agora);
          const foraDaBase = !veiculosDentroDeBase.has(veiculoId);

          // Pré-condição comum aos 3 detectores (eles a re-checam por dentro;
          // aqui ela só evita pagar POI/Overpass e as queries de contexto
          // quando nenhum deles poderia disparar). PARADA_FORA_TAPETE_MIN (3min)
          // é o menor piso dos 3.
          const candidatoParada =
            emOperacao && foraDaBase && !noCliente && paradoMinVeiculo >= PARADA_FORA_TAPETE_MIN;

          // Não ser candidato é ausência REAL de condição (está no cliente, na
          // base, fora do horário, parado há menos de 3min) -- avaliação
          // completa, pode fechar o que estiver aberto.
          podeFecharParadas = !candidatoParada;
          podeFecharForaTapete = !candidatoParada;

          if (candidatoParada) {
            dentroTapeteVeiculo = avaliarDentroTapete({
              confiavel: tapeteConfiavel,
              contagemCelulasCliente: contagemTapetePorCliente.get(info.cliente_id) ?? 0,
              celulasCliente: celulasTapetePorCliente.get(info.cliente_id) ?? new Set<string>(),
              lat: latAtual,
              lng: lngAtual,
            });

            // Só os 2 gatilhos reais consultam POI/congestionamento -- mesma
            // economia da Central (route.ts:2006 e 2024).
            const candidatoAnomala = paradoMinVeiculo >= 12 && paradoMinVeiculo < 90;
            const candidatoForaTapete = dentroTapeteVeiculo === false;
            const candidatoLonga = paradoMinVeiculo >= 90;

            let temPOI = false;
            let overpassFalhou = false;
            if (candidatoAnomala || candidatoForaTapete || candidatoLonga) {
              try {
                temPOI = await temPOIProximo(latAtual, lngAtual, pool);
              } catch {
                overpassFalhou = true;
                // Overpass fora do ar: assume POI presente (mesma decisão da
                // Central, route.ts:2010-2016) -- prefere não inundar a
                // operação com falso positivo em massa durante instabilidade.
                temPOI = true;
                if (!erros.some((e) => e.includes("Overpass"))) {
                  erros.push("Aviso: Overpass indisponivel neste ciclo, POI assumido presente");
                }
              }
            }

            let vizinhosParados = 0;
            if (candidatoAnomala || candidatoForaTapete) {
              const parados = await paradosDaFrota();
              let dentro = 0;
              for (const q of parados) {
                if (haversineM(latAtual, lngAtual, q.lat, q.lng) <= RAIO_CONGESTION_M) dentro++;
              }
              vizinhosParados = Math.max(0, dentro - 1); // exclui o próprio veículo
            }

            if (candidatoForaTapete) {
              riscoAreaVeiculo = (await riscoAreaPorVeiculo()).get(veiculoId) ?? 0;
            }

            // estavEmMovimento: velocidade máxima nos 10min ANTES do início da
            // parada (não do ciclo anterior) -- fix real de 21/08 na Central
            // (route.ts:1971-2001): com paradoMin>=12 o ciclo anterior está
            // sempre parado também, e a condição era impossível por construção.
            // Falha da query => false => cai no limiar conservador de 20min.
            let estavEmMovimento = false;
            if (candidatoAnomala) {
              try {
                const inicioParada = new Date(paradoDesdeVeiculo);
                const janelaAntes = new Date(inicioParada.getTime() - 10 * 60_000);
                const { rows: velAntes } = await pool.query<{ vmax: number | null }>(
                  `SELECT max(velocidade) AS vmax FROM posicoes_historico
                    WHERE veiculo_id = $1 AND criado_em >= $2 AND criado_em < $3`,
                  [veiculoId, janelaAntes.toISOString(), inicioParada.toISOString()]
                );
                estavEmMovimento = (velAntes[0]?.vmax ?? 0) >= 30;
              } catch (errVelAntes) {
                if (!erros.some((e) => e.includes("velocidade pre-parada"))) {
                  erros.push(`Aviso: falha ao ler velocidade pre-parada: ${String(errVelAntes)}`);
                }
              }
            }

            const horaSPAgora = parseInt(
              new Intl.DateTimeFormat("pt-BR", { timeZone: "America/Sao_Paulo", hour: "numeric", hour12: false }).format(agora),
              10
            );

            // Confiabilidade DESTE veículo neste ciclo (ver podeFecharParadas
            // acima): Overpass caído ou leitura de congestionamento falha/ativa
            // suprimem os detectores por motivo que NÃO é "a condição acabou"
            // -- nesses casos o ciclo não fecha alerta em aberto, só deixa de
            // abrir alerta novo.
            const avaliacaoConfiavel = !overpassFalhou && !paradosFrotaFalhou && vizinhosParados < 2;
            podeFecharParadas = avaliacaoConfiavel;
            // parada_fora_tapete ainda exige um veredito real do tapete:
            // dentroTapete null (cold-start ou leitura parcial) é "não sei",
            // nunca "não está mais fora do tapete".
            podeFecharForaTapete = avaliacaoConfiavel && dentroTapeteVeiculo !== null;

            alertasParada.push(
              ...avaliarParadasRomaneio({
                paradoMin: paradoMinVeiculo,
                emOperacao,
                foraDaBase,
                noCliente,
                estavEmMovimento,
                esMadrugada: horaSPAgora >= 0 && horaSPAgora < 5,
                temPOIProximo: temPOI,
                jaParedoNoCicloAnterior:
                  anterior != null && anterior.velocidade === 0 && mesmoPonto,
                vizinhosParados,
                dentroTapete: dentroTapeteVeiculo,
                riscoAreaAtual: riscoAreaVeiculo,
              })
            );
          }
        }

        // Classe viária atual -- classificação de dado (SELECT em lote acima),
        // não é regra de desvio. Calculada só quando a posição é fresca,
        // igual à Central (route.ts:2217).
        let classeViaAtual: ClasseViaria | null = null;
        if (fresco) {
          for (const cel of vizinhanca3x3(latAtual, lngAtual)) {
            classeViaAtual = melhorClasse(classeViaAtual, classePorCelula.get(cel) ?? null);
          }
        }
        const ultimaViaPrincipalAnteriorEm = estadoAnterior.ultima_via_principal_em;
        const ultimaViaPrincipalEmNova = fresco && classeViaAtual === "principal" ? agora : ultimaViaPrincipalAnteriorEm;
        // saiu_parada_confirmada_em: a Central deriva QUANDO marcar esta
        // transição (deveMarcarSaidaParadaConfirmada) a partir de colunas de
        // dwell/raio de posicoes_atuais (no_raio_dwell_segundos etc.) que
        // pertencem exclusivamente à Central e não estão no schema de
        // romaneio_desvio_estado (migration 055) -- não há como calcular essa
        // transição aqui sem reimplementar esse rastreio (fora do escopo desta
        // task, decisão revisada e mantida no fix de 22/08). Carrega o valor
        // anterior indefinidamente, nunca seta um novo "agora": efeito é
        // fail-open (a supressão "saiu de parada há pouco" nunca entra em
        // ação nesta rota -- mais alertas, nunca menos, ver
        // [[feedback_desvio_priorizar_recall]]); a corroboração de queda de
        // classe viária continua funcionando normalmente.
        const saiuParadaConfirmadaEmNova = estadoAnterior.saiu_parada_confirmada_em;

        // C1: streak SEMPRE começa zerado -- mesmo default da Central
        // (route.ts:2418-2419). Só é restaurado ao valor anterior no branch
        // específico de falha do OSRM /table logo abaixo (route.ts:2821-2824)
        // -- qualquer outro motivo de bloqueio (não fresco, chegada, carência
        // de base, parado, movimento insignificante, sem destino relevante)
        // zera o streak, nunca deixa ele sobreviver ao ciclo bloqueado.
        let afastandoStreakNovo = 0;
        let ruaRaraStreakNovo = 0;
        let alerta: ReturnType<typeof montarAlertaDesvio> = null;

        if (fresco && !suspensoPorChegada && !emCarenciaDeBase && !paradoSemSeMover && !movimentoInsignificante && destinosRelevantes.length > 0) {
          // M3: correção de posição via OSRM /match (route.ts:2551-2624) --
          // só entra em ação quando já existe streak (afastandoStreak > 0) e
          // existe pra matar o ruído de snap-to-road do achado de 13/08.
          let posParaAvaliar: Ponto = { lat: latAtual, lng: lngAtual };
          let anteriorParaAvaliar: Ponto | null = anterior ? { lat: anterior.lat, lng: anterior.lng } : null;
          if (estadoAnterior.afastando_streak > 0 && anteriorParaAvaliar !== null && contadorCorrecoesMatch.valor < MAX_CORRECOES_MATCH_POR_CICLO) {
            try {
              const { rows: janelaRecente } = await pool.query<{ lat: number; lng: number; criado_em: Date }>(
                `SELECT lat, lng, criado_em FROM posicoes_historico
                  WHERE veiculo_id = $1 AND criado_em > now() - interval '5 minutes'
                  ORDER BY criado_em ASC`,
                [veiculoId]
              );
              const pontosMatch = janelaRecente.map((p) => ({ lat: p.lat, lng: p.lng, timestamp: p.criado_em }));
              pontosMatch.push({ lat: latAtual, lng: lngAtual, timestamp: agora });
              const corrigido: ResultadoMatch | null = await corrigirPosicoesComMatch(pontosMatch);
              if (corrigido && corrigido.confidence >= LIMIAR_CONFIANCA_MATCH) {
                posParaAvaliar = corrigido.atual;
                anteriorParaAvaliar = corrigido.anterior;
                contadorCorrecoesMatch.valor += 1;
              }
            } catch (errMatch) {
              erros.push(`Aviso: falha ao corrigir posicao via /match pro veiculo ${veiculoId}: ${String(errMatch)}`);
            }
          }

          // Step 6: mesma sequência e mesmos argumentos que a Central usa.
          const distAtuaisReais = await buscarDistanciasReais(posParaAvaliar, destinosRelevantes);
          const distAnterioresReais =
            anteriorParaAvaliar && distAtuaisReais
              ? await buscarDistanciasReais(anteriorParaAvaliar, destinosRelevantes)
              : null;

          if (distAtuaisReais && distAnterioresReais) {
            const afastando = avaliarAfastandoDeTudo(distAtuaisReais, distAnterioresReais, estadoAnterior.afastando_streak);
            afastandoStreakNovo = afastando.streak;

            const celulaAtual = celulaDe(latAtual, lngAtual);
            const nVisitasHistorico = freqCelulaPorCliente.get(info.cliente_id)?.get(celulaAtual) ?? 0;
            const ruaRara = avaliarRuaRara(nVisitasHistorico, afastando.aproximandoAlgum, estadoAnterior.rua_rara_streak);
            ruaRaraStreakNovo = ruaRara.streak;

            // Sinal B (rua rara) desligado -- MESMA decisão/mesmos argumentos
            // da Central (13/08): só o Sinal A dispara alerta, mas o streak
            // continua sendo calculado/gravado pra não perder a série
            // histórica caso volte a ser religado.
            alerta = montarAlertaDesvio(afastando, { ...ruaRara, disparou: false, celula: celulaAtual, nVisitas: nVisitasHistorico });

            // Step 7: corroborações, mesma ordem da Central -- corredor, depois classe viária.
            if (alerta) {
              try {
                const segundosStreak = Math.min(afastandoStreakNovo, 20) * 30;
                const { rows: ancoraRows } = await pool.query<{ lat: number; lng: number }>(
                  `SELECT lat, lng FROM posicoes_historico
                    WHERE veiculo_id = $1 AND criado_em <= now() - ($2 || ' seconds')::interval
                    ORDER BY criado_em DESC LIMIT 1`,
                  [veiculoId, String(segundosStreak)]
                );
                const ancora = ancoraRows[0];
                if (ancora) {
                  const { confirmaFora } = await verificarCorredorFora(
                    { lat: ancora.lat, lng: ancora.lng },
                    { lat: latAtual, lng: lngAtual, velocidade: posAtual.velocidade ?? 0 },
                    destinosRelevantes
                  );
                  if (confirmaFora) {
                    alerta = aplicarCorroboracaoCorredor(alerta, confirmaFora, BONUS_CORROBORACAO_POR_SINAL);
                  }
                }
              } catch (errCorredor) {
                erros.push(`Aviso: falha ao verificar corredor pro veiculo ${veiculoId}: ${String(errCorredor)}`);
              }

              try {
                const { quedaDetectada } = avaliarQuedaClasseViaria(classeViaAtual, ultimaViaPrincipalAnteriorEm, agora);
                const saiuParadaRecente = avaliarSaiuParadaConfirmadaRecentemente(saiuParadaConfirmadaEmNova, agora);
                alerta = aplicarCorroboracaoClasseViaria(alerta, quedaDetectada, saiuParadaRecente, BONUS_CORROBORACAO_POR_SINAL);
              } catch (errClasseViaria) {
                erros.push(`Aviso: falha ao avaliar classe viaria pro veiculo ${veiculoId}: ${String(errClasseViaria)}`);
              }
            }
          } else {
            // C1: falha pontual do OSRM /table (transiente) -- preserva o
            // streak anterior em vez de zerar, mesmo comportamento de
            // route.ts:2821-2824 (só este branch específico preserva; todo
            // resto do gate acima zera).
            afastandoStreakNovo = estadoAnterior.afastando_streak;
            ruaRaraStreakNovo = estadoAnterior.rua_rara_streak;
          }
        }

        // Step 8: grava estado (UPSERT por veiculo_id), tabela PRÓPRIA.
        // ultimo_datagps grava o datagps DESTA leitura -- vira o marco de
        // idempotência do próximo ciclo (ver comentário no gate acima).
        // COALESCE evita regredir pra null quando posAtual.datagps veio
        // ausente neste ciclo (mesmo padrão das outras colunas que só
        // avançam quando o dado novo é conhecido).
        //
        // datagpsPlausivelComoMarco (@/lib/motor-romaneio-estado, com teste
        // unitário e o raciocínio numérico completo): a Central grava
        // `parseDatagps(pos.datagps) ?? agora.toISOString()`
        // (motor/route.ts:2982), então um payload da Unitrac sem datagps
        // envenena posicoes_atuais.datagps com o UTC REAL, ~3h à frente de
        // todos os outros valores da coluna. Guardar esse valor como marco
        // travaria este veículo por ~3h (`datagps <= ultimo_datagps` a cada
        // 30s), silenciosamente. O veículo é processado normalmente; só a
        // leitura implausível não vira marco -- o marco antigo fica, e o
        // COALESCE abaixo o preserva.
        const datagpsMarco = datagpsPlausivelComoMarco(posAtual.datagps, agora) ? posAtual.datagps : null;
        try {
          await pool.query(
            `INSERT INTO romaneio_desvio_estado (veiculo_id, afastando_streak, rua_rara_streak, ultima_via_principal_em, saiu_parada_confirmada_em, ultimo_datagps, atualizado_em)
             VALUES ($1, $2, $3, $4, $5, $6, now())
             ON CONFLICT (veiculo_id) DO UPDATE SET
               afastando_streak = EXCLUDED.afastando_streak,
               rua_rara_streak = EXCLUDED.rua_rara_streak,
               ultima_via_principal_em = COALESCE(EXCLUDED.ultima_via_principal_em, romaneio_desvio_estado.ultima_via_principal_em),
               saiu_parada_confirmada_em = COALESCE(EXCLUDED.saiu_parada_confirmada_em, romaneio_desvio_estado.saiu_parada_confirmada_em),
               ultimo_datagps = COALESCE(EXCLUDED.ultimo_datagps, romaneio_desvio_estado.ultimo_datagps),
               atualizado_em = now()`,
            [veiculoId, afastandoStreakNovo, ruaRaraStreakNovo, ultimaViaPrincipalEmNova, saiuParadaConfirmadaEmNova, datagpsMarco]
          );
        } catch (errEstado) {
          erros.push(`Aviso: falha ao gravar romaneio_desvio_estado pro veiculo ${veiculoId}: ${String(errEstado)}`);
        }

        // Step 9: gerencia alertas_romaneio, tabela PRÓPRIA -- MESMO padrão
        // de dedup + auto-resolve que a Central faz em `alertas`
        // (route.ts:3079-3212).
        const alertasAbertosVeiculo = alertasAbertosPorVeiculo.get(veiculoId) ?? [];

        // 🔴 O MOTOR NUNCA FECHA DESVIO. Mesmo filtro da Central
        // (route.ts:3079-3081, TIPOS_NAO_GERENCIADOS importado de
        // @/lib/detectores -- a MESMA lista, nunca uma cópia paralela):
        // favela, desvio, bypass_entrega e parada_sem_marcacao só saem de
        // 'ativo' por ação MANUAL do operador. É pedido explícito do
        // usuário depois do incidente de 11/07 (churn da cerca virtual:
        // alerta sumia e voltava com id/desde novos a cada ciclo, e
        // 210+ desvios reais foram fechados sozinhos em 5 dias).
        //
        // Sem este filtro o pipeline novo repetia o 11/07 inteiro: como
        // montarAlertaDesvio só produz tipo "desvio", 100% do conteúdo de
        // alertas_romaneio era auto-fechável a cada ciclo, e QUALQUER gate
        // do ciclo servia de gatilho (!fresco, suspensoPorChegada,
        // emCarenciaDeBase, movimentoInsignificante, destinosRelevantes
        // vazio, OSRM devolvendo null). Já aconteceu em produção: o único
        // alerta que a entrega gerou (TTK-8A87, crítico, score 90) foi
        // fechado pela máquina às 01:51:36 do dia 23/08 -- operador_id e
        // origem_acao nulos, ou seja, não foi humano.
        //
        // ATUALIZADO 27/08 (task B1): "desvio" deixou de ser o único tipo
        // desta tabela -- parada_anomala/parada_longa/parada_fora_tapete
        // entraram e NÃO estão em TIPOS_NAO_GERENCIADOS, então o resolve
        // abaixo passa a executar de verdade pra elas (fecham sozinhas quando
        // o carro volta a andar, igual à Central). Desvio continua saindo de
        // 'ativo' só por ação manual. Quem fecha o que
        // ninguém trata é o cron diário 'expirar-alertas-romaneio-do-dia-
        // anterior' (migration 058) -- mesmo mecanismo da Central, mas com
        // janela de 1 dia em vez dos 7 dela, porque ninguém trabalha a tela
        // nova e um alerta preso cala o veículo na comparação (o motivo
        // completo está na migration).
        const alertasGerenciados = alertasAbertosVeiculo.filter(
          (a) => !TIPOS_NAO_GERENCIADOS.has(a.tipo)
        );

        // Candidatos DESTE ciclo: o desvio (Sinal A, quando houver) mais os
        // alertas de parada da task B1. Até 27/08 este bloco tratava UM
        // candidato só; com os 3 detectores de parada ele passa a tratar um
        // conjunto -- mesma semântica da Central, que já convive com vários
        // tipos abertos por veículo ao mesmo tempo.
        const candidatosCiclo: Alerta[] = [...(alerta ? [alerta] : []), ...alertasParada];
        const tiposDoCiclo = new Set(candidatosCiclo.map((c) => c.tipo));
        // Silenciamento de 2h (ver tiposSilenciadosPorVeiculo acima) --
        // mesma estrutura da Central (route.ts:3086-3088): tipo silenciado
        // não insere, não escala e não é resolvido pela máquina (preserva o
        // contexto enquanto o operador investiga).
        const silenciadosVeiculo = tiposSilenciadosPorVeiculo.get(veiculoId) ?? new Set<string>();

        // Auto-resolve dos GERENCIADOS que pararam de valer neste ciclo
        // (route.ts:3206-3212). Antes da task B1 isto nunca executava (só
        // "desvio" existia nesta tabela, e desvio nunca é gerenciado); agora
        // é o que faz parada_anomala/parada_longa/parada_fora_tapete fechar
        // sozinha quando o carro volta a andar -- exatamente como na Central.
        //
        // Só fecha o que este ciclo AVALIOU (podeFecharParadas /
        // podeFecharForaTapete, ver o bloco de parada acima) -- "não disparou"
        // e "não deu pra avaliar" não podem ter o mesmo efeito num alerta
        // antirroubo em aberto.
        const obsoletos = alertasGerenciados.filter((a) =>
          deveResolverAlertaGerenciado({
            tipo: a.tipo,
            disparouNesteCiclo: tiposDoCiclo.has(a.tipo),
            silenciado: silenciadosVeiculo.has(a.tipo),
            podeFecharParadas,
            podeFecharForaTapete,
          })
        );
        if (obsoletos.length > 0) {
          const erroResolveObsoletos = await resolverPelaMaquina(admin, obsoletos, agora.toISOString());
          if (erroResolveObsoletos) {
            erros.push(`Aviso: falha ao resolver alertas_romaneio obsoletos do veiculo ${veiculoId}: ${erroResolveObsoletos}`);
          }
        }

        for (const candidato of candidatosCiclo) {
          if (silenciadosVeiculo.has(candidato.tipo)) continue;
          const alertaExistente = alertasAbertosVeiculo.find((a) => a.tipo === candidato.tipo);
          // contexto por tipo: desvio leva origem_desvio (insumo da comparação
          // entre os pipelines); parada_fora_tapete leva os mesmos 3 campos
          // que a Central grava (route.ts:3178-3182); as outras paradas levam
          // o tempo parado, que é o que o operador precisa ver no card.
          const contextoAlerta =
            candidato.tipo === "desvio"
              ? { origem_desvio: candidato.origemDesvio }
              : candidato.tipo === "parada_fora_tapete"
                ? { parado_min: paradoMinVeiculo, dentro_tapete: dentroTapeteVeiculo, risco_area_atual: riscoAreaVeiculo }
                : { parado_min: paradoMinVeiculo };

          if (!alertaExistente) {
            // Cooldown por EPISÓDIO de parada (deveSuprimirRedisparoParada,
            // @/lib/detectores): um alerta já tratado pelo operador tem
            // status='resolvido' e por isso NUNCA aparece em
            // alertasAbertosVeiculo -- sem este gate, o mesmo episódio de
            // parada reabriria a cada ciclo de 30s (caso TUG-9D18 na Central).
            // Aninhado aqui de propósito, pelo mesmo motivo documentado em
            // route.ts:3198-3206.
            const suprimidoPorCooldown =
              TIPOS_PARADA_COM_COOLDOWN.has(candidato.tipo) &&
              deveSuprimirRedisparoParada({
                paradoDesde: paradoDesdeVeiculo,
                alertasTratadosDoTipo: paradasTratadasPorVeiculoTipo.get(`${veiculoId}:${candidato.tipo}`) ?? [],
              });
            if (suprimidoPorCooldown) continue;

            const { error: erroInsert } = await admin.from("alertas_romaneio").insert({
              cliente_id: info.cliente_id,
              veiculo_id: veiculoId,
              nivel: candidato.nivel,
              tipo: candidato.tipo,
              motivo: candidato.motivo,
              score: candidato.score,
              status: "ativo",
              lat: latAtual,
              lng: lngAtual,
              contexto: contextoAlerta,
              desde: agora.toISOString(),
            });
            if (erroInsert) {
              erros.push(`Aviso: falha ao inserir alertas_romaneio pro veiculo ${veiculoId}: ${erroInsert.message}`);
            } else {
              alertasGerados++;
            }
          } else if (alertaExistente.nivel !== "critico" && candidato.nivel === "critico") {
            // contexto vai junto, igual à Central (route.ts:3195-3201): sem
            // isso o contexto ficaria congelado no valor do alerta inicial
            // quando ele muda entre o disparo e a escalação.
            const { error: erroEscalar } = await admin
              .from("alertas_romaneio")
              .update({
                nivel: candidato.nivel,
                motivo: candidato.motivo,
                score: candidato.score,
                contexto: contextoAlerta,
              })
              .eq("id", alertaExistente.id);
            if (erroEscalar) {
              erros.push(`Aviso: falha ao escalar alertas_romaneio do veiculo ${veiculoId}: ${erroEscalar.message}`);
            }
          }
        }
      } catch (errVeiculo) {
        erros.push(`Erro ao processar veiculo ${veiculoId}: ${String(errVeiculo)}`);
      }
    }

    return Response.json({ veiculosProcessados, alertasGerados, erros });
  } finally {
    // Libera o lease SÓ se ainda formos o dono (token confere) -- mesmo
    // cuidado da Central (route.ts:4019-4033): um ciclo que passou de 90s e
    // já perdeu o lease nunca pode derrubar o lease do sucessor.
    try {
      const pgLease = await pool.connect();
      try {
        await pgLease.query(
          `update motor_lease set expira_em = now() where id = $1 and token = $2`,
          [MOTOR_ROMANEIO_LEASE_ID, leaseToken]
        );
      } finally {
        pgLease.release();
      }
    } catch { /* lease expira sozinho em 90s */ }
    await pool.end();
  }
}
