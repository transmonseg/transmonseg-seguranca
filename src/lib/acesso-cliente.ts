import { createAdminClient } from "@/lib/supabase/admin";
import { createClient } from "@/lib/supabase/server";

// Isolamento por cliente (06/10): operadores.cliente_id preenchido = a conta
// só enxerga aquela frota (ex.: login da Nutry Max não vê a Rio Quality).
// cliente_id null = central, vê todas. Sem login ou sem registro em
// operadores = não vê nada (fail-closed).

export type AcessoCliente =
  | { tipo: "todos" }
  | { tipo: "um"; clienteId: string }
  | { tipo: "nenhum" };

export async function acessoDoUsuario(): Promise<AcessoCliente> {
  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return { tipo: "nenhum" };
  const { data, error } = await createAdminClient()
    .from("operadores").select("cliente_id").eq("id", user.id).maybeSingle();
  if (error || !data) return { tipo: "nenhum" };
  return data.cliente_id ? { tipo: "um", clienteId: data.cliente_id as string } : { tipo: "todos" };
}

export function podeVerCliente(acesso: AcessoCliente, clienteId: string | null | undefined): boolean {
  if (acesso.tipo === "todos") return true;
  if (acesso.tipo === "nenhum" || !clienteId) return false;
  return acesso.clienteId === clienteId;
}

export function filtrarPorAcesso<T extends { id: string }>(acesso: AcessoCliente, clientes: T[]): T[] {
  return clientes.filter((c) => podeVerCliente(acesso, c.id));
}

/** Pode ver o veículo do cv? Central sempre; conta de um cliente só se o cv é da frota dela. */
export async function podeVerCv(acesso: AcessoCliente, cv: string | null): Promise<boolean> {
  if (acesso.tipo === "todos") return true;
  if (acesso.tipo === "nenhum" || !cv) return false;
  const { data } = await createAdminClient()
    .from("veiculos").select("id").eq("cliente_id", acesso.clienteId).eq("cv", cv).limit(1);
  return (data ?? []).length > 0;
}

/** Pode ver o cliente pelo cod_user_unitrac? */
export async function podeVerCod(acesso: AcessoCliente, cod: string | null): Promise<boolean> {
  if (acesso.tipo === "todos") return true;
  if (acesso.tipo === "nenhum" || !cod) return false;
  const { data } = await createAdminClient()
    .from("clientes").select("id").eq("cod_user_unitrac", cod).maybeSingle();
  return !!data && data.id === acesso.clienteId;
}

/** Filtra uma lista de cvs pros que a conta pode ver (central: todos). */
export async function cvsPermitidos(acesso: AcessoCliente, cvs: string[]): Promise<string[]> {
  if (acesso.tipo === "todos") return cvs;
  if (acesso.tipo === "nenhum" || cvs.length === 0) return [];
  const { data } = await createAdminClient()
    .from("veiculos").select("cv").eq("cliente_id", acesso.clienteId).in("cv", cvs);
  const ok = new Set((data ?? []).map((v) => v.cv as string));
  return cvs.filter((cv) => ok.has(cv));
}
