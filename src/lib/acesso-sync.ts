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

export type NovaConta = { email: string; senha: string; cliente: string | null };

/** Conta nova vinda do convite do KPI (06/10: cadastro aberto fechado). So'
 *  cria com cliente definido -- conta ambigua nunca nasce central. */
export function validarNovaConta(b: unknown): NovaConta | { erro: string } {
  if (!b || typeof b !== "object") return { erro: "corpo invalido" };
  const o = b as Record<string, unknown>;
  const email = String(o.email ?? "").trim().toLowerCase();
  const senha = String(o.senha ?? "");
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) return { erro: "email invalido" };
  if (senha.length < 6) return { erro: "senha curta" };
  const cliente = clienteDaConta({ email, admin: o.admin === true, empresas: Array.isArray(o.empresas) ? o.empresas.map(String) : [] });
  if (cliente === undefined) return { erro: "conta sem cliente do monitoramento" };
  return { email, senha, cliente };
}
