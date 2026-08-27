// Motor de detecção de alertas — funções PURAS (sem I/O).
// Cada detector avalia uma PosicaoNormalizada e retorna Alerta | null.
// Nunca importe nada de 'next' aqui — lib pura TypeScript.

import type { PosicaoNormalizada } from "./unitrac";
import { zScoreBaseline, type Baseline } from "./baseline-veiculo";

export type Alerta = {
  nivel: "critico" | "atencao";
  tipo: string;
  motivo: string;
  score: number;
  // Sinaliza que este alerta de desvio precisa passar pela verificacao de
  // corredor real (route.ts) antes de confirmar -- substitui o acoplamento
  // por string magica (motivo.startsWith("Afastando-se")) que existia ate
  // 10/07: qualquer ajuste de texto desligava a protecao inteira em
  // silencio. So os branches do FLUXO PRINCIPAL de detectarDesvio setam
  // isso; o branch remanescente da Camada 3 ("Aproximando...") nao seta --
  // tem semantica de deteccao diferente e nunca teve verificacao de corredor.
  precisaVerificacaoCorredor?: boolean;
  // Achado real 11/07: quando true, o alerta so pode sobreviver se o
  // corredor CONFIRMAR "fora" explicitamente -- "indisponivel"/orcamento
  // estourado NAO fazem fail-open aqui (ao contrario do padrao normal de
  // precisaVerificacaoCorredor). Usado especificamente pro caso "sem
  // historico de comportamento ainda" (0 entregas feitas): sem essa
  // exigencia extra, o gate antigo bloqueava a deteccao por completo; com
  // ela, a estrada real supre a falta de historico sem abrir mao de
  // cautela quando a API estiver fora.
  exigeConfirmacaoCorredor?: boolean;
  // Achado real 22/07 (auditoria): substitui o matching fragil por string
  // (motivo.startsWith(...)) em segmentoCalibracaoPreferido, que quebrava
  // silenciosamente se o texto do motivo mudasse. Distingue a ORIGEM real
  // de um alerta tipo="desvio": veio do detector comportamental
  // (detectarDesvio), da cerca virtual (alertaCerca, route.ts), da regra de
  // virada errada saindo de parada (achado real 26/07, Fase 2 -- dispara
  // com 1 leitura so, ver viradaErradaSaindoDeParada), ou da queda de
  // classe viaria disparando SOZINHA (achado real 27/07, pedido explicito
  // do usuario -- ate entao esse sinal so REFORCAVA um alerta que ja ia
  // disparar por outro motivo via aplicarBonusClasseViaria; ver o branch
  // dedicado dentro de detectarDesvio).
  // NAO inclui mais "parada_fora_tapete" (achado real da revisao adversarial
  // de 27/07, caso TTK-4D14): esse gatilho nasceu reusando tipo="desvio" +
  // origemDesvio="parada_fora_tapete", mas isso o fazia ocupar a MESMA vaga
  // de alerta-unico-por-veiculo-por-tipo da familia de desvio comportamental
  // (arriscando bloquear/perder um desvio real que surgisse depois, ver
  // detectarParadaForaTapete abaixo) e o excluia do auto-resolve generico
  // (fica preso ate resolucao manual ou o cron de 7 dias, muito mais tempo
  // do que faz sentido pra um sinal fundamentalmente de PARADA). Agora tem
  // tipo proprio ("parada_fora_tapete", ver TIPOS_NAO_GERENCIADOS) e nunca
  // seta este campo.
  // Achado real 28/07 (Task 2 do plano de melhorias pos-baseline): "rumo
  // diverge" (divergenciaRumoDispara, ver branch dedicado abaixo) usava
  // "comportamental" ate aqui -- igual a "afastando de tudo" e ao alerta
  // fraco de "alem do raio", apesar de ter perfil de falso positivo bem
  // diferente (dispara com o veiculo ainda se aproximando em linha reta,
  // so a DIRECAO diverge). Sem valor proprio, a taxa de falso positivo
  // desta regra especifica ficava escondida dentro do balde generico
  // tipo:desvio (ver segmentoCalibracaoPreferido em calibracao-desvio.ts).
  origemDesvio?: "afastando_geral" | "rua_rara_frota";
};

// Informativo de veiculo sem comunicacao (atraso > 60 min).
// Nao e um alerta critico nem de atencao — apenas contexto informativo.
export type InfoSemComunicacao = {
  tipo: "sem_comunicacao";
  nivel: "informativo";
  motivo: string;
  atraso: number;
};

export function detectarSemComunicacao(p: PosicaoNormalizada): InfoSemComunicacao | null {
  if (p.fresco) return null;
  return {
    tipo: "sem_comunicacao",
    nivel: "informativo",
    motivo: `Sem comunicacao ha ${formataDuracao(p.atraso)}`,
    atraso: p.atraso,
  };
}

// Formata minutos como '1h35min' ou '45min'.
export function formataDuracao(minutos: number): string {
  if (minutos >= 60) {
    const h = Math.floor(minutos / 60);
    const m = minutos % 60;
    return m > 0 ? `${h}h${m}min` : `${h}h`;
  }
  return `${minutos}min`;
}

// Formata o progresso de um alerta "afastando de tudo" em relação ao
// destino conhecido mais próximo, pro card do operador -- ver
// docs/superpowers/specs/2026-08-06-progresso-destino-desvio-design.md.
// Puramente informativo: o texto nunca sugere "resolvido"/"seguro" (achado
// de segurança do spec -- este sinal nao reduz urgencia automaticamente).
export function formatarProgressoDestino(deltaM: number): { texto: string; aproximando: boolean } {
  const arredondado = Math.round(Math.abs(deltaM));
  if (deltaM < 0) {
    return { texto: `aproximando de um destino (${arredondado}m)`, aproximando: true };
  }
  return { texto: `ainda se afastando (+${arredondado}m)`, aproximando: false };
}

const LABEL_COMPONENTE_PLACAR: Record<string, string> = {
  s1AfastandoDeTudo: "afastando de tudo",
  s2RumoDivergente: "rumo divergente",
  s3ForaDoCorredor: "fora do corredor",
  s4CelulaDesconhecida: "célula desconhecida",
  s5DiaEstagnado: "dia estagnado",
  s6ParadoLongeDeTudo: "parado longe de tudo",
  d1ParadaPertoDeEntrega: "parado perto de entrega",
  d2PadraoEntrega: "padrão de entrega",
  d3DestinoAlinhadoAproximando: "destino alinhado e aproximando",
  d4DentroDoCorredor: "dentro do corredor",
};

// Texto do placar de desvio sombra pro card do alerta -- ver
// docs/superpowers/specs/2026-08-07-placar-sombra-anotacao-design.md. So
// informacao (nunca "resolvido"/"seguro", nunca cor verde no chamador) --
// numero e sinais, quem decide e o operador. Chaves de auditoria que nao
// sao pesos reais de score (classeViariaSuprimida, classeViariaSuprimidaPor,
// zeradoPorChegada) ficam de fora por nao estarem em LABEL_COMPONENTE_PLACAR
// -- sem precisar de lista de exclusao separada.
export function formatarPlacarSombra(placar: number, componentes: Record<string, unknown>): string {
  const ativos = Object.keys(componentes)
    .filter((k) => LABEL_COMPONENTE_PLACAR[k] && componentes[k] !== false)
    .map((k) => LABEL_COMPONENTE_PLACAR[k]);
  const sufixo = ativos.length > 0 ? ` — sinais: ${ativos.join(", ")}` : "";
  return `Placar sombra: ${Math.round(placar)}/100${sufixo}`;
}

// Texto de confiabilidade historica do card, a partir de
// contexto.calibracao.taxa_falso_positivo -- ja gravado na criacao/
// escalacao de todo alerta de desvio por montarContextoDesvio (route.ts),
// nenhuma escrita nova. Ver
// docs/superpowers/specs/2026-08-08-confiabilidade-detector-anotacao-design.md:
// achado real que classe_viaria erra 66% das vezes (139+ amostras) sem
// nenhum sinal nos dados ja coletados que discrimine certo de errado --
// em vez de inventar supressao automatica sem sinal confiavel, expoe o
// numero real e deixa a leitura com o operador. So informacao, nunca
// "resolvido"/"seguro", nunca cor por valor.
export function formatarConfiabilidadeDetector(taxaFalsoPositivo: number): string | null {
  if (taxaFalsoPositivo < 0) return null;
  const pct = Math.round(taxaFalsoPositivo * 100);
  return `Histórico: ${pct}% de falso positivo neste tipo de alerta`;
}

