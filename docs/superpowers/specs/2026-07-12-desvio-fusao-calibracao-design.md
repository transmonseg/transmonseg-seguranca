# Fusao de sinais, calibracao ao vivo e correcoes pontuais do desvio, Design

**Data:** 2026-07-12
**Status:** em revisao com o usuario

## Problema

O redesenho fundamentado de 11/07 (spec
`docs/superpowers/specs/2026-07-11-desvio-redesenho-fundamentado-design.md`, plano
`docs/superpowers/plans/2026-07-11-desvio-redesenho-fundamentado.md`) foi implementado,
auditado e esta em producao. Depois de um dia observando o sistema ao vivo, quatro
lacunas concretas ficaram claras:

1. A calibracao (Fase 5 do redesenho anterior) so escreve `calibracao_desvio`; nada le
   essa tabela pra ajustar score/comportamento em producao. E calibracao de mentirinha.
2. Os detectores competem por "quem tem o score mais alto" em vez de se corroborarem.
   Pior: hoje, quando o jammer dispara, a checagem de desvio comportamental **nem chega
   a rodar** naquele ciclo (`let alerta = alertaJammer ? alertaJammer : avaliar(...)`,
   `route.ts:1449`) -- o combo mais valioso de todos ("jammer + desvio ao mesmo tempo",
   confirmado pela pesquisa de 11/07 como o padrao de maior confianca da industria)
   nunca teve chance de acontecer.
3. `bypass_entrega` tem um ponto cego documentado desde a auditoria de 11/07 (comentario
   em `route.ts:1377-1396`): identifica o alvo por `codigo` (numero da nota fiscal), nao
   por `pontoCodigo` (endereco fisico) -- varias NFs pendentes no mesmo endereco resetam
   o cronometro de permanencia sem o veiculo ter saido do lugar.
4. `baseline_veiculo` se autopolui: confirmado com dado real (TTH-6G37, 87km/h sustentado,
   z-score caiu de 14.5 pra 3.5 em 10min) -- cada ciclo de 30s conta como "1 amostra",
   entao um evento anomalo sustentado acaba entrando no proprio baseline enquanto
   acontece, mascarando a si mesmo.

Um quinto item levantado (correlacao com transito real, tipo Waze/Google, pra reduzir
falso positivo de corte de transito legitimo) foi pesquisado e a conclusao pratica foi:
nao existe fonte gratuita E self-serve com cobertura real (HERE Traffic API e a unica
opcao self-serve viavel, ~US$10/mes, quebrando a regra de orcamento zero do projeto
inteiro). O usuario escolheu a alternativa gratuita: inferir congestionamento pela
PROPRIA FROTA (floating car data), reaproveitando um padrao ja existente no motor
(`paradosFrescos`/`vizinhosParados`, hoje usado so pra suprimir `parada_anomala`). Esse
item se funde naturalmente com o item 2 (fusao de sinais): vira um sinal MITIGADOR (reduz
severidade) em vez de mais um detector isolado.

## Escopo

Quatro mudancas, todas internas ao subsistema de desvio, sem dependencia externa nova:

1. **Calibracao ao vivo** (fecha o loop da Fase 5 do redesenho anterior).
2. **Fusao de sinais + transito inferido pela frota** (a mudanca de maior risco, mexe no
   nucleo de arbitragem usado por TODOS os tipos de alerta, nao so desvio).
3. **Correcao do ponto cego do `bypass_entrega`** (chave de rastreio por endereco, nao
   por nota fiscal).
4. **Correcao da autopoluição do baseline** (nao incorpora amostra anomala no
   baseline enquanto o evento estiver ativo).

Fora de escopo (nao mudou desde a decisao do usuario nesta sessao): API de transito
paga, deteccao de inicio/fim de viagem formal, e qualquer coisa que exija dado que o
sistema nao coleta hoje.

## 1. Calibracao ao vivo

