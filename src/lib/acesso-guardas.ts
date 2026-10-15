import { createAdminClient } from "@/lib/supabase/admin";
import type { AcessoCliente } from "@/lib/acesso-cliente";

// Guardas de autorização das ações/rotas de operador (auditoria 15/10, OP-09 e
// OP-10): antes, qualquer sessão logada -- inclusive conta de cliente -- podia
// resolver alerta de outro cliente, acionar sirene em qualquer cv e apagar o
// romaneio do dia de todos. Central (cliente_id null) continua vendo tudo.

export function ehCentral(acesso: AcessoCliente): boolean {
  return acesso.tipo === "todos";
}

/** Ids de alerta (alertas/alertas_romaneio) que a conta pode alterar. */
export async function idsAlertaPermitidos(
  acesso: AcessoCliente,
  tabela: "alertas" | "alertas_romaneio",
  ids: string[],
): Promise<string[]> {
  if (acesso.tipo === "todos") return ids;
  if (acesso.tipo === "nenhum" || ids.length === 0) return [];
  const { data } = await createAdminClient().from(tabela).select("id")
    .eq("cliente_id", acesso.clienteId).in("id", ids);
  return (data ?? []).map((r) => r.id as string);
}

/** Veículos da conta. null = central (sem filtro). */
export async function idsVeiculosDoCliente(acesso: AcessoCliente): Promise<string[] | null> {
  if (acesso.tipo === "todos") return null;
  if (acesso.tipo === "nenhum") return [];
  const { data } = await createAdminClient().from("veiculos").select("id").eq("cliente_id", acesso.clienteId);
  return (data ?? []).map((v) => v.id as string);
}
