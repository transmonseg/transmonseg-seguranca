"use server";

import { createAdminClient } from "@/lib/supabase/admin";
import { createClient } from "@/lib/supabase/server";

// Tela Veiculos (05/10): marcar placa que saiu da frota. `ativo = false` tira
// a placa do motor de desvio (que ja' so' le ativo = true) e da contagem da
// Central. Nada e' apagado -- volta com um clique.

export type VeiculoLinha = { id: string; placa: string; grupo: string | null; ativo: boolean; datagps: string | null };
export type ClienteLinha = { id: string; nome: string };

async function exigirLogin(): Promise<boolean> {
  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  return !!user;
}

export async function listarClientes(): Promise<ClienteLinha[]> {
  if (!(await exigirLogin())) return [];
  const { data } = await createAdminClient().from("clientes").select("id, nome").eq("ativo", true).order("nome");
  return (data ?? []) as ClienteLinha[];
}

export async function listarVeiculos(clienteId: string): Promise<VeiculoLinha[]> {
  if (!(await exigirLogin())) return [];
  const admin = createAdminClient();
  const { data: veiculos } = await admin.from("veiculos").select("id, placa, grupo, ativo").eq("cliente_id", clienteId).order("placa");
  const ids = (veiculos ?? []).map((v) => v.id);
  const posicoes = new Map<string, string | null>();
  for (let i = 0; i < ids.length; i += 200) {
    const { data } = await admin.from("posicoes_atuais").select("veiculo_id, datagps").in("veiculo_id", ids.slice(i, i + 200));
    for (const p of data ?? []) posicoes.set(p.veiculo_id, p.datagps);
  }
  return (veiculos ?? []).map((v) => ({ ...v, datagps: posicoes.get(v.id) ?? null })) as VeiculoLinha[];
}

export async function definirAtivo(ids: string[], ativo: boolean): Promise<{ ok: boolean; erro?: string; alterados?: number }> {
  if (!(await exigirLogin())) return { ok: false, erro: "Faça login de novo." };
  if (ids.length === 0) return { ok: true, alterados: 0 };
  const { data, error } = await createAdminClient().from("veiculos").update({ ativo }).in("id", ids).select("id");
  if (error) return { ok: false, erro: error.message };
  return { ok: true, alterados: data?.length ?? 0 };
}