export function detectarPanico(p: PosicaoNormalizada): Alerta | null {
  if (!p.panico) return null;
  return { nivel: "critico", tipo: "panico", motivo: "PANICO acionado", score: 100 };
}

export function detectarBau(
  p: PosicaoNormalizada,
  ctx?: { noCliente?: boolean }
): Alerta | null {
  if (!p.bau) return null;
  // Descarga no cliente: operacao normal, nao e alerta.
  if (ctx?.noCliente) return null;
  // Bau aberto em movimento e mais grave: perda de carga em transito.
  if (p.velocidade > 0) {
    return {
      nivel: "critico",
      tipo: "bau",
      motivo: `Bau aberto em movimento a ${p.velocidade} km/h — risco de perda de carga`,
      score: 95,
    };
  }
  return { nivel: "critico", tipo: "bau", motivo: "Bau aberto fora do ponto de entrega", score: 90 };
}

// 30-59 min: pode ser tunel/garagem — atencao. 60-180 min: critico.
// Acima de 180 min: defeito de rastreador ou veiculo recolhido, nao jammer real.
const JAMMER_ATENCAO_MIN = 30;
const JAMMER_CRITICO_MIN = 60;
const JAMMER_TETO_MIN = 180;

export function detectarJammer(p: PosicaoNormalizada): Alerta | null {
  if (!p.ignicao) return null;
  if (p.atraso < JAMMER_ATENCAO_MIN || p.atraso > JAMMER_TETO_MIN) return null;

  // Achado da pesquisa (07/07): ~85% dos roubos de carga documentados no
  // Mexico envolveram jammer, e casos reais mostram que foi o sinal cair
  // justamente durante uma PARADA (nao um jammer com o veiculo em movimento,
  // que pode ser so sombra de sinal num tunel/vao entre predios) que expos
  // o roubo. p.velocidade aqui e a ULTIMA leitura conhecida antes do sinal
  // cair (a linha nao atualiza durante o gap) — reflete o estado real no
  // momento em que o sinal sumiu, nao um "zero" por falta de dado.
  const paradoQuandoSinalCaiu = p.velocidade === 0;

  if (p.atraso < JAMMER_CRITICO_MIN) {
    return {
      nivel: "critico",
      tipo: "jammer",
      motivo: paradoQuandoSinalCaiu
        ? `Sinal ausente ha ${p.atraso}min — veiculo estava PARADO quando o sinal caiu (monitorar de perto)`
        : `Sinal ausente ha ${p.atraso}min com ignicao ligada (monitorar)`,
      score: paradoQuandoSinalCaiu ? 65 : 55,
    };
  }
  return {
    nivel: "critico",
    tipo: "jammer",
    motivo: paradoQuandoSinalCaiu
      ? `Sinal perdido ha ${p.atraso}min — veiculo estava PARADO quando o sinal caiu (padrao de bloqueio durante parada, ver protocolo)`
      : `Sinal perdido ha ${p.atraso}min com ignicao ligada (possivel bloqueador GPS)`,
    score: paradoQuandoSinalCaiu ? 90 : 80,
  };
}

// Achado real 09/08: usuario pediu pra desligar este detector inteiro --
// falso positivo recorrente reportado no grupo (veiculo que saiu
// legitimamente da base horas atras continuava sinalizado a cada ciclo,
// nao so no instante da saida). Mesmo padrao ja usado neste arquivo pra
// desligar regra sem apagar a logica (ver DESVIO_SO_AFASTANDO_OU_FORA_DO_TAPETE
// acima): flag desliga em producao, `ctx.ativo` override mantem os testes
// existentes exercitando a logica real, caso o detector precise voltar
// (ex: redesenhado como disparo por BORDA -- so no momento da transicao
// base->fora -- em vez de reavaliar o estado a cada ciclo).
const SAIDA_NAO_AUTORIZADA_ATIVO = false;

// Veiculo fora da base, motor ligado e SEM rota/entrega programada no dia.
// Roda 24h: o que define a suspeita NAO e o horario (existe entrega de madrugada),
// e sim nao ter rota. Motor ligado parado pode ser recarga/descanso (atencao);
// em movimento fora da base sem rota e deslocamento indevido (critico).
// Substitui o antigo detector "ignicao_noturna", que disparava por horario.
export function detectarSaidaNaoAutorizada(
  p: PosicaoNormalizada,
  ctx: {
    foraDaBase: boolean;
    temPendentes: boolean;
    entregasTotal?: number;
    rumoMovimento?: number | null;
    rumoBase?: number | null;
    distBaseM?: number | null;
    temPOIProximo?: boolean;
    ativo?: boolean;
  }
): Alerta | null {
  if (!(ctx.ativo ?? SAIDA_NAO_AUTORIZADA_ATIVO)) return null;
  if (!p.fresco || !p.ignicao) return null;
  if (!ctx.foraDaBase || ctx.temPendentes) return null;
  // undefined = API de rota indisponivel; sem saber se ha entregas, nao dispara.
  if (ctx.entregasTotal === undefined) return null;
  // Tem (ou teve) entregas no dia = esta trabalhando legitimamente.
  if (ctx.entregasTotal > 0) return null;
  // Perto da base (< 2km): saindo para o dia, manobrando ou abastecendo na
  // propria base. A grande fonte de falso positivo (veiculo que acabou de sair).
  if (ctx.distBaseM != null && ctx.distBaseM < 2000) return null;
  // Parado perto de posto/POI legitimo (Overpass): abastecimento ou parada de
  // apoio (pegar carga, lanche), nao deslocamento indevido.
  if (p.velocidade === 0 && ctx.temPOIProximo) return null;
  // Veiculo se aproximando da base (ate 3km, heading dentro de 60 graus): retornando, nao dispara.
  if (
    ctx.rumoMovimento != null && ctx.rumoBase != null && ctx.distBaseM != null &&
    ctx.distBaseM <= 3000 && difAnguloGraus(ctx.rumoMovimento, ctx.rumoBase) <= 60
  ) return null;
  if (p.velocidade > 0) {
    return {
      nivel: "critico",
      tipo: "saida_nao_autorizada",
      motivo: "Em movimento fora da base sem rota programada",
      score: 80,
    };
  }
  return {
    nivel: "critico",
    tipo: "saida_nao_autorizada",
    motivo: "Parado fora da base sem rota programada",
    score: 45,
  };
}

export function detectarExcessoVelocidade(p: PosicaoNormalizada): Alerta | null {
  // 120 km/h: rodovias federais do RJ permitem 110-120 km/h para veiculos pesados;
  // 100 km/h gerava falso atencao em qualquer estrada normal.
  if (p.velocidade > 120) {
    return {
      nivel: "critico",
      tipo: "excesso",
      motivo: `Excesso de velocidade: ${p.velocidade} km/h`,
      score: 40,
    };
  }
  return null;
}

// Retorna true se a data estiver em horario de operacao:
// dia util (segunda a sexta) E entre 6h e 20h no fuso America/Sao_Paulo.
export function emHorarioOperacao(d: Date): boolean {
  const fmt = new Intl.DateTimeFormat("pt-BR", {
    timeZone: "America/Sao_Paulo",
    weekday: "short",
    hour: "numeric",
    hour12: false,
  });
  const partes = fmt.formatToParts(d);
  const weekday = partes.find((p) => p.type === "weekday")?.value ?? "";
  const horaStr = partes.find((p) => p.type === "hour")?.value ?? "0";
  const hora = parseInt(horaStr, 10);

  // Dias uteis em pt-BR: seg, ter, qua, qui, sex
  const diaUtil = ["seg", "ter", "qua", "qui", "sex"].some((dia) =>
    weekday.toLowerCase().startsWith(dia)
  );

  return diaUtil && hora >= 6 && hora < 20;
}

export function detectarParadaCliente(ctx: {
  paradoMin: number;
  emOperacao: boolean;
  noCliente?: boolean;
}): Alerta | null {
  if (ctx.noCliente && ctx.emOperacao && ctx.paradoMin >= 90) {
    return {
      nivel: "critico",
      tipo: "parada_cliente",
      motivo: `Parado no cliente ha ${formataDuracao(ctx.paradoMin)} — acionar motorista imediatamente`,
      score: 72,
    };
  }
  return null;
}

