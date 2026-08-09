"use server";

import { createAdminClient } from "@/lib/supabase/admin";
import { resolverDestinoEscala } from "@/lib/escala-geocode";
import { geocodificarGoogle, geocodificarNominatim } from "@/lib/romaneio-geocode";

export type Apelido = { id: string; apelidoTexto: string; cidadeDestino: string };

export async function listarApelidos(): Promise<Apelido[]> {
  const admin = createAdminClient();
  const { data } = await admin
    .from("escala_apelidos")
    .select("id, apelido_texto, cidade_destino")
    .order("apelido_texto");
  return (data ?? []).map((a) => ({ id: a.id, apelidoTexto: a.apelido_texto, cidadeDestino: a.cidade_destino }));
}

export async function adicionarApelido(apelidoTexto: string, cidadeDestino: string): Promise<{ ok: boolean; erro?: string; reResolvidas?: number }> {
  const texto = apelidoTexto.trim().toUpperCase();
  const cidade = cidadeDestino.trim();
  if (!texto || !cidade) return { ok: false, erro: "Preenche os dois campos." };
  const admin = createAdminClient();
  const { error } = await admin.from("escala_apelidos").upsert(
    { apelido_texto: texto, cidade_destino: cidade, atualizado_em: new Date().toISOString() },
    { onConflict: "apelido_texto" }
  );
  if (error) return { ok: false, erro: error.message };

  // Re-resolve linhas ja gravadas como nao_resolvido pra este destino --
  // achado da revisao final: sem isso, cadastrar o apelido nao tinha
  // NENHUM efeito ate o proximo upload, e o texto da tela sugeria o
  // contrario. Reaproveita resolverDestinoEscala inteiro (mesma checagem
  // de bounding-box do RJ) em vez de geocodificar direto.
  const deps = {
    geocodificarGoogleDep: geocodificarGoogle,
    geocodificarNominatimDep: geocodificarNominatim,
    buscarApelidoDep: async () => cidade,
  };
  const resolucao = await resolverDestinoEscala(texto, deps);
  let reResolvidas = 0;
  if (resolucao.via !== "nao_resolvido") {
    const { data: atualizadas } = await admin
      .from("escala_pontos")
      .update({
        lat: resolucao.lat,
        lng: resolucao.lng,
        raio_m: resolucao.raioM,
        resolvido_via: "apelido",
      })
      .eq("destino_normalizado", texto)
      .eq("resolvido_via", "nao_resolvido")
      .select("id");
    reResolvidas = atualizadas?.length ?? 0;
  }

  return { ok: true, reResolvidas };
}

export async function removerApelido(id: string): Promise<{ ok: boolean; erro?: string }> {
  const admin = createAdminClient();
  const { error } = await admin.from("escala_apelidos").delete().eq("id", id);
  if (error) return { ok: false, erro: error.message };
  return { ok: true };
}
