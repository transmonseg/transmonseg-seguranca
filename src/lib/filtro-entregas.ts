// Filtro de pontos de entrega no mapa (06/10, pedido do usuário: "ver só os
// pendentes, só os entregues"). Entregue = realizado ou esteve no local
// (situacao != 0, mesmo critério de PontoEntrega.feito).
export type FiltroEntregas = "todas" | "pendentes" | "entregues";

export function filtrarEntregas<T extends { feito: boolean }>(pontos: T[], filtro: FiltroEntregas): T[] {
  if (filtro === "pendentes") return pontos.filter((p) => !p.feito);
  if (filtro === "entregues") return pontos.filter((p) => p.feito);
  return pontos;
}
