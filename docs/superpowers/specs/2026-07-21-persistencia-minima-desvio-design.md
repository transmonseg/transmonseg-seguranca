# Reversão da persistência mínima do gatilho de desvio (Camada 1), Design

**Data:** 2026-07-21
**Status:** aprovado pelo usuário, indo para plano

## Problema

Em 11/07, o usuário baixou explicitamente a persistência mínima do
gatilho comportamental de desvio (Camada 1, "afastando-se de TODOS os
destinos") de 2 ciclos pra 1 (`src/lib/detectores.ts:657`), priorizando
nunca perder um desvio real sobre reduzir falso positivo ("pode ter um
desvio de 100 metros e já SER um desvio... falso positivo aceitável,
prioridade total e nunca perder desvio real").

Achado real desta sessão (revisão contínua de casos ao vivo, `/loop` de
monitoramento): 69 de 81 alertas do tipo "afastando-se" dispararam com
apenas 1 leitura — volume de ruído considerável. O usuário, avisado
explicitamente do trade-off (voltar pra 2 ciclos atrasa em ~1min a
confirmação de um desvio real pequeno), decidiu conscientemente reverter
a diretiva de 11/07.

## Decisão

**Reverter para exigir 2 leituras consecutivas** antes de disparar
crítico pela Camada 1. Decisão consciente do usuário, feita com o
trade-off explicitado (não é um ajuste técnico neutro — é uma escolha
deliberada de segurança vs. ruído, na direção oposta da decisão de
11/07).

**Escopo estritamente limitado à Camada 1.** Nenhum outro limiar do
arquivo é tocado: `FORA_TAPETE_STREAK_MIN` (Camada 3, já em 2),
`FORA_TAPETE_STREAK_MIN_FAMILIAR` (já em 5), `RISCO_AREA_LIMIAR`, nenhum
outro.

**Nenhuma mudança na lógica de incremento do streak.** `avancarStreaksDesvio`
(`route.ts`) já incrementa `desvioStreak` genericamente ciclo a ciclo
(0→1→2→...), sem assumir em lugar nenhum que 1 leitura é suficiente pra
disparar — essa é uma decisão exclusiva de `detectarDesvio`. Confirmado
lendo o código: nenhum outro ponto do motor ou de `detectores.ts` hardcoda
essa suposição.

## Escopo

`src/lib/detectores.ts:653-657`:

```ts
// Persistência mínima RESTAURADA pra 2 ciclos em 21/07 (revertendo a
// baixa de 11/07 pra 1 ciclo) -- achado real desta sessão: 69 de 81
// alertas "afastando-se" dispararam com apenas 1 leitura, volume de
// ruído considerável. Decisão consciente do usuário, avisado do
// trade-off (desvio real pequeno leva ~1min a mais pra confirmar).
if (ctx.streak < 2) return null;
```

## Fora de escopo

- Qualquer outro limiar de streak/persistência no arquivo.
- Mudança na Camada 2/3 (tapete, familiaridade, classificação viária).
- Mudança em `avancarStreaksDesvio`/lógica de incremento do motor.

## Testes

Em `src/lib/detectores.test.ts` (describe `"detectarDesvio (v4:
afastamento de TODOS os destinos...)"`):

- O teste existente "streak 1 DISPARA agora" (linhas 306-314) é
  substituído por um teste confirmando que streak 1 NÃO dispara mais.
- O teste existente "streak 0 continua não disparando" (linhas 316-318)
  passa a cobrir explicitamente 0 E 1 (ambos abaixo do novo piso).
- Novo teste: streak 2 dispara (cobrindo o novo piso mínimo).
- Os demais testes do describe (streak 2/4 já usados como `base.streak`)
  continuam válidos sem alteração — já usam streak≥2.

`tsc`/`eslint`/suite completa (`vitest`)/`build` limpos nos dois repos
antes do push. Sem mudança de banco, sem I/O novo — é ajuste de uma
constante de comparação numa função pura já testada.
