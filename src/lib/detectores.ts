// Motor de detecção de alertas — funções PURAS (sem I/O).
// Cada detector avalia uma PosicaoNormalizada e retorna Alerta | null.
// Nunca importe nada de 'next' aqui — lib pura TypeScript.

import type { PosicaoNormalizada } from "./unitrac";

export type Alerta = {
  nivel: "critico" | "atencao";
  tipo: string;
  motivo: string;
  score: number;
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
  if (p.atraso < JAMMER_CRITICO_MIN) {
    return {
      nivel: "atencao",
      tipo: "jammer",
      motivo: `Sinal ausente ha ${p.atraso}min com ignicao ligada (monitorar)`,
      score: 55,
    };
  }
  return {
    nivel: "critico",
    tipo: "jammer",
    motivo: `Sinal perdido ha ${p.atraso}min com ignicao ligada (possivel bloqueador GPS)`,
    score: 80,
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
    nivel: "atencao",
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
      nivel: "atencao",
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
  ehBenassi?: boolean;
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
  ehBenassi?: boolean;
}): Alerta | null {
  // Parado no cliente: coberto por detectarParadaCliente, evita duplicata.
  if (ctx.noCliente) return null;
  if (ctx.paradoMin >= 90 && ctx.emOperacao && ctx.foraDaBase) {
    return {
      nivel: "atencao",
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

  // 20 min em cidade (vinha de >= 30km/h), 35 min em estrada — limites anteriores
  // (12/25 min) disparavam para praticamente qualquer parada em trânsito pesado do RJ.
  const limiteMin = ctx.estavEmMovimento ? 20 : 35;
  if (ctx.paradoMin < limiteMin || ctx.paradoMin >= 90) return null; // >= 90 ja e parada_longa

  let score = 55;
  if (ctx.esMadrugada) score += 15;
  if (ctx.emZonaRisco) score += 10;

  // Madrugada + zona de risco juntos: combinacao classica de roubo — escala para critico.
  const nivel: "critico" | "atencao" = (ctx.esMadrugada && ctx.emZonaRisco) ? "critico" : "atencao";

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

// Faixa de distância (m) em que faz sentido falar de "desvio de rota local".
// Abaixo do mínimo o veículo está chegando no ponto (normal). Acima do teto não
// é desvio: é DESLOCAMENTO interurbano (a frota atende o estado todo; veículos
// indo/voltando de regiões distantes ficam a 40-120km de qualquer pendente).
const DESVIO_MIN_M = 2500;
const DESVIO_GATILHO_TETO_M = 25000;

export type CtxDesvio = {
  distAlvoM: number | null;
  distAlvoAnteriorM: number | null;
  temPendentes: boolean;
  emOperacao: boolean;
  foraDaBase: boolean;
  rumoMovimento: number | null;
  rumoAlvo: number | null;
  // Corredor OSRM (quando disponível): distância mínima ao corredor de rota.
  distCorredorM?: number | null;
  // Anti-falso-positivo: true se o veículo já estava fora do corredor no ciclo anterior.
  // Obrigatório para disparar no modo OSRM — exige 2 ciclos consecutivos fora.
  jaForaCorretor?: boolean;
};

// O veículo está FORA DE ROTA agora? Condição FROUXA, usada para MANTER um
// alerta de desvio ativo (anti-pisca): basta estar longe (>=2,5km), com
// pendentes, fora da base e em operação. Não exige afastamento instantâneo nem
// rumo — assim o alerta não some quando o veículo para no semáforo ou faz uma
// curva. Sem teto superior: se o desvio escalou pra 60km, continua valendo.
export function foraDeRota(
  p: PosicaoNormalizada,
  ctx: { distAlvoM: number | null; temPendentes: boolean; emOperacao: boolean; foraDaBase: boolean }
): boolean {
  if (!ctx.temPendentes || !ctx.emOperacao || !ctx.foraDaBase) return false;
  if (ctx.distAlvoM === null) return false;
  return ctx.distAlvoM >= 2000;
}

// Detector de DESVIO DE ROTA (GATILHO de criação — estrito).
// A Unitrac não fornece a rota planejada, só os ALVOS (pontos de entrega). A
// "rota" é o conjunto de pontos pendentes. Para criar um alerta exigimos TRÊS
// sinais juntos, o que elimina os falsos positivos:
//   1) faixa LOCAL de rota (2,5km a 25km) — acima disso é deslocamento, não desvio;
//   2) SE AFASTANDO (distância ao pendente mais próximo cresceu desde o ciclo anterior);
//   3) rumo do movimento OPOSTO ao alvo (indo no sentido contrário ao ponto).
// Quem vai em direção às entregas (distância caindo OU rumo pro alvo) nunca dispara.
export function detectarDesvio(p: PosicaoNormalizada, ctx: CtxDesvio): Alerta | null {
  if (!ctx.temPendentes || !ctx.emOperacao || !ctx.foraDaBase) return null;
  if (p.velocidade <= 0) return null;

  // ── MODO CORREDOR (OSRM): mais preciso, sem falsos positivos por via tortuosa ──
  if (ctx.distCorredorM != null) {
    // 800m de tolerancia: ruas estreitas, obras e rerotas urbanas comuns no RJ.
    const CORREDOR_M = 800;
    if (ctx.distCorredorM <= CORREDOR_M) return null;

    // Heading check: se o veiculo esta se movendo EM DIRECAO ao proximo waypoint
    // (angulo <= 75 graus), provavelmente esta tomando rua alternativa ao mesmo
    // destino — nao e desvio real, e sim rota paralela nao mapeada no OSRM.
    if (
      ctx.rumoMovimento !== null &&
      ctx.rumoAlvo !== null &&
      difAnguloGraus(ctx.rumoMovimento, ctx.rumoAlvo) <= 75
    ) {
      return null;
    }

    // Debounce de 2 ciclos consecutivos: exige que o veiculo JA estivesse fora
    // do corredor no ciclo anterior. Elimina falsos positivos por GPS bounce,
    // ponto GPS unico ruim ou divergencia momentanea do OSRM.
    if (!ctx.jaForaCorretor) return null;

    const km = (ctx.distCorredorM / 1000).toFixed(1).replace(".", ",");
    if (ctx.distCorredorM >= 3000) {
      return {
        nivel: "critico",
        tipo: "desvio",
        motivo: `Fora do corredor de rota por ${km}km (2+ ciclos confirmados)`,
        score: 72,
      };
    }
    return {
      nivel: "atencao",
      tipo: "desvio",
      motivo: `Saindo do corredor: ${km}km da rota planejada`,
      score: 48,
    };
  }

  // ── MODO CLASSICO (sem corredor): distância ao alvo + rumo ──────────────────
  if (ctx.distAlvoM === null) return null;
  if (ctx.distAlvoM < DESVIO_MIN_M || ctx.distAlvoM > DESVIO_GATILHO_TETO_M) return null;
  const afastando =
    ctx.distAlvoAnteriorM !== null && ctx.distAlvoM > ctx.distAlvoAnteriorM + 200;
  if (!afastando) return null;
  if (ctx.rumoMovimento === null || ctx.rumoAlvo === null) return null;
  const opostoAoAlvo = difAnguloGraus(ctx.rumoMovimento, ctx.rumoAlvo) > 90;
  if (!opostoAoAlvo) return null;

  const km = (ctx.distAlvoM / 1000).toFixed(1).replace(".", ",");
  if (ctx.distAlvoM >= 5000) {
    return {
      nivel: "critico",
      tipo: "desvio",
      motivo: `Fora de rota: ${km}km do ponto de entrega e seguindo no sentido oposto`,
      score: 72,
    };
  }
  return {
    nivel: "atencao",
    tipo: "desvio",
    motivo: `Saindo da rota: ${km}km do ponto, sentido oposto`,
    score: 48,
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
      nivel: "atencao",
      tipo: "tiroteio",
      motivo: `Tiroteio a ${fmtDist(ctx.distTiroteioM)} (${quando}) — monitorar situacao`,
      score: 60,
    };
  }
  if (ctx.distTiroteioM <= 2000) {
    return {
      nivel: "atencao",
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
    nivel: "atencao",
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
    tipo: "parada_noturna_ignicao",
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
  if (ctx.velocidadeAnterior === null || ctx.velocidadeAnterior !== 0) return null;
  if (p.velocidade < 80) return null;
  return {
    nivel: "critico",
    tipo: "aceleracao_brusca",
    motivo: `Aceleracao brusca: 0 para ${p.velocidade} km/h em 1 ciclo — verificar`,
    score: 70,
  };
}

// Avalia todos os detectores e retorna TODOS os alertas ativos, ordenados por severidade.
// Use quando precisar de multiplos alertas simultaneos por veiculo (ex: panico + desvio).
export function avaliarTodos(
  p: PosicaoNormalizada,
  ctx: Parameters<typeof avaliar>[1]
): Alerta[] {
  const candidatos: Alerta[] = [
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
      ehBenassi: ctx.ehBenassi,
    }),
    detectarParadaLonga({
      paradoMin: ctx.paradoMin,
      emOperacao: ctx.emOperacao,
      foraDaBase: ctx.foraDaBase,
      noCliente: ctx.noCliente,
      ehBenassi: ctx.ehBenassi,
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
    detectarTiroteioProximo(p, {
      distTiroteioM: ctx.distTiroteioM ?? null,
      tiroteioIdadeMin: ctx.tiroteioIdadeMin ?? null,
    }),
    ctx.distAlvoM !== undefined || ctx.distCorredorM !== undefined
      ? detectarDesvio(p, {
          distAlvoM: ctx.distAlvoM ?? null,
          distAlvoAnteriorM: ctx.distAlvoAnteriorM ?? null,
          temPendentes: ctx.temPendentes ?? false,
          emOperacao: ctx.emOperacao,
          foraDaBase: ctx.foraDaBase,
          rumoMovimento: ctx.rumoMovimento ?? null,
          rumoAlvo: ctx.rumoAlvo ?? null,
          distCorredorM: ctx.distCorredorM ?? null,
          jaForaCorretor: ctx.jaForaCorretor ?? false,
        })
      : null,
  ].filter((a): a is Alerta => a !== null);

  return candidatos.sort((a, b) => {
    if (a.nivel === b.nivel) return b.score - a.score;
    return a.nivel === "critico" ? -1 : 1;
  });
}

// Avalia todos os detectores e retorna o alerta de maior severidade.
// Prioridade: critico > atencao; desempate por score (maior vence).
export function avaliar(
  p: PosicaoNormalizada,
  ctx: {
    paradoMin: number;
    emOperacao: boolean;
    foraDaBase: boolean;
    noCliente?: boolean;
    ehBenassi?: boolean;
    distAlvoM?: number | null;
    distAlvoAnteriorM?: number | null;
    temPendentes?: boolean;
    entregasTotal?: number;
    rumoMovimento?: number | null;
    rumoAlvo?: number | null;
    distCorredorM?: number | null;
    jaForaCorretor?: boolean;
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
  }
): Alerta | null {
  const candidatos: Alerta[] = [
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
      ehBenassi: ctx.ehBenassi,
    }),
    detectarParadaLonga({
      paradoMin: ctx.paradoMin,
      emOperacao: ctx.emOperacao,
      foraDaBase: ctx.foraDaBase,
      noCliente: ctx.noCliente,
      ehBenassi: ctx.ehBenassi,
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
    detectarTiroteioProximo(p, {
      distTiroteioM: ctx.distTiroteioM ?? null,
      tiroteioIdadeMin: ctx.tiroteioIdadeMin ?? null,
    }),
    ctx.distAlvoM !== undefined || ctx.distCorredorM !== undefined
      ? detectarDesvio(p, {
          distAlvoM: ctx.distAlvoM ?? null,
          distAlvoAnteriorM: ctx.distAlvoAnteriorM ?? null,
          temPendentes: ctx.temPendentes ?? false,
          emOperacao: ctx.emOperacao,
          foraDaBase: ctx.foraDaBase,
          rumoMovimento: ctx.rumoMovimento ?? null,
          rumoAlvo: ctx.rumoAlvo ?? null,
          distCorredorM: ctx.distCorredorM ?? null,
          jaForaCorretor: ctx.jaForaCorretor ?? false,
        })
      : null,
  ].filter((a): a is Alerta => a !== null);

  if (candidatos.length === 0) return null;

  return candidatos.reduce((melhor, atual) => {
    if (melhor.nivel === "critico" && atual.nivel !== "critico") return melhor;
    if (atual.nivel === "critico" && melhor.nivel !== "critico") return atual;
    return atual.score > melhor.score ? atual : melhor;
  });
}
