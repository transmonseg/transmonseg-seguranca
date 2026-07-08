"use server";

import { revalidatePath } from "next/cache";
import { createClient } from "@/lib/supabase/server";
import { createAdminClient } from "@/lib/supabase/admin";

export type CandidatoEntrega = {
  id: string;
  veiculo_id: string;
  alvo_codigo: number;
  ponto_codigo: number | null;
  lat: number;
  lng: number;
  distancia_m: number;
  parado_min: number;
  detectado_em: string;
  placa: string;
};

// Lista de candidatos por proximidade (compensa bug de perimetro do
// Unitrac, ver lib/entrega-proximidade.ts). Le via admin (RLS bloqueia
// leitura direta, mesmo padrao de /api/alertas), so exige sessao valida.
export async function listarCandidatosEntrega(clienteId: string): Promise<CandidatoEntrega[]> {
  const auth = await createClient();
  const { data: { user } } = await auth.auth.getUser();
  if (!user) return [];

  const admin = createAdminClient();
  const { data: candidatos } = await admin
    .from("entregas_confirmacao_manual")
    .select("id, veiculo_id, alvo_codigo, ponto_codigo, lat, lng, distancia_m, parado_min, detectado_em")
    .eq("cliente_id", clienteId)
    .eq("status", "pendente")
    .order("detectado_em", { ascending: false });

  if (!candidatos || candidatos.length === 0) return [];

  const veiculoIds = [...new Set(candidatos.map((c) => c.veiculo_id))];
  const { data: veiculosRaw } = await admin
    .from("veiculos")
    .select("id, placa")
    .in("id", veiculoIds);
  const placaPorVeiculo = new Map((veiculosRaw ?? []).map((v) => [v.id, v.placa]));

  return candidatos.map((c) => ({
    id: c.id,
    veiculo_id: c.veiculo_id,
    alvo_codigo: c.alvo_codigo,
    ponto_codigo: c.ponto_codigo,
    lat: c.lat,
    lng: c.lng,
    distancia_m: c.distancia_m,
    parado_min: c.parado_min,
    detectado_em: c.detectado_em,
    placa: placaPorVeiculo.get(c.veiculo_id) ?? "?????",
  }));
}

// Garante o registro do operador logado (espelho de auth.users em
// operadores, ver acoes-alertas.ts) — operador_id tem FK pra essa tabela.
async function operadorAtual(): Promise<string | null> {
  const auth = await createClient();
  const { data: { user } } = await auth.auth.getUser();
  if (!user) return null;
  const admin = createAdminClient();
  const nome = (user.user_metadata?.nome as string | undefined) ?? user.email ?? "operador";
  await admin
    .from("operadores")
    .upsert({ id: user.id, nome, papel: "operador" }, { onConflict: "id", ignoreDuplicates: true });
  return user.id;
}

async function resolverCandidato(id: string, status: "confirmado" | "rejeitado"): Promise<{ ok: boolean }> {
  const opId = await operadorAtual();
  if (!opId) return { ok: false };

  const admin = createAdminClient();
  const { error } = await admin
    .from("entregas_confirmacao_manual")
    .update({ status, resolvido_em: new Date().toISOString(), operador_id: opId })
    .eq("id", id)
    .eq("status", "pendente");
  if (error) return { ok: false };
  revalidatePath("/");
  return { ok: true };
}

export async function confirmarEntrega(id: string): Promise<{ ok: boolean }> {
  return resolverCandidato(id, "confirmado");
}

export async function rejeitarEntrega(id: string): Promise<{ ok: boolean }> {
  return resolverCandidato(id, "rejeitado");
}
