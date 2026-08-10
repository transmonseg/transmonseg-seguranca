# Harness de backtest + relaxamento do "afastando de tudo" — Design

**Contexto:** dois veículos reportados hoje (10/08) no grupo WhatsApp
"DESVIO DE ROTA" — TTM-7C13 e TTH-0G95, "desvio na Unitrack mas não
apareceu no sistema" — motivaram uma investigação forense completa
(rastro real de `posicoes_historico` + destinos reais de
`pendentes_snapshot_log`, feature construída nesta mesma sessão
especificamente para viabilizar esse tipo de investigação).

## O bug confirmado

`afastouDeTudo` (`src/lib/detectores.ts:1383`, v4) exige que a distância
cresça para TODOS os destinos pendentes simultaneamente, ciclo a ciclo:

```typescript
distDestinosM.every((d, i) => d > distDestinosAnteriorM[i] + AFASTAMENTO_MARGEM_M)
```

(`AFASTAMENTO_MARGEM_M = 50`, `detectores.ts:533`). Regra desenhada de
propósito em 06/07 (achado real documentado no código): usar só a
distância ao destino MAIS PRÓXIMO causava 22 falsos positivos em 20min,
porque motorista entregando para o cliente que não é o mais próximo —
padrão comuníssimo — disparava desvio numa entrega normal. A correção
histórica foi exigir afastamento de TODOS os destinos legítimos
(pendentes + bases) simultaneamente.

**Problema:** recalculando `afastouDeTudo` linha a linha (Python, contra
dados reais) para TTM-7C13 e TTH-0G95 — ambos com 13-15 pendentes
espalhados pela cidade (dezenas de km de raio) — a condição "TODOS os
destinos cresceram no mesmo ciclo" nunca foi verdadeira nem uma vez em
~100 leituras consecutivas ao longo de 90 minutos para nenhum dos dois
(streak máximo = 0). Isso não é um bug pontual: é uma propriedade
matemática da regra que degrada conforme N (quantidade de pendentes)
cresce — com destinos dispersos, é geometricamente quase impossível todos
crescerem de distância ao mesmo tempo entre duas leituras de GPS
consecutivas, mesmo que o veículo esteja indo pro lugar errado. Bate com
um relato independente do mesmo dia, de um operador real: "percebi que
essa semana pra cá a frequência de acerto diminuiu".

## Por que a validação anterior (Python) não é confiável

Uma tentativa anterior nesta mesma sessão de validar candidatos (Top-K,
percentual) via replay em Python, contra 5 casos reais, falhou em
reproduzir 3 deles mesmo usando a regra ATUAL. Investigação (Explore
agent, hoje) achou a causa: o motor real tem dois comportamentos que o
replay não reproduzia —

1. **Histerese no streak** (`avancarStreaksDesvio`, `detectores.ts:1503-1515`):
   uma leitura isolada de "aproximando" CONGELA o streak (não zera); só 2
   leituras consecutivas de aproximação zeram. O replay zerava no primeiro
   sinal contrário.
2. **Cadência real, não fixa** (`devAvancarStreaksDesvio`,
   `detectores.ts:1491-1501`): o streak só avança quando `fresco`,
   `velocidade > 0` e a posição mudou o suficiente
   (`POSICAO_CONGELADA_M = 10`) — veículo parado congela o streak dos dois
   lados. E `distDestinosAnteriorM` vem de `posicoes_atuais` (estado
   sobrescrito, não histórico) — o "anterior" de um ciclo é o último ciclo
   que processou aquele veículo com sucesso, não necessariamente ~30s
   atrás (há buracos reais: lease do motor ocupado, timeout de cliente,
   erro pontual por veículo — cada um produz zero linhas para aquele
   veículo naquele ciclo).

Isso não muda a conclusão sobre TTM-7C13/TTH-0G95 (lá a condição "TODOS
crescem" nunca foi verdadeira nem uma vez — histerese de reset é
irrelevante quando o streak nunca chega a avançar), mas invalida a
comparação entre candidatos feita em Python. Antes de escolher a regra de
substituição, é preciso um harness fiel.

## Harness de backtest

Script novo em TypeScript, **importando as funções reais** de
`src/lib/detectores.ts` (`afastouDeTudo`, `avancarStreaksDesvio`,
`devAvancarStreaksDesvio`) — zero reimplementação da lógica.

**Fonte de dados, por caso do corpus:**
- `casos_desvio_revisao.trilha` (jsonb array de `{lat, lng, velocidade,
  ignicao, atraso_min, criado_em}`) já é exatamente o rastro de posição
  usado na revisão original do caso — não precisa reconsultar
  `posicoes_historico` à parte.
- Destinos (pendentes + bases) vigentes em cada ponto do rastro: via
  `pendentes_snapshot_log` (mesmo padrão de junção por
  `criado_em <= ponto.criado_em order by criado_em desc limit 1` já usado
  nesta sessão).
- `contexto_detector` de cada caso já traz `dist_destinos_m`/
  `dist_destinos_anterior_m`/`desvio_streak`/`fora_tapete`/
  `queda_classe_viaria`/`divergencia_rumo_streak` do momento da resolução —
  usado para filtrar o corpus (abaixo), não para re-simular.

**Máquina de estado:** replay ciclo a ciclo sobre os pontos do `trilha`
(ordenados por `criado_em`, na ordem em que já vêm), usando o delta real de
tempo entre pontos consecutivos (nunca assumir 30s/60s fixos) para os
mesmos guards que o motor real usa (`devAvancarStreaksDesvio`,
`POSICAO_CONGELADA_M`), e a mesma histerese (`avancarStreaksDesvio`) para
decidir quando o streak realmente zera.