Hoje `scripts/recalibrar-desvio.mjs` escreve `taxa_falso_positivo` (e deixa
`score_ajustado` sempre `null`) na tabela `calibracao_desvio` (migration 019). Em vez de
inventar o que "score ajustado" deveria significar como valor absoluto (alertas do mesmo
tipo tem scores base muito diferentes -- 45, 68, 75, 80, 85 pro `desvio` sozinho -- um
valor fixo por segmento nao se aplica igual a todos), a taxa de falso positivo ja
calculada vira um FATOR aplicado ao vivo no motor:

```
fator = 1 - taxa_falso_positivo_calibrada
score_final = round(score_base * fator)
```

Isso e proporcional ao score original (nunca inverte a ordem de severidade dentro do
mesmo tipo), simples de explicar e de testar. So aplica quando o segmento ja tem
amostra suficiente (`n_amostras >= 20`, mesma regra ja estabelecida no redesenho
anterior); sem isso, o score sai sem ajuste (igual hoje). Prefere o segmento mais
especifico disponivel (ex: `corredor_veredito:fora`) e cai pro generico (`tipo:desvio`)
se nao houver dado especifico pro caso -- mesmo padrao hierarquico ja usado no fallback
`baseline_veiculo` -> `baseline_frota`.

A coluna `score_ajustado` fica sem uso neste ciclo (documentado em comentario no codigo
pra nao confundir quem ler depois) -- o fator e sempre derivado ao vivo de
`taxa_falso_positivo`, nao precisa de uma segunda coluna calculada e guardada.

**Onde entra no motor:** depois que a arbitragem (item 2) decide o alerta vencedor do
ciclo, antes de gravar no banco, busca a calibracao do(s) segmento(s) relevantes
(carregada uma vez por ciclo, tabela pequena, mesmo padrao de `mapaBaselineVeiculo`) e
aplica o fator ao `score` final.

## 2. Fusao de sinais (o item de maior risco)

### O problema estrutural

`route.ts:1449` hoje faz:
```ts
let alerta: Alerta | null = alertaJammer ? alertaJammer : (pos.fresco ? avaliar(pos, {...}) : null);
```
Quando `alertaJammer` existe, `avaliar()` (que contem a deteccao de desvio comportamental,
Camada 1) **nunca roda** nesse ciclo. Rodar corredor/desvio so quando `alerta?.tipo ===
"desvio"` (linha 1499) tambem depende de `alerta` ja ser desvio -- ou seja, o sistema
hoje e incapaz de saber que jammer e desvio aconteceram juntos, porque um bloqueia a
deteccao do outro antes de qualquer arbitragem acontecer.

### Redesenho da ordem de calculo

`avaliar(pos, {...})` passa a rodar **sempre** que `pos.fresco`, independente de
`alertaJammer` -- vira um candidato `alertaDesvioCandidato`, calculado em paralelo, nao
mais atras de um `?:` que apaga o outro. A verificacao de corredor (Camada 1,
`CAMADA_CORREDOR_ATIVA && alerta?.tipo === "desvio" && ...`, hoje ancorada em `alerta`)
passa a ser ancorada direto em `alertaDesvioCandidato` -- mesma logica de hoje (suprime
quando corredor confirma "dentro", exige confirmacao quando `exigeConfirmacaoCorredor`),
so que aplicada ao candidato especifico, nao ao vencedor da arbitragem (que ainda nao
foi decidido nesse ponto do ciclo).

### Arbitragem nova (funcao pura, testavel isolada)

Nova funcao em `src/lib/detectores.ts`, algo como
`arbitrarAlertas(candidatos: Alerta[]): Alerta | null`, substituindo o loop atual
(`for (const extra of extras) { if (extra.score > alerta.score) alerta = extra; ... }`):

1. Recebe a lista completa de candidatos do ciclo: `alertaJammer`,
   `alertaDesvioCandidato`, `alertaCerca`, `alertaBypass`, `alertaBaseline`, e os extras
   ja existentes (retorno tardio, parada noturna, aceleracao brusca), tudo filtrado por
   nao-nulo.