export function detectarParadaLonga(ctx: {
  paradoMin: number;
  emOperacao: boolean;
  foraDaBase: boolean;
  noCliente?: boolean;
  temPOIProximo?: boolean;
  entregasFeitas?: number;
  entregasTotal?: number;
}): Alerta | null {
  // Parado no cliente: coberto por detectarParadaCliente, evita duplicata.
  if (ctx.noCliente) return null;
  // Parado em posto/POI legítimo: não é suspeito.
  if (ctx.temPOIProximo) return null;
  // Rota concluída: coberto por retorno_tardio, evita duplicata.
  if (ctx.entregasTotal && ctx.entregasTotal > 0 && ctx.entregasFeitas !== undefined && ctx.entregasFeitas >= ctx.entregasTotal) return null;
  if (ctx.paradoMin >= 90 && ctx.emOperacao && ctx.foraDaBase) {
    return {
      nivel: "critico",
      tipo: "parada_longa",
      motivo: `Parado ha ${formataDuracao(ctx.paradoMin)}, contatar equipe`,
      score: 50,
    };
  }
  return null;
}

// Parada anômala curta — detecta parada suspeita ANTES dos 90min da parada_longa.
// Um roubo típico acontece em 10-20min; 90min já é tarde demais para reagir.
//
// Thresholds:
//   cidade (estavEmMovimento=true, velocidade anterior >= 30 km/h): >= 12min
//   estrada (velocidade anterior < 30 km/h ou não disponível): >= 25min
//
// Anti-pisca: só dispara se o veículo já estava parado no ciclo anterior
// (jaParedoNoCicloAnterior=true), evitando alerta em paradas de semáforo.
export function detectarParadaAnomala(ctx: {
  paradoMin: number;
  emOperacao: boolean;
  foraDaBase: boolean;
  noCliente: boolean;
  estavEmMovimento: boolean;  // velocidade anterior >= 30 km/h
  esMadrugada: boolean;       // 00h-05h fuso Sao Paulo
  emZonaRisco: boolean;       // dentro de geofence tipo "risco"
  temPOIProximo: boolean;     // posto/restaurante/farmacia a <80m
  jaParedoNoCicloAnterior: boolean; // anti-pisca
  vizinhosParados?: number;   // outros veiculos da frota parados num raio curto
}): Alerta | null {
  if (!ctx.emOperacao || !ctx.foraDaBase || ctx.noCliente) return null;
  if (!ctx.jaParedoNoCicloAnterior) return null; // aguarda um ciclo antes de disparar
  if (ctx.temPOIProximo) return null; // parada em local legitimo
  // Congestionamento: 2+ outros veiculos da frota parados na mesma area =
  // transito/fila, nao roubo. Comparar veiculos entre si mata o falso positivo.
  if ((ctx.vizinhosParados ?? 0) >= 2) return null;

  // Baixado de 20/35 pra 12/20 em 12/07 (revisao linha por linha a pedido do
  // usuario, buscando desvio real passando batido por excesso de cautela --
  // "um roubo tipico acontece em 10-20min" ja documentado acima, e 20/35
  // estava na borda ou depois disso). ATENCAO: os valores 12/25 ja foram
  // tentados ANTES e revertidos pra 20/35 porque disparavam pra
  // praticamente qualquer parada em transito pesado do RJ -- o novo par
  // (12/20) fica no limite do que ja foi tentado pra cidade e mais
  // conservador que repetir o par exato que falhou pra estrada. Se
  // reproduzir ruido de transito pesado, e uma reversao facil (1 linha) e
  // o monitoramento periodico ja em andamento vai pegar isso.
  const limiteMin = ctx.estavEmMovimento ? 12 : 20;
  if (ctx.paradoMin < limiteMin || ctx.paradoMin >= 90) return null; // >= 90 ja e parada_longa

  let score = 55;
  if (ctx.esMadrugada) score += 15;
  if (ctx.emZonaRisco) score += 10;

  // Todo mundo vira critico agora (pedido do cliente 06/07: acabar com o
  // nivel "atencao") — mantido o sufixo de madrugada/zona de risco no motivo
  // pra nao perder o contexto de severidade dentro do proprio texto.
  const nivel: "critico" | "atencao" = "critico";

  const duracao = formataDuracao(ctx.paradoMin);
  const sufixo = (ctx.esMadrugada && ctx.emZonaRisco)
    ? " (MADRUGADA + AREA DE RISCO)"
    : ctx.esMadrugada
      ? " (madrugada)"
      : ctx.emZonaRisco
        ? " (area de risco)"
        : "";
  return {
    nivel,
    tipo: "parada_anomala",
    motivo: `Parada suspeita de ${duracao} fora de rota sem ponto de entrega${sufixo}`,
    score,
  };
}

// Parada FORA DO TAPETE — gatilho RÁPIDO complementar a detectarParadaAnomala.
// Achado real 27/07 (caso TTK-4D14 -- ver
// docs/superpowers/specs/2026-07-27-parada-fora-tapete-e-fix-lat-escalacao-design.md):
// devAvancarStreaksDesvio (abaixo, ~linha 690) exige velocidade>0 pra avançar
// QUALQUER streak de desvio (comportamental, tapete, divergência de rumo) —
// correto e intencional (anti-jitter de GPS parado, achado 10/07). Consequência:
// um veículo que sai da rota e PARA antes de acumular streak>=2 nunca dispara
// nada por essa família inteira de regras. detectarParadaAnomala cobre paradas
// de 12-89min fora da base/cliente, mas não olha se a parada é especificamente
// fora do tapete — só cobre parada LONGA em geral. Uma parada de poucos
// minutos já fora do tapete/rua conhecida cai no buraco: curta demais pra
// parada suspeita, parada demais pra qualquer streak de movimento.
//
// Piso de 3min deliberadamente baixo comparado ao piso de 12min da parada
// anômala genérica — a condição extra (dentroTapete===false, que já exige
// TAPETE_MIN_CELULAS de cobertura mínima confirmada no motor, ver route.ts)
// é uma corroboração espacial forte o bastante pra justificar confirmar mais
// rápido. Ajustável com dado real depois (mesmo espírito de todo limiar deste
// arquivo).
//
// Reusa as MESMAS supressões anti-FP já usadas por detectarParadaAnomala:
// temPOIProximo (posto de gasolina/apoio) e vizinhosParados (congestionamento
// — 2+ outros veículos da frota parados na mesma área).
//
// tipo="parada_fora_tapete" PRÓPRIO (revisão adversarial de 27/07, caso
// TTK-4D14 -- corrige o design original desta mesma sessão, que reusava
// tipo="desvio" + origemDesvio="parada_fora_tapete"). Dois problemas reais
// encontrados nesse reuso, ambos resolvidos por dar um tipo próprio:
//   (1) lat/lng errados -- o insert de alerta em route.ts decide
//       "ehDesvio = tipo==='desvio' && desvioInicio!==null" e, quando
//       true, grava desvioInicio.lat/lng (ponto FIXO de um streak de
//       MOVIMENTO anterior, possivelmente obsoleto) em vez de pos.lat/lng
//       (onde o veículo está PARADO agora, o único ponto que faz sentido
//       pra este alerta). Tipo próprio faz ehDesvio ser sempre false aqui,
//       então o insert cai no default correto (pos.lat/lng) sem precisar
//       de nenhum caso especial.
//   (2) colisão de vaga -- alertas no banco são 1-por-veículo-por-tipo
//       (dedup e escalação em route.ts chaveiam por `alerta.tipo`). Com
//       tipo="desvio" compartilhado, este gatilho (baseado em posição
//       ESTÁTICA) ocupava a MESMA linha que um desvio comportamental real
//       (baseado em streak de MOVIMENTO) usaria depois. Se esta parada
//       disparasse critico primeiro (score>=65 quando riscoAreaAtual>=25,
//       ex. 1 favela), um desvio real subsequente do mesmo veículo nunca
//       conseguiria criar linha nova (jaExiste=true) nem escalar (a
//       escalação só grava quando não-crítico -> crítico; se a linha já
//       está crítica por causa DESTA parada, o motivo/lat/lng/score do
//       desvio real de verdade nunca chegam ao banco). Tipo próprio
//       elimina a colisão por construção: nunca compete pela mesma vaga
//       que "desvio" (dedup, escalação, TIPOS_NAO_GERENCIADOS).
// Consequência boa e desejada do tipo próprio: participa do auto-resolve
// GENÉRICO (baseado em alertasGerenciados em route.ts) exatamente como
// detectarParadaAnomala já participa -- fecha sozinho quando a condição
// deixa de valer (voltou pro tapete, saiu da base, etc.), em vez de ficar
// preso até resolução manual ou o cron de 7 dias (o que acontecia sob
// tipo="desvio", ver TIPOS_NAO_GERENCIADOS). Não precisa de guard contra
// dupla contagem em aplicarBonusClasseViaria nem entra em
// TIPOS_CORROBORANTES -- este detector só dispara com velocidade===0,
// mutuamente exclusivo por construção com detectarDesvio (sempre exige
// p.velocidade>0), nunca pode coexistir com o mesmo veículo no mesmo
// ciclo.
export const PARADA_FORA_TAPETE_MIN = 3;