**Regra sob teste é parametrizável:** o harness roda o mesmo replay uma vez
por candidato, trocando só a função "todos os destinos afastaram" por:
- ALL (atual, `afastouDeTudo` sem modificação — baseline).
- Top-K mais próximos (K = 3, 5, 8).
- Percentual (≥60%, ≥80%).

Cuidado explícito de implementação (a resolver durante a execução do
plano, não fechado aqui): com N pequeno (2-3 destinos, como os 2 casos de
falso-positivo confirmado já investigados hoje), Top-K com K≥N e
percentual precisam se comportar como ALL — senão reabrem o incidente de
06/07 (motorista indo pro cliente não-mais-próximo disparando FP). Isso
vale tanto pra Top-K (natural: se K≥N, testa todos) quanto pra percentual
(a direção do arredondamento importa: 60% de 2 destinos são 1,2 — arredondar
pra baixo exige só 1 dos 2, o que É o bug original reintroduzido; a
implementação precisa arredondar pra CIMA nesse caso, ou usar
`Math.ceil`).

## Corpus de teste

Todos os casos de `casos_desvio_revisao` (retenção 30 dias, confirmado via
query ao vivo: 494 linhas de 27/07 a hoje) com `origem_acao IS NULL OR
origem_acao <> 'resolver_massa'` (mesmo filtro já usado em
`recalibrar-desvio/route.ts`, exclui ações em massa que não representam
julgamento individual do operador), restritos a casos cujo
`contexto_detector` indica que `afastouDeTudo`/`fora_tapete` foi
relevante para aquele alerta (não um caso de classe_viaria puro sem
streak de afastamento) — filtragem exata a definir no plano, usando os
campos já disponíveis em `contexto_detector` (`desvio_streak`,
`fora_tapete`, `queda_classe_viaria`).

Dividido em dois grupos:
- **"Tem que disparar"**: `status_final = 'resolvido'` (~220 casos hoje).
- **"Não pode disparar"**: `status_final = 'falso_positivo'` E
  (`motivo_falso_positivo IS NULL OR motivo_falso_positivo =
  'detector_errado'`) — exclui `dado_entrada_errado` (marcação/endereço
  errado, não é falha do detector; NULL cobre o histórico anterior à
  feature de hoje, tratado como `detector_errado`, mesma política já usada
  em `recalibrar-desvio/route.ts`) (~201 casos hoje).

TTM-7C13 e TTH-0G95 especificamente precisam ter um caso equivalente no
corpus — como os alertas de hoje para esses dois nunca chegaram a
disparar, não existe linha correspondente em `casos_desvio_revisao` (só
existe pra alertas que de fato foram criados e revisados). O plano precisa
incluir os dois como casos extras, montados a partir do
`posicoes_historico`/`pendentes_snapshot_log` já baixados nesta sessão
(arquivos em `/tmp/pendentes_7c13.txt`, `/tmp/trail_7c13.txt`,
`/tmp/pendentes_0g95.txt`, `/tmp/trail_0g95.txt`), rotulados "tem que
disparar" mesmo sem `casos_desvio_revisao` — são os 2 casos que motivaram
toda a investigação.

## Critério de decisão

Candidato vencedor = maximiza recall no grupo "tem que disparar" (streak
cruza o limiar real de disparo, `FORA_TAPETE_STREAK_MIN = 2`) sem piorar a
taxa de disparo espúrio no grupo "não pode disparar" em relação à regra
ALL atual nesse mesmo corpus.

Se nenhum candidato atender aos dois critérios ao mesmo tempo (trade-off
sem vencedor claro), o harness reporta a tabela completa (candidato ×
recall × taxa de disparo espúrio × latência média até disparo nos casos
capturados) e a escolha final é levada de volta para decisão explícita —
não decido sozinho uma mudança de comportamento de produção
safety-critical sem essa tabela na mesa.

## Mudança de código (após a escolha do candidato vencedor)

Substituir a chamada a `afastouDeTudo` em `detectarDesvio`
(`detectores.ts:1589`) pela função vencedora, mantendo a mesma assinatura
de entrada (`distDestinosM`, `distDestinosAnteriorM`) — o candidato
vencedor vira a nova implementação de `afastouDeTudo` (ou uma função nova
que a substitui no call site, a decidir no plano conforme o nome mais
claro). Nenhum outro consumidor de `afastouDeTudo` deveria precisar mudar
(é usada só nesse um ponto, mais o cálculo do streak logo acima na mesma
função — confirmar durante o plano com um grep antes de assumir fechado).

## Testes

- `src/lib/detectores.test.ts`: casos novos para a função vencedora,
  cobrindo explicitamente (a) os 2 FPs confirmados de N pequeno continuam
  não disparando, (b) um caso sintético com N grande e destinos dispersos
  (shape de TTM-7C13/TTH-0G95) passa a disparar.
- Harness em si não precisa de teste unitário próprio (é uma ferramenta de
  validação, não código de produção) — mas o próprio output do harness
  (tabela candidato × recall × taxa de FP) É a evidência de aceite,
  documentada no relatório da task correspondente do plano.

## Não-objetivos

- Não mexe em classe_viaria, rumo_diverge, saida_parada, corredor OSRM,
  nem no bug do ponto_seguro (spec irmã
  `2026-08-10-ponto-seguro-parado-design.md`) — escopo é só a função
  `afastouDeTudo` e o que depende diretamente dela.
- Não reativa rumo_diverge nem saida_parada (permanecem desligados por
  `DESVIO_SO_AFASTANDO_OU_FORA_DO_TAPETE`, decisão de 01/08 fora de
  escopo aqui).
- Harness não vira ferramenta permanente de CI nesta rodada — script
  utilitário em `scripts/`, rodado manualmente durante a execução do
  plano. Virar suíte de regressão automatizada fica para depois, se a
  necessidade aparecer.
