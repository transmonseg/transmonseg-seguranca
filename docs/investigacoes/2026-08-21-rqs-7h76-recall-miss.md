# Investigação: RQS-7H76, desvio que a Unitrac pegou e nós não (21/08 ~12:08)

**Data da investigação:** 2026-08-22
**Origem:** reportado pela operação no grupo "DESVIO DE ROTA" em 21/08 12:08 — "7H76 Está com desvio pela unitrac, não apareceu no sistema".
**Pergunta:** qual gate impediu o disparo?

## Resumo

A premissa do reporte está **parcialmente errada**: o sistema **disparou** um alerta de
desvio real e correto para o RQS-7H76 às **11:44:31 BRT** ("Afastando de todos os clientes
pendentes e da base", corroborado por corredor real fora de rota, `match_confianca` 0.88) —
24 minutos antes do reporte, e a divergência **continuou crescendo** por mais ~7 minutos
depois disso (streak de afastamento subiu de 2 até 9). O que explica "não apareceu no
sistema" às 12:08 não é nenhum dos 6 gates listados no brief: um operador marcou esse
alerta como **falso_positivo apenas 1min43s depois** de ele aparecer (11:46:14 BRT) —
enquanto a divergência ainda estava ativamente crescendo — e essa marcação **silenciou o
tipo `desvio` para este veículo por 2 horas** (mecanismo `contaComoEventoDeSilenciamento` /
`mapaTiposSilenciados`, `route.ts:1432-1445`), cobrindo toda a janela até ~13:46 BRT. Não
houve nenhum outro alerta de `desvio` para esta placa entre 13:00 e 18:00. Separadamente,
o sinal interno do próprio detector já tinha parado de crescer por volta de 11:52 (o veículo
ficou parado ~11min e depois passou a se aproximar de um dos pendentes, "RESTAURANTE E
POUSADA EBENEZER") — então mesmo sem o silenciamento, é incerto se um novo disparo teria
saído exatamente às 12:08 pelo critério "afastando de TUDO" (ver limitação ao final).
Esse mesmo padrão — desvio real disparado minutos antes do horário reportado, marcado
falso_positivo pelo operador — aparece em pelo menos 6 dos 8 casos da investigação paralela
de marcações faltantes do mesmo dia (`docs/investigacoes/2026-08-21-marcacoes-faltantes.md`),
o que reforça que não é coincidência isolada deste veículo.

## O rastro

Veículo `RQS-7H76` (`f50697c3-fd35-47b4-9009-ef76e50977b0`), cliente Nutry Max confirmado.
77 leituras em `posicoes_historico` entre 11:30 e 12:40 BRT — veículo em operação o tempo
todo (velocidades de 0 a 55 km/h, movimento real constante, sem gaps).

| Horário (BRT) | lat | lng | vel (km/h) | Observação |
|---|---|---|---|---|
| 11:30:41 | -22.597712 | -43.296538 | 15 | |
| 11:36:33 | -22.588360 | -43.303810 | 0 | |
| 11:42:36 | -22.586783 | -43.304698 | 0 | |
| 11:44:53 | ~ | ~ | ~14-21 | 1º disparo em `desvio_disparo_log` (streak=2) |
| 11:46:14 | | | | Alerta de desvio marcado **falso_positivo** pelo operador (1min43s após surgir) |
| 11:48:05 | -22.573652 | -43.308430 | 32 | streak=5 |
| 11:51:44 | ~ | ~ | ~6 | streak=9 (pico) |
| 11:52:29 | ~ | ~ | 6 | streak cai a 8; último `desvio_disparo_log` do dia inteiro |
| 11:53:08–12:04:30 | -22.591... | -43.317... | **0 (parado ~11min)** | Veículo parado, sem se mover |
| 12:06:44–12:20:05 | | | 9–29 | Retoma movimento, **aproximando** monotonicamente de "RESTAURANTE E POUSADA EBENEZER" (642115): 2393m → 39m |
| 12:39:32 | -22.596952 | -43.313385 | 40 | fim da janela |

Deslocamento total acumulado no período (soma dos segmentos, haversine): **9.492m**.
Deslocamento ponta-a-ponta (11:30→12:39): 1.732m — a diferença mostra que o veículo andou
bastante, mas em voltas/manobras dentro de uma área relativamente contida, não numa fuga
retilínea longa.

## O que o motor via

**Destinos carregados (`pendentes_snapshot_log`):** o veículo tinha entre **9 e 2 pendentes
carregados** ao longo de toda a janela 11:00–13:00 BRT (nunca zero) — a hipótese "sem
destinos carregados" (levantada pela investigação paralela de marcações faltantes, onde
4/8 veículos tinham zero pendentes por dias seguidos) **não se aplica a este caso**,
confirmado com dado direto. Os pendentes eram: 612385 (Mercado Machado Barbosa), 121892
(Jaci Paes de Abreu), 642115 (Restaurante Ebenezer), 60756 (Hott Silveira, ~78km em Campos
dos Goytacazes — 2ª base da Nutry Max), mais base (~27-31km).

**`desvio_disparo_log` (11:00–13:30 BRT): 9 entradas, todas entre 11:44:53 e 11:52:29:**

| Horário BRT | streak_afastando | streak_rua_rara | corredor_confirmou | match_confianca |
|---|---|---|---|---|
| 11:44:53 | 2 | 0 | true | 0.881 |
| 11:46:08 | 3 | 0 | true | 0.907 |
| 11:47:04 | 4 | 0 | true | 0.939 |
| 11:48:04 | 5 | 0 | true | 0.964 |
| 11:48:57 | 6 | 1 | true | 0.934 |
| 11:49:40 | 7 | 0 | true | 0.936 |
| 11:50:38 | 8 | 1 | true | 0.648 |
| 11:51:44 | 9 | 2 | true | 0.509 |
| 11:52:29 | 8 | 0 | true | 0.310 |

Ou seja: o sinal A (`afastando_geral`) **foi avaliado a cada ciclo** e **disparou**
repetidamente, com corroboração do corredor real em 100% dos ciclos e confiança de posição
alta na maior parte deles. Nenhuma entrada existe fora dessa janela no dia inteiro — o sinal
parou de crescer sozinho por volta de 11:52 (ver rastro acima: o veículo parou de se mover
por ~11min e depois passou a se aproximar de um pendente, o que decai o streak por
definição em `avaliarAfastandoDeTudo`, `src/lib/desvio.ts:80`).

**`alertas` do dia (RQS-7H76), qualquer tipo:** 7 no total. O único de tipo `desvio`:

```
id: 117ea208-3b55-4a24-9a10-f3ea68a05486
desde: 2026-08-21 11:44:31 BRT
resolvido_em: 2026-08-21 11:46:14 BRT  (1min43s depois)
nivel: critico | score: 32 | status: falso_positivo | operador_id: preenchido (ação humana)
motivo: "Afastando de todos os clientes pendentes e da base (distância real de rua)
         (corroborado por: corredor real fora de rota)"
contexto: {} (sem auto_resolvido=true — conta como evento de silenciamento)
```

Nenhum outro alerta (de nenhum tipo) apareceu entre 11:46 e 13:13 BRT — a "vaga" da
arbitragem não foi ocupada por nada nesse intervalo porque nada mais disparou.

**`desvio_estado` (estado atual, não histórico):** `afastando_streak=0`,
`rua_rara_streak=0`, atualizado pela última vez às 00:42 BRT do dia seguinte (22/08) — como
a tabela é sobrescrita a cada ciclo, não serve para reconstruir o valor às 12:08 do dia
anterior; usei `desvio_disparo_log` (imune a isso por design) como fonte de verdade do
streak histórico, como o brief já antecipava.

## Gate que barrou

Não foi nenhum dos 6 gates candidatos do brief. O mecanismo real:

**`mapaTiposSilenciados`, construído em `src/app/api/motor/route.ts:1432-1445`, a partir de
`contaComoEventoDeSilenciamento` (`src/lib/detectores.ts:580-589`).**

A cada ciclo do motor, o sistema busca todo alerta com `status='falso_positivo'` e
`resolvido_em >= agora - 2h` (`desde2h`, `route.ts:540`) por cliente. Para cada um cujo
`contexto` não tenha `auto_resolvido===true` (ou seja, foi um clique humano de "falso
positivo" na UI, não um auto-resolve do próprio motor), o `tipo` daquele alerta é
**silenciado para aquele veículo específico pelas próximas 2 horas** — nenhum novo alerta
daquele tipo é inserido nem escala o nível de um existente (`route.ts:3068`, todo o bloco de
insert/escalate fica dentro de `if (!silenciado)`).

O alerta `117ea208...` foi marcado falso_positivo às 11:46:14 BRT com `contexto={}`
(sem `auto_resolvido`), então `contaComoEventoDeSilenciamento` retornou `true`. A partir do
próximo tick do motor, `desvio` ficou silenciado para RQS-7H76 até ~13:46:14 BRT — cobrindo
integralmente o horário do reporte (12:08). O `desvio_disparo_log` seguiu gravando (essa
tabela é escrita antes da checagem de silenciamento, por design — ver comentário em
`route.ts:2761-2767`), então o sinal continuou sendo avaliado e disparando internamente
(streak até 9), só que **sem nenhum efeito visível para o operador**: nenhuma linha nova em
`alertas`, nenhuma escalada de nível.

## Hipóteses descartadas

- **Streak não chegou a `LIMIAR_STREAK_AFASTANDO` (2)?** Descartada com dado direto: o
  streak passou de 2 (11:44:53) e chegou a 9 (11:51:44) — muito acima do limiar.
- **`movimentoInsignificante` (< 50m) suspendeu a avaliação?** Descartada para o episódio
  11:44–11:52: os deslocamentos entre leituras nesse intervalo variam de ~60m a ~660m, bem
  acima do limiar de 50m (ver tabela do rastro). O gate agiu corretamente mais tarde
  (11:53–12:04, veículo genuinamente parado), mas isso é comportamento correto, não a causa
  do "não apareceu".
- **`emTransitoLongo` (menor distância relevante > 300km) zerou o streak?** Descartada: a
  distância mais distante entre os destinos *relevantes* (filtro de 50km em
  `LIMIAR_DESTINO_RELEVANTE_M`, `route.ts:2505-2508`) nunca passou de ~17km no episódio —
  muito abaixo de 300km. O pendente a ~78km (Hott Silveira, Campos dos Goytacazes) já é
  excluído do cálculo por estar fora do raio de 50km, então nem chega a competir para o
  `Math.min` do sinal.
- **Array de destinos vazio (sem pendentes carregados)?** Descartada com dado direto: entre
  9 e 2 pendentes carregados durante toda a janela 11:00–13:00 BRT — nunca zero. Esta é
  exatamente a hipótese "barata" sinalizada pela investigação paralela (veículos com zero
  pendentes por dias); **não se aplica a este veículo/dia**.
- **Veículo dentro da base ou no cliente (gates anteriores, `suspensoPorChegada`/
  `emCarenciaDeBase`)?** Descartada: às 11:44 o veículo estava a ~27-31km da base e a mais
  de 400m de qualquer pendente, em movimento a 15-40km/h — nenhum dos dois gates de
  proximidade se aplicava.
- **Outro tipo de alerta ocupou a vaga na arbitragem?** Descartada: nenhum outro alerta
  (de qualquer tipo) existe para este veículo entre 11:46 e 13:13 BRT — não havia candidato
  concorrente disputando a arbitragem nesse intervalo.

## Proposta

**Não implementado — apenas diagnóstico, conforme escopo desta task.**

O problema real não é um limiar de detecção (esses continuam corretos e recall-first): é
que a política de silenciamento de 2h (desenhada para não repetir o mesmo falso positivo
"ensinado" pelo operador) trata **qualquer** clique humano em falso_positivo como sinal
confiável, mesmo quando o clique acontece 1min43s depois do alerta aparecer e a divergência
real ainda está em andamento (streak ainda subindo). Duas direções possíveis, com o
trade-off explícito de cada uma:

1. **Não confiar cegamente em dispensas muito rápidas.** Se o alerta for marcado
   falso_positivo dentro de poucos minutos (ex. <2-3min) e o streak/sinal subjacente ainda
   estava subindo no momento do clique, não contar esse evento como
   `contaComoEventoDeSilenciamento` (ou reduzir a janela de silêncio para esse caso
   específico). *Trade-off:* isso reintroduz o próprio ruído que o silenciamento de 2h foi
   criado para resolver (revisar o volume de "desvio" que motivou esse recurso) — precisa
   ser calibrado contra dado real (mesmo processo usado para `LIMIAR_STREAK_AFASTANDO`),
   não decidido a priori.
2. **Não silenciar `desvio` se o streak subjacente ultrapassar o pico observado no momento
   do falso_positivo.** Ou seja: o silenciamento vale para "o mesmo padrão que o operador
   viu e descartou", não para "qualquer novo pico maior que já era maior quando ele
   descartou". *Trade-off:* mais complexo de implementar corretamente (exige guardar o
   streak no momento da dispensa, não só o tipo), e ainda não resolve o caso onde a
   divergência de fato parou por si (como aconteceu aqui às ~11:52, quando o veículo se
   aproximou de um pendente) — nesse caso o silenciamento nunca teria sido testado de
   qualquer forma.

Qualquer uma das duas aumenta recall de `desvio` justamente nos casos onde o operador é
mais propenso a errar (decisão apressada) — o trade-off simétrico é mais alertas
`desvio` reaparecendo pouco depois de terem sido dispensados, que é exatamente o ruído que
a feature de silenciamento existe para evitar. Vale medir contra um dia real (mesmo
processo de `scripts/simular-dia-desvio-v2.mjs`) antes de mudar o comportamento em
produção.

## Limitações

- **Não temos o log de alerta da Unitrac em si** (nem timestamp exato nem geometria da
  rota de referência dela) — não dá para confirmar com certeza se o "desvio" que a operação
  viu às 12:08 é o mesmo episódio de 11:44-11:52 (relatado com ~24min de atraso, comum em
  fluxo de WhatsApp) ou um evento novo e diferente ocorrendo exatamente às 12:08. Pelo
  cálculo de distância em linha reta (aproximação; o motor usa distância real de rua via
  OSRM, que não reproduzi aqui) às 12:08:27 BRT, o veículo estava **se aproximando de
  todos os 5 destinos simultaneamente** (nenhuma distância cresceu entre 12:07:42 e
  12:08:27) — ou seja, pelo critério "afastando de tudo" não haveria sinal ali de qualquer
  forma, silenciamento à parte. Se o reporte da Unitrac se refere de fato a esse instante
  exato (e não ao episódio anterior), a explicação seria estrutural — Unitrac provavelmente
  compara contra uma rota planejada perna-a-perna, enquanto nosso Sinal A só dispara quando
  o veículo diverge de **todos** os destinos ao mesmo tempo, por design (para não confundir
  desvio real com geometria de rua até um destino específico) — não um gate quebrado, mas
  uma diferença de método de detecção. Não consigo decidir entre as duas leituras sem o
  dado da Unitrac; ambas estão documentadas acima com a evidência disponível.
- A distância usada na seção de limitação acima é linha reta (haversine), não a distância
  real de rua via OSRM que o motor de fato usa — serve como indicador direcional, não como
  reprodução exata do sinal.

## Adendo (2026-08-22): interação com a mudança de 20/08 na revisão de desvio

Contexto que não tinha ao escrever o corpo acima: em **20/08** (véspera deste caso) foi
shipada `TIPOS_REVISAO_INDIVIDUAL = new Set(["desvio", "parada_fora_tapete"])`
(`src/app/(app)/central-v2/MonitorV2.tsx:98`), usada para filtrar
`alertasResolviveisEmMassa` (`MonitorV2.tsx:1160`) — o botão "Resolver todos" deixou de
poder fechar alertas desses dois tipos. Motivo documentado no próprio arquivo
(`MonitorV2.tsx:2447-2451`): em 19/08, 29 dos 35 desvios marcados "correto" vieram de
cliques em lote e só 6 de revisão individual, contaminando a calibração. A partir de 20/08,
`desvio` só pode ser tratado card a card.

**Verifiquei a mecânica exata dos dois caminhos de escrita** (`src/app/(app)/acoes-alertas.ts`):
- `resolverVarios` ("Resolver todos", linhas 91-149) grava sempre `status: "resolvido"`,
  nunca `status: "falso_positivo"` — não existe um "falso positivo em massa".
- `marcarFalsoPositivoComMotivo` (linhas 68-81, chamada pelo botão individual "Falso
  positivo" de um card) grava `status: "falso_positivo"`, `origem_acao: "falso_individual"`.

O silenciamento de 2h (`contaComoEventoDeSilenciamento` / `mapaTiposSilenciados`) dispara
apenas para linhas com `status='falso_positivo'` (`route.ts:1432-1445`) — ou seja, **só o
caminho individual pode acioná-lo; o antigo "Resolver todos" em lote nunca acionava**,
porque nunca escreve esse status. Antes de 20/08, um desvio que um operador considerasse
"não é nada" podia ser descartado via clique em massa sem tocar no silenciamento. Depois de
20/08, esse mesmo julgamento só pode ser expresso via um dos dois botões individuais
(Resolver ou Falso positivo) — e, quando o operador escolhe "Falso positivo" (o rótulo
semanticamente certo para "isso não é um desvio real"), aciona o silenciamento de 2h.
**A mudança que corrigiu a contaminação da calibração aumenta, como efeito colateral não
previsto, a frequência do gatilho que causou o miss deste caso.**

**O caso RQS-7H76 é a primeira manifestação observada dessa interação** — 1 dia depois do
deploy de `TIPOS_REVISAO_INDIVIDUAL`. Confirmei com consulta direta ao banco que a linha do
alerta `117ea208-3b55-4a24-9a10-f3ea68a05486` tem `origem_acao = 'falso_individual'`
(não `resolver_massa`) — ou seja, o clique de 1min43s que silenciou o tipo `desvio` para
este veículo só foi possível *porque* desvio já não podia mais ser fechado em lote naquele
dia. Não tenho dado de antes de 20/08 para comparar taxa de silenciamento (a coluna
`origem_acao` e a lógica de silenciamento já existiam antes; o que mudou foi só o volume
que passa a percorrer o caminho individual) — então "primeira manifestação observada" é
sobre este caso específico, não uma alegação de que o problema não existia antes.

**Isso reforça a proposta original, não a reformula.** A Proposta 1 ("não confiar
cegamente em dispensas muito rápidas") já mirava exatamente este mecanismo; o que muda é a
urgência: a mudança de 20/08 empurra mais decisões de desvio para o único caminho que pode
acionar o silenciamento, então o volume de exposição a esse risco tende a subir, não cair,
depois da correção de calibração. As duas mudanças (a de 19-20/08 e o que está documentado
aqui) puxam em direções opostas de um mesmo eixo — dado de calibração mais limpo vs. mais
cegueira operacional de 2h — e isso não estava visível para quem decidiu a mudança de 20/08,
porque não são a mesma pessoa nem o mesmo momento de decisão.

**Trade-off explícito para quem for decidir:**
- Encurtar ou condicionar a janela de 2h aumenta o risco de ruído repetido — exatamente o
  problema que a Task 2 deste mesmo plano acabou de resolver para o tipo `parada`, via
  cooldown por episódio (`deveSuprimirRedisparoParada`). Aplicar uma lógica equivalente a
  `desvio` não é uma cópia direta: parada tem um "episódio" bem definido (`parado_desde`);
  desvio, no sinal atual, não tem um conceito de episódio persistido além do streak
  (que já reseta), então precisaria de desenho próprio.
- Manter a janela como está aceita cegueira de 2h toda vez que um clique de "Falso
  positivo" for apressado — e a mudança de 20/08 aumenta quantas vezes esse clique
  acontece por não ter mais a válvula de escape do "Resolver todos" em lote.
- Meio-termo possível, **como sugestão, não recomendação fechada**: silenciar só a partir
  da 2ª ou 3ª marcação de falso_positivo do mesmo tipo+veículo dentro de uma janela curta
  (exige repetição do julgamento antes de confiar nele), ou tornar a janela de silêncio
  proporcional ao tempo que o operador levou entre o alerta aparecer e a decisão (um
  clique em 1min43s pesa menos que um clique após 10min de análise). Nenhuma das duas foi
  validada contra dado real — precisam do mesmo tratamento que os limiares de streak já
  receberam (simulação de dia real antes de ir para produção).

Nenhum código de produção foi alterado para produzir este adendo — apenas leitura de
`MonitorV2.tsx`, `acoes-alertas.ts` e uma consulta de confirmação no banco de produção.
