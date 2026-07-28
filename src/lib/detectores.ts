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
  origemDesvio?: "comportamental" | "cerca_virtual" | "saida_parada" | "classe_viaria" | "rumo_diverge";
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
  }
): Alerta | null {
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

// Teto (m): acima disso não é mais "desvio local", é DESLOCAMENTO interurbano
// (a frota atende o estado todo; ida/volta de praça distante fica sempre a
// dezenas de km de qualquer destino, isso é viagem normal, não desvio).
// Subido de 25km pra 80km em 11/07, depois pra 300km em 12/07 (revisao
// linha por linha a pedido do usuario): 80km ainda era um teto ABSOLUTO que
// escondia desvio de verdade acima disso. 300km cobre confortavelmente
// qualquer entrega dentro do RJ e estados vizinhos (SP, MG, ES), mantendo
// so um piso de sanidade contra leitura de GPS corrompida (coordenada
// absurda).
const DESVIO_GATILHO_TETO_M = 300000;
// Distância (m) usada só pra RESOLVER o alerta (voltou perto de algo = chegou).
const DESVIO_RESOLVE_M = 2500;
// Achado real 22/07 (auditoria): piso original do design de 06/07, removido
// silenciosamente durante a Fase Agressiva de 11/07 sem nenhuma spec
// documentando a remocao. Restaurado -- abaixo disso, o veiculo esta perto
// o suficiente de algum destino que e mais provavel manobra/estacionamento
// normal do que desvio de verdade. Mesmo valor numerico de DESVIO_RESOLVE_M
// por coincidencia (nao e o mesmo conceito -- um e piso pra CRIAR o alerta,
// outro e a distancia pra RESOLVER -- mantidos como constantes separadas).
const DESVIO_MIN_M = 2500;
// Crescimento mínimo por ciclo pra contar como afastamento real (ruído de GPS).
const AFASTAMENTO_MARGEM_M = 50;
// Ciclos consecutivos (aproximando de algum destino, mas fora do tapete
// conhecido) antes de disparar a Camada 3. 2 ciclos (~2min), mesmo padrão de
// persistência mínima da Camada 1 — filtra ruído de 1 leitura de GPS.
// Substituiu o cálculo por linha reta base->destino (TRAJETO_PERPENDICULAR_
// LIMIAR_M + perfil de rota): achado real (TUK-0H45, 08/07/2026) mostrou que
// essa métrica degenera pra "distância crua até a entrega" quando a base
// fica dezenas de km distante e o veículo chega por um ângulo fora da reta
// base->destino, disparando em aproximação 100% normal.
export const FORA_TAPETE_STREAK_MIN = 2;
// Quando o PROPRIO veiculo (nao a frota) ja tem historico de ter passado
// pela area -- ver corredor_celulas_veiculo, design de 21/07 -- exige mais
// leituras consecutivas antes de escalar: reduz falso positivo de atalho
// pessoal legitimo sem suprimir o alerta por completo (nunca fecha
// sozinho, so amortece -- decisao explicita do usuario em 21/07).
export const FORA_TAPETE_STREAK_MIN_FAMILIAR = 5;
// DESATIVADA em 09/07/2026 (achado ao vivo, mesmo dia do deploy): virou
// quase metade de todo o ruído de desvio (74 Camada 1 vs 75 Camada 3 em 6h),
// disparando e resolvendo a cada 2min nas MESMAS placas (TTM-7C14, TTM-2G01,
// TUS-1A47) que rodam rotas rurais/serra (Nova Friburgo/Teresópolis/
// Saquarema) — o tapete dessas regiões ainda não tem cobertura suficiente,
// então qualquer variação legítima de caminho (trânsito, GPS, entrega nova)
// virava "via nunca percorrida". motor continua computando e persistindo
// foraTapeteStreak normalmente (dado útil pra redesenhar o limiar com calma,
// ex.: exigir cobertura mínima por REGIÃO, não só por cliente).
// Religada em 12/07/2026 apos revisao linha por linha a pedido do usuario.
// Causa raiz do incidente de 09/07 que motivou a desativacao (o alerta
// FECHAVA sozinho e reabria a cada ~2min, indistinguivel de bug) ja foi
// corrigida em 11/07 (desvio nunca mais fecha sozinho, commit 1a23048).
// Residual esperado: mais alertas em rotas rurais/serra com tapete esparso
// -- falso positivo que FAZ SENTIDO (fica aberto aguardando o operador, nao
// pisca), aceitavel pela diretiva do usuario. Cobertura minima POR REGIAO
// (nao so por cliente inteiro, ja proposta em docs/analise-deteccao.md
// 09/07) fica FORA de escopo deste ciclo -- resolveria a esparsidade rural
// de forma mais fina, mas e um projeto proprio.
const CAMADA3_TAPETE_ATIVA = true;

// A Unitrac NÃO fornece rota planejada nem ordem confiável de entregas.
// Desvio aqui é comportamento: o veículo se afastando de TODOS os destinos
// legítimos (cada entrega pendente + cada base) em vez de progredir rumo a
// pelo menos um deles.
//
// Por que TODOS e não só o mais próximo (corrigido ao vivo em produção —
// achado real, não teórico: 06/07/2026, 22 alertas em 20min): usar só o
// destino mais próximo dispara em entrega NORMAL sempre que o motorista tem
// 2+ pendentes e vai para a que não é a mais próxima (comuníssimo — a ordem
// de distância euclidiana raramente é a ordem real da rota). Exigir que a
// distância a TODOS cresça ao mesmo tempo é o critério matematicamente
// correto de "não está progredindo rumo a nada legítimo": basta se aproximar
// de QUALQUER pendente ou base pra cancelar a suspeita, então a entrega
// comum (indo para qualquer pendente, mesmo o mais distante) nunca dispara.
//
// Por que sem piso de distância mínima: um desvio de 500m já pode ser um
// assalto em andamento. Não dá pra esperar acumular quilômetros. A proteção
// contra falso positivo vem de outro lugar: persistência mínima (2 ciclos,
// ~2min, o mais rápido que dá pra filtrar ruído de GPS de 1 leitura) e do
// tapete histórico (ver Camada 2 abaixo, com piso de tamanho mínimo pra não
// repetir o falso-positivo de cold-start do dia 06/07 — tapete vazio/pequeno
// não pode ser tratado como "fora de via conhecida").
export type CtxDesvio = {
  // Distância atual e do ciclo anterior a CADA destino legítimo (mesma ordem
  // nos dois arrays): alvos pendentes + bases do cliente.
  distDestinosM: number[];
  distDestinosAnteriorM: number[];
  temPendentes: boolean;
  emOperacao: boolean;
  foraDaBase: boolean;
  entregasFeitas?: number;
  // Quando a API /alvos falhou/deu timeout neste ciclo, destinos vira so
  // bases pra TODOS os veiculos do cliente -- indistinguivel de "rota
  // realmente sem pendencias". alvosApiOk=false bloqueia o disparo (mesmo
  // tratamento que saida_nao_autorizada ja tem via alvosApiOk em route.ts).
  // undefined = comportamento de hoje (API ok).
  alvosApiOk?: boolean;
  // Sabado 6h-20h COM rota carregada hoje na Unitrac (achado real 10/07:
  // frota se move de verdade aos sabados e o gate de calendario seg-sex
  // deixava o desvio cego). Se tem rota de HOJE, e dia de trabalho DESSE
  // veiculo, independente do calendario. undefined/false = so calendario.
  sabadoDiurnoComRota?: boolean;
  // Ciclos consecutivos afastando-se de TUDO (motor incrementa e persiste).
  streak: number;
  // menorDist(agora) - menorDist(no início da sequência). Só informativo
  // (mostrado no motivo do alerta); não é exigência pra disparar.
  afastamentoAcumuladoM: number;
  // Camada 2 (tapete): true = célula (3x3) já percorrida pela frota nos
  // últimos 30 dias; false = fora de qualquer caminho conhecido E o tapete
  // já tem cobertura mínima confiável (motor só passa false quando o
  // tamanho do tapete supera o piso — ver TAPETE_MIN_CELULAS no motor);
  // null = sem tapete confiável ainda na região (não modula, nunca crítico
  // só por isso).
  dentroTapete: boolean | null;
  // Familiaridade PESSOAL do veiculo (nao da frota) com a area atual -- ver
  // corredor_celulas_veiculo. true = esse veiculo especifico ja passou por
  // essa celula antes (30 dias), com cobertura minima confirmada
  // (FAMILIARIDADE_MIN_CELULAS no motor). null = sem historico suficiente
  // ainda (veiculo novo/pouco dado) -- nao amortece nada nesse caso. Nunca
  // suprime o alerta, so exige mais leituras (FORA_TAPETE_STREAK_MIN_FAMILIAR)
  // antes de escalar -- decisao explicita do usuario em 21/07.
  familiarVeiculo: boolean | null;
  // Achado real 25/07 (redesign): substitui o cancelamento por distancia.
  // true = veiculo dentro do raio de um destino legitimo OU ponto_seguro
  // -- suspende TODA checagem de desvio neste ciclo.
  suspensoPorChegada: boolean;
  // Streak de ciclos consecutivos com divergencia de rumo acima do limiar
  // (persistido pelo motor, ver divergenciaRumoGraus em lib/unitrac.ts).
  divergenciaRumoStreak: number;
  // Achado real 26/07 (Fase 2): true no ciclo exato em que o veiculo saiu
  // do raio de um destino legitimo (mesmo sinal usado por
  // detectarBypassEntrega no motor). Usado por viradaErradaSaindoDeParada.
  saiuDoRaioAgora: boolean;
  // Divergencia de rumo (graus) do ciclo atual, CRUA (nao acumulada em
  // streak) -- mesmo valor usado pra avancar divergenciaRumoStreak, exposto
  // aqui pra viradaErradaSaindoDeParada decidir com 1 leitura so.
  divergenciaGrausAtual: number | null;
  // Achado real 27/07 (pedido explicito do usuario): true quando o veiculo
  // saiu de via principal ha menos de 10min e esta numa rua estreita (ja
  // calculado no motor, mesmo campo usado por aplicarBonusClasseViaria) --
  // usado aqui pra disparar um alerta PROPRIO, nao so reforcar um existente.
  quedaClasseViaria: boolean;
  // Achado real 28/07 (Task 6, 36% dos FP manuais de rua-estreita): true
  // quando o veiculo saiu de uma parada CONFIRMADA (dwell >=
  // BYPASS_ENTREGA_DWELL_MINIMO_SEGUNDOS antes de sair do raio, ver
  // route.ts/saiuParadaConfirmadaHaMenosDe) ha menos de JANELA_SAIDA_PARADA_MIN
  // minutos -- veiculo terminando a manobra normal de saida de uma entrega
  // legitima e entrando numa rua estreita, nao um desvio de verdade. So
  // SUPRIME o branch de quedaClasseViaria (abaixo); nao mexe em nenhum outro
  // gatilho de desvio.
  saiuParadaConfirmadaRecentemente: boolean;
  // Camada 3 (score de risco da área ATUAL, 0-100, ver calcularRiscoArea):
  // "via conhecida ou não" (tapete) não é a mesma coisa que "área perigosa
  // agora". Desvio numa rua nova mas tranquila não deveria ter a MESMA
  // urgência que desvio numa rua conhecida mas dentro de uma favela/com
  // tiroteio recente perto/com histórico de roubo de carga alto no CISP.
  // Default 0 (sem dado de risco disponível) — nunca ACELERA sozinho sem
  // ativar junto com o gatilho normal de streak; só faz o "fora do tapete"
  // (ou equivalente) disparar mais rápido, nunca suprime nem atrasa alerta.
  riscoAreaAtual: number;
  // Ponto cego identificado (comparação com iBOAT, pesquisa 07/07): o
  // gatilho principal cancela a suspeita assim que o veículo se aproxima de
  // QUALQUER destino — um trajeto raro que ainda assim vai "na direção"
  // certa nunca dispara. Ciclos consecutivos (aproximando de algum destino,
  // MAS fora do tapete conhecido, com cobertura mínima confirmada) — motor
  // só incrementa quando afastouDeTudo=false E dentroTapete=false (ver
  // TAPETE_MIN_CELULAS no motor). Substituiu o cálculo por linha reta
  // (ver FORA_TAPETE_STREAK_MIN acima) — pega desvio grande mesmo quando
  // tecnicamente aproximando, sem o defeito de degenerar em distância crua.
  foraTapeteStreak: number;
};

// Ponto FIXO de início da suspeita de desvio (última posição confirmada
// ANTES do afastamento começar) -- persistido pelo motor em
// desvio_inicio (jsonb), ver route.ts. Definido aqui (nao mais duplicado
// localmente em route.ts, que agora importa este tipo -- task 3 da Fase 2)
// pra montarContextoDesvio poder referenciar sem duplicar o literal.
export type DesvioInicio = { lat: number; lng: number; ts: string; menor_dist_m: number };

// Achado real 26/07: o `contexto` jsonb gravado no alerta hoje so tem
// inicio_ts/fora_tapete/corredor -- todo o resto que o detector calculou
// (distancias, streaks, risco de area, classe de via, calibracao) existe
// em memoria no ciclo do motor mas se perde depois. Esta funcao monta o
// contexto EXPANDIDO, usado tanto pelo insert/escalation do alerta quanto
// pelo snapshot de casos_desvio_revisao (ver
// docs/superpowers/specs/2026-07-26-fase2-historico-casos-e-regras-simples-design.md).
export interface ContextoDesvio {
  inicio_ts: string;
  fora_tapete: boolean;
  corredor?: { veredito: string; bufferM: number };
  dist_destinos_m: number[];
  dist_destinos_anterior_m: number[];
  desvio_streak: number;
  fora_tapete_streak: number;
  divergencia_rumo_streak: number;
  risco_area_atual: number;
  dentro_tapete: boolean | null;
  familiar_veiculo: boolean | null;
  classe_via_atual: string | null;
  queda_classe_viaria: boolean;
  afastamento_acumulado_m: number;
  calibracao?: { segmento: string | null; taxa_falso_positivo: number };
}

export function montarContextoDesvio(p: {
  desvioInicio: DesvioInicio;
  dentroTapete: boolean | null;
  corredorInfo?: { veredito: string; bufferM: number } | null;
  distDestinosM: number[];
  distDestinosAnteriorM: number[];
  desvioStreak: number;
  foraTapeteStreak: number;
  divergenciaRumoStreak: number;
  riscoAreaAtual: number;
  familiarVeiculo: boolean | null;
  classeViaAtual: string | null;
  quedaClasseViaria: boolean;
  segmentoEspecifico: string | null;
  taxaFp: number | undefined;
}): ContextoDesvio {
  return {
    inicio_ts: p.desvioInicio.ts,
    fora_tapete: p.dentroTapete === false,
    ...(p.corredorInfo ? { corredor: p.corredorInfo } : {}),
    dist_destinos_m: p.distDestinosM,
    dist_destinos_anterior_m: p.distDestinosAnteriorM,
    desvio_streak: p.desvioStreak,
    fora_tapete_streak: p.foraTapeteStreak,
    divergencia_rumo_streak: p.divergenciaRumoStreak,
    risco_area_atual: p.riscoAreaAtual,
    dentro_tapete: p.dentroTapete,
    familiar_veiculo: p.familiarVeiculo,
    classe_via_atual: p.classeViaAtual,
    queda_classe_viaria: p.quedaClasseViaria,
    afastamento_acumulado_m: Math.min(...p.distDestinosM) - p.desvioInicio.menor_dist_m,
    ...(p.segmentoEspecifico !== null || p.taxaFp !== undefined
      ? { calibracao: { segmento: p.segmentoEspecifico, taxa_falso_positivo: p.taxaFp ?? -1 } }
      : {}),
  };
}

// Achado real 28/07 (Task 3, REFEITO no Task 4b apos revisao independente
// -- BLOCK na 1a rodada): rumo-diverge dispara com !afastandoDeTudo --
// desvioInicio (a ancora que montarContextoDesvio usa pra inicio_ts/
// afastamento_acumulado_m) so avanca via avancarStreaksDesvio, atrelado ao
// streak de "afastando de tudo" (desvioStreak), entao normalmente esta null
// quando rumo-diverge e' o alerta vencedor.
//
// A versao original (Task 3) sintetizava um "inicio" na posicao/instante
// ATUAL quando desvioInicio era null. A revisao independente (Task 4b)
// apontou 2 problemas nisso: (1) ambiguidade de diagnostico -- o mesmo
// campo persistido tinha 2 significados possiveis (inicio real de um
// episodio de afastando-de-tudo QUE SOBREVIVEU por historese, ou so a
// posicao atual sem streak nenhum por tras), sem como distinguir os dois
// depois; (2) deixava a verificacao de corredor da Task 4 SEM ancora
// utilizavel no caso exato que a motivou (rodovia com curva, TTK-4D14) --
// usar a posicao atual como origem do corredor seria tautologico (ver
// corredor-verificacao.ts), entao o fallback so ajudava o contexto, nunca o
// corredor.
//
// Fix definitivo: rumo-diverge ganhou seu PROPRIO anchor real
// (divergenciaRumoInicio, ver route.ts -- mesmo padrao de desvioInicio,
// setado na transicao 0->1 da streak de divergencia de rumo, limpo quando
// ela zera). Como rumo-diverge so dispara com divergenciaRumoStreak >= 2
// (mesmo guard de divergenciaRumoDispara), esse anchor SEMPRE existe nesse
// momento (foi setado quando a streak virou 1, pelo menos 1 ciclo atras) --
// elimina de vez a ambiguidade sintetico-vs-real (so ha UM significado
// agora, sempre real) e da' a Task 4 uma origem utilizavel pro corredor no
// mesmo caso. NAO sintetiza mais nada a partir da posicao atual.
export function desvioInicioEfetivoParaContexto(
  desvioInicio: DesvioInicio | null,
  origemRumoDiverge: boolean,
  divergenciaRumoInicio: DesvioInicio | null
): DesvioInicio | null {
  return origemRumoDiverge ? divergenciaRumoInicio : desvioInicio;
}

// Achado IMPORTANTE da revisao independente 28/07 (Task 4b): agora que a
// verificacao de corredor roda tambem pra rumo-diverge (Task 4), os
// vereditos "dentro"/"fora" precisam mexer SO no streak/anchor da regra que
// efetivamente disparou o alerta verificado -- um alerta FRACO de
// rumo-diverge (nivel "atencao") nao pode zerar/reescrever uma streak
// CRITICA de afastando-de-tudo em andamento em paralelo pro MESMO veiculo
// (e vice-versa: um veredito de afastando-de-tudo nao pode mexer no streak
// de divergencia de rumo). Os dois streaks sao INDEPENDENTES (streaks e
// anchors distintos, guards de disparo distintos) e por isso nao podem
// compartilhar o mesmo efeito colateral -- so por acaso os dois passam pelo
// MESMO bloco de verificarCorredor (mesmo mecanismo, reaproveitado).
export type StreaksDesvio = {
  desvioStreak: number;
  desvioInicio: DesvioInicio | null;
  divergenciaRumoStreak: number;
  divergenciaRumoInicio: DesvioInicio | null;
};

// Veredito "dentro" (corredor confirma que a posicao atual esta numa
// estrada real legitima, suprime o alerta): zera SO o streak/anchor da
// regra vencedora, preserva o outro par intocado.
export function zerarStreakDaOrigemVencedora(
  origemRumoDiverge: boolean,
  atual: StreaksDesvio
): StreaksDesvio {
  return origemRumoDiverge
    ? { ...atual, divergenciaRumoStreak: 0, divergenciaRumoInicio: null }
    : { ...atual, desvioStreak: 0, desvioInicio: null };
}

// Veredito "fora" (corredor confirma o desvio, reancorando no ultimo ponto
// confirmado dentro do corredor -- ver cache.ultimoDentro em route.ts):
// reescreve SO o anchor da regra vencedora (nunca o streak em si, nunca o
// outro par), preserva o outro par intocado.
export function reancorarOrigemVencedora(
  origemRumoDiverge: boolean,
  atual: StreaksDesvio,
  novoAnchor: DesvioInicio
): StreaksDesvio {
  return origemRumoDiverge
    ? { ...atual, divergenciaRumoInicio: novoAnchor }
    : { ...atual, desvioInicio: novoAnchor };
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

// Auto-resolucao retroativa da "rua estranha" (achado real 27/07, revisao
// manual de 215 alertas: ~69% de falso positivo, padrao dominante era
// "chegou e parou pouco depois, sem area de risco por perto" -- exatamente
// o tipo de coisa que so da pra confirmar DEPOIS do alerta ja ter
// disparado). Mantem a deteccao rapida (dispara igual a hoje) e so limpa
// sozinho o que se confirma como falso positivo -- nao atrasa nenhum caso
// real.
//
// Task 5 (28/07) -- 2 padroes reais confirmados hoje (dado real de
// posicao/velocidade de 3 casos: TTI-6E43 33min, TB466437 18min, TTD-7H14
// 10.6min) que impediam o disparo a tempo em ~36% dos casos elegiveis:
//
// Padrao A -- REMOVIDO (era RUA_ESTRANHA_JANELA_AUTORESOLVE_MIN=5min,
// constante deletada): a janela era contada a partir da CRIACAO do alerta
// (idadeAlertaMin), nao do momento em que o veiculo de fato fica parado.
// Casos reais (TTI-6E43, TB466437) mostraram o veiculo terminando a
// manobra (virar, entrar na rua) alguns minutos DEPOIS do alerta disparar
// -- normal -- entao a janela ja tinha fechado quando ele finalmente
// satisfazia o gate de "parado o suficiente" abaixo. Removida por
// completo, sem parametro morto -- mesmo padrao ja validado e em producao
// do auto-resolve irmao (deveAutoResolverAfastandoRotaConcluida, abaixo),
// que nunca teve janela de tempo nenhuma, so as condicoes de seguranca
// (risco baixo + parado confirmado). Consistencia deliberada com esse
// precedente ja revisado.
//
// Padrao B -- ver RUA_ESTRANHA_VELOCIDADE_TOLERANTE_KMH e
// calcularParadaToleranteSegundos logo abaixo.
// Minutos parado pra contar como "parou de verdade", nao blip de semaforo.
export const RUA_ESTRANHA_PARADO_MIN_MIN = 2;

// Task 5, Padrao B (28/07): paradoMin (route.ts, coluna parado_desde) zera
// com QUALQUER leitura de velocidade!=0, mesmo um blip isolado de poucos
// km/h (ver bloco que calcula parado_desde em route.ts) -- em transito
// parado-e-anda esse timer nunca acumula os RUA_ESTRANHA_PARADO_MIN_MIN
// continuos exigidos acima. Caso real TTD-7H14 (~cron a cada 30s):
// velocidade oscilou 0,6,7,7,7,7,0,0,0,0,0,7,7,0,0,10,10,0,0,20,20,0,0,19.
//
// Achado da revisao independente (5b.1, rodada 1): o lat/lng REAL desse
// caso mostra o veiculo se deslocando uns 10-30m a cada leitura o tempo
// todo -- NAO fica no mesmo ponto (mesmoPonto, usado por parado_desde,
// ficaria FALSE quase todo ciclo). Por isso o acumulador abaixo NAO usa
// posicao como gate, so velocidade -- ver comentario em
// calcularParadaToleranteSegundos pro raciocinio completo de por que uma
// primeira versao gateada por mesmoPonto reproduzia o proprio bug.
//
// NAO mexe em paradoMin em si (primitivo compartilhado por muitos outros
// consumidores em route.ts -- mudar sua semantica arriscaria regressao em
// coisa nao relacionada). Sinal PROPRIO, so pro auto-resolve de rua-
// estreita: este limiar decide o que ainda TOLERA sem resetar a contagem
// (nao decide o que conta como "parado" -- so velocidade===0 de verdade
// soma tempo, ver calcularParadaToleranteSegundos abaixo pro raciocinio
// completo, incluindo o achado CRITICO da revisao independente round 2:
// uma primeira versao deste fix somava tempo pra qualquer leitura ate
// este limiar, contando dirigir devagar como se fosse ter parado).
//
// 20km/h cobre o pico observado no caso real (TTD-7H14 chegou a 20) com
// folga confortavel abaixo de velocidade de desvio de verdade -- dado real
// levantado na Task 7 (28/07, 19 falsos-positivos de rumo-diverge
// checados): so 1/19 (5%) ficou perto de 10km/h, 74% ficou em 40km/h ou
// mais. Conceito diferente de DIVERGENCIA_RUMO_VELOCIDADE_MIN_KMH
// (unitrac.ts) -- la e' "velocidade minima pra bearing fazer sentido", aqui
// e' "velocidade maxima que ainda conta como efetivamente parado" --
// constante propria, deliberadamente.
export const RUA_ESTRANHA_VELOCIDADE_TOLERANTE_KMH = 20;

// M4 (revisao independente round 3, 27/07): riscoAreaAtual vem de
// riscoPorVeiculo (route.ts), um Map preenchido por UMA query em batch por
// ciclo -- se essa query falhar, o Map fica vazio pro ciclo inteiro e TODO
// veiculo le riscoAreaAtual=0 (fallback deliberado, "falha graciosa: sem
// dado, risco fica 0", ver comentario no motor). Em QUALQUER outro consumidor
// de riscoAreaAtual neste arquivo, esse fallback erra pro lado seguro:
// nunca ACELERA nem SUPRIME um alerta sozinho, so deixa de reforcar um que
// ja ia disparar por outro motivo (ver riscoAreaAtual em CtxDesvio acima).
// Aqui seria o oposto -- riscoAreaAtual=0 por FALTA de dado e riscoAreaAtual
// =0 por dado real "area tranquila confirmada" ficam indistinguiveis, e so
// o segundo deveria poder fechar o alerta sozinho. Um caminhao parado
// literalmente dentro de uma favela, no ciclo exato em que a query de risco
// falhou, seria auto-resolvido por engano. riscoDisponivel (passado pelo
// caller como riscoPorVeiculo.has(veiculo_id)) EXIGE que o dado exista de
// verdade pro veiculo neste ciclo -- sem ele, a funcao recusa resolver
// (alerta so fica aberto mais um ciclo, mesma direcao de fail-safe de tudo
// mais neste arquivo).
//
// idadeAlertaMin foi REMOVIDO daqui (Task 5, Padrao A -- ver comentario
// acima): nao ha mais janela de tempo, sem deixar parametro morto.
// paradaEfetivaMin substitui o antigo paradoMin estrito NESTA chamada
// especificamente (Task 5, Padrao B) -- route.ts calcula esse valor
// tolerante-a-blip via calcularParadaToleranteSegundos e passa aqui; o
// paradoMin estrito continua existindo em route.ts e sendo usado por
// TODOS os outros consumidores, sem nenhuma mudanca de comportamento pra
// eles.
export function deveAutoResolverRuaEstranha(ctx: {
  paradaEfetivaMin: number;
  riscoAreaAtual: number;
  riscoDisponivel: boolean;
}): boolean {
  return (
    ctx.riscoDisponivel &&
    ctx.paradaEfetivaMin >= RUA_ESTRANHA_PARADO_MIN_MIN &&
    ctx.riscoAreaAtual < RISCO_AREA_LIMIAR
  );
}

// Task 5b.1 (revisao independente, achado MAIS SERIO da rodada 1): a
// versao original desta funcao usava mesmoPonto (celula de 4 casas
// decimais, mesma logica de parado_desde) como gate -- pra decidir se
// acumulava ou resetava. O revisor conferiu o lat/lng REAL do caso
// TTD-7H14 (nao so a velocidade, que ja tinha sido checada) e o veiculo
// esta se deslocando uns 10-30m a cada leitura o tempo todo -- mesmoPonto
// fica FALSE quase todo ciclo pra esse caso real. Com aquele gate, o
// acumulador resetava quase toda leitura, reproduzindo o EXATO bug
// original (parado_desde) um nivel abaixo -- nao corrigia o caso real que
// foi construido pra corrigir (so passava no teste, que usava uma fixture
// idealizada com mesmoPonto:true hardcoded, fisicamente incompativel com
// o lat/lng real do caso).
//
// CRITICO (revisao independente, round 2 apos o fix de mesmoPonto acima):
// a primeira versao deste fix somava +30s pra QUALQUER velocidade
// <=RUA_ESTRANHA_VELOCIDADE_TOLERANTE_KMH (ate 20km/h) -- isso nao tolera
// blip, CONTA DIRIGIR COMO SE FOSSE PARAR. Cenario real: veiculo sequestrado
// dirigindo por ruas estreitas a 10-18km/h (velocidade normal pra uma rua
// estreita, nunca excede o limiar) por 20+ minutos -- o acumulador nunca
// reseta, so precisa de UMA leitura de semaforo com velocidade=0 no fim pra
// "paradaEfetivaMin" passar de 20min e o alerta fechar sozinho como falso
// positivo. O gate de decisao (`pos.velocidade === 0` no ciclo exato) nao
// protege disso -- ele so exige a leitura ATUAL parada, nao o historico.
// A comparacao com no_raio_dwell_segundos nos comentarios da versao
// anterior tambem estava errada nesse ponto: aquele acumulador MANTEM
// (nao soma) quando devagar mas nao parado, e reseta ao sair do raio --
// aqui replicado corretamente: SO velocidade===0 de verdade soma tempo;
// velocidade entre 1 e RUA_ESTRANHA_VELOCIDADE_TOLERANTE_KMH so evita
// resetar (tolera o blip), sem fingir que o veiculo parou naquele ciclo.
// Verificado contra o caso real TTD-7H14: ainda cruza o limiar de 2min
// (leitura 9, ~4.5min dos 10.6min do episodio), so que agora contando
// somente as leituras genuinamente paradas (12 das 24 leituras sao 0).
//
// Persistido em posicoes_atuais.parada_tolerante_segundos (migration
// 015), coluna PROPRIA -- nao reusa parado_desde (herdaria o reset por
// blip que e' o proprio bug) nem escreve em paradoMin. A posicao
// (mesmoPonto) so importa pro parado_desde ESTRITO (paradoMin), que
// continua existindo sem mudanca pra todos os outros consumidores.
export function calcularParadaToleranteSegundos(ctx: {
  velocidade: number;
  anteriorSegundos: number;
}): number {
  if (ctx.velocidade > RUA_ESTRANHA_VELOCIDADE_TOLERANTE_KMH) return 0;
  // So velocidade===0 de verdade acumula tempo (mesmo incremento fixo de
  // 30s ja usado por no_raio_dwell_segundos, aproxima o intervalo real do
  // cron de ~30s). Velocidade entre 1 e o limiar tolerante NAO soma --
  // so evita que o proximo 0 reinicie a contagem do zero (o blip em si
  // nunca conta como tempo parado).
  return ctx.velocidade === 0 ? ctx.anteriorSegundos + 30 : ctx.anteriorSegundos;
}

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
export const JANELA_SAIDA_PARADA_MIN = 5;

// Funcao pura extraida (em vez de inline em route.ts) pra poder testar a
// fronteira exata da janela sem simular um ciclo completo do motor --
// mesmo espirito de deveAutoResolverRuaEstranha acima. route.ts chama isso
// UMA vez por veiculo/ciclo e passa so o booleano resultante adiante (ver
// CtxDesvio.saiuParadaConfirmadaRecentemente) -- detectarDesvio continua
// sem precisar saber a hora atual, mesmo padrao de todo outro campo de
// CtxDesvio (booleanos/numeros ja calculados, nunca timestamps crus).
export function saiuParadaConfirmadaHaMenosDe(
  saiuParadaConfirmadaEm: string | null,
  agora: Date,
  janelaMin: number = JANELA_SAIDA_PARADA_MIN
): boolean {
  return (
    saiuParadaConfirmadaEm !== null &&
    agora.getTime() - new Date(saiuParadaConfirmadaEm).getTime() <= janelaMin * 60_000
  );
}

// Achado da revisao independente (Task 6): a condicao de transicao em si
// (saiuDoRaioAgora && dwell>=minimo) nunca tinha teste proprio -- so o
// resultado ja combinado com o guard de detectarDesvio, entao um mutante
// que removia o check de dwell (deixando QUALQUER passagem, nao so parada
// de verdade, marcar a saida) passava nos 504 testes sem quebrar nenhum.
// Extraida pra cá pra fechar esse buraco. Tambem fecha um segundo achado:
// sem gate de pos.fresco/alvosApiOk, um blip na API de alvos (buscarAlvos
// falhou) fazia alvoNoRaioAgora virar null e saiuDoRaioAgora disparar por
// tabela mesmo com o veiculo parado no MESMO lugar -- combinado com dwell
// alto (ja estava parado ha tempo), marcava uma "saida" que nunca aconteceu,
// suprimindo rua-estreita por 5min so por causa do blip.
export function deveMarcarSaidaParadaConfirmada(ctx: {
  fresco: boolean;
  alvosApiOk: boolean;
  saiuDoRaioAgora: boolean;
  dwellAnteriorSegundos: number;
  dwellMinimoSegundos?: number;
}): boolean {
  const minimo = ctx.dwellMinimoSegundos ?? BYPASS_ENTREGA_DWELL_MINIMO_SEGUNDOS;
  return ctx.fresco && ctx.alvosApiOk && ctx.saiuDoRaioAgora && ctx.dwellAnteriorSegundos >= minimo;
}

// Motivo exato gravado pelo branch quedaClasseViaria (abaixo, dentro de
// detectarDesvio) -- exportado pra route.ts poder identificar de volta
// quais alertas tipo="desvio" vieram desta regra especifica sem duplicar a
// string magica (risco real: duas copias divergirem em silencio se o texto
// mudar num lugar so).
export const MOTIVO_RUA_ESTRANHA =
  "Saiu de via principal recentemente e está em rua estreita, fora do raio de qualquer destino conhecido";

// BLOCKER 2 (revisao independente 27/07): o check de auto-resolucao
// original filtrava so por tipo/motivo, sem olhar status -- podia
// auto-resolver um alerta que o operador ja tinha clicado "Reconhecer"
// (status='reconhecido'), puxando o tapete debaixo dele em silencio.
// Extraido como funcao pura testavel (route.ts nao tem harness de teste
// proprio, ver nota em detectores.test.ts) -- so alertas 'ativo' sao
// elegiveis.
//
// Task 5b.3 (revisao independente rodada 1): idadeAlertaMin foi removido
// do PADRAO A (deveAutoResolverRuaEstranha nao olha mais idade -- ver
// comentario la), mas sem NENHUM teto um alerta de dias/semanas (o cron
// expirar-alertas-ativos-esquecidos so fecha depois de 7 dias) ficaria
// elegivel pra fechar sozinho na primeira parada tranquila de 2min, sem
// ninguem saber o que aconteceu ENTRE a criacao e essa parada (ex:
// sequestro real, veiculo levado dezenas de km, estacionado numa area sem
// risco corroborado). Teto generoso (60min, quase 2x o pior caso real
// observado: TTI-6E43 33min) ancorado na CRIACAO do alerta --
// deliberadamente mais simples que ancorar numa nova "elegibilidade"
// (exigiria mais um campo persistido). Aplicado AQUI, no filtro de
// elegibilidade -- nao em deveAutoResolverRuaEstranha, que continua sem
// saber de tempo: a idade e' sobre QUAL ALERTA e' candidato, nao sobre as
// condicoes de seguranca em si.
export const RUA_ESTRANHA_IDADE_MAXIMA_AUTORESOLVE_MS = 60 * 60 * 1000;

export function alertaElegivelParaAutoResolveRuaEstranha(
  alerta: { status: string; tipo: string; motivo: string; desde: string },
  agora: Date,
  idadeMaximaMs: number = RUA_ESTRANHA_IDADE_MAXIMA_AUTORESOLVE_MS
): boolean {
  return (
    alerta.status === "ativo" &&
    alerta.tipo === "desvio" &&
    alerta.motivo === MOTIVO_RUA_ESTRANHA &&
    agora.getTime() - new Date(alerta.desde).getTime() <= idadeMaximaMs
  );
}

// Auto-resolucao retroativa de "afastando de todos os destinos" quando a
// rota foi 100% concluida (achado real 27/07, revisao de 215 alertas: ~15
// dos 91 casos eram esse padrao -- voltando pra base depois de terminar).
// NAO usa so "rota concluida" (entregas_feitas>=entregas_total) -- esse
// sinal sozinho e' EXATAMENTE o que um cenario de entrega forcada sob
// coacao tambem produziria (motorista forcado a confirmar falsamente,
// depois desviado). Por isso exige TAMBEM baseOcupada=true (veiculo
// fisicamente DENTRO do poligono de uma base cadastrada, ja calculado
// todo ciclo em route.ts) -- sinal muito mais forte, um sequestro
// terminando dentro de uma base real seria autodestrutivo pro atacante.
// Decisao de 21/07 (docs/superpowers/specs/2026-07-21-anotacao-rota-
// concluida-desvio-design.md) evitava suprimir so por rota_concluida por
// esse motivo exato -- este design respeita a mesma preocupacao.
// FIX 1 (revisao independente 27/07, achado severo): poligono de base NAO e'
// garantia de "instalacao segura da empresa". Consulta real na producao
// (27/07) via `SELECT nome, ST_Area(geom::geography) AS area_m2 FROM bases`:
//   Base Nutry (8 veic)      ~11.719 m²   -- patio legitimo, pequeno
//   Base Nutry (73 veic)     ~53.873 m²   -- patio legitimo, medio
//   Base Benassi (9 veic)    ~233.964 m²  -- grande, ambiguo (excluido, fail-safe)
//   Base Benassi — CEASA-RJ  ~739.364 m²  -- mercado publico (CEASA), NAO e'
//     patio da empresa: contem vias "principal" reais e registrou 96 veiculos
//     distintos passando por dentro a ate 66km/h. "Dentro do poligono" nesse
//     caso nao significa "chegou numa instalacao segura" -- e' exatamente o
//     tipo de area onde um motorista sob coacao (forcado a confirmar entrega
//     falsamente, depois sequestrado) passaria de carro sem isso ser sinal
//     de seguranca nenhum.
// Limiar escolhido: 100.000 m² (10 hectares). Ha um gap de >4x entre a maior
// base legitima (53.873 m²) e a menor base ambigua (233.964 m²) -- 100.000
// cai confortavelmente no meio, sem risco de fronteira. Deliberadamente
// exclui TAMBEM a Base Benassi de 233.964 m² (nao so a CEASA) -- prioridade e'
// fail-safe, nao maximizar quantas bases qualificam; uma base grande o
// suficiente pra ter duvida quanto a ser "patio fechado" nao deveria poder
// mascarar um sequestro sozinha.
export const BASE_AREA_MAX_M2_AUTORESOLVE_AFASTANDO = 100_000;

// FIX 2 (revisao independente 27/07): sem isso, o check original so exigia
// baseOcupada verdadeiro, sem nenhuma exigencia de velocidade/parada/frescor
// -- um veiculo simplesmente TRANSITANDO pelo poligono a qualquer velocidade
// satisfazia a condicao, e o check rodava mesmo com posicao de GPS obsoleta
// (ate ~180min, incluindo durante jammer ativo -- ver detectarJammer, tratado
// em outro lugar deste arquivo como o indicador mais forte de sequestro,
// ~85% de correlacao). Mesmo padrao ja usado por deveAutoResolverRuaEstranha
// (RUA_ESTRANHA_PARADO_MIN_MIN acima): exige parado de verdade, nao um blip.
export const AFASTANDO_ROTA_CONCLUIDA_PARADO_MIN_MIN = 2;

// ctx.baseOcupada mantem o significado de sempre ("dentro do poligono de
// ALGUMA base") -- ctx.baseElegivelAutoResolve e' a condicao NOVA e mais
// estreita ("dentro de uma base pequena o suficiente pra este auto-resolve
// especifico", ver BASE_AREA_MAX_M2_AUTORESOLVE_AFASTANDO acima). O caller
// (route.ts) calcula baseElegivelAutoResolve a partir do areaM2 ja carregado
// em mapaBasesCliente (sem query nova por veiculo) e so passa ctx.paradoMin
// quando pos.fresco && pos.velocidade===0 (mesma convencao de gate usada
// pela chamada de deveAutoResolverRuaEstranha em route.ts -- so entra no
// bloco quando pos.velocidade===0; a partir da Task 5/Padrao B aquela
// chamada passa paradaEfetivaMin, tolerante a blip, em vez de paradoMin
// estrito, mas o GATE de entrada continua o mesmo).
export function deveAutoResolverAfastandoRotaConcluida(ctx: {
  rotaConcluida: boolean;
  baseOcupada: boolean;
  baseElegivelAutoResolve: boolean;
  paradoMin: number;
}): boolean {
  return (
    ctx.rotaConcluida &&
    ctx.baseOcupada &&
    ctx.baseElegivelAutoResolve &&
    ctx.paradoMin >= AFASTANDO_ROTA_CONCLUIDA_PARADO_MIN_MIN
  );
}

export const MOTIVO_AFASTANDO_PREFIXO = "Afastando-se de todos";

export function elegivelParaAutoResolveAfastando(alerta: { tipo: string; motivo: string; status: string }): boolean {
  return alerta.status === "ativo" && alerta.tipo === "desvio" && alerta.motivo.startsWith(MOTIVO_AFASTANDO_PREFIXO);
}

// BLOCKER 1 (revisao independente 27/07): mapaTiposSilenciados (route.ts)
// contava QUALQUER linha status='falso_positivo' recente como "operador
// ensinando o sistema" e silenciava o tipo pro veiculo por 2h -- inclusive
// as que o proprio auto-resolve acima gerou, o que silenciava tipo="desvio"
// (inclusive cerca_virtual/comportamental REAIS) quase continuamente, dado
// que o padrao auto-resolvido e' ~69% dos casos. contexto.auto_resolvido
// marca a origem; linhas assim NUNCA devem contar pro silenciamento --
// so falso_positivo marcado por acao humana explicita (resolverAlerta/
// marcarFalsoPositivo em acoes-alertas.ts) ensina o sistema.
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

// O veículo se afastou de TODOS os destinos legítimos desde o ciclo
// anterior? Aproximar de QUALQUER um cancela — é assim que uma entrega
// normal (rumo a um pendente que não é o mais próximo) nunca dispara.
export function afastouDeTudo(
  distDestinosM: number[],
  distDestinosAnteriorM: number[]
): boolean {
  if (distDestinosM.length === 0) return false;
  if (distDestinosM.length !== distDestinosAnteriorM.length) return false;
  return distDestinosM.every(
    (d, i) => d > distDestinosAnteriorM[i] + AFASTAMENTO_MARGEM_M
  );
}

// Piso de streak de divergencia de rumo pra disparar. Duplicado de unitrac
// (DIVERGENCIA_RUMO_STREAK_MIN em lib/unitrac.ts, mesmo valor) para manter
// este modulo sem dependencias de I/O -- mesmo padrao ja usado por
// difAnguloGraus abaixo. SEM amortecimento por familiaridade (decisao
// revista pelo usuario 25/07): qualquer desvio de rota dispara, mesmo que o
// veiculo ja conheca a area.
const DIVERGENCIA_RUMO_STREAK_MIN = 2;
function divergenciaRumoDispara(streak: number): boolean {
  return streak >= DIVERGENCIA_RUMO_STREAK_MIN;
}

// Achado real 26/07 (Fase 2 -- casos reais da cliente Nutry Max, ver
// docs/superpowers/specs/2026-07-26-fase2-historico-casos-e-regras-simples-design.md):
// o piso de streak>=2 da regra geral de divergencia de rumo (acima) existe
// pra nao confundir ruido de GPS com desvio real, mas isso deixa passar
// qualquer virada errada mais curta que ~1min antes do veiculo se
// autocorrigir sozinho -- padrao relatado 3x pela cliente ("saiu do
// cliente e foi sentido contrario"). Esta regra e' mais restrita: SO vale
// no ciclo exato em que o veiculo saiu do raio de um destino legitimo
// (saiuDoRaioAgora, ja calculado pelo motor pra detectarBypassEntrega) --
// fora dessa janela estreita, a regra geral acima continua sendo a unica.
// Por disparar com 1 leitura so (sem confirmacao por streak), usa um
// limiar mais alto (140 graus, vs 100 da regra geral) pra compensar.
const VIRADA_ERRADA_LIMIAR_GRAUS = 140;

export function viradaErradaSaindoDeParada(
  saiuDoRaioAgora: boolean,
  divergenciaGrausAtual: number | null
): boolean {
  return (
    saiuDoRaioAgora &&
    divergenciaGrausAtual !== null &&
    divergenciaGrausAtual > VIRADA_ERRADA_LIMIAR_GRAUS
  );
}

// Avanço dos streaks do desvio com HISTERESE (achado real 09/07, vídeo da
// operação: desvio pra Xerém só pontuou lá em cima). Em estrada de serra a
// distância em linha reta a um destino oscila a cada curva — zerar o streak
// na primeira leitura de aproximação apagava a suspeita acumulada e o
// alerta saía km depois do desvio começar. Agora: 1 leitura de aproximação
// isolada CONGELA o streak (não zera, não incrementa); só 2 consecutivas
// zeram — mesma régua de persistência usada pra disparar e pra resolver.
// Tolerancia de "jitter" normal de GPS parado -- abaixo disso, o veiculo
// nao se moveu de verdade (nao e sinal de aproximacao nem de afastamento).
const POSICAO_CONGELADA_M = 10;

// Decide se o ciclo atual tem informacao NOVA o suficiente pra avancar os
// streaks de desvio, ou se e um nao-evento que deve congelar tudo (mesmo
// tratamento ja dado a saltoImplausivel). Achado real 10/07: se a posicao
// trava entre ciclos (sinal ruim/bloqueado) mas a velocidade reportada
// continua >0, afastouDeTudo() calcula "sem afastamento" (distancia nao
// mudou) e a historese le isso como aproximacao -- em 2 ciclos zera o
// streak E fecha um alerta ja ativo, exatamente o que um sequestro com
// bloqueio de sinal faria parecer. distanciaAoAnteriorM=null (sem ciclo
// anterior) tambem nao avanca -- nada a comparar ainda.
export function devAvancarStreaksDesvio(ctx: {
  fresco: boolean;
  saltoImplausivel: boolean;
  distanciaAoAnteriorM: number | null;
  velocidade: number;
}): boolean {
  if (!ctx.fresco || ctx.saltoImplausivel) return false;
  if (ctx.distanciaAoAnteriorM === null) return false;
  if (ctx.distanciaAoAnteriorM < POSICAO_CONGELADA_M) return false;
  return ctx.velocidade > 0;
}

export function avancarStreaksDesvio(
  afastando: boolean,
  atual: { desvioStreak: number; aproximandoStreak: number }
): { desvioStreak: number; aproximandoStreak: number; zerou: boolean } {
  if (afastando) {
    return { desvioStreak: atual.desvioStreak + 1, aproximandoStreak: 0, zerou: false };
  }
  const aproximandoStreak = atual.aproximandoStreak + 1;
  if (aproximandoStreak >= 2) {
    return { desvioStreak: 0, aproximandoStreak, zerou: true };
  }
  return { desvioStreak: atual.desvioStreak, aproximandoStreak, zerou: false };
}

// Ciclos consecutivos de aproximação (sem afastar de TUDO) que já bastam pra
// encerrar o alerta — mesmo limiar mínimo usado pra disparar (Camada 1),
// pelo mesmo motivo: 1 leitura pode ser ruído/blip (inclusive um sequestro
// fingindo aproximar pra "limpar" o alerta); 2 leituras é comportamento
// sustentado de verdade.
const APROXIMANDO_RESOLVE_STREAK = 2;

// Condição de permanência do alerta (anti-pisca). Duas formas de encerrar:
// (a) ficou fisicamente perto (<2,5km) de algum destino -- critério antigo,
// (b) aproximação SUSTENTADA de algum destino (>=2 leituras seguidas sem
// afastar de tudo) -- acrescentado 09/07/2026, achado real (TUL-1C38, ver
// docs/analise-deteccao.md secao 7.2): veículo aproximando monotonicamente
// da base por 10 leituras (8,26km -> 2,12km) ficava com o alerta "ativo" o
// trajeto INTEIRO, porque só (a) existia e a base ainda estava longe. Sem
// (b), disparar e resolver usavam réguas diferentes pro mesmo conceito de
// "aproximando cancela a suspeita".
export function foraDeRota(
  p: PosicaoNormalizada,
  ctx: {
    menorDistDestinoM: number | null;
    foraDaBase: boolean;
    aproximandoStreak: number;
  }
): boolean {
  if (!ctx.foraDaBase) return false;
  if (ctx.aproximandoStreak >= APROXIMANDO_RESOLVE_STREAK) return false;
  if (ctx.menorDistDestinoM === null) return false;
  return ctx.menorDistDestinoM >= DESVIO_RESOLVE_M;
}

// Detector de DESVIO (gatilho de criação). Rápido de propósito: streak>=2
// (~2min) já dispara. Piso de distância mínima (DESVIO_MIN_M) RESTAURADO
// em 22/07 -- tinha sido removido silenciosamente na Fase Agressiva de
// 11/07 sem nenhuma spec documentando (achado da auditoria de 22/07). A
// precisão vem de exigir afastamento de TODOS os destinos (não só o mais
// próximo), do tapete (via desconhecida, com cobertura mínima confirmada),
// da persistência (mata ruído de GPS) e agora também do piso mínimo.
export function detectarDesvio(p: PosicaoNormalizada, ctx: CtxDesvio): Alerta | null {
  if (ctx.alvosApiOk === false) return null;
  // Achado real 11/07 (diretiva explicita: falso positivo aceitavel,
  // prioridade total e nunca perder desvio real): calendario removido de
  // vez quando ha PENDENTES -- se a Unitrac carregou rota, e hora de
  // trabalho DESSE veiculo, ponto final, nao importa dia/hora (cobre
  // domingo e madrugada, alem do sabado ja coberto por
  // sabadoDiurnoComRota). O fallback por calendario so sobra pro caso sem
  // NENHUMA rota carregada (evita disparar pra veiculo em manutencao de
  // madrugada sem nada pra fazer).
  const operando = ctx.temPendentes || ctx.emOperacao || ctx.sabadoDiurnoComRota === true;
  if (!operando || !ctx.foraDaBase) return null;
  if (p.velocidade <= 0) return null;
  // Indo para a primeira entrega do dia: sem referência de comportamento
  // ainda. Achado real 11/07: bloquear TOTAL aqui apagava a deteccao o dia
  // INTEIRO pra veiculos de rota curta (1-3 entregas passam a maior parte
  // do dia com 0 feitas) -- 4 de 5 casos reais confirmados pela cerca
  // virtual como fora de rota real nunca viravam alerta so por isso. Agora
  // dispara igual, mas marca exigeConfirmacaoCorredor: a estrada real
  // (corredor) supre a falta de historico de comportamento sem abrir mao
  // de cautela -- route.ts so deixa sobreviver se o corredor CONFIRMAR
  // "fora" (nao fail-open pra este caso especifico).
  const semHistorico = ctx.temPendentes && (ctx.entregasFeitas ?? 1) === 0;
  if (ctx.distDestinosM.length === 0) return null;

  const menorDistM = Math.min(...ctx.distDestinosM);

  // Achado real 25/07 (redesign): substitui o cancelamento por distancia
  // ("distancia liquida caindo cancela suspeita") por geofence real --
  // dentro do raio de um destino legitimo OU de um ponto_seguro (ver
  // suspenderPorChegada em lib/unitrac.ts, calculado pelo motor) suspende
  // TODA checagem de desvio neste ciclo, mesmo com todos os outros sinais
  // presentes.
  if (ctx.suspensoPorChegada) return null;

  const afastandoDeTudo = afastouDeTudo(ctx.distDestinosM, ctx.distDestinosAnteriorM);

  // Achado real 27/07 (pedido explicito do usuario, revisão de regras):
  // ate hoje, sair de via principal pra rua estreita (quedaClasseViaria)
  // so REFORCAVA um alerta que ja ia disparar por outro motivo
  // (aplicarBonusClasseViaria) -- sozinho, nunca criava alerta. Diretriz
  // explicita: "mesmo que esteja indo em direcao ao cliente, se o CAMINHO
  // nao faz sentido (rua estranha), e desvio" -- dispara mesmo aproximando
  // (por isso dentro do bloco !afastandoDeTudo, nao precisa de mais nada).
  // A protecao contra falso positivo em toda chegada normal de entrega
  // (que tambem sai de via principal pra rua estreita) e' o guard
  // suspensoPorChegada, ja aplicado no topo desta funcao -- se chegou
  // aqui, nao e' uma chegada real.
  //
  // Achado do revisor (opus) + decisao explicita do usuario, task 2 (achado
  // 22/07, corrigido 27/07): posicionado ORIGINALMENTE depois do teto de
  // 300km (DESVIO_GATILHO_TETO_M) e do piso de 2500m (DESVIO_MIN_M) --
  // herdava os dois sem querer, so disparava com o veiculo a mais de 2,5km
  // de QUALQUER destino e a menos de 300km de todos. Usuario recusou
  // explicitamente esse piso pra ESTA regra: um roubo pode acontecer bem
  // perto do cliente (ex.: 100m depois de virar numa rua errada), entao a
  // checagem de classe viaria precisa disparar independente de distancia --
  // sem piso, sem teto -- confiando SO no guard suspensoPorChegada (que ja
  // rodou acima) pra nao confundir com uma chegada real de entrega. Por
  // isso o branch fica ANTES do teto/piso, logo apos os dois guards
  // universais (suspensoPorChegada + calculo de afastandoDeTudo), virando o
  // primeiro branch de disparo real da funcao. Os irmaos abaixo
  // (virada_errada saindo de parada, divergencia de rumo geral) CONTINUAM
  // depois do piso de 2500m de proposito -- essa mudanca e' so pra
  // quedaClasseViaria.
  //
  // Achado real 28/07 (Task 6, revisao manual de FP): 36% dos casos
  // resolvidos manualmente como falso-positivo desta regra eram o veiculo
  // saindo de uma parada de entrega LEGITIMA (dwell confirmado, ver
  // saiuParadaConfirmadaRecentemente acima) e pegando uma rua estreita logo
  // em seguida -- normal, mas ate aqui a regra nao tinha nenhum sinal disso
  // (saiuDoRaioAgora e' um pulso de 1 ciclo, dwellSegundosAcumulados zera no
  // mesmo ciclo da saida). Guard adicional: dentro da janela de saida
  // recente, suprime SO este branch (o veiculo continua elegivel a
  // qualquer outro gatilho de desvio nesta mesma chamada).
  if (!afastandoDeTudo && ctx.quedaClasseViaria && !ctx.saiuParadaConfirmadaRecentemente) {
    return {
      nivel: "atencao",
      tipo: "desvio",
      origemDesvio: "classe_viaria",
      motivo: MOTIVO_RUA_ESTRANHA,
      score: 40,
    };
  }

  // Achado real 22/07 (auditoria): acima do teto, em vez de silencio total,
  // dispara um alerta FRACO (nivel atencao) se o veiculo ainda estiver se
  // afastando de tudo -- fecha o "ponto cego" documentado desde 12/07
  // (sequestro que passe do teto ficava 100% invisivel), sem inflar o
  // volume de alertas criticos (viagem legitima >300km que nao esta se
  // afastando de nada continua silenciosa).
  if (menorDistM > DESVIO_GATILHO_TETO_M) {
    if (afastandoDeTudo && ctx.streak >= 2) {
      return {
        nivel: "atencao",
        tipo: "desvio",
        origemDesvio: "comportamental",
        motivo: `Muito além do raio de verificação detalhada (${(menorDistM / 1000).toFixed(0)}km de todos os ${ctx.distDestinosM.length} destinos) — alerta de baixa confiança, revisar manualmente`,
        score: 30,
      };
    }
    return null;
  }
  if (menorDistM < DESVIO_MIN_M) return null;

  // Ponto cego do gatilho principal: aproximar de QUALQUER destino cancela a
  // suspeita, mesmo que o caminho até lá nunca tenha sido percorrido pela
  // frota antes (ex.: sequestro que ainda assim segue "na direção" de uma
  // entrega). ctx.foraTapeteStreak conta ciclos consecutivos assim — o
  // motor só incrementa quando afastandoDeTudo=false E dentroTapete=false
  // (cobertura mínima confirmada, ver TAPETE_MIN_CELULAS no motor).
  const limiarForaTapete = ctx.familiarVeiculo === true
    ? FORA_TAPETE_STREAK_MIN_FAMILIAR
    : FORA_TAPETE_STREAK_MIN;
  if (CAMADA3_TAPETE_ATIVA && !afastandoDeTudo && ctx.foraTapeteStreak >= limiarForaTapete) {
    return {
      nivel: "critico",
      tipo: "desvio",
      origemDesvio: "comportamental",
      motivo: `Aproximando de um destino, mas por caminho que a frota nunca percorreu antes (fora de via conhecida há ${ctx.foraTapeteStreak} leituras)`,
      score: 65,
    };
  }

  // Achado real 26/07 (Fase 2): virada errada no ciclo exato em que o
  // veiculo saiu do raio de um destino legitimo -- dispara com 1 leitura
  // so (sem esperar streak>=2 da regra geral abaixo), usando um limiar
  // mais alto (140 graus) pra compensar a falta de confirmacao. Ver
  // viradaErradaSaindoDeParada. Colocado ANTES do branch geral de
  // divergencia de rumo (mesma guarda !afastandoDeTudo) por ser a
  // checagem mais rapida; a ordem entre os dois nao importa na pratica,
  // os dois sinais nunca coincidem de forma relevante.
  if (!afastandoDeTudo && viradaErradaSaindoDeParada(ctx.saiuDoRaioAgora, ctx.divergenciaGrausAtual)) {
    return {
      nivel: "atencao",
      tipo: "desvio",
      origemDesvio: "saida_parada",
      motivo: `Saiu de um ponto de entrega e tomou direção oposta à esperada (divergência de ${Math.round(ctx.divergenciaGrausAtual!)}°), sem esperar confirmação por streak`,
      score: 40,
    };
  }

  // Achado real 25/07: divergencia de rumo dispara independente da
  // distancia estar caindo -- pega o ponto cego onde o veiculo se afasta
  // por uma rua que nao faz sentido mas ainda esta "se aproximando" em
  // linha reta (ex.: contorno de lagoa/baia). Nivel atencao quando so a
  // direcao disparou (mais ambiguo); critico quando TAMBEM esta afastando
  // de tudo (o branch de afastandoDeTudo mais abaixo ja cobre esse caso
  // com nivel critico, entao aqui so cobre o caso "aproximando mas direcao
  // errada").
  // Achado real 28/07 (Task 4 do plano de melhorias pos-baseline, caso real
  // TTK-4D14: 84-88km/h no momento do disparo, perfil de rodovia -- bearing
  // reto diverge de uma rota real que curva): liga a MESMA verificacao de
  // corredor (verificarCorredor, OSRM/Valhalla) ja usada pelas branches de
  // "afastando de tudo" mais abaixo. Corrobora ao mesmo tempo o caso de
  // rodovia com curva e o de "muitos destinos" (a rota real confirma contra
  // o destino especifico, nao so a linha reta), sem precisar desenhar
  // bearing sensivel a curva do zero.
  //
  // Decisao EXPLICITA (Step 3, NAO assumida): as branches de "afastando de
  // tudo" abaixo TAMBEM setam exigeConfirmacaoCorredor quando semHistorico
  // (exige confirmacao POSITIVA de "fora" antes de sobreviver -- fail
  // CLOSED se o corredor estiver indisponivel/orcamento estourado, ver
  // docstring de exigeConfirmacaoCorredor no tipo Alerta acima e o consumo
  // em route.ts). rumo_diverge NAO seta esse campo -- decisao consciente,
  // nao descuido. Motivos: (1) exigeConfirmacaoCorredor existe pra
  // compensar um problema especifico das branches de afastando-de-tudo
  // (veiculo com ZERO entregas feitas, sem historico de comportamento
  // nenhum pra confiar) -- rumo_diverge nao tem esse problema, dispara
  // igual independente de entregasFeitas; (2) rumo_diverge e' um sinal
  // estruturalmente mais FRACO (nivel "atencao" hardcoded, nunca "critico",
  // ao contrario das branches de afastando-de-tudo que usam
  // exigeConfirmacaoCorredor) -- faz sentido a corroboracao do corredor ser
  // so OPCIONAL aqui (confirma "dentro" => suprime, mesmo comportamento que
  // precisaVerificacaoCorredor sozinho ja da; "fora"/"indisponivel"/
  // "orcamento_estourado" => sobrevive, fail-open) em vez de EXIGIR
  // confirmacao positiva pra sobreviver -- exigir isso arriscaria perder um
  // alerta real toda vez que OSRM/Valhalla estiver fora do ar, por um sinal
  // que ja e' de baixa confianca por natureza.
  if (!afastandoDeTudo && divergenciaRumoDispara(ctx.divergenciaRumoStreak)) {
    const nDestDirecao = ctx.distDestinosM.length;
    return {
      nivel: "atencao",
      tipo: "desvio",
      origemDesvio: "rumo_diverge",
      motivo: `Direção do movimento diverge da rota esperada há ${ctx.divergenciaRumoStreak} leituras, mesmo aproximando em linha reta de ${nDestDirecao} destino(s)`,
      score: 40,
      precisaVerificacaoCorredor: true,
    };
  }

  // Persistência mínima RESTAURADA pra 2 ciclos em 21/07 (revertendo a
  // baixa de 11/07 pra 1 ciclo) -- achado real desta sessão: 69 de 81
  // alertas "afastando-se" dispararam com apenas 1 leitura, volume de
  // ruído considerável. Decisão consciente do usuário, avisado do
  // trade-off (desvio real pequeno leva ~1min a mais pra confirmar).
  if (ctx.streak < 2) return null;
  // Checagem própria (não confia só no streak pré-computado pelo motor):
  // se o ciclo ATUAL mostra aproximação de qualquer destino, cancela na
  // hora — não espera o motor zerar o streak no próximo ciclo.
  if (!afastandoDeTudo) return null;

  const kmAcum = (Math.max(0, ctx.afastamentoAcumuladoM) / 1000).toFixed(1).replace(".", ",");
  const nDest = ctx.distDestinosM.length;

  // Fora de qualquer via já percorrida pela frota (com cobertura mínima
  // confirmada pelo motor): sinal quase certo, crítico já no 2º ciclo.
  // Mesmo dado de tapete que causou o incidente de 09/07 (Camada 3) -- esta
  // escalada vivia SEM a flag, e continuava produzindo o mesmo sintoma
  // ("fora de via conhecida da frota") mesmo com CAMADA3_TAPETE_ATIVA=false.
  // Confirmado com dado real: disparou as 21h43 de 09/07, depois da
  // desativacao. Agora atras da MESMA flag que protege a linha ~527.
  if (CAMADA3_TAPETE_ATIVA && ctx.dentroTapete === false) {
    return {
      nivel: "critico",
      tipo: "desvio",
      origemDesvio: "comportamental",
      motivo: `Afastando-se de todos os ${nDest} destinos há ${ctx.streak} leituras seguidas (~${ctx.streak}min), +${kmAcum}km acumulado, fora de via conhecida da frota`,
      score: 80,
      precisaVerificacaoCorredor: true,
      exigeConfirmacaoCorredor: semHistorico || undefined,
    };
  }

  // Via CONHECIDA mas área ATUAL de risco elevado (favela, tiroteio recente
  // perto, CISP com histórico alto de roubo de carga, corredor de rodovia
  // perigosa, ou madrugada — ver calcularRiscoArea): escala tão rápido
  // quanto "fora do tapete". "Rua que a frota já usa" não é garantia de
  // segurança se a região está quente agora — resposta rápida importa mais
  // que esperar mais ciclos só porque a via em si é conhecida.
  if (ctx.riscoAreaAtual >= RISCO_AREA_LIMIAR) {
    return {
      nivel: "critico",
      tipo: "desvio",
      origemDesvio: "comportamental",
      motivo: `Afastando-se de todos os ${nDest} destinos há ${ctx.streak} leituras seguidas (~${ctx.streak}min), +${kmAcum}km acumulado, em área de risco elevado`,
      score: 80,
      precisaVerificacaoCorredor: true,
      exigeConfirmacaoCorredor: semHistorico || undefined,
    };
  }

  // Persistência longa (4+ ciclos, ~4min) escala mesmo em via conhecida —
  // pode ser assalto acontecendo numa rua/rodovia que a frota usa sempre.
  if (ctx.streak >= 4) {
    return {
      nivel: "critico",
      tipo: "desvio",
      origemDesvio: "comportamental",
      motivo: `Afastando-se de todos os ${nDest} destinos há ${ctx.streak} leituras seguidas (~${ctx.streak}min), +${kmAcum}km acumulado`,
      score: 68,
      precisaVerificacaoCorredor: true,
      exigeConfirmacaoCorredor: semHistorico || undefined,
    };
  }

  return {
    nivel: "critico",
    tipo: "desvio",
    origemDesvio: "comportamental",
    motivo: `Afastando-se de todos os ${nDest} destinos há ${ctx.streak} leituras seguidas (~${ctx.streak}min), +${kmAcum}km acumulado`,
    score: 45,
    precisaVerificacaoCorredor: true,
      exigeConfirmacaoCorredor: semHistorico || undefined,
  };
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
const BONUS_CORROBORACAO_POR_SINAL = 15;

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
export const TIPOS_NAO_GERENCIADOS = new Set(["favela", "desvio", "bypass_entrega"]);

// Reforco de score da classificacao viaria (via principal -> rua estreita)
// -- ver docs/superpowers/specs/2026-07-21-classe-viaria-desvio-design.md.
// Aplicado ao RESULTADO de detectarDesvio. Ate 26/07 esse sinal NUNCA era
// lido dentro da propria funcao, garantindo por construcao que nunca
// criava alerta sozinho. Achado real 27/07 (pedido explicito do usuario):
// isso mudou -- quedaClasseViaria agora TAMBEM e lido dentro de
// detectarDesvio (origemDesvio="classe_viaria"), pra disparar um alerta
// PROPRIO em vez de so reforcar um alerta de outra origem. A guarda abaixo
// (alerta.origemDesvio === "classe_viaria") evita contar o mesmo sinal 2x:
// se o alerta ja nasceu do branch novo, o sinal ja esta 100% contabilizado
// no score/motivo dele, reforcar de novo aqui duplicaria o bonus e
// repetiria o texto. Mesma magnitude de BONUS_CORROBORACAO_POR_SINAL,
// capado em 100.
const BONUS_CLASSE_VIARIA = 15;

export function aplicarBonusClasseViaria(
  alerta: Alerta | null,
  quedaClasseViaria: boolean
): Alerta | null {
  if (!alerta || !quedaClasseViaria || alerta.origemDesvio === "classe_viaria") return alerta;
  return {
    ...alerta,
    score: Math.min(100, alerta.score + BONUS_CLASSE_VIARIA),
    motivo: alerta.motivo ? `${alerta.motivo} — saiu de via principal recentemente` : alerta.motivo,
  };
}

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
  distDestinosM?: number[];
  distDestinosAnteriorM?: number[];
  desvioStreak?: number;
  afastamentoAcumuladoM?: number;
  dentroTapete?: boolean | null;
  familiarVeiculo?: boolean | null;
  quedaClasseViaria?: boolean;
  // Achado real 28/07 (Task 6): ver CtxDesvio.saiuParadaConfirmadaRecentemente.
  saiuParadaConfirmadaRecentemente?: boolean;
  riscoAreaAtual?: number;
  foraTapeteStreak?: number;
  // Achado real 25/07 (redesign do detector de desvio): ver CtxDesvio.
  suspensoPorChegada?: boolean;
  divergenciaRumoStreak?: number;
  // Achado real 26/07 (Fase 2): ver CtxDesvio.saiuDoRaioAgora /
  // CtxDesvio.divergenciaGrausAtual (viradaErradaSaindoDeParada).
  saiuDoRaioAgora?: boolean;
  divergenciaGrausAtual?: number | null;
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
    detectarParadaLonga({
      paradoMin: ctx.paradoMin,
      emOperacao: ctx.emOperacao,
      foraDaBase: ctx.foraDaBase,
      noCliente: ctx.noCliente,
      temPOIProximo: ctx.temPOIProximo,
      entregasFeitas: ctx.entregasFeitas,
      entregasTotal: ctx.entregasTotal,
    }),
    ctx.estavEmMovimento !== undefined
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
    detectarParadaForaTapete({
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
    ctx.distDestinosM !== undefined
      ? aplicarBonusClasseViaria(detectarDesvio(p, {
          distDestinosM: ctx.distDestinosM ?? [],
          distDestinosAnteriorM: ctx.distDestinosAnteriorM ?? [],
          temPendentes: ctx.temPendentes ?? false,
          emOperacao: ctx.emOperacao,
          foraDaBase: ctx.foraDaBase,
          entregasFeitas: ctx.entregasFeitas,
          alvosApiOk: ctx.alvosApiOk,
          sabadoDiurnoComRota: ctx.sabadoDiurnoComRota,
          streak: ctx.desvioStreak ?? 0,
          afastamentoAcumuladoM: ctx.afastamentoAcumuladoM ?? 0,
          dentroTapete: ctx.dentroTapete ?? null,
          familiarVeiculo: ctx.familiarVeiculo ?? null,
          riscoAreaAtual: ctx.riscoAreaAtual ?? 0,
          foraTapeteStreak: ctx.foraTapeteStreak ?? 0,
          suspensoPorChegada: ctx.suspensoPorChegada ?? false,
          divergenciaRumoStreak: ctx.divergenciaRumoStreak ?? 0,
          saiuDoRaioAgora: ctx.saiuDoRaioAgora ?? false,
          divergenciaGrausAtual: ctx.divergenciaGrausAtual ?? null,
          quedaClasseViaria: ctx.quedaClasseViaria ?? false,
          saiuParadaConfirmadaRecentemente: ctx.saiuParadaConfirmadaRecentemente ?? false,
        }), ctx.quedaClasseViaria ?? false)
      : null,
  ].filter((a): a is Alerta => a !== null);
}

// Avalia todos os detectores core e retorna o alerta de maior severidade.
// Prioridade: critico > atencao; desempate por score (maior vence).
export function avaliar(p: PosicaoNormalizada, ctx: CtxAvaliacao): Alerta | null {
  return arbitrarCandidatos(montarCandidatosCore(p, ctx));
}