2. Escolhe o de maior score como base (igual hoje).
3. Conta quantos **TIPOS DISTINTOS** de sinal de seguranca relevante estao presentes
   simultaneamente. `desvio` conta como 1 tipo mesmo se `alertaDesvioCandidato` E
   `alertaCerca` dispararem juntos (sao dois DETECTORES pro mesmo conceito -- desvio --
   nao dois sinais independentes). O conjunto que conta pra corroboracao e
   `{jammer, desvio, bypass_entrega, baseline_veiculo}` -- os sinais que a pesquisa de
   11/07 confirmou como relevantes de seguranca. Os "extras" mais operacionais (retorno
   tardio, parada noturna, aceleracao brusca) continuam disputando a arbitragem
   normalmente, so nao contam pra bonus de corroboracao (manter o sinal de corroboracao
   restrito ao que a pesquisa validou, evita diluir o efeito).
4. Se 2+ tipos distintos do conjunto relevante estiverem presentes: soma um bonus fixo
   por tipo extra alem do primeiro (`+15` por tipo adicional, capado em 100) ao score do
   vencedor, e acrescenta ao `motivo` quais outros sinais corroboraram (ex: "(corroborado
   por: jammer, baseline anomalo)"), pra o operador entender o motivo da escalada.
5. Sem corroboracao (0 ou 1 tipo do conjunto relevante presente): comportamento
   identico ao de hoje, maior score vence sozinho.

### Transito inferido pela frota (item 5, dobra dentro da fusao)

Reaproveita e generaliza `paradosFrescos`/`vizinhosParados`
(`route.ts:858-873,1217-1223`), que hoje so rastreia veiculos frescos **parados**
(`velocidade === 0`) pra suprimir `parada_anomala`. Generaliza a coleta pra guardar
`{lat, lng, velocidade}` de TODO veiculo fresco do cliente (nao so parado), permitindo
computar tanto `vizinhosParados` (filtro `velocidade === 0`, comportamento identico ao de
hoje) quanto um novo `vizinhosLentos` (filtro `0 < velocidade <= 20`, mesmo raio
`RAIO_CONGESTION_M`).

Quando o alerta vencedor da arbitragem e do tipo `desvio` em contexto de rodovia (buffer
da cerca = 200m, ou seja `pos.velocidade` no momento da SEMEADURA foi >= 60km/h) E o
veiculo desacelerou bastante (proxy de "saiu da via principal"), 2+ vizinhos lentos da
propria frota por perto reduz a severidade (`-20` no score, nunca abaixo de um piso
minimo que mantenha o alerta visivel) -- corrobora transito real em vez de desvio
suspeito, igual ao insight do audio do cliente ("cortar transito" e ambiguo, mas se
outros carros da frota tambem estao lentos ali, pesa pra explicacao legitima).

### Rede de seguranca

Depois de implementar, roda a suite de testes completa (`avaliar()` ja tem cobertura
extensa: panico, bau, jammer, parada_longa, parada_cliente, saida_nao_autorizada,
desvio, tiroteio) pra confirmar que nenhum caso de sinal UNICO mudou de comportamento --
a mudanca so deve alterar o resultado quando 2+ sinais relevantes coincidem no mesmo
ciclo, que e um caso raro e novo, nao os casos ja cobertos hoje.

## 3. Correcao do ponto cego do bypass_entrega

Troca a chave de rastreio de permanencia no raio de `codigo` (NF) pra `pontoCodigo`
(endereco fisico). Concretamente: `alvoNoRaioAgora` passa a ser encontrado (e comparado
pra "mesmo alvo que antes") por `pontoCodigo`, nao por `codigo`. Isso resolve o caso mais
comum e valioso (varias NFs pendentes no mesmo endereco nao resetam mais o cronometro de
dwell a toa). O caso de dois enderecos FISICAMENTE DIFERENTES com raio sobreposto
continua como limitacao aceita e documentada (ja estava no comentario da auditoria de
11/07) -- resolver isso exigiria rastrear todos os pontos simultaneamente, complexidade
desproporcional pra um caso raro (exigiria dois enderecos de entrega a poucos metros um
do outro).

## 4. Correcao da autopoluicao do baseline

