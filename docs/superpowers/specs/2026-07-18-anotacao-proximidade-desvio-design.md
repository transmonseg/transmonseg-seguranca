# Anotação de proximidade em alertas de desvio ativos, Design

**Data:** 2026-07-18
**Status:** aprovado pelo usuário, implementado

## Problema

Auditoria pedida pelo usuário nos 21 alertas de desvio ativos em produção (18/07,
14h): em 3 casos concretos (TTK-9F48, RQU-0B47, TTI-3A09) o veículo estava **parado a
21-100m** de um ponto conhecido (pendente ou já feito) — muito provavelmente já
chegou no destino — mas o alerta continuava "crítico" sem nenhuma indicação disso.

**Causa raiz:** desvio nunca fecha sozinho (decisão de segurança de 11/07 — parado
pode ser sequestro em andamento). O alerta é criado num instante em que o veículo
ainda está longe; se ele chega ao destino minutos depois, nada no sistema reflete
isso — o alerta fica com a mesma aparência de "grave e recém-disparado" para sempre,
até um operador resolver manualmente.

## Decisão

**Não mexer no fechamento** (mantém a regra de segurança intacta). Só **anotar**: o
motor já calcula, pra QUALQUER veículo, se ele está dentro do raio de algum ponto
conhecido e há quanto tempo (`alvoNoRaioAgora`/`noRaioDwellSegundos`, infra existente
do `detectarBypassEntrega`). Quando esse veículo tem um alerta de desvio ativo, grava
essa proximidade no `contexto` (jsonb) do alerta — nome do ponto, segundos de
permanência, timestamp. Nunca muda `nivel`/`status`, nunca fecha o alerta. Mesma
filosofia de "parado no cliente" (informação, não decisão automática).

## Implementação

Reaproveita infraestrutura 100% existente — zero query nova, zero chamada de rede
extra. `route.ts`: no ponto onde `alvoNoRaioAgora` já é calculado (pro
bypass_entrega), se há alerta(s) de desvio aberto pro mesmo veículo
(`alertasAbertos`, já carregado em lote por cliente), coleta candidato num array de
ciclo (`proximidadeDesvioCiclo`). Flush em lote no fim do ciclo (mesmo padrão de
`presencaConfirmadaCiclo`/baseline): `UPDATE alertas SET contexto = contexto ||
$2::jsonb WHERE id = $1` — o operador `||` do Postgres faz merge raso, preserva
qualquer outra chave já existente no contexto (ex.: `corredor`, `inicio_ts`).

## Testes

`tsc`/`eslint`/`vitest` (291 testes, nenhum novo — é fiação usando dado já
computado, sem lógica nova testável isoladamente)/`build` limpos. Query de UPDATE
validada isoladamente contra um alerta real de produção (TTK-9F48): confirmado que
só `contexto` muda, `nivel`/`status` inalterados; dado de teste revertido pro estado
original depois.
