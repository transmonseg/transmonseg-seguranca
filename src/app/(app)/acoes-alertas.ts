"use server";

import { revalidatePath } from "next/cache";
import { createClient } from "@/lib/supabase/server";
import { createAdminClient } from "@/lib/supabase/admin";
import { registrarCasosDesvioRevisao } from "@/lib/casos-desvio-revisao";
import { IDADE_MINIMA_ACAO_MASSA_MIN } from "@/lib/detectores";
import { invalidarCacheAlertas } from "@/app/api/alertas/route";
import { invalidarCacheAlertasRomaneio } from "@/app/api/alertas-romaneio/route";
import { invalidarCacheMapa } from "@/app/api/mapa/route";

// Achado real 29/08 (grupo WhatsApp: "alerta limpo demora sumir, às vezes
// volta"): as rotas de leitura têm cache manual em memória de 8s
// (CACHE_MS) que revalidatePath NÃO alcança (é cache de PÁGINA do Next,
// não do módulo da rota). Sem isto, uma ação podia continuar servindo o
// alerta já resolvido por até 8s -- e se duas telas pollavam em momentos
// diferentes desse intervalo, uma via resolvido e a outra ainda via o
// alerta antigo, dando a impressão de "sumiu e voltou". /api/mapa tem o
// mesmo problema pra cor do carro no mapa (achado da varredura de sistema).
function invalidarCachesLeitura(tabela: TabelaAlertas) {
  if (tabela === "alertas_romaneio") invalidarCacheAlertasRomaneio();
  else invalidarCacheAlertas();
  invalidarCacheMapa();
}

export type ResultadoAcao = { ok?: boolean; erro?: string; ignoradosRecentes?: number };

// Task 3 fix (revisão 2026-08-22, achado Important): /central-romaneio reusa
// estas mesmas ações, mas tem que escrever em alertas_romaneio -- não em
// alertas. Sem isso, "Correto"/"Falso"/"Resolver todos" nessa tela eram
// no-ops silenciosos (update rodava em alertas com um id que só existe em
// alertas_romaneio, 0 linhas afetadas, sem erro, card reaparecia no poll
// seguinte). Default "alertas" preserva EXATAMENTE o comportamento atual da
// Central -- nenhum call site existente passa este parâmetro.
export type TabelaAlertas = "alertas" | "alertas_romaneio";

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

async function atualizar(id: string, patch: Record<string, unknown>, tabela: TabelaAlertas = "alertas"): Promise<ResultadoAcao> {
  const opId = await operadorAtual();
  if (!opId) return { erro: "Sessao expirada." };
  const admin = createAdminClient();
  const { error } = await admin
    .from(tabela)
    .update({ ...patch, operador_id: opId })
    .eq("id", id);
  if (error) return { erro: "Não foi possível atualizar o alerta." };
  revalidatePath(tabela === "alertas_romaneio" ? "/central-romaneio" : "/");
  invalidarCachesLeitura(tabela);
  return { ok: true };
}

// Operador assume o alerta (continua em aberto, mas registrado quem cuida).
export async function reconhecerAlerta(id: string, tabela: TabelaAlertas = "alertas"): Promise<ResultadoAcao> {
  return atualizar(id, { status: "reconhecido" }, tabela);
}

// Campos pesados removidos ao resolver — texto basta para o dashboard histórico.
// alertas_romaneio (migration 055) não tem coluna `geom` (só alertas tem,
// ver 001_schema_base.sql) -- por isso o strip é por tabela.
const STRIP_PESADO_BASE = { lat: null, lng: null, contexto: {} };
function stripPesado(tabela: TabelaAlertas): Record<string, unknown> {
  return tabela === "alertas_romaneio" ? STRIP_PESADO_BASE : { ...STRIP_PESADO_BASE, geom: null };
}