export function detectarParadaForaTapete(ctx: {
  paradoMin: number;
  emOperacao: boolean;
  foraDaBase: boolean;
  noCliente: boolean;
  dentroTapete: boolean | null;
  temPOIProximo: boolean;
  vizinhosParados?: number;
  riscoAreaAtual: number;
}): Alerta | null {
  if (!ctx.emOperacao || !ctx.foraDaBase || ctx.noCliente) return null;
  // false = fora do tapete com cobertura mínima confirmada (route.ts,
  // TAPETE_MIN_CELULAS). true = dentro do tapete: nunca dispara. null = sem
  // cobertura suficiente ainda pra confiar no sinal (cold-start): também não
  // dispara, mesma cautela de CAMADA3_TAPETE_ATIVA/dentroTapete em geral.
  if (ctx.dentroTapete !== false) return null;
  if (ctx.paradoMin < PARADA_FORA_TAPETE_MIN) return null;
  if (ctx.temPOIProximo) return null; // parada em local legitimo (posto/apoio)
  // Congestionamento: 2+ outros veiculos da frota parados na mesma area =
  // transito/fila, nao roubo — mesma régua de detectarParadaAnomala.
  if ((ctx.vizinhosParados ?? 0) >= 2) return null;

  const nivel: "critico" | "atencao" = ctx.riscoAreaAtual >= RISCO_AREA_LIMIAR ? "critico" : "atencao";
  const duracao = formataDuracao(ctx.paradoMin);
  return {
    nivel,
    tipo: "parada_fora_tapete",
    motivo: `Parado há ${duracao} fora de qualquer via conhecida da frota, sem ponto de entrega por perto`,
    score: nivel === "critico" ? 65 : 45,
  };
}
// Pesos do score de risco de área (0-100). Cada camada contribui
// independente — não é probabilidade, é um índice de prioridade pro
// desvio decidir se escala rápido (ver RISCO_AREA_LIMIAR).
const RISCO_FAVELA = 40;
const RISCO_TIROTEIO_PERTO = 40;
const RISCO_ROUBO_CARGA_ALTO = 20;
const RISCO_ROUBO_CARGA_MEDIO = 10;
const RISCO_CORREDOR_RODOVIA = 20;
// Area de risco cadastrada pelo PROPRIO cliente (ex.: "Caixotaria do Ceasa",
// area conhecida de receptacao/roubo perto do Benassi, ja mapeada por eles
// no Unitrac -- ver geofences.tipo='area_risco_cliente', escopada por
// cliente_id, 16/07/2026). Peso proximo do favela: e conhecimento
// operacional direto do cliente sobre um risco real, nao um proxy
// estatistico como CISP/corredor.
const RISCO_AREA_CLIENTE = 30;
// Fator horario multiplicativo (ver calcularPerfilHorario em fogocruzado.ts):
// fora dessa faixa, um horario com poucos dados historicos poderia zerar ou
// disparar o score espacial por ruido estatistico — consenso da literatura
// STKDE/aoristic e sempre MULTIPLICAR a base espacial, nunca somar bonus fixo.
export const FATOR_HORARIO_MIN = 0.7;
export const FATOR_HORARIO_MAX = 1.6;
// Acima disso, trata como "área de risco elevado" pro desvio escalar tão
// rápido quanto "fora do tapete" — um sinal isolado (só favela, ou só
// tiroteio perto) já basta; não precisa de combinação de vários.
// Baixado de 40 pra 25 em 11/07 (diretiva explicita: falso positivo
// aceitavel, prioridade total e nunca perder desvio real) -- um sinal
// moderado isolado (ex. so roubo de carga alto + fator horario) ja deve
// bastar, sem precisar de combinacao forte tipo favela+tiroteio.
export const RISCO_AREA_LIMIAR = 25;

// Achado real 28/07 (Task 6, revisao manual de FP de rua-estreita): 36%
// dos casos eram o veiculo saindo de uma parada de entrega LEGITIMA e
// pegando uma rua estreita logo em seguida. saiu_parada_confirmada_em
// (posicoes_atuais, migration 011) e' setado por route.ts no ciclo exato
// da transicao (saiuDoRaioAgora && dwellAnterior >=
// BYPASS_ENTREGA_DWELL_MINIMO_SEGUNDOS -- "confirmada" = parou tempo
// suficiente pra nao ser so uma passagem, mesmo limiar ja usado por
// detectarBypassEntrega) e propagado enquanto a janela abaixo nao expira
// (decai sozinho, mesmo espirito de ultima_via_principal_em/
// JANELA_QUEDA_CLASSE_MIN em route.ts -- sem reset explicito). Mesma ordem
// de grandeza do JANELA_QUEDA_CLASSE_MIN existente (10min), um pouco menor
// porque a manobra tipica (sair do raio, virar numa rua estreita) e rapida
// -- nao precisa da dezena de minutos que justifica o gate de classe
// viaria em si.
// Idade minima (minutos) pra um alerta virar elegivel pra acao em massa
// (Resolver todos / Limpar avisos) -- ver
// docs/superpowers/specs/2026-08-09-idade-minima-acao-massa-design.md.
// Achado real 08/08 (caso TTH-3C94): alerta real fechado por "limpar em
// massa" 80s depois de nascer, antes de qualquer revisao humana -- 22
// casos assim nos ultimos 7 dias (todos < 2min), 0 casos assim em acao
// INDIVIDUAL no mesmo periodo. So acoes em massa tem esse risco.
export const IDADE_MINIMA_ACAO_MASSA_MIN = 5;

// Limite INCLUSIVO (exatamente 5min conta como elegivel) -- evita ficar
// preso por causa de arredondamento entre o momento gravado em `desde` e
// o momento do clique real do operador.
export function elegivelParaAcaoMassa(desde: string, agora: Date): boolean {
  const idadeMin = (agora.getTime() - new Date(desde).getTime()) / 60000;
  return idadeMin >= IDADE_MINIMA_ACAO_MASSA_MIN;
}

// BLOCKER 1 (revisao independente 27/07): mapaTiposSilenciados (route.ts)
// contava QUALQUER linha status='falso_positivo' recente como "operador
// ensinando o sistema" e silenciava o tipo pro veiculo por 2h -- inclusive
// as que um auto-resolve gerou (hoje, so o de "afastando de tudo" quando
// rota concluida). contexto.auto_resolvido marca a origem; linhas assim
// NUNCA devem contar pro silenciamento -- so falso_positivo marcado por
// acao humana explicita (resolverAlerta/marcarFalsoPositivo em
// acoes-alertas.ts) ensina o sistema.
export function contaComoEventoDeSilenciamento(contexto: unknown): boolean {
  if (
    contexto !== null &&
    typeof contexto === "object" &&
    (contexto as Record<string, unknown>).auto_resolvido === true
  ) {
    return false;
  }
  return true;
}

// M1 (revisao independente round 3, 27/07): contaComoEventoDeSilenciamento
// acima responde uma pergunta DIFERENTE (deve este falso_positivo silenciar
// o tipo pro veiculo por 2h?) da que recalibrar-desvio/route.ts precisa
// (deve esta linha contar como JULGAMENTO HUMANO real pra taxaGlobal e pro
// segmento grosseiro `tipo:desvio`?). Ate round 2, so
// contaComoEventoDeSilenciamento existia e a calibracao reusava ela --
// cobria contexto.auto_resolvido (auto-resolve de "rua estranha", este
// arquivo), mas NAO contexto.auto_expirado (cron
// 'expirar-alertas-ativos-esquecidos', scripts/migrations/contabo/
// 002_retencao.sql), que fecha sozinho como status='resolvido' qualquer
// alerta 'ativo' esquecido ha 7+ dias. Como desvio NUNCA fecha sozinho por
// conta propria (so por acao manual do operador ou por esse cron -- ver
// TIPOS_NAO_GERENCIADOS), TODO desvio que o operador nunca chegou a tratar
// eventualmente vira uma linha auto_expirado -- e sem este predicado essas
// linhas contavam como "verdadeiro positivo" (status != 'falso_positivo')
// na calibracao, inflando taxaGlobal e o segmento tipo:desvio com "operador
// nunca chegou a ver" disfarcado de "confirmado por revisao humana".
// Funcao NOVA e separada (em vez de sobrecarregar
// contaComoEventoDeSilenciamento com uma segunda pergunta -- a resposta
// certa pra "silenciar por 2h" e pra "conta pra calibracao" nao precisam
// coincidir, e forcar as duas na mesma funcao esconderia isso): false pra
// auto_resolvido===true OU auto_expirado===true, true no resto (inclusive
// {}/null) -- mesmo comportamento default-true de
// contaComoEventoDeSilenciamento. Usada so em recalibrar-desvio/route.ts
// (pergunta de pureza de calibracao); motor/route.ts continua usando
// contaComoEventoDeSilenciamento pra mapaTiposSilenciados -- alerta
// auto_expirado silenciar o tipo por 2h e' uma questao separada, fora de
// escopo mudar esse comportamento aqui (ver M1 na revisao round 3).
export function contaComoRotuloHumano(contexto: unknown): boolean {
  if (contexto !== null && typeof contexto === "object") {
    const c = contexto as Record<string, unknown>;
    if (c.auto_resolvido === true || c.auto_expirado === true) return false;
  }
  return true;
}

