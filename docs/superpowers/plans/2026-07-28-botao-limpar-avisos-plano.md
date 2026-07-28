# Botão "Limpar avisos" (separado de "Resolver todos") — Plano

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development pra rodar este plano tarefa por tarefa.

**Goal:** Separar a ação de "só tirar da tela" da ação de "revisei e confirmo que foi tratado" — hoje as duas são a mesma (`resolverVarios`, status `resolvido`), e isso contaminou a leitura de "quantos foram confirmados de verdade" (achado real 27-28/07: maioria dos `resolvido` de um dia vinham de um clique só em "Resolver todos", sem revisão caso a caso).

**Architecture:** Novo status `limpo` na tabela `alertas` (não substitui `resolvido`/`falso_positivo` — soma). Nova server action `limparVarios` espelhando `resolverVarios`, mas sem chamar `registrarCasosDesvioRevisao` (não é veredito humano, não deve alimentar calibração). Botão novo na UI ao lado do "Resolver todos" existente. Toda query que hoje trata "não-ativo" como população de calibração/estatística precisa excluir explicitamente `limpo`.

**Tech Stack:** Postgres (migration no Contabo), `src/app/(app)/acoes-alertas.ts`, `src/app/(app)/central-v2/MonitorV2.tsx`, `src/app/(app)/analise/page.tsx`, `src/app/api/recalibrar-desvio/route.ts`, `src/app/api/motor/route.ts` (housekeeping sweeps).

---

## Task 1: Migration — novo status `limpo`

**Arquivos:**
- Criar: `scripts/migrations/contabo/007_status_limpo.sql`

```sql
-- scripts/migrations/contabo/007_status_limpo.sql
--
-- Pedido do usuario (28/07): separar "so tirar da tela" (Limpar avisos) de
-- "revisei e confirmo" (Resolver todos) -- achado real 27-28/07: a maioria
-- dos alertas "resolvido" de um dia vinham de um clique so em massa, sem
-- revisao caso a caso, contaminando qualquer leitura de "quantos foram
-- confirmados de verdade" (e a calibracao, que aprende de casos_desvio_
-- revisao supondo veredito humano).
--
-- Novo status 'limpo': soma aos 4 existentes, nao substitui nenhum.
ALTER TABLE alertas DROP CONSTRAINT alertas_status_check;
ALTER TABLE alertas ADD CONSTRAINT alertas_status_check
  CHECK (status = ANY (ARRAY['ativo'::text, 'reconhecido'::text, 'resolvido'::text, 'falso_positivo'::text, 'limpo'::text]));

-- Indice de limpeza (geom/lat/lng/contexto apos resolvido) precisa cobrir o
-- status novo tambem, senao essas linhas nunca entram na varredura de
-- privacidade nem na retencao de 30 dias (ver route.ts, housekeeping sweep).
DROP INDEX IF EXISTS idx_alertas_cleanup;
CREATE INDEX idx_alertas_cleanup ON alertas (status, COALESCE(resolvido_em, created_at))
  WHERE status = ANY (ARRAY['resolvido'::text, 'falso_positivo'::text, 'limpo'::text]);

NOTIFY pgrst, 'reload schema';
```

**Aplicar:** `scp` pro Contabo + `sudo -u postgres psql -d transmonseg -f <arquivo>` (mesmo padrão de toda migration desta sessão). Confirmar com `\d alertas` que a constraint aceita `'limpo'`.

---

## Task 2: Server action `limparVarios` (sem chamar registrarCasosDesvioRevisao)

**Arquivos:**
- Modificar: `src/app/(app)/acoes-alertas.ts`

Ler `resolverVarios` (função existente no mesmo arquivo) e criar uma função irmã:

```ts
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
    .update({ status: "limpo", resolvido_em: new Date().toISOString(), operador_id: opId, ...STRIP_PESADO })
    .in("id", ids);
  if (error) return { erro: "Não foi possível limpar os alertas." };
  revalidatePath("/");
  return { ok: true, limpos: ids.length };
}
```

Reusar `STRIP_PESADO` já existente no arquivo (mesmo tratamento de privacidade que `resolverVarios` já dá).

---

## Task 3: Botão "Limpar avisos" na UI (MonitorV2.tsx — o painel realmente em uso; `PainelCentral.tsx` não é importado em lugar nenhum, confirmado, não mexer nele)

