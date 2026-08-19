"use server";

import { revalidatePath } from "next/cache";
import { createClient } from "@/lib/supabase/server";
import { createAdminClient } from "@/lib/supabase/admin";
import { registrarCasosDesvioRevisao } from "@/lib/casos-desvio-revisao";
import { IDADE_MINIMA_ACAO_MASSA_MIN } from "@/lib/detectores";

export type ResultadoAcao = { ok?: boolean; erro?: string; ignoradosRecentes?: number };

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
// motivo_falso_positivo distingue "o detector errou" de "a marcacao/dado de
// entrada enganou o detector" -- achado real via audio do WhatsApp (25/07,
// ver docs/superpowers/specs/2026-08-09-motivo-falso-positivo-design.md).
// Coluna PROPRIA (nao dentro de contexto): STRIP_PESADO zera contexto no
// mesmo update, guardar o motivo la o apagaria na mesma escrita.
type MotivoFalsoPositivo =
  | "detector_errado" | "dado_entrada_errado" // legado, so' leitura -- ver spec 2026-08-18
  | "NAO_FOI_AO_CLIENTE" | "NAO_SAIU_DA_BASE" | "DESATUALIZADO" | "MUDOU_DE_ROTA";

async function marcarFalsoPositivoComMotivo(
  id: string,
  motivo: MotivoFalsoPositivo
): Promise<ResultadoAcao> {
  const admin = createAdminClient();
  await registrarCasosDesvioRevisao(admin, [id], "falso_positivo", "falso_individual", motivo);
  return atualizar(id, {
    status: "falso_positivo",
    resolvido_em: new Date().toISOString(),
    origem_acao: "falso_individual",
    motivo_falso_positivo: motivo,
    ...STRIP_PESADO,
  });
}

export async function marcarFalsoComCategoria(
  id: string,
  categoria: "NAO_FOI_AO_CLIENTE" | "NAO_SAIU_DA_BASE" | "DESATUALIZADO" | "MUDOU_DE_ROTA"
): Promise<ResultadoAcao> {
  return marcarFalsoPositivoComMotivo(id, categoria);
}

// Resolve vários alertas de uma vez (botão "Resolver todos" do painel).
export async function resolverVarios(
  ids: string[]
): Promise<ResultadoAcao & { resolvidos?: number }> {
  const opId = await operadorAtual();
  if (!opId) return { erro: "Sessao expirada." };
  if (ids.length === 0) return { ok: true, resolvidos: 0, ignoradosRecentes: 0 };
  const admin = createAdminClient();
  // Guard de idade minima (achado real 08/08, caso TTH-3C94): acao em
  // massa nunca fecha alerta recem-nascido sem revisao individual -- ver
  // docs/superpowers/specs/2026-08-09-idade-minima-acao-massa-design.md.
  // Servidor e' a AUTORIDADE (nunca confia no cliente ja ter filtrado).
  // `corte` e' computado UMA vez e reaplicado tanto no select quanto no
  // update final -- protege contra TOCTOU real: o motor (route.ts, escalada
  // atencao->critico) reescreve `desde` de um alerta existente preservando o
  // id, entao um alerta elegivel no momento do select pode escalar e ficar
  // jovem de novo antes do update rodar (registrarCasosDesvioRevisao faz
  // round-trips sequenciais no meio do caminho). Se isso acontecer, o WHERE
  // do update deixa de bater e o alerta simplesmente nao fecha -- o Postgres
  // avalia a condicao no momento real do update, sem logica extra em JS.
  const corte = new Date(Date.now() - IDADE_MINIMA_ACAO_MASSA_MIN * 60_000).toISOString();
  const { data: linhas, error: erroSelect } = await admin
    .from("alertas")
    .select("id")
    .in("id", ids)
    .lte("desde", corte);
  if (erroSelect) return { erro: "Não foi possível verificar a idade dos alertas." };
  const elegiveis = (linhas ?? []).map((l) => l.id);
  const ignoradosRecentes = ids.length - elegiveis.length;
  if (elegiveis.length === 0) return { ok: true, resolvidos: 0, ignoradosRecentes };
  // Achado 01/08: este botao gravava exatamente igual ao "Resolver"
  // individual -- inclusive alimentando casos_desvio_revisao como se fosse
  // veredito caso a caso. Nao era possivel, olhando o dado, saber se um
  // 'resolvido' foi julgamento ou clique pra desentupir a tela. Agora
  // carrega origem_acao='resolver_massa' nos DOIS lugares, e quem le pra
  // medir/calibrar filtra por origem individual.
  await registrarCasosDesvioRevisao(admin, elegiveis, "resolvido", "resolver_massa");
  // Update final reaplica `.lte("desde", corte)` (mesmo corte, nao
  // recalculado) e restringe a status ainda abertos -- e' a autoridade
  // atomica: `elegiveis` acima e' so pra decidir o que tentar e alimentar
  // registrarCasosDesvioRevisao, quem realmente fechou vem de `.select("id")`
  // encadeado no proprio update.
  const { data: atualizados, error } = await admin
    .from("alertas")
    .update({
      status: "resolvido",
      resolvido_em: new Date().toISOString(),
      operador_id: opId,
      origem_acao: "resolver_massa",
      ...STRIP_PESADO,
    })
    .in("id", elegiveis)
    .lte("desde", corte)
    .in("status", ["ativo", "reconhecido"])
    .select("id");
  if (error) return { erro: "Não foi possível resolver os alertas." };
  const resolvidos = atualizados?.length ?? 0;
  revalidatePath("/");
  return { ok: true, resolvidos, ignoradosRecentes: ids.length - resolvidos };
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
  if (ids.length === 0) return { ok: true, limpos: 0, ignoradosRecentes: 0 };
  const admin = createAdminClient();
  // Mesmo guard de idade minima de resolverVarios acima -- ver
  // docs/superpowers/specs/2026-08-09-idade-minima-acao-massa-design.md.
  // Sem select previo (nao chama registrarCasosDesvioRevisao, nao precisa
  // capturar contexto antes do STRIP_PESADO) -- uma UNICA query atomica:
  // `.lte("desde", corte)` decide o que fecha no proprio momento do update
  // (sem gap de tempo, sem risco de truncamento do select afetar a decisao),
  // e `.select("id")` encadeado devolve quem realmente foi afetado.
  const corte = new Date(Date.now() - IDADE_MINIMA_ACAO_MASSA_MIN * 60_000).toISOString();
  const { data: atualizados, error } = await admin
    .from("alertas")
    .update({
      status: "limpo",
      resolvido_em: new Date().toISOString(),
      operador_id: opId,
      origem_acao: "limpar_massa",
      ...STRIP_PESADO,
    })
    .in("id", ids)
    .lte("desde", corte)
    .in("status", ["ativo", "reconhecido"])
    .select("id");
  if (error) return { erro: "Não foi possível limpar os alertas." };
  const limpos = atualizados?.length ?? 0;
  revalidatePath("/");
  return { ok: true, limpos, ignoradosRecentes: ids.length - limpos };
}