// Score de risco da posição ATUAL do veículo (0-100), combinando sinais
// geográficos/temporais independentes do tapete de rotas. Função pura —
// o motor busca os dados (favela, tiroteio, roubo_carga por CISP, horário)
// e só passa os booleanos/números já resolvidos aqui.
export function calcularRiscoArea(ctx: {
  emFavela: boolean;
  tiroteioRecentePertoM: number | null; // null = nenhum tiroteio ativo relevante
  rouboCargaCispTotal: number | null; // null = sem CISP resolvido pra essa posição
  emCorredorRodoviaRisco: boolean;
  emAreaRiscoCliente: boolean; // area de risco cadastrada pelo proprio cliente
  // Fator multiplicativo por hora do dia (ver calcularPerfilHorario), tipico
  // 0.7-1.6. Default esperado 1 (neutro) quando nao ha perfil horario
  // disponivel ainda (ex.: Fogo Cruzado fora do ar) — nunca inventa risco.
  fatorHorario: number;
}): number {
  let score = 0;
  if (ctx.emFavela) score += RISCO_FAVELA;
  if (ctx.tiroteioRecentePertoM !== null && ctx.tiroteioRecentePertoM <= 1500) {
    score += RISCO_TIROTEIO_PERTO;
  }
  if (ctx.rouboCargaCispTotal !== null) {
    if (ctx.rouboCargaCispTotal >= 15) score += RISCO_ROUBO_CARGA_ALTO;
    else if (ctx.rouboCargaCispTotal > 0) score += RISCO_ROUBO_CARGA_MEDIO;
  }
  if (ctx.emCorredorRodoviaRisco) score += RISCO_CORREDOR_RODOVIA;
  if (ctx.emAreaRiscoCliente) score += RISCO_AREA_CLIENTE;
  return Math.min(100, score * ctx.fatorHorario);
}

// Ponto de entrega com coordenada valida? Unitrac retorna null quando o
// endereco nunca foi geocodificado -- sem este filtro, haversineM trata
// null como 0 (coercao JS), e o "destino" vira um ponto fantasma a
// ~5.300km (distancia até 0,0 a partir do Rio) que infla a contagem de
// destinos pendentes sem representar nada real.
export function temCoordenadaValida(pt: { lat: number | null; lng: number | null }): boolean {
  return pt.lat != null && pt.lng != null && !(pt.lat === 0 && pt.lng === 0);
}

// Diferença angular absoluta entre dois rumos (0..180). Duplicada de unitrac
// para manter este módulo sem dependências de I/O.
function difAnguloGraus(a: number, b: number): number {
  const d = Math.abs(a - b) % 360;
  return d > 180 ? 360 - d : d;
}

function fmtDist(m: number): string {
  if (m < 1000) return `${Math.round(m / 10) * 10}m`;
  return `${(m / 1000).toFixed(1).replace(".", ",")}km`;
}
function fmtIdade(min: number | null): string {
  if (min == null) return "agora";
  if (min < 1) return "agora";
  if (min < 60) return `há ${min}min`;
  return `há ${Math.floor(min / 60)}h`;
}

// Fogo Cruzado mantém eventos por ate 3h. Filtrar por idade evita tratar
// tiroteio encerrado ha 2h como risco ativo.
const TIROTEIO_CRITICO_MAX_MIN = 60;  // acima disso: maximo atencao, mesmo perto
const TIROTEIO_SUPRIME_MIN = 120;     // acima disso: evento provavelmente encerrado

// Detector de TIROTEIO PRÓXIMO (operação/violência acontecendo agora na região).
// Cruza a posição do veículo com os tiroteios ATIVOS (últimas ~3h, Fogo Cruzado).
// Perigo imediato à carga: se há tiro perto, a central tem que saber JÁ.
export function detectarTiroteioProximo(
  p: PosicaoNormalizada,
  ctx: { distTiroteioM: number | null; tiroteioIdadeMin: number | null }
): Alerta | null {
  if (ctx.distTiroteioM === null) return null;
  if (!p.fresco) return null;
  const idadeMin = ctx.tiroteioIdadeMin ?? 0;
  if (idadeMin >= TIROTEIO_SUPRIME_MIN) return null;
  const quando = fmtIdade(ctx.tiroteioIdadeMin);
  if (ctx.distTiroteioM <= 600) {
    if (idadeMin < TIROTEIO_CRITICO_MAX_MIN) {
      return {
        nivel: "critico",
        tipo: "tiroteio",
        motivo: `Tiroteio RECENTE a ${fmtDist(ctx.distTiroteioM)} (${quando}) — area de risco`,
        score: 88,
      };
    }
    return {
      nivel: "critico",
      tipo: "tiroteio",
      motivo: `Tiroteio a ${fmtDist(ctx.distTiroteioM)} (${quando}) — monitorar situacao`,
      score: 60,
    };
  }
  if (ctx.distTiroteioM <= 2000) {
    return {
      nivel: "critico",
      tipo: "tiroteio",
      motivo: `Tiroteio a ${fmtDist(ctx.distTiroteioM)} (${quando}) proximo a rota`,
      score: 50,
    };
  }
  return null;
}

// Retorna o veiculo como suspeito se concluiu todas as entregas mas nao retornou
// a nenhuma base em mais de 60 min apos a ultima entrega.
export function detectarRetornoTardio(ctx: {
  entregas_feitas: number;
  entregas_total: number;
  foraDaBase: boolean;
  paradoMin: number;
  emOperacao: boolean;
}): Alerta | null {
  if (!ctx.emOperacao) return null;
  if (ctx.entregas_total === 0) return null;
  if (ctx.entregas_feitas < ctx.entregas_total) return null;
  if (!ctx.foraDaBase) return null;
  if (ctx.paradoMin < 60) return null;
  return {
    nivel: "critico",
    tipo: "retorno_tardio",
    motivo: `Rota concluida ha ${formataDuracao(ctx.paradoMin)} sem retorno a base`,
    score: 58,
  };
}

// Veiculo parado com motor ligado durante a madrugada fora da base.
// Cobre o gap em que emHorarioOperacao=false desativa os detectores principais.
export function detectarParadaNoturnaIgnicaoAtiva(
  p: PosicaoNormalizada,
  ctx: { foraDaBase: boolean; noCliente?: boolean; horaSP: number }
): Alerta | null {
  if (!p.fresco) return null;
  if (!p.ignicao || p.velocidade !== 0) return null;
  if (!ctx.foraDaBase) return null;
  if (ctx.noCliente) return null;
  // Madrugada: 22h-05h (hora SP)
  const ehMadrugada = ctx.horaSP >= 22 || ctx.horaSP < 5;
  if (!ehMadrugada) return null;
  return {
    nivel: "critico",
    tipo: "ignicao_noturna",
    motivo: `Parado com ignicao ligada as ${ctx.horaSP}h fora da base`,
    score: 75,
  };
}

// Saida brusca de 0 para >=80 km/h em 1 ciclo: padrao de fuga pos-abordagem.
// Caminhao pesado nao acelera 0->80 km/h em 1 min em condicoes normais.
export function detectarAceleracaoBrusca(
  p: PosicaoNormalizada,
  ctx: { velocidadeAnterior: number | null; foraDaBase: boolean }
): Alerta | null {
  if (!p.fresco) return null;
  if (!ctx.foraDaBase) return null;
  if (ctx.velocidadeAnterior === null || ctx.velocidadeAnterior > 5) return null;
  if (p.velocidade < 80) return null;
  return {
    nivel: "critico",
    tipo: "aceleracao",
    motivo: `Aceleracao brusca: 0 para ${p.velocidade} km/h em 1 ciclo — verificar`,
    score: 70,
  };
}

