"use server";

import { revalidatePath } from "next/cache";
import { createClient } from "@/lib/supabase/server";
import { createAdminClient } from "@/lib/supabase/admin";
import { registrarCasosDesvioRevisao } from "@/lib/casos-desvio-revisao";

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
  const admin = createAdminClient();
  await registrarCasosDesvioRevisao(admin, [id], "resolvido", "resolver_individual");
  return atualizar(id, {
    status: "resolvido",
    resolvido_em: new Date().toISOString(),
    origem_acao: "resolver_individual",
    ...STRIP_PESADO,
  });
}

// Operador classificou como engano: encerra e SILENCIA o tipo por 2h no motor.
export async function marcarFalsoPositivo(id: string): Promise<ResultadoAcao> {
  const admin = createAdminClient();
  await registrarCasosDesvioRevisao(admin, [id], "falso_positivo", "falso_individual");
  return atualizar(id, {
    status: "falso_positivo",
    resolvido_em: new Date().toISOString(),
    origem_acao: "falso_individual",
    ...STRIP_PESADO,
  });
}

// Resolve vários alertas de uma vez (botão "Resolver todos" do painel).
export async function resolverVarios(
  ids: string[]
): Promise<ResultadoAcao & { resolvidos?: number }> {
  const opId = await operadorAtual();
  if (!opId) return { erro: "Sessao expirada." };
  if (ids.length === 0) return { ok: true, resolvidos: 0 };
  const admin = createAdminClient();
  // Achado 01/08: este botao gravava exatamente igual ao "Resolver"
  // individual -- inclusive alimentando casos_desvio_revisao como se fosse
  // veredito caso a caso. Nao era possivel, olhando o dado, saber se um
  // 'resolvido' foi julgamento ou clique pra desentupir a tela. Agora
  // carrega origem_acao='resolver_massa' nos DOIS lugares, e quem le pra
  // medir/calibrar filtra por origem individual.
  await registrarCasosDesvioRevisao(admin, ids, "resolvido", "resolver_massa");
  const { error } = await admin
    .from("alertas")
    .update({
      status: "resolvido",
      resolvido_em: new Date().toISOString(),
      operador_id: opId,
      origem_acao: "resolver_massa",
      ...STRIP_PESADO,
    })
    .in("id", ids);
  if (error) return { erro: "Não foi possível resolver os alertas." };
  revalidatePath("/");
  return { ok: true, resolvidos: ids.length };
}

// Operador so quer tirar da tela, sem afirmar nada sobre o caso (nem real,
// nem falso) -- achado real 27-28/07: "Resolver todos" clicado em massa
// nao e' revisao caso a caso, mas contava como se fosse (contaminava
// calibracao e qualquer leitura de "quantos confirmados"). Este botao e'
// pro caso comum (limpar a tela no fim do turno), sem fingir confirmacao.
// Por isso NAO chama registrarCasosDesvioRevisao (nao e' veredito humano,
// nao deve alimentar casos_desvio_revisao nem taxaGlobal/segmento algum).
export async function limparVarios(
  ids: string[]
): Promise<ResultadoAcao & { limpos?: number }> {
  const opId = await operadorAtual();
  if (!opId) return { erro: "Sessao expirada." };
  if (ids.length === 0) return { ok: true, limpos: 0 };
  const admin = createAdminClient();
  const { error } = await admin
    .from("alertas")
    .update({
      status: "limpo",
      resolvido_em: new Date().toISOString(),
      operador_id: opId,
      origem_acao: "limpar_massa",
      ...STRIP_PESADO,
    })
    .in("id", ids);
  if (error) return { erro: "Não foi possível limpar os alertas." };
  revalidatePath("/");
  return { ok: true, limpos: ids.length };
}
