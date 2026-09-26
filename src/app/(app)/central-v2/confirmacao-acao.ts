// Confirmacao em dois cliques para acoes criticas (26/09): antes Sirene e
// Bloqueio/Desbloqueio de motor disparavam no primeiro clique no cartao do
// veiculo. Agora o primeiro clique so arma a confirmacao por 5 s, valida so
// para a mesma acao e o mesmo veiculo; trocar de veiculo cancela.

export type AcaoCritica = "sirene" | "bloqueio";
export type EstadoConfirmacao = { pendente: AcaoCritica; cv: number | string; ate: number } | null;

export const JANELA_CONFIRMACAO_MS = 5000;

export function pedirConfirmacao(acao: AcaoCritica, cv: number | string, agora: number): EstadoConfirmacao {
  return { pendente: acao, cv, ate: agora + JANELA_CONFIRMACAO_MS };
}

export function podeExecutar(estado: EstadoConfirmacao, acao: AcaoCritica, cv: number | string, agora: number): boolean {
  return !!estado && estado.pendente === acao && estado.cv === cv && agora <= estado.ate;
}

export function aoTrocarVeiculo(estado: EstadoConfirmacao, cvNovo: number | string | null): EstadoConfirmacao {
  if (!estado) return null;
  return cvNovo !== estado.cv ? null : estado;
}
