// Tela Veiculos (05/10, pedido do usuario: "um lugar que coloco as placas que
// nao fazem mais parte"): a ultima transmissao ajuda a decidir quem saiu da
// frota. Em 05/10 a Nutry Max tinha 173 cadastrados e so' 111 transmitindo.
export type SituacaoTransmissao = "ok" | "parado" | "sem_sinal" | "nunca";

export const ROTULO_SITUACAO: Record<SituacaoTransmissao, string> = {
  ok: "Transmitindo",
  parado: "Sem transmitir há 3–30 dias",
  sem_sinal: "Sem transmitir há +30 dias",
  nunca: "Nunca transmitiu",
};

const DIA_MS = 24 * 3_600_000;

export function situacaoTransmissao(datagps: string | null, agora: Date): SituacaoTransmissao {
  if (!datagps) return "nunca";
  const t = new Date(datagps).getTime();
  if (!Number.isFinite(t)) return "nunca";
  const dias = (agora.getTime() - t) / DIA_MS;
  if (dias <= 3) return "ok";
  if (dias <= 30) return "parado";
  return "sem_sinal";
}
