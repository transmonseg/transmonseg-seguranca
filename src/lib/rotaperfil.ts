// Perfil estatistico de rota: baseline (media/desvio-padrao) do desvio
// perpendicular observado na aproximacao final de cada destino especifico.
// Complementa o teto FIXO de 3km (TRAJETO_PERPENDICULAR_LIMIAR_M em
// detectores.ts) com um teto por-rota: se uma entrega sempre foi feita com
// ~50m de desvio e hoje aparece 500m, isso é muito anomalo pra ESSA rota
// mesmo estando bem abaixo do teto fixo global.
//
// EWMA (nao media cumulativa classica) de proposito: rotas mudam de verdade
// (obra, novo acesso) e a media deve se adaptar em dias, nao ficar "presa"
// por causa de milhares de amostras antigas. Formula padrao de
// media/variancia movel exponencial.
export type PerfilRotaEstado = {
  nAmostras: number;
  mediaM: number;
  varianciaM2: number;
};

// ~1/ALPHA amostras de "memoria efetiva" (~12,5) -- adapta a mudanca de rota
// em poucos dias, sem reagir demais a uma unica leitura ruidosa.
export const PERFIL_ROTA_ALPHA = 0.08;

export function atualizarPerfilRota(
  estadoAnterior: PerfilRotaEstado | null,
  novoValorM: number
): PerfilRotaEstado {
  if (!estadoAnterior || estadoAnterior.nAmostras === 0) {
    return { nAmostras: 1, mediaM: novoValorM, varianciaM2: 0 };
  }
  const delta = novoValorM - estadoAnterior.mediaM;
  const media = estadoAnterior.mediaM + PERFIL_ROTA_ALPHA * delta;
  const variancia =
    (1 - PERFIL_ROTA_ALPHA) * (estadoAnterior.varianciaM2 + PERFIL_ROTA_ALPHA * delta * delta);
  return {
    // Capado só pra gate de confianca (ver PERFIL_ROTA_MIN_AMOSTRAS em
    // detectores.ts) -- nao entra na formula da media/variancia.
    nAmostras: Math.min(estadoAnterior.nAmostras + 1, 1000),
    mediaM: media,
    varianciaM2: Math.max(0, variancia),
  };
}

export function desvioPadraoDe(estado: PerfilRotaEstado): number {
  return Math.sqrt(Math.max(0, estado.varianciaM2));
}
