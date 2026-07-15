# Redução de falso positivo da cerca virtual (zona de chegada + prioridade por direção), Design

**Data:** 2026-07-15
**Status:** aprovado pelo usuário, indo para plano

## Problema

Depois do fix de 15/07 (cerca virtual passou a considerar base como destino legítimo,
commit `3cef7ca`/`36d3e4c`), investigamos o caso do veículo 3C94 (alerta crítico de
desvio às 13:20, veículo genuinamente indo pro cliente) e o usuário reportou que o
padrão se repete em vários veículos. Duas causas técnicas concretas, ambas na cerca
virtual (`src/lib/corredor-verificacao.ts` + bloco "CERCA VIRTUAL" em
`src/app/api/motor/route.ts`):

1. **Buffer uniforme demais perto da chegada.** O buffer atual
   (`bufferPorVelocidade`: 120m urbano / 200m rodovia) foi calibrado pra trecho de rota,
   mas o OSRM/Valhalla roteia até a via pública mais próxima do ponto, nunca até a
   portaria/doca/estacionamento real do cliente ou da base. Na manobra final de chegada
   (últimos 200-300m), é normal e legítimo o veículo se afastar mais da polilinha do que
   o buffer de trânsito permite — foi exatamente o que aconteceu com o 3C94 (213m de
   distância da rota, contra buffer de 120m).
2. **Priorização só por distância em linha reta, com orçamento de verificação apertado.**
   `ordenarPendentesPorDistancia` ordena os pendentes só por distância haversine. O
   throttle global de 1 req/s do OSRM público + prazo de 5s por verificação
   (`verificarCorredor`) permite testar só ~4-5 rotas candidatas por chamada. Cliente
   Nutry Max tem mediana de 11 entregas pendentes por veículo (ESTADO.md) — se o destino
   real do motorista não está entre os ~5 mais próximos em linha reta (rio, rodovia, mão
   única separando distância real de distância em linha reta), a rota correta nunca é
   computada dentro do orçamento, e a verificação retorna "fora" mesmo o veículo estando
   numa rota legítima pra um pendente mais distante.

Ambas as causas fazem a cerca virtual disparar crítico já na 1ª leitura (comportamento
deliberado da Fase Agressiva de 11/07) sobre veículos que não estão desviados de
verdade.

## Escopo

Duas mudanças, ambas internas à cerca virtual, sem dependência externa nova e sem
alterar o comportamento da Camada 1 (comportamental) ou Camada 3 (tapete):

1. **Buffer alargado na zona de chegada** — dentro de um raio curto de qualquer pendente
   ou base, usar um buffer maior que o de trânsito.
2. **Priorização por direção de deslocamento** — usar o rumo atual do veículo como
   critério de ordenação antes da distância, aumentando a chance de testar a rota
   correta dentro do orçamento de chamadas existente (sem gastar mais chamadas de API).

Fora de escopo (registrado como próximos passos, não implementado agora — ver seção
"Próximos passos" no fim): exigir corroboração de outro sinal antes de escalar a cerca
pra crítico (mudança de sensibilidade, precisa de validação com dado real antes de
subir, regra estabelecida em 09/07); hospedar OSRM próprio (remove o throttle de vez,
mas é projeto de infraestrutura à parte); piso de cobertura do tapete por região
(Camada 3, projeto já identificado e adiado duas vezes); tabela de histórico bruto de
posição (destravaria backtest de verdade, investimento maior).

## 1. Buffer alargado na zona de chegada

`bufferPorVelocidade(velKmH)` hoje retorna só 120 ou 200. Passa a receber também a
distância do veículo ao pendente/base mais próximo (já é calculada em outros pontos do
motor via `haversineM`) e, dentro de um raio de chegada, retorna um buffer maior:

```ts
const RAIO_CHEGADA_M = 300;
const BUFFER_CHEGADA_M = 250;

export function bufferPorVelocidade(velKmH: number, distDestinoMaisPertoM?: number): number {
  if (distDestinoMaisPertoM !== undefined && distDestinoMaisPertoM <= RAIO_CHEGADA_M) {
    return BUFFER_CHEGADA_M;
  }
  return velKmH >= 60 ? 200 : 120;
}
```

