// Lógica pura do aviso de desvio no topo do mapa (spec
// docs/superpowers/specs/2026-09-26-topo-mapa-aviso-desvio-design.md).
// Sem React: o componente AvisoDesvioTopo só renderiza e controla o timer.

export const AVISO_DESVIO_MS = 8000;

export type ModoAviso = "pilula" | "aviso" | "lista";

export type EventoAviso =
  | { tipo: "novos"; quantidade: number }
  | { tipo: "timeout" }
  | { tipo: "clique" }
  | { tipo: "fechar" };

export function proximoModo(atual: ModoAviso, evento: EventoAviso, n: number): ModoAviso {
  if (n === 0) return "pilula";
  switch (evento.tipo) {
    case "novos":
      if (evento.quantidade === 0 || atual === "lista") return atual;
      return "aviso";
    case "timeout":
      return atual === "aviso" ? "pilula" : atual;
    case "clique":
      return atual === "lista" ? "pilula" : "lista";
    case "fechar":
      return "pilula";
  }
}

export function rotuloPilula(n: number): string | null {
  return n > 0 ? `Ver mais desvios (${n})` : null;
}

const MAX_PLACAS_NO_AVISO = 3;

export function textoAviso(novos: { placa: string; tipo: string }[], nomeTipo: (tipo: string) => string): string {
  if (novos.length === 1) {
    const [a] = novos;
    return a.tipo === "desvio" ? `${a.placa} em desvio agora` : `${a.placa} · ${nomeTipo(a.tipo)}`;
  }
  const placas = novos.slice(0, MAX_PLACAS_NO_AVISO).map(a => a.placa).join(", ");
  const resto = novos.length - MAX_PLACAS_NO_AVISO;
  return `${novos.length} desvios novos: ${placas}${resto > 0 ? ` e mais ${resto}` : ""}`;
}

// O "novo" vem do LOTE do poll (ids que não existiam no poll anterior), nunca
// de um diff da lista filtrada -- senão trocar TODOS -> SELECIONADOS faria
// alertas antigos "aparecerem" e disparar o aviso.
export function novosDoLoteNoEscopo<A extends { id: string }>(loteIds: readonly string[], escopo: readonly A[]): A[] {
  if (loteIds.length === 0) return [];
  const lote = new Set(loteIds);
  return escopo.filter(a => lote.has(a.id));
}
