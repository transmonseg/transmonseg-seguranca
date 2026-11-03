// Texto do relatorio diario de desvio (22h, DM pro usuario -- nunca poste
// automatico no grupo "DESVIO DE ROTA", pedido explicito do usuario 10/09).
//
// DSV-02 (auditoria 03/11): ate aqui o relatorio contava a Central Unitrac
// (`alertas` + desvio_disparo_log, so' Nutry) e o dono recebia numeros de um
// motor que nao e' o da tela. Agora le a Central Romaneio (alertas_romaneio,
// sem os tipos sombra) e a trilha alertas_romaneio_disparos (migration 092),
// um bloco por cliente com romaneio (Nutry Max e Rio Quality).
// Funcoes puras: o script (scripts/relatorio-diario-desvio.mjs) so' roda as
// consultas abaixo e passa as linhas.

export type CommitDoDia = { hash: string; mensagem: string };

export type RelatorioCliente = {
  cliente: string;
  alertas: number;
  porTipo: Record<string, number>;
  falsoPositivo: number;
  resolvido: number;
  /** Carros com pelo menos 1 alerta de desvio no dia. */
  veiculos?: number;
  /** Linhas de alertas_romaneio_disparos (ciclos com desvio). */
  disparos?: number;
  /** Disparos que abriram ou reabriram card (novo_alerta + novo_episodio). */
  episodios?: number;
};

// $1 = inicio do dia SP (timestamptz), $2 = fim. Uma linha por cliente/tipo/status.
export const SQL_RELATORIO_ALERTAS_ROMANEIO = `
  SELECT a.cliente_id, a.tipo, a.status, count(*)::text AS n, max(v.veiculos)::text AS veiculos_desvio
    FROM alertas_romaneio a
    LEFT JOIN (SELECT cliente_id, count(DISTINCT veiculo_id) AS veiculos
                 FROM alertas_romaneio
                WHERE tipo = 'desvio' AND sombra = false AND desde >= $1 AND desde < $2
                GROUP BY 1) v ON v.cliente_id = a.cliente_id
   WHERE a.sombra = false
     AND a.desde >= $1 AND a.desde < $2
   GROUP BY 1, 2, 3`;

// Mesma janela. Episodio = disparo que criou ou reabriu o card.
export const SQL_RELATORIO_DISPAROS_ROMANEIO = `
  SELECT cliente_id,
         count(*)::text AS disparos,
         count(*) FILTER (WHERE contexto->>'decisao' IN ('novo_alerta', 'novo_episodio'))::text AS episodios
    FROM alertas_romaneio_disparos
   WHERE tipo = 'desvio' AND criado_em >= $1 AND criado_em < $2
   GROUP BY 1`;

export type LinhaAlertasRelatorio = { cliente_id: string; tipo: string; status: string; n: string | number; veiculos_desvio?: string | number | null };
export type LinhaDisparosRelatorio = { cliente_id: string; disparos: string | number; episodios: string | number };

export function agruparRelatorioPorCliente(
  clientes: { id: string; nome: string }[],
  alertas: LinhaAlertasRelatorio[],
  disparos: LinhaDisparosRelatorio[],
): RelatorioCliente[] {
  return clientes.map((c) => {
    const r: RelatorioCliente = { cliente: c.nome, alertas: 0, porTipo: {}, falsoPositivo: 0, resolvido: 0, veiculos: 0, disparos: 0, episodios: 0 };
    for (const l of alertas.filter((x) => x.cliente_id === c.id)) {
      const n = Number(l.n) || 0;
      r.alertas += n;
      r.porTipo[l.tipo] = (r.porTipo[l.tipo] ?? 0) + n;
      if (l.status === "falso_positivo") r.falsoPositivo += n;
      if (l.status === "resolvido") r.resolvido += n;
      r.veiculos = Math.max(r.veiculos ?? 0, Number(l.veiculos_desvio) || 0);
    }
    const d = disparos.find((x) => x.cliente_id === c.id);
    if (d) {
      r.disparos = Number(d.disparos) || 0;
      r.episodios = Number(d.episodios) || 0;
    }
    return r;
  });
}

export function montarTextoRelatorioDiario(
  porCliente: RelatorioCliente[],
  extras: { dia?: string; commits?: CommitDoDia[] } = {},
): string {
  const blocos = porCliente.map((c) => {
    const tipos = Object.entries(c.porTipo).sort((a, b) => b[1] - a[1]).map(([t, n]) => `${t} ${n}`).join(", ");
    return [
      `*${c.cliente}*`,
      `Alertas: ${c.alertas}${tipos ? ` (${tipos})` : ""}`,
      ...(c.veiculos != null ? [`Carros com desvio: ${c.veiculos}`] : []),
      ...(c.episodios != null ? [`Episódios de desvio: ${c.episodios}`] : []),
      ...(c.disparos != null ? [`Disparos de desvio: ${c.disparos}`] : []),
      `Falso positivo: ${c.falsoPositivo} · Resolvidos: ${c.resolvido}`,
    ].join("\n");
  });
  const commits = extras.commits ?? [];
  const linhasCommits =
    commits.length === 0 ? "Nenhuma mudança no motor de desvio hoje." : commits.map((c) => `- ${c.mensagem}`).join("\n");
  return [
    `📋 Relatório desvio — Central Romaneio${extras.dia ? ` — ${extras.dia}` : ""}`,
    "",
    blocos.join("\n\n"),
    "",
    "Mudanças no motor de desvio hoje:",
    linhasCommits,
  ].join("\n");
}
