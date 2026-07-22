# Economia de orçamento OSRM na recuperação da cerca virtual, Design

**Data:** 2026-07-21
**Status:** aprovado pelo usuário, indo para plano

## Problema

Continuação da pergunta "como podemos melhorar os desvios" (escopo restrito
a desvio de rota). A cerca virtual (`src/app/api/motor/route.ts`,
`CERCA_VIRTUAL_MODO`) tem um orçamento de chamadas OSRM/Valhalla
compartilhado e GLOBAL (`CERCA_SEEDS_POR_CICLO = 3`, throttle 1 req/s) entre
todos os clientes e dois pontos de uso: **semeadura** (1ª vez que o veículo
ganha um corredor cacheado) e **recuperação** (o veículo saiu do corredor
cacheado, tenta validar se a nova posição ainda é uma rota legítima até
algum pendente).

Na recuperação (`route.ts:1584-1633`), quando o orçamento do ciclo já está
esgotado no momento em que o veículo precisa de verificação, NADA acontece
— nem `foraStreak` avança, nem alerta dispara (fail-open silencioso, tenta
de novo no próximo ciclo). Isso significa que o orçamento escasso é gasto
na ORDEM em que os veículos aparecem no loop (já melhorada nesta sessão via
`ordenarPorPrioridadeVerificacao`, que prioriza por tempo desde a última
verificação), sem considerar se aquele veículo específico já tem evidência
barata (em memória, zero I/O) de que a área é conhecida.

Essa evidência já existe e já está calculada nesse ponto do loop:
`dentroTapete` (tapete de frota, `corredor_celulas`) e `familiarVeiculo`
(histórico pessoal do veículo, `corredor_celulas_veiculo`, construído nesta
sessão) — ambos computados mais cedo no mesmo loop por veículo (linhas
~1282-1300), antes do bloco de cerca virtual (linha ~1520).

## Decisão

**Só a Recuperação é tocada** (confirmado com o usuário) — a Semeadura
continua com a prioridade atual, porque adiar a 1ª semeadura de um veículo
"conhecido" o deixaria permanentemente sem corredor cacheado pra comparar
no futuro.

Na recuperação, adiciona-se mais uma condição pra só gastar a chamada OSRM
quando o histórico NÃO já souber que a área é conhecida:

```ts
} else if (
  cerca &&
  cercaChamadasNoCiclo < CERCA_SEEDS_POR_CICLO + 1 &&
  dentroTapete !== true &&
  familiarVeiculo !== true
) {
```

Quando `dentroTapete === true` OU `familiarVeiculo === true`, a chamada OSRM
é pulada para ESTE veículo neste ciclo — o orçamento fica livre pra outro
veículo processado depois no mesmo ciclo que não tenha essa evidência.
**Não é reordenação da fila** (nenhuma mudança em
`ordenarPorPrioridadeVerificacao` ou na ordem do loop) — é só uma condição
a mais no ponto de decisão que já existe, redirecionando o orçamento
naturalmente porque `cercaChamadasNoCiclo` só incrementa quando a chamada
de fato acontece.

**Por que é seguro pular**: quando essa chamada é pulada, o veículo NÃO
fica sem cobertura nenhuma — a Camada 2/3 do desvio (`foraTapeteStreak`,
`detectores.ts`) roda em paralelo, de graça, usando o MESMO dado
(`dentroTapete`/`familiarVeiculo`), e (verificado na revisão final da
feature de familiaridade, mais cedo nesta sessão) nunca deixa de disparar
para sempre — só amortece (`FORA_TAPETE_STREAK_MIN_FAMILIAR`). A cerca
virtual perde só a confirmação/upgrade extra desse ciclo específico
(`alertaCerca` com score 75-85), não a detecção do desvio como um todo.

**Risco documentado, aceito conscientemente**: enquanto a chamada for
pulada, `cerca.ultimoDentro` (âncora do corredor cacheado) não avança. Se o
veículo eventualmente entrar em área desconhecida, a verificação real vai
partir dessa âncora mais antiga (não da posição mais recente). Não é bug
de correção — `verificarCorredor` já é desenhado pra recalcular a partir
de qualquer âncora válida — só significa que o corredor recalculado pode
ser levemente menos "fresco" nesse recálculo pontual. Aceitável porque a
âncora só fica velha enquanto o veículo permanece em território
comprovadamente conhecido.

## Escopo

Modificar `src/app/api/motor/route.ts:1584` (condição do bloco de
recuperação) — ver código exato acima. Nenhuma mudança em:
- `src/lib/corredor-verificacao.ts` (nenhuma lógica de verificação muda)
- `ordenarPorPrioridadeVerificacao` (ordem do loop intacta)
- `CERCA_SEEDS_POR_CICLO`, `MAX_VERIFICACOES_POR_CICLO` (orçamentos intactos)
- Bloco de Semeadura (`route.ts:1557-1579`)
- `detectores.ts` (Camada 2/3 já existe e já usa esse mesmo dado)

## Fora de escopo

- Mudança no bloco de Semeadura (decisão explícita do usuário).
- Qualquer sinalização nova pro operador (a cerca virtual continua
  operando em modo sombra/ativo exatamente como hoje quando a chamada
  acontece).
- Métricas/telemetria de quantas chamadas foram economizadas — se fizer
  sentido medir o impacto real depois de rodar em produção, é um projeto
  à parte (ex.: reaproveitar `cercaSombraCiclo` pra logar também os casos
  pulados, hoje fora de escopo).

## Testes

`route.ts` não tem testes unitários diretos (padrão já estabelecido nesta
sessão) — a condição nova é extraída pra uma função pura testável em
`src/lib/corredor-verificacao.ts` (mesmo arquivo de
`ordenarPorPrioridadeVerificacao`, adicionada nesta sessão):

```ts
export function deveVerificarRecuperacao(
  dentroTapete: boolean | null,
  familiarVeiculo: boolean | null
): boolean {
  return dentroTapete !== true && familiarVeiculo !== true;
}
```

`route.ts:1584` chama essa função dentro da condição:

```ts
} else if (
  cerca &&
  cercaChamadasNoCiclo < CERCA_SEEDS_POR_CICLO + 1 &&
  deveVerificarRecuperacao(dentroTapete, familiarVeiculo)
) {
```

Teste unitário cobrindo as 4 combinações (`true/true`, `true/false`,
`false/true`, `false/false`) mais os casos `null` (cold-start, sem
cobertura mínima) em `src/lib/corredor-verificacao.test.ts`. `tsc`/
`eslint`/suite completa (`vitest`)/`build` limpos nos dois repos antes do
push. Nenhuma validação isolada de banco é necessária nesta feature — é
lógica condicional pura sobre dado que já existe em memória, sem I/O
novo.