// Operador tratou e encerrou (ligou, confirmou, resolveu).
export async function resolverAlerta(id: string, tabela: TabelaAlertas = "alertas"): Promise<ResultadoAcao> {
  const admin = createAdminClient();
  // registrarCasosDesvioRevisao alimenta a calibração automática da Central
  // (recalibrar-desvio). O motor do romaneio ainda não tem calibração
  // própria nem passou pela mesma bateria de validação -- por spec
  // (2026-08-22-motor-romaneio-paralelo-design.md linha 88: "ações... escrevem
  // SÓ em alertas_romaneio"), pular de propósito quando a fonte é romaneio.
  if (tabela === "alertas") {
    await registrarCasosDesvioRevisao(admin, [id], "resolvido", "resolver_individual");
  }
  return atualizar(id, {
    status: "resolvido",
    resolvido_em: new Date().toISOString(),
    origem_acao: "resolver_individual",
    ...stripPesado(tabela),
  }, tabela);
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
  motivo: MotivoFalsoPositivo,
  tabela: TabelaAlertas = "alertas",
  // Pedido do time (grupo DESVIO DE ROTA, 26/08): a categoria fixa nem
  // sempre cobre o caso real -- texto livre OPCIONAL do operador, coluna
  // PROPRIA (motivo_falso_positivo_detalhe, ver migration 060) pra nao
  // tocar no enum estruturado que alimenta a calibração automática
  // (registrarCasosDesvioRevisao/recalibrar-desvio continuam recebendo só
  // a categoria, nunca o texto livre).
  detalhe?: string
): Promise<ResultadoAcao> {
  const admin = createAdminClient();
  // Mesmo raciocínio de resolverAlerta acima: só alimenta calibração quando
  // a fonte é a Central de verdade.
  if (tabela === "alertas") {
    await registrarCasosDesvioRevisao(admin, [id], "falso_positivo", "falso_individual", motivo);
  }
  const detalheLimpo = detalhe?.trim();
  return atualizar(id, {
    status: "falso_positivo",
    resolvido_em: new Date().toISOString(),
    origem_acao: "falso_individual",
    motivo_falso_positivo: motivo,
    motivo_falso_positivo_detalhe: detalheLimpo ? detalheLimpo : null,
    ...stripPesado(tabela),
  }, tabela);
}

export async function marcarFalsoComCategoria(
  id: string,
  categoria: "NAO_FOI_AO_CLIENTE" | "NAO_SAIU_DA_BASE" | "DESATUALIZADO" | "MUDOU_DE_ROTA",
  tabela: TabelaAlertas = "alertas",
  detalhe?: string
): Promise<ResultadoAcao> {
  return marcarFalsoPositivoComMotivo(id, categoria, tabela, detalhe);
}

// Resolve vários alertas de uma vez (botão "Resolver todos" do painel).
export async function resolverVarios(
  ids: string[],
  tabela: TabelaAlertas = "alertas"
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
    .from(tabela)
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
  // Só alimenta calibração quando a fonte é a Central de verdade (mesmo
  // raciocínio de resolverAlerta/marcarFalsoPositivoComMotivo acima).
  if (tabela === "alertas") {
    await registrarCasosDesvioRevisao(admin, elegiveis, "resolvido", "resolver_massa");
  }
  // Update final reaplica `.lte("desde", corte)` (mesmo corte, nao
  // recalculado) e restringe a status ainda abertos -- e' a autoridade
  // atomica: `elegiveis` acima e' so pra decidir o que tentar e alimentar
  // registrarCasosDesvioRevisao, quem realmente fechou vem de `.select("id")`
  // encadeado no proprio update.
  const { data: atualizados, error } = await admin
    .from(tabela)
    .update({
      status: "resolvido",
      resolvido_em: new Date().toISOString(),
      operador_id: opId,
      origem_acao: "resolver_massa",
      ...stripPesado(tabela),
    })
    .in("id", elegiveis)
    .lte("desde", corte)
    .in("status", ["ativo", "reconhecido"])
    .select("id");
  if (error) return { erro: "Não foi possível resolver os alertas." };
  const resolvidos = atualizados?.length ?? 0;
  revalidatePath(tabela === "alertas_romaneio" ? "/central-romaneio" : "/");
  invalidarCachesLeitura(tabela);
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
  ids: string[],
  tabela: TabelaAlertas = "alertas"
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
    .from(tabela)
    .update({
      status: "limpo",
      resolvido_em: new Date().toISOString(),
      operador_id: opId,
      origem_acao: "limpar_massa",
      ...stripPesado(tabela),
    })
    .in("id", ids)
    .lte("desde", corte)
    .in("status", ["ativo", "reconhecido"])
    .select("id");
  if (error) return { erro: "Não foi possível limpar os alertas." };
  const limpos = atualizados?.length ?? 0;
  revalidatePath(tabela === "alertas_romaneio" ? "/central-romaneio" : "/");
  invalidarCachesLeitura(tabela);
  return { ok: true, limpos, ignoradosRecentes: ids.length - limpos };
}
