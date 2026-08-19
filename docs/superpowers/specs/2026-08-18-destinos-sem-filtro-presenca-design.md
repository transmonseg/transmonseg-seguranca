# `destinos` do desvio não pode perder o ponto por presença recém-confirmada, Design

**Data:** 2026-08-18
**Status:** implementado, aguardando aprovação de deploy do usuário (não deployado ainda)

## Contexto

Caso real, 17/08 10:57 (grupo WhatsApp "DESVIO DE ROTA"): veículo RQQ-1B52 chegando na porta do cliente, sistema apontou desvio de rota. Operador: *"está chegando ao cliente, porém, no sistema novo, a marcação não consta. No Unitrac, a marcação está normalmente."*

Confirmado com dado real (`desvio_disparo_log`, alerta `6b648d31-0248-46ee-9ff4-ae05cd3d2202`, log `b2de6dbb-1b2a-4f30-8cd5-ca13c558de0c`): o disparo teve 21 destinos no array avaliado, TODOS entre 6,3km e 24km, TODOS ~60m mais longe naquele ciclo — incluindo as 2 corroborações (corredor e classe viária) confirmando, porque geometricamente fazia sentido pro que estava na lista. O cliente real não estava nos 21 pontos.

**Causa raiz**: `destinos` (`motor/route.ts`, alimenta `avaliarAfastandoDeTudo`/Sinal A) usava `pendentes` direto — e `pendentes` já filtra por `ENTREGA_PRESENCA_ATIVA` ("parada no local conta como entregue", regra de 01/08): assim que o veículo fica parado ~2min na porta do cliente, o ponto some da lista de pendentes. No exato momento em que o motorista está fisicamente chegando, o ponto certo desaparece do array — e os outros destinos distantes "ficam mais longe" porque o caminhão parou de se mover na direção deles. `afastouDeTudo` fica matematicamente verdadeiro dado um array sem o destino real.

**Mesma classe de bug já achada e corrigida uma vez neste arquivo** — 03/08, caso UBO-5E01 ("SENDAS BARRA I"), pro consumidor D1/D3 do placar antigo (removido 12/08 junto com o resto do placar). O fix de 03/08 nunca foi aplicado ao consumidor do Sinal A porque na época esse consumidor usava outro caminho de código — a variável que guardava aquele fix (`pontosVeiculoParaCorroboracao`) ficou órfã (dead code, nunca lida por ninguém) desde a remoção do placar em 12/08.

## Decisão

Reaproveita a variável órfã, renomeada e com o filtro ajustado pro Sinal A especificamente:

```typescript
// pontosVeiculoParaDesvio: fonte de `destinos` do Sinal A -- diferente de
// `pendentes` (usada pra bypass_entrega, "mais próximo", snapshot, etc)
// em UMA coisa só: NÃO filtra por ENTREGA_PRESENCA_ATIVA/presencaEntregaCliente
// (o heurístico de presença nosso, que é o que causa o bug -- marca "feito"
// demais cedo em relação à chegada física). AINDA filtra por `pt.feito`
// (confirmação real da Unitrac, dado externo verdadeiro) e coordenada
// válida -- diferente do padrão antigo (`pontosVeiculoParaCorroboracao`,
// 03/08), que não filtrava feito NENHUM, porque aquele consumidor era só
// corroboração aditiva (nunca decidia se o alerta existia); aqui é o
// GATE PRIMÁRIO (decide se dispara), risco diferente -- ponto genuinamente
// confirmado pela Unitrac deve continuar saindo da conta.
const pontosVeiculoParaDesvio = (pontosVeiculo ?? []).filter(
  (pt) => !pt.feito && temCoordenadaValida(pt)
);
```

`destinos` e `NAO_ESCALA_LEN` passam a usar `pontosVeiculoParaDesvio` em vez de `pendentes`. `pendentes` (e todo o resto que depende dela — bypass_entrega, "mais próximo", snapshot de pendentes, etc.) **fica exatamente como está** — só o Sinal A do desvio muda de fonte.

## Por que isso é seguro (sem dado histórico pra replay completo — ver seção Testes)

- É estritamente **aditivo em completude de dado**: adiciona de volta um ponto que deveria estar lá, nunca remove nada que já estava. Não existe mecanismo plausível pelo qual isso CRIE um falso positivo novo — só corrige um caso onde faltava dado.
- `pt.feito` (verdade da Unitrac) continua filtrado — um ponto genuinamente entregue (confirmado pela própria Unitrac, não só nosso heurístico) não volta pra lista.
- Risco teórico considerado: o veículo parado bem em cima do ponto (ruído de GPS fazendo a distância "aumentar" por jitter) poderia, em teoria, contribuir pra um falso `afastouDeTudo` justamente no momento em que fica ali. Mitigado por proteção JÁ existente e independente: `LIMIAR_MOVIMENTO_MINIMO_M=50m`/`movimentoInsignificante` (achado 13/08) suspende TODA avaliação do ciclo quando o veículo não se moveu de verdade entre leituras — exatamente o cenário "parado numa entrega" já é coberto por esse gate, então esse risco teórico já tem proteção prévia, não é uma exposição nova.

## Testes

- `npx tsc --noEmit`, `npx eslint src/app/api/motor/route.ts`, `npx vitest run` (508/508) — limpos.
- **Não foi possível fazer replay de dia real completo** (padrão desta sessão pra mudança de parâmetro do detector): `scripts/simular-dia-desvio-v2.mjs` lê de `pendentes_snapshot_log`, que só guarda o snapshot da lista JÁ FILTRADA (`pendentes`, com o bug) — não existe captura histórica da lista sem esse filtro específico pra reconstruir "o que teria acontecido" com o fix aplicado num dia passado. Confirmado manualmente só o caso RQQ-1B52 em si (reconstrução via `desvio_disparo_log.destinos`, mesmo método usado pro caso TOS-3C21 hoje).
- **Recomendação pro usuário**: por não ter replay de dia inteiro, vale acompanhar de perto o primeiro dia real depois do deploy (volume de alertas de `afastando_geral` não deveria SUBIR — se subir de forma anormal, é sinal de que a análise de segurança acima está incompleta e merece investigar antes de continuar).

## Fora de escopo

- Qualquer mudança em `pendentes` em si (usada por bypass_entrega, gates de chegada, snapshot) — nenhuma dessas outras leituras muda.
- Instrumentar um log dedicado de "ponto saiu de pendentes/destinos por presença" (achado de falta de observabilidade durante a investigação) — útil pra diagnosticar casos futuros mais rápido, mas não bloqueia este fix. Registrar como melhoria futura.
