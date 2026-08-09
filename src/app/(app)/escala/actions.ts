"use server";

import { createAdminClient } from "@/lib/supabase/admin";

export type Apelido = { id: string; apelidoTexto: string; cidadeDestino: string };

export async function listarApelidos(): Promise<Apelido[]> {
  const admin = createAdminClient();
  const { data } = await admin
    .from("escala_apelidos")
    .select("id, apelido_texto, cidade_destino")
    .order("apelido_texto");
  return (data ?? []).map((a) => ({ id: a.id, apelidoTexto: a.apelido_texto, cidadeDestino: a.cidade_destino }));
}

export async function adicionarApelido(apelidoTexto: string, cidadeDestino: string): Promise<{ ok: boolean; erro?: string }> {
  const texto = apelidoTexto.trim().toUpperCase();
  const cidade = cidadeDestino.trim();
  if (!texto || !cidade) return { ok: false, erro: "Preenche os dois campos." };
  const admin = createAdminClient();
  const { error } = await admin.from("escala_apelidos").upsert(
    { apelido_texto: texto, cidade_destino: cidade, atualizado_em: new Date().toISOString() },
    { onConflict: "apelido_texto" }
  );
  if (error) return { ok: false, erro: error.message };
  return { ok: true };
}

export async function removerApelido(id: string): Promise<{ ok: boolean; erro?: string }> {
  const admin = createAdminClient();
  const { error } = await admin.from("escala_apelidos").delete().eq("id", id);
  if (error) return { ok: false, erro: error.message };
  return { ok: true };
}
