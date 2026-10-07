// Logins separados por cliente (06/10): regra de qual cliente cada conta do KPI
// enxerga no monitoramento. Ver api/acessos/sincronizar.
export type Conta = { email: string; admin: boolean; empresas: string[] };
const CLIENTE_POR_EMPRESA: Record<string, string> = { nutrimax: "Nutry Max", rioquality: "Rio Quality" };

/** null = vê todas; string = nome do cliente; undefined = não mexe. */
export function clienteDaConta(c: Conta): string | null | undefined {
  if (c.admin) return null;
  const doMonitoramento = c.empresas.filter((e) => CLIENTE_POR_EMPRESA[e]);
  if (doMonitoramento.length === 1) return CLIENTE_POR_EMPRESA[doMonitoramento[0]];
  return undefined;
}