// Achado do audio do cliente Nutry Max (11/07/2026): "desvio de rota e
// quando ele esta na porta do cliente e nao para, segue por outra via, sem
// confirmar". Parametros de stay-point detection pra logistica urbana
// (raio do proprio alvo, ja fornecido pela Unitrac em pt.raio; tempo minimo
// de permanencia com velocidade baixa, nao so posicao). Sinal OPERACIONAL
// (nivel atencao): confirmado que ninguem na industria trata isso sozinho
// como alerta de seguranca, so combinado com outro sinal (route.ts decide
// a escalada, ver comentario no fluxo de deteccao).
export type CtxBypassEntrega = {
  saiuDoRaioAgora: boolean;
  mesmoAlvoCodigo: boolean;
  dwellSegundosAcumulados: number;
  entregaConfirmada: boolean;
};

export const BYPASS_ENTREGA_DWELL_MINIMO_SEGUNDOS = 120;

export function detectarBypassEntrega(ctx: CtxBypassEntrega): Alerta | null {
  if (!ctx.saiuDoRaioAgora || !ctx.mesmoAlvoCodigo) return null;
  if (ctx.entregaConfirmada) return null;
  if (ctx.dwellSegundosAcumulados >= BYPASS_ENTREGA_DWELL_MINIMO_SEGUNDOS) return null;
  return {
    nivel: "atencao",
    tipo: "bypass_entrega",
    motivo: `Passou pelo raio de um ponto de entrega sem confirmar (parado so ${ctx.dwellSegundosAcumulados}s, esperado ${BYPASS_ENTREGA_DWELL_MINIMO_SEGUNDOS}s+)`,
    score: 40,
  };
}

// Achado real 28/07 (cliente Nutry Max, casos TTM-7C13 e TUS-1A47 --
// mandados pelo cliente como "desvio que o sistema nao identificou"):
// TTM-7C13 parou 9min direto (11:55-12:04) perto de um cliente real, mas
// FORA do raio registrado da entrega -- nenhum alerta disparou o tempo
// todo. bypass_entrega ja cobre o caso OPOSTO (passou rapido demais pra
// ser entrega real, DENTRO do raio); este detector cobre o buraco: parou
// tempo suficiente pra ser entrega real, perto o bastante de um cliente
// conhecido, mas fora do raio marcado, e foi embora SEM confirmar.
//
// Achado CRITICO da revisao independente (round 1): a primeira versao
// disparava ENQUANTO o veiculo estava parado na faixa (50-200m tipico) --
// exatamente a mesma faixa que `noCliente`/`suspenderPorChegada` (route.ts,
// unitrac.ts) ja tratam como "chegou no cliente" (max(raio,150)). Disparava
// em toda entrega normal em andamento, antes da confirmacao ter tempo de
// chegar, e nunca fechava sozinho (nem TIPOS_NAO_GERENCIADOS previa
// fechamento automatico). Redesenhado pra ser um sinal de TRANSICAO, igual
// bypass_entrega: so avalia quando o veiculo SAI da faixa (nao enquanto
// esta nela), e so dispara se a entrega ficou sem confirmar. Isso:
// (a) nunca dispara numa entrega normal em andamento (so avalia na saida);
// (b) se a Unitrac confirmar antes de sair, nunca dispara (entregaConfirmada);
// (c) e' um evento pontual, nao um estado -- faz sentido ficar fora do
// auto-resolve generico (mesmo motivo de bypass_entrega: cortar o sinal
// destruiria a evidencia), sem o problema de nunca fechar sozinho que a v1
// tinha (nao ha re-disparo por ciclo, so 1 alerta por transicao de saida).
export type CtxParadaSemMarcacao = {
  saiuDaFaixaAgora: boolean;
  mesmoAlvoCodigo: boolean;
  dwellSegundosAcumulados: number;
  entregaConfirmada: boolean;
};

// Faixa "perto mas fora do raio": alem do raio confirmado do proprio ponto
// (varia por ponto, tipico 50-100m, ver PontoEntrega.raio em unitrac.ts),
// ate +150m. Cobre coordenada de cadastro imprecisa (endereco vs porta de
// entrada, estacionamento em dobro) sem virar "qualquer parada em qualquer
// lugar perto de alguma coisa" -- acima disso nao e mais "perto o bastante
// pra ser a mesma entrega", e' so uma parada qualquer (ja coberta por
// parada_anomala/parada_longa se for o caso).
export const PARADA_SEM_MARCACAO_RAIO_EXTRA_M = 150;

// Achado da revisao independente (M6): BYPASS_ENTREGA_DWELL_MINIMO_SEGUNDOS
// (120s) responde uma pergunta diferente ("parou nem que seja um pouco?").
// Este detector precisa saber "parou tempo SUFICIENTE pra ser uma tentativa
// de entrega de verdade, nao so um semaforo ou cruzamento devagar" -- o
// unico dado real disponivel e' o caso TTM-7C13 (9min continuos). Limiar
// proprio, abaixo do caso real com folga, mas bem acima do bypass (que
// alias cobriria exatamente o cenario de trafego lento/cruzamento que a
// revisao apontou como falso positivo se reusassemos 120s aqui).
export const PARADA_SEM_MARCACAO_DWELL_MINIMO_SEGUNDOS = 8 * 60;

export function detectarParadaSemMarcacao(ctx: CtxParadaSemMarcacao): Alerta | null {
  if (!ctx.saiuDaFaixaAgora || !ctx.mesmoAlvoCodigo) return null;
  if (ctx.entregaConfirmada) return null;
  if (ctx.dwellSegundosAcumulados < PARADA_SEM_MARCACAO_DWELL_MINIMO_SEGUNDOS) return null;
  // Achado real 20/08 (spec reduzir-ruido-e-melhorar-desvio): parada perto
  // de destino conhecido sem confirmar entrega e' candidato real a desvio
  // disfarçado de parada -- sobe pra critico pra ganhar destaque na tela
  // (antes ficava em "atencao", perdendo pro resto da lista).
  return {
    nivel: "critico",
    tipo: "parada_sem_marcacao",
    motivo: `Parou perto de um destino conhecido por ${Math.round(ctx.dwellSegundosAcumulados / 60)}min (fora do raio confirmado) e saiu sem confirmar entrega`,
    score: 40,
  };
}

export type CtxAnomaliaBaseline = {
  velocidadeMediaViagemKmh: number;
  baselineProprio: Baseline;
  baselineFrota: Baseline;
  minAmostrasProprio: number;
};

const BASELINE_MIN_AMOSTRAS_FROTA = 20;
const BASELINE_Z_LIMIAR = 3;

export function detectarAnomaliaBaseline(ctx: CtxAnomaliaBaseline): Alerta | null {
  const usaProprio = ctx.baselineProprio.n >= ctx.minAmostrasProprio;
  const baseline = usaProprio ? ctx.baselineProprio : ctx.baselineFrota;
  const minAmostras = usaProprio ? ctx.minAmostrasProprio : BASELINE_MIN_AMOSTRAS_FROTA;
  const z = zScoreBaseline(ctx.velocidadeMediaViagemKmh, baseline, minAmostras);
  if (z === null || !Number.isFinite(z) || Math.abs(z) < BASELINE_Z_LIMIAR) return null;
  const origem = usaProprio ? "deste veiculo" : "da frota (veiculo ainda sem historico proprio)";
  return {
    nivel: "atencao",
    tipo: "baseline_veiculo",
    motivo: `Velocidade media da viagem (${ctx.velocidadeMediaViagemKmh.toFixed(0)}km/h) foge ${Math.abs(z).toFixed(1)} desvios do padrao ${origem}`,
    score: 35,
  };
}


// Conjunto de sinais de seguranca relevantes pra corroboracao -- confirmado
// pela pesquisa de 11/07 como o padrao de maior confianca da industria
// ("jammer + desvio + area de risco juntos"). Extras mais operacionais
// (retorno_tardio, parada_noturna_ignicao, aceleracao_brusca) ficam de fora
// de proposito: continuam disputando a arbitragem normalmente, so nao
// geram bonus de corroboracao, pra nao diluir o sinal.
const TIPOS_CORROBORANTES = new Set(["jammer", "desvio", "bypass_entrega", "baseline_veiculo"]);
export const BONUS_CORROBORACAO_POR_SINAL = 15;

