// Filtro de pontos de entrega no mapa (06/10, pedido do usuário: "ver só os
// pendentes, só os entregues"). Entregue = realizado ou esteve no local
// (situacao != 0, mesmo critério de PontoEntrega.feito).
export type FiltroEntregas = "todas" | "pendentes" | "entregues";

export function filtrarEntregas<T extends { feito: boolean }>(pontos: T[], filtro: FiltroEntregas): T[] {
  if (filtro === "pendentes") return pontos.filter((p) => !p.feito);
  if (filtro === "entregues") return pontos.filter((p) => p.feito);
  return pontos;
}

/** Situacao que o mapa mostra (06/10, "por que no Entregues tem ponto amarelo"):
 *  entrega confirmada pelo GPS (feito, mas a Unitrac ainda com situacao 0)
 *  aparece como entregue -- a mesma regra do filtro acima. */
export function situacaoExibida(p: { feito: boolean; situacao: number }): number {
  return p.situacao === 0 && p.feito ? 1 : p.situacao;
}