Em `route.ts`, no bloco que acumula `amostrasBaselineCiclo` pra depois atualizar
`baseline_veiculo`/`baseline_frota` em lote: quando `alertaBaseline` (o resultado de
`detectarAnomaliaBaseline` NESTE ciclo, calculado ANTES do bloco de atualizacao) nao for
nulo -- ou seja, a leitura atual ja foi sinalizada como anomala -- essa amostra especifica
NAO entra em `amostrasBaselineCiclo`. O baseline "congela" enquanto o evento anomalo
persiste, e volta a incorporar amostras normalmente assim que a leitura deixar de ser
anomala. Isso e uma tecnica padrao de estatistica robusta (nao contaminar o estimador
com outliers detectados) e nao exige nenhum conceito novo de "viagem" no schema.

## Amendment: reduzir conservadorismo (12/07, achados da revisao linha por linha)

Depois de escrever o design acima, o usuario pediu uma revisao direta de TODO ponto do
codigo que suprime/bloqueia um alerta de desvio (`return null` em `detectarDesvio` e
detectores vizinhos), buscando onde desvio real pode estar passando batido por excesso
de cautela. Revisao linha por linha de `src/lib/detectores.ts` achou 4 pontos reais.
Tres viram mudanca agora; um fica documentado como decisao consciente de NAO mexer.

### E. Parada subita sem aviso previo (mudar)

`detectarDesvio` exige `p.velocidade > 0` pra criar qualquer alerta (linha 574) -- um
veiculo que ja tinha alerta de desvio aberto continua coberto (nunca fecha sozinho), mas
um veiculo que e forcado a parar de repente, ANTES de ter construido streak de desvio
(primeira leitura anomala ja e uma parada), so tem cobertura via `detectarParadaAnomala`,
que hoje exige 20min (cidade) ou 35min (estrada) parado antes de disparar qualquer
coisa -- mesmo o proprio comentario do codigo (`detectores.ts:253`) reconhecendo que "um
roubo tipico acontece em 10-20min". Os limiares atuais (20/35min) estao NA BORDA ou
DEPOIS do que a propria pesquisa ja documentada considera critico.

**Mudanca:** baixar `limiteMin` de 20/35 pra **8min (cidade) / 15min (estrada)** em
`detectarParadaAnomala`. Falso positivo aceitavel (parada legitima curta vira alerta
com mais frequencia), mas corta a janela cega de ate 35 minutos pra uma janela de no
maximo 15.

### F. Camada 3 (via nunca percorrida pela frota) religada

`CAMADA3_TAPETE_ATIVA = false` desde 09/07/2026, por causa de flapping em rotas
rurais/serra com tapete esparso (74 Camada 1 vs 75 Camada 3 em 6h, disparando e
resolvendo a cada 2min). A causa RAIZ daquele incidente especifico -- o alerta se
FECHAVA sozinho e reabria, indistinguivel de bug -- ja foi corrigida hoje (desvio nunca
mais fecha sozinho). O sintoma que restaria ao religar (mais alertas HOJE em rotas
rurais com tapete esparso) e um falso positivo "que faz sentido" pelo criterio do
proprio usuario (regiao com pouca cobertura, alerta fica ABERTO aguardando o operador,
nao fica piscando), nao o tipo de ruido sem sentido que motivou a desativacao.

**Mudanca:** `CAMADA3_TAPETE_ATIVA = true`. **Escopo consciente:** a ideia mais
sofisticada (cobertura minima POR REGIAO, nao por cliente inteiro -- ja proposta em
`docs/analise-deteccao.md` 09/07, nunca implementada) fica de FORA deste ciclo --
resolve a esparsidade rural de forma mais fina, mas e um projeto proprio (definir o que
conta como "regiao", agregar densidade por regiao). Religar com o piso global
(`TAPETE_MIN_CELULAS = 300`, hoje folgado: 197k+ celulas acumuladas) e o suficiente pra
esse ciclo, dado que o mecanismo de flapping que tornava isso inaceitavel ja foi
corrigido.

### G. Teto de deslocamento interurbano

