// Estado do sinal do veículo (RAS-01 + RAS-04, auditoria 03/11).
//
// Antes cada tela tinha o seu limite (10, 15, 30, 60 min) e todas olhavam o
// atraso_min da ÚLTIMA gravação, que congela quando o motor para de gravar o
// cliente: o carro parecia "ao vivo" parado no último ponto. Agora:
//   - a entrada é o atraso EFETIVO, calculado no Postgres pelo /api/mapa
//     (max(atraso_min, idade do updated_at), F1-15) -- nunca Date.now() do
//     navegador, que pode estar com o relógio diferente do servidor;
//   - um só critério: < 5 min atual, 5-30 atrasado, > 30 sem sinal,
//     sem número = desconhecido.
export type EstadoSinal = "atual" | "atrasado" | "sem_sinal" | "desconhecido";

export const LIMITE_ATUAL_MIN = 5;
export const LIMITE_SEM_SINAL_MIN = 30;

export function estadoSinal(atrasoEfetivoMin: number | null | undefined): EstadoSinal {
  if (atrasoEfetivoMin == null || !Number.isFinite(atrasoEfetivoMin)) return "desconhecido";
  if (atrasoEfetivoMin < LIMITE_ATUAL_MIN) return "atual";
  if (atrasoEfetivoMin <= LIMITE_SEM_SINAL_MIN) return "atrasado";
  return "sem_sinal";
}

/** Atraso a usar na tela: o efetivo do servidor; sem ele (resposta antiga), o da Unitrac. */
export function atrasoDoVeiculo(v: { atraso_min: number | null; atraso_efetivo_min?: number | null }): number | null {
  return v.atraso_efetivo_min ?? v.atraso_min;
}

export function estadoDoVeiculo(v: { atraso_min: number | null; atraso_efetivo_min?: number | null }): EstadoSinal {
  return estadoSinal(atrasoDoVeiculo(v));
}

/** Seta de rumo e cor de "em movimento" só para leitura atual. */
export function aparenciaMarcador(p: { estado: EstadoSinal; velocidade: number | null | undefined; rumo: number | null | undefined }): {
  seta: boolean; cinza: boolean; tracejado: boolean; opacidade: number;
} {
  const atual = p.estado === "atual";
  return {
    seta: atual && (p.velocidade ?? 0) > 5 && p.rumo != null,
    cinza: !atual,
    tracejado: p.estado === "atrasado",
    opacidade: p.estado === "sem_sinal" || p.estado === "desconhecido" ? 0.5 : 1,
  };
}

/** "HH:MM" em Brasília. */
export function horaBRT(iso: string | null | undefined): string | null {
  if (!iso) return null;
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return null;
  return new Intl.DateTimeFormat("pt-BR", { timeZone: "America/Sao_Paulo", hour: "2-digit", minute: "2-digit", hour12: false }).format(d);
}

/** Velocidade: só o número se atual; senão "última: X km/h às HH:MM". */
export function rotuloVelocidade(velocidade: number | null | undefined, estado: EstadoSinal, posicaoEmISO: string | null | undefined): string {
  if (velocidade == null) return "—";
  if (estado === "atual") return `${velocidade} km/h`;
  const h = horaBRT(posicaoEmISO);
  return h ? `última: ${velocidade} km/h às ${h}` : `última: ${velocidade} km/h`;
}

export function rotuloComunicacao(atrasoEfetivoMin: number | null | undefined, estado: EstadoSinal): string {
  if (estado === "desconhecido" || atrasoEfetivoMin == null) return "sem posição";
  if (estado === "atual") return "ao vivo";
  const min = Math.round(atrasoEfetivoMin);
  if (min < 60) return `há ${min} min`;
  const h = Math.floor(min / 60);
  return h < 24 ? `há ${h} h` : `há ${Math.floor(h / 24)} d`;
}
