"use server";

import { revalidatePath } from "next/cache";
import { createClient } from "@/lib/supabase/server";
import { createAdminClient } from "@/lib/supabase/admin";

export type ResultadoAcao = { ok?: boolean; erro?: string };

// Garante o registro do operador logado (espelho de auth.users em operadores)
// e devolve o id. Defensivo para contas criadas antes do espelho existir.
async function operadorAtual(): Promise<string | null> {
  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return null;
  const admin = createAdminClient();
  const nome = (user.user_metadata?.nome as string | undefined) ?? user.email ?? "operador";
  await admin
    .from("operadores")
    .upsert({ id: user.id, nome, papel: "operador" }, { onConflict: "id", ignoreDuplicates: true });
  return user.id;
}

async function atualizar(id: string, patch: Record<string, unknown>): Promise<ResultadoAcao> {
  const opId = await operadorAtual();
  if (!opId) return { erro: "Sessao expirada." };
  const admin = createAdminClient();
  const { error } = await admin
    .from("alertas")
    .update({ ...patch, operador_id: opId })
    .eq("id", id);
  if (error) return { erro: "Não foi possível atualizar o alerta." };
  revalidatePath("/");
  return { ok: true };
}

// Operador assume o alerta (continua em aberto, mas registrado quem cuida).
export async function reconhecerAlerta(id: string): Promise<ResultadoAcao> {
  return atualizar(id, { status: "reconhecido" });
}

// Campos pesados removidos ao resolver — texto basta para o dashboard histórico.
const STRIP_PESADO = { geom: null, lat: null, lng: null, contexto: {} };

// Operador tratou e encerrou (ligou, confirmou, resolveu).
export async function resolverAlerta(id: string): Promise<ResultadoAcao> {
  return atualizar(id, { status: "resolvido", resolvido_em: new Date().toISOString(), ...STRIP_PESADO });
}

// Operador classificou como engano: encerra e SILENCIA o tipo por 2h no motor.
export async function marcarFalsoPositivo(id: string): Promise<ResultadoAcao> {
  return atualizar(id, { status: "falso_positivo", resolvido_em: new Date().toISOString(), ...STRIP_PESADO });
}

// Resolve vários alertas de uma vez (botão "Resolver todos" do painel).
export async function resolverVarios(
  ids: string[]
): Promise<ResultadoAcao & { resolvidos?: number }> {
  const opId = await operadorAtual();
  if (!opId) return { erro: "Sessao expirada." };
  if (ids.length === 0) return { ok: true, resolvidos: 0 };
  const admin = createAdminClient();
  const { error } = await admin
    .from("alertas")
    .update({ status: "resolvido", resolvido_em: new Date().toISOString(), operador_id: opId, ...STRIP_PESADO })
    .in("id", ids);
  if (error) return { erro: "Não foi possível resolver os alertas." };
  revalidatePath("/");
  return { ok: true, resolvidos: ids.length };
}
