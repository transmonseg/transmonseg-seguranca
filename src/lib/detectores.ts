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

export function detectarParadaLonga(ctx: {
  paradoMin: number;
  emOperacao: boolean;
  foraDaBase: boolean;
}): Alerta | null {
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

// Avalia todos os detectores e retorna o alerta de maior severidade.
// Prioridade: critico > atencao; desempate por score (maior vence).
export function avaliar(
  p: PosicaoNormalizada,
  ctx: { paradoMin: number; emOperacao: boolean; foraDaBase: boolean }
): Alerta | null {
  const candidatos: Alerta[] = [
    detectarPanico(p),
    detectarBau(p),
    detectarJammer(p),
    detectarExcessoVelocidade(p),
    detectarParadaLonga(ctx),
  ].filter((a): a is Alerta => a !== null);

  if (candidatos.length === 0) return null;

  return candidatos.reduce((melhor, atual) => {
    if (melhor.nivel === "critico" && atual.nivel !== "critico") return melhor;
    if (atual.nivel === "critico" && melhor.nivel !== "critico") return atual;
    return atual.score > melhor.score ? atual : melhor;
  });
}
