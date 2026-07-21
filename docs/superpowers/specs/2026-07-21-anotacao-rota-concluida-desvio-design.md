# Anotação de "rota concluída" em alertas de desvio ativos, Design

**Data:** 2026-07-21
**Status:** aprovado pelo usuário, indo para plano

## Problema

Continuação da investigação de hoje (Bug 3, systematic-debugging): confirmado
ao vivo que alertas de desvio ficam "críticos" por até 35+ horas mesmo com o
veículo comprovadamente já tendo chegado ao destino (dentro de uma
base/cliente agora). Desvio nunca fecha sozinho (decisão de segurança
deliberada de 11/07 — parado pode ser sequestro em andamento), então o
sistema não tem hoje um jeito de sinalizar "esse veículo já terminou a rota"
pra quem for revisar o alerta depois.

O sistema já tem uma anotação parecida (`contexto.proximidade_atual`, feature
de 18/07): quando o veículo está DENTRO DO RAIO de um ponto de entrega
específico, o motor anota nome do ponto + dwell. Mas isso só existe enquanto
o veículo está fisicamente perto de UM ponto conhecido — se ele já entregou
tudo e foi embora (voltou pra base, foi pra casa do motorista, etc), a
anotação de proximidade não reflete mais nada, mesmo que a rota do dia já
tenha terminado.

O sistema também já CALCULA a condição exata de "rota concluída"
(`entregas_total > 0 && entregas_feitas >= entregas_total`) em
`detectarRetornoTardio` (`src/lib/detectores.ts:771`) — só que hoje só usa
isso pra outro alerta (retorno tardio à base), não anota nada no desvio.

## Decisão

**Não mexer no fechamento** (mantém a regra de segurança de 11/07 intacta,
mesma decisão já tomada pra `proximidade_atual`). Confirmado com o usuário
nesta sessão: **fica só no backend por enquanto** (sem selo/badge na tela do
operador) — o objetivo agora é dar mais um sinal pra análise
manual/automatizada (ex.: a revisão contínua de alertas já feita nesta
sessão), não mudar a experiência do operador.

Reaproveita 100% infraestrutura existente: `entregas_feitas`/`entregas_total`
já são computados por veículo todo ciclo (mesmos valores que
`detectarRetornoTardio` já usa). Quando esse veículo tem um alerta de desvio
ativo, grava essa condição no `contexto` (jsonb) do alerta — mesmo padrão
exato de `proximidade_atual`: coleta num array de ciclo, flush em lote no fim
do ciclo, `UPDATE alertas SET contexto = contexto || $2::jsonb`. Nunca muda
`nivel`/`status`, nunca fecha o alerta.

Diferença chave em relação a `proximidade_atual`: esse sinal é COMPLEMENTAR,
não substituto — fica verdadeiro mesmo depois do veículo sair de perto de
qualquer ponto específico (proximidade zera nesse caso, rota_concluida
continua). Os dois podem coexistir no mesmo `contexto`, cada um informando
uma coisa diferente.

## Implementação

`route.ts`: novo array de ciclo `rotaConcluidaCiclo` (mesmo padrão de
`proximidadeDesvioCiclo`, declarado perto dele, linha ~641). No ponto onde
`alertasAbertos`/`entregas_feitas`/`entregas_total` já estão disponíveis
(logo após o bloco de `proximidadeDesvioCiclo`, linha ~1954), adiciona:

```ts
if (entregas_total > 0 && entregas_feitas >= entregas_total) {
  for (const d of alertasAbertos.filter((a) => a.tipo === "desvio")) {
    rotaConcluidaCiclo.push({ alerta_id: d.id, entregasFeitas: entregas_feitas, entregasTotal: entregas_total });
  }
}
```

Flush em lote no fim do ciclo (logo após o flush de `proximidadeDesvioCiclo`,
linha ~2241), mesmo padrão de dedupe por `alerta_id` e `UPDATE ... contexto =
contexto || $2::jsonb`:

```json
{ "rota_concluida": { "entregas_feitas": 12, "entregas_total": 12, "atualizado_em": "2026-07-21T..." } }
```

## Testes

`tsc`/`eslint`/`vitest` (suite existente, nenhum teste novo — é fiação usando
dado já computado, mesma justificativa de `proximidade_atual`)/`build`
limpos nos dois repos antes do push. Query de UPDATE validada isoladamente
contra um alerta real de produção (mesma cautela de sempre: nunca rodar o
motor de produção pra testar) — confirma que só `contexto` muda,
`nivel`/`status` inalterados; dado revertido pro estado original depois.