// Tipos EXCLUÍDOS do auto-resolve genérico e da resolução de "obsoletos" em
// route.ts (ver alertasGerenciados) -- ficam abertos até ação manual do
// operador (Resolver/Falso positivo) ou o cron de 7 dias
// (expirar-alertas-ativos-esquecidos), nunca fecham sozinhos só porque a
// condição que os disparou deixou de valer num ciclo. Extraído aqui (em vez
// de literal duplicado em route.ts) pra ser testável e pra documentar num
// só lugar QUEM está nesta lista -- achado real da revisão adversarial de
// 27/07 (caso TTK-4D14): detectarParadaForaTapete tinha sido implementado
// reusando tipo="desvio", o que o colocava aqui por acidente (ficava preso
// igual a um desvio de verdade, e podia ocupar/bloquear a vaga de um desvio
// real subsequente do mesmo veículo -- ver comentário completo acima de
// detectarParadaForaTapete). Tipo próprio ("parada_fora_tapete") resolve
// isso simplesmente por NÃO entrar nesta lista -- participa do auto-resolve
// genérico exatamente como parada_anomala (nunca esteve aqui) e qualquer
// outro tipo "gerenciado" (parada_longa, parada_cliente,
// saida_nao_autorizada, excesso, etc.).
// parada_sem_marcacao (achado real 28/07, cliente Nutry Max) entra aqui pelo
// mesmo motivo de bypass_entrega: e' um sinal sobre uma parada perto de um
// destino SEM confirmacao -- pode ser so coordenada de cadastro imprecisa,
// mas tambem pode ser parada suspeita perto (nao dentro) de um destino real.
// Merece revisao humana, nao fechamento automatico e silencioso so porque a
// condicao de distancia/tempo deixou de valer no ciclo seguinte.
export const TIPOS_NAO_GERENCIADOS = new Set(["favela", "desvio", "bypass_entrega", "parada_sem_marcacao"]);

// Arbitragem compartilhada: escolhe o candidato de maior severidade
// (critico > atencao, depois maior score) e, se 2+ TIPOS DISTINTOS do
// conjunto relevante estiverem presentes ao mesmo tempo, soma um bonus por
// tipo extra (capado em 100) e lista quem corroborou no motivo. Usada
// internamente por avaliar() E pelo motor (route.ts) pra combinar o
// resultado de avaliar() com os detectores extras (cerca, bypass, baseline).
export function arbitrarCandidatos(candidatos: Alerta[]): Alerta | null {
  if (candidatos.length === 0) return null;

  const vencedor = candidatos.reduce((melhor, atual) => {
    if (melhor.nivel === "critico" && atual.nivel !== "critico") return melhor;
    if (atual.nivel === "critico" && melhor.nivel !== "critico") return atual;
    return atual.score > melhor.score ? atual : melhor;
  });

  const tiposPresentes = new Set(
    candidatos.filter((a) => TIPOS_CORROBORANTES.has(a.tipo)).map((a) => a.tipo)
  );

  if (tiposPresentes.size < 2) return vencedor;

  const outrosTipos = [...tiposPresentes].filter((t) => t !== vencedor.tipo);
  const bonus = outrosTipos.length * BONUS_CORROBORACAO_POR_SINAL;
  return {
    ...vencedor,
    score: Math.min(100, vencedor.score + bonus),
    motivo: `${vencedor.motivo} (corroborado por: ${outrosTipos.join(", ")})`,
  };
}

const TRANSITO_INFERIDO_MIN_VIZINHOS = 2;
const TRANSITO_INFERIDO_REDUCAO = 20;
const TRANSITO_INFERIDO_SCORE_MINIMO = 30;

// Transito inferido pela PROPRIA frota (floating car data, decisao do
// usuario 12/07 apos pesquisa mostrar que nao ha fonte de transito real
// gratuita e self-serve viavel): se 2+ outros veiculos da frota estao
// LENTOS (nao parados, ver vizinhosParados que ja existe pra isso) perto
// da posicao, em contexto de rodovia, isso corrobora "corte de transito
// legitimo" em vez de desvio suspeito -- reduz a prioridade, nunca some o
// alerta (piso minimo).
export function reduzirPorTransitoInferido(
  alerta: Alerta,
  ctx: { emRodovia: boolean; vizinhosLentos: number }
): Alerta {
  if (alerta.tipo !== "desvio") return alerta;
  if (!ctx.emRodovia || ctx.vizinhosLentos < TRANSITO_INFERIDO_MIN_VIZINHOS) return alerta;
  return {
    ...alerta,
    score: Math.max(TRANSITO_INFERIDO_SCORE_MINIMO, alerta.score - TRANSITO_INFERIDO_REDUCAO),
  };
}

export type CtxAvaliacao = {
  paradoMin: number;
  emOperacao: boolean;
  foraDaBase: boolean;
  noCliente?: boolean;
  dentroTapete?: boolean | null;
  riscoAreaAtual?: number;
  temPendentes?: boolean;
  entregasTotal?: number;
  entregasFeitas?: number;
  alvosApiOk?: boolean;
  sabadoDiurnoComRota?: boolean;
  rumoMovimento?: number | null;
  rumoBase?: number | null;
  distBaseM?: number | null;
  distTiroteioM?: number | null;
  tiroteioIdadeMin?: number | null;
  // Parada anomala (opcional — so roda se estavEmMovimento for fornecido)
  estavEmMovimento?: boolean;
  esMadrugada?: boolean;
  emZonaRisco?: boolean;
  temPOIProximo?: boolean;
  jaParedoNoCicloAnterior?: boolean;
  vizinhosParados?: number;
  // Achado real 26/08 (grupo DESVIO DE ROTA, caso RBJ-2J67 "parada anômala
  // falsa, veículo no cliente"): noCliente aqui é SEMPRE Unitrac (achado
  // 31/07, ver comentário "a Central NAO PODE MAIS ser afetada pelo
  // romaneio" em route.ts) -- cliente cujo ponto existe no romaneio mas
  // não tem alvo correspondente na Unitrac nunca aparece como noCliente
  // pra esse motor, então os detectores de parada "anômala" (que dependem
  // de noCliente pra saber que NÃO é um cliente legítimo) disparam falso
  // toda vez que esse gap acontece. Decisão do usuário: Central continua
  // 100% Unitrac (não mistura romaneio aqui, decisão de 31/07 mantida) --
  // mas pra cliente com motor-romaneio paralelo rodando (fonte de verdade
  // dele), os detectores de parada abaixo (que SÓ fazem sentido quando
  // Central tem visão completa dos clientes via Unitrac) ficam desligados
  // aqui, evitando ruído duplicado/conflitante com o que o motor-romaneio
  // já resolve corretamente pra esse cliente.
  usaMotorRomaneioParalelo?: boolean;
};

// Monta a lista CRUA de candidatos dos detectores "core" (sem arbitrar).
// Exportada pra route.ts poder combinar esses candidatos com os "extras"
// (cerca virtual, bypass, baseline) numa UNICA arbitragem. Bug real 12/07
// corrigido: chamar arbitrarCandidatos duas vezes em cadeia (uma aqui
// dentro, outra em route.ts com os extras) somava o bonus de corroboracao
// 2x quando o mesmo tipo (ex: "desvio", vindo de detectarDesvio aqui E de
// alertaCerca em route.ts, fontes diferentes do mesmo tipo) aparecia nas
// duas chamadas -- arbitrar so uma vez sobre a uniao de todos os candidatos
// crus evita a duplicacao.
export function montarCandidatosCore(p: PosicaoNormalizada, ctx: CtxAvaliacao): Alerta[] {
  return [
    detectarPanico(p),
    detectarBau(p, { noCliente: ctx.noCliente }),
    detectarJammer(p),
    detectarSaidaNaoAutorizada(p, {
      foraDaBase: ctx.foraDaBase,
      temPendentes: ctx.temPendentes ?? false,
      entregasTotal: ctx.entregasTotal,
      rumoMovimento: ctx.rumoMovimento ?? null,
      rumoBase: ctx.rumoBase ?? null,
      distBaseM: ctx.distBaseM ?? null,
      temPOIProximo: ctx.temPOIProximo ?? false,
    }),
    detectarExcessoVelocidade(p),
    detectarParadaCliente({
      paradoMin: ctx.paradoMin,
      emOperacao: ctx.emOperacao,
      noCliente: ctx.noCliente,
    }),
    ctx.usaMotorRomaneioParalelo
      ? null
      : detectarParadaLonga({
          paradoMin: ctx.paradoMin,
          emOperacao: ctx.emOperacao,
          foraDaBase: ctx.foraDaBase,
          noCliente: ctx.noCliente,
          temPOIProximo: ctx.temPOIProximo,
          entregasFeitas: ctx.entregasFeitas,
          entregasTotal: ctx.entregasTotal,
        }),
    ctx.estavEmMovimento !== undefined && !ctx.usaMotorRomaneioParalelo
      ? detectarParadaAnomala({
          paradoMin: ctx.paradoMin,
          emOperacao: ctx.emOperacao,
          foraDaBase: ctx.foraDaBase,
          noCliente: ctx.noCliente ?? false,
          estavEmMovimento: ctx.estavEmMovimento,
          esMadrugada: ctx.esMadrugada ?? false,
          emZonaRisco: ctx.emZonaRisco ?? false,
          temPOIProximo: ctx.temPOIProximo ?? false,
          jaParedoNoCicloAnterior: ctx.jaParedoNoCicloAnterior ?? false,
          vizinhosParados: ctx.vizinhosParados ?? 0,
        })
      : null,
    ctx.usaMotorRomaneioParalelo
      ? null
      : detectarParadaForaTapete({
          paradoMin: ctx.paradoMin,
          emOperacao: ctx.emOperacao,
          foraDaBase: ctx.foraDaBase,
          noCliente: ctx.noCliente ?? false,
          dentroTapete: ctx.dentroTapete ?? null,
          temPOIProximo: ctx.temPOIProximo ?? false,
          vizinhosParados: ctx.vizinhosParados ?? 0,
          riscoAreaAtual: ctx.riscoAreaAtual ?? 0,
        }),
    detectarTiroteioProximo(p, {
      distTiroteioM: ctx.distTiroteioM ?? null,
      tiroteioIdadeMin: ctx.tiroteioIdadeMin ?? null,
    }),
  ].filter((a): a is Alerta => a !== null);
}