`DESVIO_GATILHO_TETO_M = 80000` (subido de 25km pra 80km ontem) continua sendo um teto
ABSOLUTO -- acima disso, Camada 1 nunca dispara desvio comportamental, nao importa o
quao suspeito. Um sequestro que levasse o caminhao mais de 80km de qualquer destino
conhecido ficaria invisivel pra esse detector especifico (a cerca virtual e o baseline
por veiculo nao tem esse teto, entao ainda haveria alguma chance de deteccao por outra
via, mas nao dessa).

**Mudanca:** subir `DESVIO_GATILHO_TETO_M` pra **300000 (300km)** -- cobre
confortavelmente qualquer entrega dentro do RJ e estados vizinhos (SP, MG, ES) mantendo
so um piso de sanidade contra leitura de GPS corrompida/absurda (ex.: coordenada do
outro lado do planeta), sem mais funcionar como teto que esconde desvio real dentro da
faixa de operacao normal da frota.

### H. Bloqueio quando a API de destinos falha (decisao consciente: NAO mudar)

Confirmado no codigo (`route.ts:836-1467`): `alvosApiOk === false` bloqueia
especificamente `detectarDesvio` (Camada 1) e `candidatoSaidaParado`
(saida_nao_autorizada parado) -- quando a API `/alvos` da Unitrac falha, os mapas de
pendentes ficam vazios, o que faz a cerca virtual tambem naturalmente nao ter nada pra
verificar (`pendentes.length > 0` fica falso). Jammer, panico, bau, excesso de
velocidade, parada_longa, parada_anomala, baseline_veiculo e tiroteio proximo continuam
funcionando normalmente -- NAO e uma cegueira total do sistema, so dos detectores que
dependem de saber quais sao os destinos.

**Por que nao mexer:** essa guarda existe por causa de um incidente REAL e ja validado
(06/07/2026): sem ela, quando a API falha, os destinos de TODOS os veiculos colapsam pra
"so as bases", e quase todo veiculo em operacao parece "afastando-se de tudo"
simultaneamente -- um estouro de alerta em massa pro cliente inteiro de uma vez, nao um
falso positivo isolado que faz sentido. E uma classe de risco diferente dos outros 3
itens (nao e "um desvio raro passando batido", e "o sistema inteiro grita ao mesmo tempo
e o operador para de confiar nele"). Falso positivo aceitavel nao cobre "alarme em massa
correlacionado, causado por uma falha tecnica, no cliente inteiro" -- fica como esta.

## Testes e validacao

Mesma disciplina do redesenho de 11/07: TDD por funcao pura nova/alterada
(`arbitrarAlertas`, ajuste em `atualizarBaselineWelford`/wiring do baseline, funcao de
calibracao ao vivo), validacao completa (`tsc`, `eslint`, `vitest`, `build`) antes de
cada commit, execucao em worktree isolado (branch separada, merge so no final),
auditoria adversarial via Agent antes do merge (o mesmo processo que achou o bug
critico do `bypass_entrega` da vez passada) dado que o item 2 mexe no nucleo de
arbitragem usado por todos os tipos de alerta.

## Fontes desta rodada de pesquisa

- Achados empiricos de producao (11-12/07/2026): contagem de alertas por tipo desde o
  deploy, detalhe dos disparos de `baseline_veiculo` (TTH-6G37, autopoluicao
  confirmada), zero disparos de `bypass_entrega` desde o fix da auditoria anterior.
- Pesquisa de fontes de transito (12/07/2026): CET-Rio/PIT (dashboard, sem API),
  data.rio/api.dados.rio (so GPS de onibus, fora do ar no teste), TomTom (self-serve,
  grátis insuficiente ~83 req/dia), HERE (self-serve, ~US$10/mes pro volume necessario,
  unica opcao paga viavel), Mapbox (nao self-serve, descartado), floating car
  data/probe vehicle data (tecnica academica real, mas exige 5-10% de penetracao NA VIA
  ESPECIFICA, nao da frota total -- viavel so em corredores que a frota realmente
  compartilha, nao cidade inteira).
- Pesquisa anterior do mesmo dia (11/07/2026) sobre fusao de sinais/scoring ponderado
  (LightBox, SambaSafety, padrao "jammer + desvio + area de risco = confianca alta").