`BUFFER_CHEGADA_M = 250` foi escolhido por ser maior que os buffers de trânsito atuais
(120/200) mas ainda restritivo o bastante pra não mascarar um desvio real que aconteça
literalmente ao lado do destino (ex.: sequestro no momento da entrega). `RAIO_CHEGADA_M`
usa a mesma ordem de grandeza do caso real (3C94: 213m) com margem.

Os dois call sites em `route.ts` (semeadura e recuperação da cerca) passam a calcular a
menor distância aos destinos candidatos (`Math.min(...destinosCerca.map(d =>
haversineM(pos.lat, pos.lng, d.lat, d.lng)))`) e repassar pro `bufferPorVelocidade`.

**Nota:** isso NÃO altera o buffer usado pela verificação de corredor da Camada 1
(`CAMADA_CORREDOR_ATIVA`), que já é mais conservadora por natureza (só roda quando o
gatilho comportamental já suspeita de desvio, não em toda checagem de rotina). Alargar
o buffer ali teria mais risco de mascarar desvio real; a cerca virtual é o mecanismo
proativo de baixo custo que roda toda hora, então é onde o ganho de reduzir ruído sem
perder sensibilidade de verdade é maior.

## 2. Priorização por direção de deslocamento

`ordenarPendentesPorDistancia` (em `corredor-verificacao.ts`) ordena só por
`haversineM`. Passa a ordenar por uma combinação de distância e alinhamento com o rumo
atual do veículo (já existe `rumoGraus` em `lib/unitrac.ts`, usado em outros pontos do
motor pra calcular rumo até a base):

- Calcula o rumo do veículo até cada candidato (`rumoGraus(pos, candidato)`).
- Calcula a diferença angular entre esse rumo e o rumo de deslocamento recente do
  veículo (delta absoluto, normalizado 0-180°).
- Ordena primeiro por essa diferença angular (menor primeiro = candidato "na frente" do
  veículo); candidatos com diferença angular dentro de `ANGULO_EMPATE_GRAUS = 30°` um do
  outro são tratados como empatados nesse critério e desempatados por distância (o mais
  próximo dentro desse grupo vence). Isso evita que um candidato 1° mais alinhado, mas
  muito mais longe, roube a prioridade de um candidato quase tão alinhado e bem mais
  perto.

Isso não muda quantas chamadas de API são feitas (mesmo orçamento de
`CERCA_SEEDS_POR_CICLO=3`/`MAX_VERIFICACOES_POR_CICLO=3`) — só muda a ORDEM em que os
candidatos são testados, aumentando a chance de o destino real do motorista estar entre
os primeiros testados quando há muitos pendentes.

**Caso degenerado:** veículo parado ou rumo indefinido (sem posição anterior confiável)
— cai de volta pra ordenação só por distância (comportamento atual), sem quebrar nada.

## Testes

Ambas as mudanças são funções puras em `corredor-verificacao.ts`, já cobertas por teste
hoje (`bufferPorVelocidade`, `ordenarPendentesPorDistancia`). Plano de teste:

- `bufferPorVelocidade`: casos dentro/fora do raio de chegada, com e sem o parâmetro de
  distância (undefined preserva comportamento atual).
- Nova função de prioridade por rumo: candidato alinhado com o rumo vence mesmo estando
  mais longe; candidato oposto ao rumo perde mesmo estando mais perto; fallback pra
  distância pura quando rumo é indefinido.
- Suite completa (`npx vitest run`) precisa continuar 100% verde nos dois repos
  (TEMP e definitivo) antes do push, mesma disciplina das mudanças anteriores.

## Próximos passos (não neste plano)

- Exigir corroboração de outro sinal antes da cerca virtual escalar pra crítico —
  precisa de validação com dado real (regra de 09/07), tratar como projeto separado.
- Hospedar OSRM próprio no Contabo (remove o throttle de 1 req/s de vez, destrava testar
  todos os pendentes em toda verificação).
- Piso de cobertura do tapete por região (Camada 3) — reduz ruído residual em rota
  rural/serra, adiado duas vezes (09/07, 12/07).
- Tabela de histórico bruto de posição (mesmo que rolling curto) — destrava backtest de
  verdade (replay), reduz risco de repetir incidentes tipo Fase Agressiva.
