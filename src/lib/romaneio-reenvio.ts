// 03/11/2026: reenviar o romaneio depois de uma troca de veiculo recriava as
// NFs na placa ORIGINAL do documento. A chave unica do upsert inclui a placa,
// e a troca (trocar-veiculo) muda a placa da linha ja gravada -- entao a linha
// do reenvio nao batia em conflito e entrava de novo. Resultado real: carga
// 101424 trocada TOS-0G53 -> RQU-2G47 e 101457 RQU-2G47 -> RQU-3F71 ficaram
// com as NFs nas DUAS placas (50 duplicatas).
//
// DSV-06 (auditoria 03/11): a 1a versao pulava QUALQUER NF da mesma carga ja
// gravada em outra placa -- um reenvio CORRIGIDO (carga num carro diferente,
// sem passar por trocar-veiculo) nao movia a NF: o carro novo ficava sem
// destino e o antigo vigiando entregas que nao sao dele. Agora so' pula a NF
// que a troca de veiculo marcou (trocado_em, migration 093). E a NF retirada
// num reenvio deixa de ficar pendente o dia todo: e' marcada removida_em
// (nunca apagada) e os consumidores a ignoram.
export type LinhaExistente = {
  nf: string;
  carga_destino_codigo: string | null;
  placa: string;
  trocado_em?: string | null;
  removida_em?: string | null;
};

type LinhaNova = { nf: string; carga_destino_codigo: string | null; placa: string };

const chaveNfCarga = (l: { nf: string; carga_destino_codigo: string | null }) => `${l.carga_destino_codigo ?? ""}::${l.nf}`;
const chaveLinha = (l: LinhaNova) => `${chaveNfCarga(l)}::${l.placa}`;

export function separarJaMovidasPorTroca<T extends LinhaNova>(
  novas: T[],
  existentes: LinhaExistente[],
): { inserir: T[]; jaMovidas: number } {
  const placasTrocadas = new Map<string, Set<string>>();
  for (const e of existentes) {
    if (!e.trocado_em) continue;
    const k = chaveNfCarga(e);
    const s = placasTrocadas.get(k) ?? new Set<string>();
    s.add(e.placa);
    placasTrocadas.set(k, s);
  }
  const inserir: T[] = [];
  let jaMovidas = 0;
  for (const l of novas) {
    const placas = placasTrocadas.get(chaveNfCarga(l));
    if (placas && !placas.has(l.placa)) { jaMovidas++; continue; }
    inserir.push(l);
  }
  return { inserir, jaMovidas };
}

export type NfDaRota = { nf: string; carga: string | null; placa: string };

/**
 * NFs do dia (mesma origem/modo) que sumiram da versao nova do documento.
 * So' dentro das cargas que vieram no reenvio (lote parcial nao apaga o resto
 * do dia), nunca carga nula (pao: nao da' pra saber o escopo do lote) e nunca
 * linha movida por troca (o documento ainda traz a placa antiga).
 */
export function nfsRemovidas(novas: LinhaNova[], existentesDaOrigem: LinhaExistente[]): NfDaRota[] {
  const cargasNoReenvio = new Set(novas.map((n) => n.carga_destino_codigo).filter((c): c is string => !!c));
  const presentes = new Set(novas.map(chaveLinha));
  return existentesDaOrigem
    .filter((e) => e.carga_destino_codigo && cargasNoReenvio.has(e.carga_destino_codigo))
    .filter((e) => !e.trocado_em && !e.removida_em)
    .filter((e) => !presentes.has(chaveLinha(e)))
    .map((e) => ({ nf: e.nf, carga: e.carga_destino_codigo, placa: e.placa }));
}

/** Linhas marcadas removidas que voltaram no documento (reenvio da versao anterior). */
export function nfsRestauradas(novas: LinhaNova[], existentesDaOrigem: LinhaExistente[]): NfDaRota[] {
  const presentes = new Set(novas.map(chaveLinha));
  return existentesDaOrigem
    .filter((e) => e.removida_em && presentes.has(chaveLinha(e)))
    .map((e) => ({ nf: e.nf, carga: e.carga_destino_codigo, placa: e.placa }));
}
