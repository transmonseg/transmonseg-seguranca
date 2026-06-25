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

export function detectarBau(p: PosicaoNormalizada): Alerta | null {
  if (!p.bau) return null;
  return { nivel: "critico", tipo: "bau", motivo: "Bau aberto fora de ponto", score: 90 };
}

export function detectarJammer(p: PosicaoNormalizada): Alerta | null {
  if (p.ignicao && p.atraso >= 15 && p.atraso <= 720) {
    return {
      nivel: "critico",
      tipo: "jammer",
      motivo: `Sinal perdido ha ${p.atraso}min (possivel bloqueador)`,
      score: 80,
    };
  }
  return null;
}

export function detectarIgnicaoForaJanela(
  p: PosicaoNormalizada,
  emOperacao: boolean,
  foraDaBase: boolean
): Alerta | null {
  if (!p.fresco || !p.ignicao || emOperacao || !foraDaBase) return null;
  return {
    nivel: "critico",
    tipo: "ignicao_noturna",
    motivo: "Motor ligado fora do horário de operação (possível movimentação não autorizada)",
    score: 85,
  };
}

export function detectarSaidaNaoAutorizada(
  p: PosicaoNormalizada,
  ctx: { foraDaBase: boolean; temPendentes: boolean; emOperacao: boolean; entregasTotal?: number }
): Alerta | null {
  if (!p.fresco || !p.ignicao) return null;
  if (!ctx.foraDaBase || ctx.temPendentes || !ctx.emOperacao) return null;
  // undefined = API Unitrac indisponível; não sabemos se havia entregas.
  // Nao disparar para evitar falsos positivos em falha de API.
  if (ctx.entregasTotal === undefined) return null;
  // Veículo que terminou entregas (entregasTotal > 0) está legitimamente retornando.
  if (ctx.entregasTotal > 0) return null;
  return {
    nivel: "critico",
    tipo: "saida_nao_autorizada",
    motivo: "Veículo saiu da base sem entregas programadas",
    score: 78,
  };
}

export function detectarExcessoVelocidade(p: PosicaoNormalizada): Alerta | null {
  if (p.velocidade > 100) {
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
  if (ctx.ehBenassi && ctx.noCliente && ctx.emOperacao && ctx.paradoMin >= 90) {
    return {
      nivel: "atencao",
      tipo: "parada_cliente",
      motivo: `Parado no cliente ha ${formataDuracao(ctx.paradoMin)}, confirmar o que esta acontecendo`,
      score: 52,
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
  // Benassi parado no cliente: coberto por detectarParadaCliente, evita duplicata.
  if (ctx.ehBenassi && ctx.noCliente) return null;
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
}): Alerta | null {
  if (!ctx.emOperacao || !ctx.foraDaBase || ctx.noCliente) return null;
  if (!ctx.jaParedoNoCicloAnterior) return null; // aguarda um ciclo antes de disparar
  if (ctx.temPOIProximo) return null; // parada em local legitimo

  const limiteMin = ctx.estavEmMovimento ? 12 : 25;
  if (ctx.paradoMin < limiteMin || ctx.paradoMin >= 90) return null; // >= 90 ja e parada_longa

  let score = 55;
  if (ctx.esMadrugada) score += 15;
  if (ctx.emZonaRisco) score += 10;

  const duracao = formataDuracao(ctx.paradoMin);
  const sufixo = ctx.esMadrugada ? " (madrugada)" : ctx.emZonaRisco ? " (area de risco)" : "";
  return {
    nivel: "atencao",
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
  // Se presente, substitui a lógica de distAlvoM + rumo (mais preciso).
  distCorredorM?: number | null;
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
    const CORREDOR_M = 400;
    if (ctx.distCorredorM <= CORREDOR_M) return null; // dentro do corredor
    const km = (ctx.distCorredorM / 1000).toFixed(1).replace(".", ",");
    if (ctx.distCorredorM >= 1000) {
      return {
        nivel: "critico",
        tipo: "desvio",
        motivo: `Fora do corredor de rota: ${km}km da rota planejada`,
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

// Detector de TIROTEIO PRÓXIMO (operação/violência acontecendo agora na região).
// Cruza a posição do veículo com os tiroteios ATIVOS (últimas ~3h, Fogo Cruzado).
// Perigo imediato à carga: se há tiro perto, a central tem que saber JÁ.
export function detectarTiroteioProximo(
  p: PosicaoNormalizada,
  ctx: { distTiroteioM: number | null; tiroteioIdadeMin: number | null }
): Alerta | null {
  if (ctx.distTiroteioM === null) return null;
  if (!p.fresco) return null; // sem posição confiável, não dá pra cruzar
  const quando = fmtIdade(ctx.tiroteioIdadeMin);
  if (ctx.distTiroteioM <= 1500) {
    return {
      nivel: "critico",
      tipo: "tiroteio",
      motivo: `Tiroteio a ${fmtDist(ctx.distTiroteioM)} (${quando}) na regiao do veiculo`,
      score: 88,
    };
  }
  if (ctx.distTiroteioM <= 3000) {
    return {
      nivel: "critico",
      tipo: "tiroteio",
      motivo: `Tiroteio a ${fmtDist(ctx.distTiroteioM)} (${quando}) próximo à rota`,
      score: 82,
    };
  }
  return null;
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
    distTiroteioM?: number | null;
    tiroteioIdadeMin?: number | null;
    // Parada anomala (opcional — so roda se estavEmMovimento for fornecido)
    estavEmMovimento?: boolean;
    esMadrugada?: boolean;
    emZonaRisco?: boolean;
    temPOIProximo?: boolean;
    jaParedoNoCicloAnterior?: boolean;
  }
): Alerta | null {
  const candidatos: Alerta[] = [
    detectarPanico(p),
    detectarBau(p),
    detectarJammer(p),
    detectarIgnicaoForaJanela(p, ctx.emOperacao, ctx.foraDaBase),
    detectarSaidaNaoAutorizada(p, {
      foraDaBase: ctx.foraDaBase,
      temPendentes: ctx.temPendentes ?? false,
      emOperacao: ctx.emOperacao,
      entregasTotal: ctx.entregasTotal,
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
