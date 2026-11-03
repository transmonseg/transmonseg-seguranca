// 03/11/2026: reenviar o romaneio depois de uma troca de veiculo recriava as
// NFs na placa ORIGINAL do documento. A chave unica do upsert inclui a placa,
// e a troca (trocar-veiculo) muda a placa da linha ja gravada -- entao a linha
// do reenvio nao batia em conflito e entrava de novo. Resultado real: carga
// 101424 trocada TOS-0G53 -> RQU-2G47 e 101457 RQU-2G47 -> RQU-3F71 ficaram
// com as NFs nas DUAS placas (50 duplicatas).
// Regra: NF da mesma carga que ja existe no dia em OUTRA placa foi movida por
// troca -- o reenvio nao a recria.
export type LinhaExistente = { nf: string; carga_destino_codigo: string | null; placa: string };

export function separarJaMovidasPorTroca<T extends { nf: string; carga_destino_codigo: string | null; placa: string }>(
  novas: T[],
  existentes: LinhaExistente[],
): { inserir: T[]; jaMovidas: number } {
  const placaPorNfCarga = new Map<string, Set<string>>();
  for (const e of existentes) {
    const k = `${e.carga_destino_codigo ?? ""}::${e.nf}`;
    const s = placaPorNfCarga.get(k) ?? new Set<string>();
    s.add(e.placa);
    placaPorNfCarga.set(k, s);
  }
  const inserir: T[] = [];
  let jaMovidas = 0;
  for (const l of novas) {
    const placas = placaPorNfCarga.get(`${l.carga_destino_codigo ?? ""}::${l.nf}`);
    if (placas && !placas.has(l.placa)) { jaMovidas++; continue; }
    inserir.push(l);
  }
  return { inserir, jaMovidas };
}