**Arquivos:**
- Modificar: `src/app/(app)/central-v2/MonitorV2.tsx`

**Step 1:** Importar `limparVarios` junto de `resolverVarios` (linha do import existente, `~linha 7`).

**Step 2:** Achar o botão "Resolver todos" (busca por `Resolver todos (${alertasFiltrados.length})`, `~linha 2199`, e o handler que chama `resolverVarios` em `~linha 1091`). Adicionar um handler irmão e um botão irmão ao lado, mesmo estilo visual (mesma lógica de confirmação/pending já usada pro resolver, se houver), rotulado **"Limpar avisos"**, chamando `limparVarios` em vez de `resolverVarios`, sobre o MESMO conjunto de alertas filtrados/visíveis (`alertasFiltrados`).

**Step 3:** Rodar a skill `run` (dev server) e testar manualmente: abrir `/central-v2`, confirmar os dois botões aparecem lado a lado, clicar "Limpar avisos" com 1-2 alertas de teste e confirmar no banco que o status virou `limpo` (não `resolvido`).

---

## Task 4: Excluir `limpo` de toda leitura de calibração/estatística

**Arquivos:**
- Modificar: `src/app/api/recalibrar-desvio/route.ts`
- Modificar: `src/app/(app)/analise/page.tsx`

**recalibrar-desvio/route.ts:** a query grosseira sobre `alertas` filtra `status != 'ativo'` — isso hoje deixaria `limpo` entrar como se fosse população válida de "não-ativo" (contando indevidamente pra `taxaGlobal`/segmento grosseiro `tipo:X`, do mesmo jeito que `auto_resolvido`/`auto_expirado` foram excluídos hoje mais cedo via `contaComoRotuloHumano`). Adicionar `status != 'limpo'` na mesma cláusula WHERE (ou reusar/estender `contaComoRotuloHumano` se fizer mais sentido conceitual — decidir olhando o código real antes de escolher).

**analise/page.tsx:** a linha `(r) => r.status === "resolvido" || r.status === "falso_positivo"` (~linha 167, usada pra alguma métrica de taxa/MTTR) e a lista de abas `["ativo", "reconhecido", "resolvido", "falso_positivo"]` (~linha 367) — decidir e implementar: `limpo` deve aparecer como aba própria no dashboard (visibilidade, sim) mas NUNCA entrar na métrica de "taxa de falso positivo" nem MTTR calculado a partir de "resolvido"/"falso_positivo" (não é dado confiável pra isso). Ler o contexto real das duas linhas antes de decidir o encaixe exato.

---

## Task 5: Incluir `limpo` nas varreduras de limpeza/retenção do motor

**Arquivos:**
- Modificar: `src/app/api/motor/route.ts`

Achar as 2 queries de housekeeping que hoje filtram `WHERE status IN ('resolvido', 'falso_positivo')` (uma zera geom/lat/lng/contexto depois de um tempo, outra é a retenção de 30 dias que deleta) — adicionar `'limpo'` na lista em AMBAS, senão essas linhas nunca são limpas de dado sensível nem nunca são deletadas (ficam pra sempre com geom/contexto completo). Confirmar que nenhuma delas colide com a exclusão de `auto_resolvido`/`auto_expirado` já adicionada hoje mais cedo (aquela exclusão é sobre CONTEXTO, não sobre STATUS — `limpo` é ortogonal, deve passar normalmente pela varredura assim que `resolvido_em` for velho o bastante).

---

## Task 6: Testes + verificação final

- Rodar `npm test -- --run`, `npx tsc --noEmit`, `npm run build`.
- Teste manual na UI (Task 3, Step 3) já cobre o caminho principal.
- Revisão independente antes de commitar: mesma classe de risco de tudo que mexeu em `status`/calibração hoje — checar especificamente que `limpo` nunca aparece em `mapaTiposSilenciados` (a query já filtra `status='falso_positivo'` exato, deveria excluir `limpo` por construção — confirmar, não assumir) e que `registrarCasosDesvioRevisao` genuinamente nunca é chamado no caminho de `limparVarios`.

Replicar pros dois repos + deploy manual nos 2 processos PM2 do Contabo (a migration também precisa ser aplicada direto no Postgres, não só o código).
