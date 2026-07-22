# Badge de "rota concluída" no card de alerta de desvio, Design

**Data:** 2026-07-21
**Status:** aprovado pelo usuário, indo para plano

## Problema

Continuação da anotação `contexto.rota_concluida` (feature "Problema B" desta
sessão): o motor já grava, no `contexto` (jsonb) de alertas de desvio
ativos, quando o veículo comprovadamente já concluiu todas as entregas do
dia (`entregas_total > 0 && entregas_feitas >= entregas_total`). Decisão
explícita do usuário na época: "só backend por enquanto" — nunca muda
`nivel`/`status`, nunca aparece na tela.

O problema que ficou registrado: alertas de desvio ficam "críticos" por até
35+ horas mesmo com o veículo já tendo chegado ao destino, e o operador não
tem NENHUM sinal visual disso — precisa abrir o `contexto` manualmente via
banco pra saber. O usuário agora quer ir além do backend-only.

## Decisão

**Badge discreto no card, sem reordenar a lista** (confirmado com o
usuário — opção mais simples e segura das duas apresentadas). Quando um
alerta de desvio tem `contexto.rota_concluida` preenchido, o card ganha um
indicador visual pequeno e neutro (não usa a cor de crítico/atenção já
existente) — só informa ao operador que aquele alerta específico já pode
ser revisado com prioridade menor. **Nada muda automaticamente**: `nivel`,
`status`, cor de fundo/borda do card e ordem na lista continuam
IDÊNTICOS ao comportamento atual. Mantém intacta a regra de segurança de
11/07 (desvio nunca fecha/rebaixa sozinho).

## Escopo

### 1. `src/app/api/alertas/route.ts`

Linha 48, adicionar `contexto` à lista de colunas já selecionadas:

```ts
  const { data: alertasRaw } = await supabase
    .from("alertas")
    .select("id, veiculo_id, nivel, tipo, motivo, desde, status, score, lat, lng, contexto")
    .eq("cliente_id", clienteId)
    .in("status", ["ativo", "reconhecido"]);
```

Esta query já é escopada a 1 cliente e só alertas ativos/reconhecidos —
não tem relação com o incidente de egress de 31GB (que era sobre buscar a
FROTA INTEIRA a cada poll, independente de alerta).

No `map` que monta o objeto de resposta (por volta da linha 83-130),
adicionar o campo `contexto: { rota_concluida?: ... } | null` ao tipo do
parâmetro `a` e, no objeto retornado, adicionar:

```ts
        rotaConcluida: (a.contexto as { rota_concluida?: unknown } | null)?.rota_concluida != null,
```

O frontend recebe só um booleano limpo — não precisa conhecer o formato
interno do jsonb.

### 2. `src/app/(app)/components/CardAlertaCritico.tsx`

Adicionar `rotaConcluida?: boolean;` à interface `CardAlertaProps` (linha
~134-153) e ao destructuring dos props (linha ~155-157).

Renderizar um badge pequeno, cor neutra (ex.: cinza/`var(--text-dim)`, NÃO
`corNivel`), condicionado a `tipo === "desvio" && rotaConcluida === true`,
posicionado ao lado do badge de nível já existente (cabeçalho do card,
linha ~179-189). Texto: "Rota concluída" (ou equivalente curto). Não
altera `corNivel`, `bgNivel`, nem nenhuma outra lógica visual do card.

### 3. `src/app/(app)/components/PainelCentral.tsx`

Linha ~555-569 (onde `<CardAlertaCritico ... />` já é instanciado dentro
do `.map((a) => ...)`), adicionar `rotaConcluida={a.rotaConcluida}` à lista
de props já passadas.

## Fora de escopo

- Reordenação da lista de alertas (decisão explícita do usuário: só
  badge).
- Qualquer mudança em `nivel`, `status`, cor de fundo/borda do card.
- Qualquer mudança no motor (`route.ts`) — a anotação `rota_concluida` já
  existe e já é gravada, esta feature só consome o dado que já existe.
- Badge em outros tipos de alerta que não `desvio` (a anotação só é
  gravada para desvio, ver `route.ts:1954` da feature original).

## Testes

Sem lógica pura nova isolável — é fiação de API → props → render. `tsc`/
`eslint`/suite completa (`vitest`)/`build` limpos nos dois repos antes do
push. Como é mudança de frontend: subir o dev server (`npm run dev`) e
conferir visualmente, via browser, que o badge aparece em um alerta de
desvio com `rota_concluida` preenchido e NÃO aparece em alertas de desvio
sem essa anotação nem em alertas de outros tipos — antes de considerar a
feature concluída.