// Avalia todos os detectores core e retorna o alerta de maior severidade.
// Prioridade: critico > atencao; desempate por score (maior vence).
export function avaliar(p: PosicaoNormalizada, ctx: CtxAvaliacao): Alerta | null {
  return arbitrarCandidatos(montarCandidatosCore(p, ctx));
}

// Cooldown de re-disparo por EPISODIO de parada (achado real 21/08, pedido
// explicito da operadora Natalia, repetido 3x no grupo: "Sistema repetindo
// informacao para clientes que precisam ficar muito tempo parados. Tem a
// possibilidade de avisar uma unica vez?"). Caso medido: TUG-9D18 gerou 17
// alertas em 2h (7 parada_anomala + 10 parada_longa) pro MESMO episodio,
// varios ja tratados pela operadora -- os detectores de parada reavaliam a
// condicao a cada ciclo e, com o carro ainda parado, ela continua verdadeira.
//
// Um "episodio" e' identificado por parado_desde (ja calculado no motor a
// cada ciclo): carro volta a andar -> parado_desde muda -> episodio novo,
// sem cooldown residual. O cooldown e' POR TIPO: a escalacao
// parada_anomala -> parada_longa (90min) continua avisando normalmente,
// porque sao tipos diferentes com listas de tratados independentes.
export function deveSuprimirRedisparoParada(ctx: {
  paradoDesde: string | null;
  alertasTratadosDoTipo: { resolvidoEm: string }[];
}): boolean {
  if (!ctx.paradoDesde) return false;
  const inicioMs = new Date(ctx.paradoDesde).getTime();
  if (!Number.isFinite(inicioMs)) return false;
  return ctx.alertasTratadosDoTipo.some((a) => {
    const tratadoMs = new Date(a.resolvidoEm).getTime();
    return Number.isFinite(tratadoMs) && tratadoMs >= inicioMs;
  });
}

// Achado real 25/08 (grupo "DESVIO DE ROTA": "Sistema está repetindo
// alertas de desvios depois de limpar, geralmente depois de 15 minutos dá
// o mesmo desvio já limpo"). Confirmado no banco: RQU-0B47 reabriu alerta
// tipo=desvio 9x num dia, algumas vezes a MENOS DE 1 MINUTO da resolução
// anterior. Causa: o cooldown acima (deveSuprimirRedisparoParada) só cobre
// parada_anomala/parada_longa -- desvio nunca teve nenhum, e o
// silenciamento de 2h existente (mapaTiposSilenciados) só conta
// status='falso_positivo', nunca 'resolvido' ("Correto" na UI).
//
// Desvio NÃO tem um equivalente limpo a parado_desde (o streak em
// avaliarAfastandoDeTudo DECAI 1 por leitura não-divergente em vez de
// zerar -- ver comentário lá -- então não existe um "início de episódio"
// discreto pra comparar). Em vez de um cooldown por episódio, este é por
// TEMPO fixo desde o último tratamento humano individual (mesmo critério
// de origem_acao de deveSuprimirRedisparoParada: só resolver_individual/
// falso_individual conta, nunca ação em massa -- ver comentário no motor
// sobre o caso TUG-9D18 que motivou essa exigência). Cobre 'resolvido' E
// 'falso_positivo' -- marcar "Correto" é tão válido quanto "Falso" pra
// dizer "já vi isso, não me avisa de novo por um tempinho".
//
// Janela curta (15min, não as 2h do silenciamento de falso_positivo) de
// propósito -- prioriza recall (ver [[feedback_desvio_priorizar_recall]]):
// um desvio genuinamente ainda em andamento deve voltar a aparecer logo,
// não ficar escondido por horas só porque foi visto uma vez.
export const JANELA_COOLDOWN_DESVIO_MS = 15 * 60 * 1000;

// Achado real 27/08 (dado de 26-27/08): detectarJammer nao passava por NENHUM
// mecanismo de supressao de re-disparo -- resolver um jammer individualmente
// nao impedia nada, o ciclo seguinte (30s) reinseria. Medido: 49 re-disparos
// apos resolver_individual, 43 deles em menos de 15min; RQU-4B93 com 25
// alertas de jammer em 64min.
//
// Jammer entra no cooldown TEMPORAL (e nao no por episodio da parada) porque
// tambem e' condicao CONTINUA -- atraso de GPS com ignicao ligada, sem
// parado_desde equivalente.
//
// Janela PROPRIA de 5min, mais curta que os 15min do desvio -- decisao
// explicita do usuario em 27/08, perguntado diretamente: jammer e' risco
// MAIOR que desvio (correlacao historica alta com sequestro/roubo de carga em
// andamento), entao a janela cega depois de um "Resolver" equivocado tem que
// ser a menor possivel. Mitigado tambem pelo fato de o veiculo continuar
// VERMELHO no mapa durante o cooldown de qualquer jeito -- o cooldown suprime
// a re-insercao do alerta, nunca esconde o veiculo do operador.
export const JANELA_COOLDOWN_JAMMER_MS = 5 * 60 * 1000;

// Janela por tipo. Fonte unica: quem quiser saber se um tipo tem cooldown
// temporal (e qual) consulta este mapa, nunca uma lista paralela de tipos.
export const JANELA_COOLDOWN_TEMPORAL_POR_TIPO: ReadonlyMap<string, number> = new Map([
  ["desvio", JANELA_COOLDOWN_DESVIO_MS],
  ["jammer", JANELA_COOLDOWN_JAMMER_MS],
]);

export function ehTipoComCooldownTemporal(tipo: string): boolean {
  return JANELA_COOLDOWN_TEMPORAL_POR_TIPO.has(tipo);
}

export function deveSuprimirRedisparoDesvio(ctx: {
  agoraMs: number;
  ultimoTratamento: { resolvidoEm: string } | null;
  // Default = janela do desvio, pra manter os chamadores antigos identicos.
  janelaMs?: number;
}): boolean {
  if (!ctx.ultimoTratamento) return false;
  const tratadoMs = new Date(ctx.ultimoTratamento.resolvidoEm).getTime();
  if (!Number.isFinite(tratadoMs)) return false;
  return ctx.agoraMs - tratadoMs < (ctx.janelaMs ?? JANELA_COOLDOWN_DESVIO_MS);
}

// Predicado COMPLETO do cooldown temporal, usado pelo motor
// (src/app/api/motor/route.ts, bloco do cooldown) -- tipo + janela do tipo +
// comparacao de tempo num lugar so'.
//
// Vive aqui, exportado, de proposito (achado da revisao 27/08): enquanto essa
// combinacao morava inline no route.ts, o teste so conseguia REIMPLEMENTAR o
// predicado -- e teste espelho continua verde mesmo se alguem apagar a logica
// do motor. Com a funcao extraida, motor e teste chamam exatamente o mesmo
// codigo.
//
// Tipo sem cooldown temporal (parada, panico, favela, ...) sempre retorna
// false -- passa direto, comportamento identico ao de antes.
export function suprimidoPorCooldownTemporal(ctx: {
  tipo: string;
  agoraMs: number;
  ultimoTratamento: { resolvidoEm: string } | null;
}): boolean {
  const janelaMs = JANELA_COOLDOWN_TEMPORAL_POR_TIPO.get(ctx.tipo);
  if (janelaMs === undefined) return false;
  return deveSuprimirRedisparoDesvio({
    agoraMs: ctx.agoraMs,
    ultimoTratamento: ctx.ultimoTratamento,
    janelaMs,
  });
}
