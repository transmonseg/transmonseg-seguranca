// Texto do relatorio diario de desvio (22h, DM pro usuario -- nunca poste
// automatico no grupo "DESVIO DE ROTA", pedido explicito do usuario 10/09).
// Funcao pura: recebe os dados ja apurados (banco + git), so monta o texto.

export type CommitDoDia = { hash: string; mensagem: string };

export type DadosRelatorioDiario = {
  dia: string; // YYYY-MM-DD (America/Sao_Paulo)
  corretos: number;
  falsos: number;
  totalDisparosBrutos: number;
  commits: CommitDoDia[];
};

export function montarTextoRelatorioDiario(dados: DadosRelatorioDiario): string {
  const { dia, corretos, falsos, totalDisparosBrutos, commits } = dados;
  const totalIndividual = corretos + falsos;
  const linhasTaxa =
    totalIndividual === 0
      ? "Sem revisão individual (caso a caso) hoje."
      : `✅ Corretos: ${corretos}\n❌ Falsos: ${falsos}\nTaxa de acerto: ${Math.round((corretos / totalIndividual) * 100)}%`;

  const linhasCommits =
    commits.length === 0
      ? "Nenhuma mudança no motor de desvio hoje."
      : commits.map((c) => `- ${c.mensagem}`).join("\n");

  return [
    `📋 Relatório desvio — Nutry Max — ${dia}`,
    "",
    "Revisão individual (caso a caso):",
    linhasTaxa,
    "",
    `Disparos brutos no dia (afastando_geral): ${totalDisparosBrutos}`,
    "",
    "Mudanças no motor de desvio hoje:",
    linhasCommits,
  ].join("\n");
}
