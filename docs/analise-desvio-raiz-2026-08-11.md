# Análise de raiz — detector de desvio de rota (11/08)

Contexto: pedido do usuário foi "analisa o código, anota as coisas na raiz,
depois muda a estrutura das regras". Este doc é o "anotar" — feito ANTES de
qualquer mudança de código. Nenhuma das ideias abaixo foi implementada em
produção ainda.

## Bug estrutural real (dado, não regra)

### 1. ~~Pontos entregues somem do conjunto de destinos no meio do streak~~ — REVISADO, não se sustenta

Hipótese original (deste doc, versão anterior): destino sumir de `pendentes`
no meio do streak causaria salto de distância no cálculo de amplitude
(`afastouDeTudo`). **Investigação de código mais precisa (11/08, tarde)
mostrou que isso não acontece**: `distDestinosM` e `distDestinosAnteriorM`
(route.ts:1962-1965) são SEMPRE recalculados no mesmo ciclo a partir do
MESMO array `destinos` (baseado no `pendentes` atual) — só muda o ponto de
origem (posição anterior vs atual). Um destino sumindo não desalinha essa
conta especificamente. Mantido aqui riscado por honestidade — era uma
hipótese plausível que não resistiu à leitura precisa do código.

**Mecanismo real do caso TOS-2B69** (já documentado em
`scripts/backtest-desvio/candidatos.ts`, comentário da função
`percentualComPisoMagnitude`): deslocamento pequeno (~80m) perto de um
cluster de destinos gera crescimento de distância em MUITOS destinos ao
mesmo tempo, por projeção vetorial — destino muito mais longe que o
deslocamento faz o delta de distância tender ao próprio deslocamento
independente da direção. É geometria pura de "amplitude sem magnitude", já
foi a causa que motivou (e depois reverteu, por quebrar TTT-1E20) o piso de
magnitude testado hoje mais cedo.

### 2. `afastamentoAcumuladoM` compara um número congelado contra um recalculado — CONFIRMADO, CORRIGIDO 11/08

`route.ts:2027-2042`. `desvioInicio.menor_dist_m` é um SCALAR tirado 1x no
início do streak (`Math.min(...distDestinosAnteriorM)`, linha 2032) e
persistido em `posicoes_atuais.desvio_inicio` — não recalculado depois.
`menorDistDestinoM` (linha 1966), por outro lado, É recalculado TODO ciclo
a partir do `pendentes` atual (que pode ter encolhido). O acumulado é
`menorDistDestinoM - desvioInicio.menor_dist_m` (linha 2039-2042).

Se o destino mais próximo no início do streak for confirmado como entregue
NO MEIO do streak, ele some de `pendentes`, e o "mais próximo atual" pula
pro próximo destino da lista — o número de "+X km acumulado" passa a
comparar distância-até-destino-A (congelado) contra
distância-até-destino-B (atual), sem relação real com o quanto o veículo se
moveu. Confirmado (via investigação de código, `ctx.afastamentoAcumuladoM` só é
lido em detectores.ts:1863 pra montar o texto `motivo`, nunca em
conditional de score/branch): puramente textual, não afeta severidade.

**Fix aplicado 11/08** (route.ts + detectores.ts): `destinos` agora carrega
`codigo` estável por pendente (`pt:${pontoCodigo}`, null pra bases/escala).
`DesvioInicio` ganhou `pontoCodigoReferencia?` — guarda QUAL destino era o
mais próximo quando o streak começou. `afastamentoAcumuladoM` agora
rastreia a distância até ESSE MESMO destino ao longo do streak; se ele
sumir de `pendentes` (entregue), a contribuição daquele ciclo trava em 0
em vez de pular pra outro destino. Sem referência rastreável (base/escala),
mantém o comportamento antigo — não é o bug documentado ali.
Typecheck limpo, 695/695 testes passando, zero regressão. Isolado, sem
mexer em nenhuma regra de decisão — elegível a subir sozinho.

Mesmo padrão de bug se repete em `divergenciaRumoInicio` (route.ts:2285) —
não corrigido ainda, mas essa regra (`divergenciaRumoDispara`) está
DESATIVADA desde 01/08, então impacto prático é zero por enquanto.

## As duas fraquezas de desenho de regra (essas sim são "regra")

### 3. Streak binário de 2 leituras consecutivas quebra com ziguezague real

`avancarStreaksDesvio`: se uma leitura não bate o critério, o contador de
aproximação sobe; só zera o streak de desvio depois de 2 aproximações
seguidas. Na prática, um caso real de tendência de afastamento genuína pode
oscilar leitura a leitura (rua com curvas, GPS ruidoso) e nunca emplacar 2
CONSECUTIVAS acima do limiar — mesmo com a tendência agregada sendo real.

**Caso real: TTH-0G95.** Contagem de destinos-que-cresceram por ciclo, de
14 destinos: `10, 9, 4, 7, 4, 8, 4`. Nunca 2 seguidos acima do limiar
pct80 (~11-12), mas a distância ao destino mais próximo foi de 2669m para
3023m ao longo da janela — afastamento real, só que não convenceu o
streak binário nenhuma vez.

**Caso real: TTT-1E20** (motivou reverter o piso de magnitude testado hoje
mais cedo) — mesma família de problema, direção oposta: um afastamento real
de baixa magnitude por leitura (~83m mediana) foi bloqueado por um piso
fixo que eu tinha adicionado, e reduziu recall.

### 4. Piso rígido de 2500m (`DESVIO_MIN_M`) é tudo-ou-nada

Abaixo de 2500m de distância ao destino mais próximo, os ramos
comportamentais principais nunca disparam — não importa o quão claro seja o
afastamento de outros destinos.

**Caso real: TTM-7C13.** Veículo nunca passou de 505m de UM destino
(o real, onde estava genuinamente perto), enquanto se afastava de outros
12 destinos cadastrados na rota. Bloqueado 100% pelo piso, independente de
qual regra de amplitude (`all`/`pct80`) estivesse ativa — nunca teve chance.

## Ideia de redesenho estrutural (proposta, ainda não implementada)

- Trocar o streak binário por um **score acumulado com decaimento (leaky
  bucket)**: cada ciclo soma uma fração contínua (`destinos que
  cresceram / N`), o score decai um pouco a cada ciclo em vez de zerar tudo
  com 1 leitura ruim. Dispara quando o score acumulado passa um limiar.
  Sobrevive a ruído de 1 ciclo sem perder a tendência real.
- Trocar o piso rígido de 2500m por um **fator de amortecimento suave**:
  perto de QUALQUER destino reduz a contribuição daquele ciclo pro score
  (não zera 100%), longe não amortece nada. Resolve o caso 7C13 sem abrir
  mão da proteção que o piso original dava perto de clientes reais.
- Os bugs #1 e #2 (dados, não regra) precisam de fix separado — mudar o
  desenho da regra não resolve destino sumindo do array. Provavelmente:
  parar de remover destinos entregues do conjunto de referência de
  distância (ou congelar o conjunto no início do streak), independente de
  qual regra de amplitude/score for usada.

Protótipo do score-com-decaimento já escrito em
`scripts/backtest-desvio/replay-score.ts` (harness, NÃO produção) — próximo
passo é rodar contra o corpus real (444+ casos) e reportar recall/FP antes
de decidir subir qualquer coisa.

## Achado maior do dia (tarde/noite, modo teste): distância em linha reta era a causa raiz dominante

Depois de implementar a regra do modo teste (média ponderada por
proximidade, base incluída, destino visitado excluído — ver spec
`docs/superpowers/specs/2026-08-11-modo-teste-desvio-zero-design.md`) e
testar contra o dia inteiro real da frota (139 veículos), o usuário
questionou: como medir desvio sem saber a rota real do carro até o
cliente, só linha reta? Testado direto: **dos 264 disparos do dia com
linha reta, só 58 (22%) sobrevivem quando a distância é recalculada com
rota real de rua (OSRM self-hosted, já rodando no Contabo,
`osrm-transmonseg`, porta 5001 local)**. 206 (78%) eram puro artefato de
linha reta — geografia do Rio (baías, morros, ruas de mão única) faz a
distância reta mentir sobre o quanto o carro andou de verdade.

Correção aplicada: `avaliarDesvioTeste` (src/lib/detectores-teste.ts) não
calcula mais distância internamente — recebe um mapa de distâncias já
calculadas do chamador. Novo módulo `src/lib/distancias-osrm.ts` busca
distância real via OSRM `/table` (matriz, 1 chamada por veículo por
ciclo, todos os destinos de uma vez — muito mais barato que uma rota
completa por destino). `route.ts` já busca essas distâncias reais antes
de avaliar a regra.

### Tecnologias pesquisadas pra melhorar ainda mais (11/08, sem busca live — sessão sem cota de web search, conhecimento próprio)

- **OSRM Map Matching (`/match`)** — encaixa a trilha de GPS bruta na rua
  mais provável antes de qualquer cálculo de distância, reduz ruído de
  GPS puro. Próximo passo natural depois da troca pra rota real — testar
  nos 58 casos que sobreviveram, ver se cai mais ruído.
- **Valhalla** — motor de rota alternativo, já citado como fallback
  planejado em `src/lib/corredor-verificacao.ts` mas não usado no modo
  teste ainda.
- **Corredor/buffer de rota** — a ideia do outro chat consultado hoje de
  manhã (rota real até cada pendente + buffer de tolerância + desvio =
  sair da união dos buffers). Descartada de manhã por custo, mas agora
  que OSRM já está confirmado barato/rápido no dia a dia, fica mais
  viável como fase seguinte se sobrar ruído depois do map matching.
- **PostGIS** (já em uso) — `ST_DWithin`/`ST_Buffer` fariam esse corredor
  direto no banco, sem lógica extra em JS.
- **H3 (grid hexagonal, Uber)** — ⭐ usuário demonstrou interesse
  específico nessa, anotar pra aprofundar depois. Ideia: pré-computar os
  corredores de rota comuns como conjuntos de células H3 uma vez (não a
  cada ciclo), depois checar só "essa célula está no conjunto conhecido"
  — evita chamar OSRM em tempo real pra toda checagem, escala melhor com
  frota grande. Relevante especialmente se o corredor/buffer (item acima)
  avançar — H3 seria a forma barata de consultar esse corredor depois de
  computado, não substitui o cálculo de rota em si.

### Testado: Map Matching não ajudou muito (nesta técnica específica)

Rodado OSRM `/match` nos 58 casos que sobreviveram à troca pra rota real,
snapeando a trilha bruta de GPS na rua antes de calcular distância: **57
dos 58 continuaram disparando** (só 1 caiu). Não vale a complexidade/
latência extra pra essa regra específica (média ponderada de distância) —
`/table` já usa a malha viária internamente pra calcular a distância,
então já captura a maior parte do ganho. Map matching provavelmente
ajudaria mais numa abordagem de corredor/buffer (comparar o FORMATO do
trajeto, não só distância ponto a ponto) — reavaliar se essa fase
(corredor) avançar no futuro.

### Pivô final: trocado "distância média subindo" por "dentro do corredor" (11/08, fim do dia)

Revisão visual caso a caso dos 160/161 disparos restantes (regra de
distância real via OSRM) achou ambiguidade genuína em pelo menos um caso
real (trânsito legítimo por rodovia longa entre áreas de atendimento,
indistinguível de desvio só pelo sinal "distância média subindo") e uma
classificação automática de 0% "desvio real forte" que não convenceu —
sintoma de que o problema não era mais calibração de parâmetro, era a
pergunta que a regra respondia. "A distância média está subindo?" é
frágil por natureza, não importa quão bem calibrado o limiar.

A pergunta certa já existia implementada e validada em produção pra outro
propósito: `src/lib/corredor-verificacao.ts::verificarCorredor` — "o
veículo está em cima de uma estrada real que leva a algum destino
pendente, sim ou não?" — binário, robusto, sem parâmetro fino de
sensibilidade pra ajustar. Hoje esse módulo só confirma um alerta que já
ia disparar por outro motivo (uso em produção); a partir de agora ele é a
regra PRINCIPAL do modo teste.

**Reescrita de `src/lib/detectores-teste.ts`:** de scoring por distância
com decaimento pra `avaliarDesvioTeste(posAtual, destinos, estadoAnterior,
params)` assíncrono, que chama `verificarCorredor` a cada ciclo. Estado
(`EstadoDesvioTeste`) muda de `{score, distanciasAnteriores, visitados}`
pra `{ultimaPosicaoDentro, foraStreak}` — a origem passada pro corredor é
sempre o último ponto confirmado DENTRO (nunca a posição atual, que
tautologizaria a checagem). `streakMinParaDisparar: 3` como ponto de
partida (ainda não validado contra harness/dia real — mesma disciplina
de sempre antes de considerar definitivo).

Consequência: `src/lib/distancias-osrm.ts` (distância em lote via
`/table`) virou código morto e foi removido — `verificarCorredor` já
resolve rota via `/route` internamente, camada 0 self-hosted primeiro.
`route.ts` atualizado pro novo contrato; migration `039_desvio_teste_estado_corredor.sql`
(local + contabo) troca as colunas de `desvio_teste_estado` de
`score/distancias_anteriores/visitados` pra
`ultima_posicao_dentro_lat/lng, fora_streak`.

**Pendente antes de considerar pronto:** validar `streakMinParaDisparar`
contra o harness (`scripts/backtest-desvio/`) e/ou um novo teste de dia
inteiro/frota inteira com a regra de corredor, aplicar a migration em
produção, redeploy (`transmonseg-vps`, ambos os repos + pm2 restart).

### Teste de dia inteiro/frota inteira: corredor como regra primária piorou (11/08, fim do dia)

Rodado contra os 139 veículos da Nutry Max hoje (`scripts/testar-corredor-tmp.mjs`,
reaproveitando `avaliarDesvioTeste`/`verificarCorredor` de verdade via tsx no
servidor, sem reimplementar nada): **380 disparos em 92/139 veículos (66% da
frota)**, streakMinParaDisparar=3. Pior que a versão anterior (161 disparos,
distância real via OSRM `/table`) e — mais grave — atinge a maioria da frota,
não um punhado de veículos com desvio genuíno.

Revisão visual manual (chrome-devtools, 5 casos reais espalhados em 4
veículos — TTG-0I17, TTF-3C99, TUC-1D15, RQV-4F38 — instrução explícita do
usuário de nunca mais delegar esse julgamento pra outro classificador
automático) confirmou dois modos de falha reais, não ruído de calibração:

1. **Disparo com 0 pendentes carregados.** Veículo em trânsito normal
   (rodovia, ponte, saindo da base) antes de ter qualquer entrega atribuída
   naquele trecho. Sem destino nenhum pra testar rota, "fora de qualquer
   corredor" é trivialmente verdade — não é desvio.
2. **Disparo em rota de entrega legítima com múltiplas paradas.**
   `verificarCorredor` traça a rota de UM ponto de origem fixo (última
   posição confirmada dentro de QUALQUER corredor) até CADA destino
   individualmente. Depois que o veículo já visitou 1-2 clientes reais, a
   rota daquele ponto de origem "congelado" até o PRÓXIMO destino não bate
   mais com o trajeto real (que passou por paradas intermediárias não
   modeladas) — a checagem não foi desenhada pra rota de múltiplas paradas,
   só pra confirmar um alerta de janela curta com origem recente (uso atual
   em produção).

Conclusão: o corredor como regra PRIMÁRIA e standalone não está pronto.
Continua sendo a pergunta certa ("está em cima de estrada real que leva a
algum pendente?"), mas a implementação atual assume implicitamente uma
única viagem origem→destino, não uma rota de entrega real com N paradas em
sequência.

### Auditoria de tecnologias pra fechar os dois gaps (11/08, pedido explícito do usuário: "deixar o teste o mais perfeito que conseguirmos")

Sessão sem cota de web search (estourada mais cedo); a peça central foi
verificada ao vivo via fetch direto na doc oficial do OSRM (link nas fontes
da resposta ao usuário), o resto é conhecimento próprio, sinalizado como tal.

**Pra resolver o modo de falha #2 (rota com múltiplas paradas, origem
congelada):**

- **OSRM `/trip` (self-hosted, já rodando, sem infra nova)** — resolve TSP
  de verdade: dado `source=first` (posição atual) + lista de pendentes,
  devolve a ORDEM eficiente de visita (`roundtrip=false&destination=any`,
  heurística farthest-insertion pra 10+ pontos, força bruta abaixo disso).
  Verificado ao vivo hoje na doc oficial do projeto. Uso proposto: computar
  a sequência otimizada periodicamente (não todo ciclo — caro), e testar o
  corredor perna-a-perna (origem = parada anterior confirmada, destino =
  próxima parada da sequência), reancorando a origem a cada parada real
  visitada, não a cada vez que o veículo "passa perto de qualquer corredor".
  **Essa é a peça que resolve o modo de falha #2 de raiz.**
- **Valhalla `/optimized_route`** — equivalente ao OSRM trip, já é o
  fallback público existente em `corredor-verificacao.ts`; mesma ideia, sem
  self-hosted.
- **pgRouting `pgr_TSP`** — resolve o mesmo problema dentro do Postgres
  (dado uma matriz de custo, geralmente montada com
  `pgr_dijkstraCostMatrix`), sem chamada de rede externa. Só vale a pena se
  a malha viária for carregada no PostGIS — hoje não é (OSRM externo faz
  esse papel), então é mais infraestrutura nova, não recomendo por ora.
- **Heurística mais barata sem TSP de verdade:** reordenar os pendentes por
  "vizinho mais próximo" a cada ciclo (guloso, sem solver) — aproxima a
  sequência real sem chamar `/trip`. Mais barato, mas pior aproximação;
  serve como fallback se `/trip` falhar ou demorar.

**Pra resolver o modo de falha #1 (0 pendentes = ruído trivial):**

Não é bem "tecnologia" — é um guard de lógica: se `destinos.length === 0`
(sem pendentes E sem base próxima o suficiente pra fazer sentido testar),
não avalia a regra naquele ciclo (nem dispara, nem acumula streak). Simples,
zero custo, resolve a fatia mais óbvia do ruído sozinho.

**Pra melhorar a qualidade geral da checagem de corredor (não crítico, mas
vale registrar):**

- **OSRM Map Matching (`/match`)** — já testado hoje mais cedo contra a
  regra antiga de distância, ganho marginal (57/58 iguais). Pode valer mais
  a pena combinado com a checagem perna-a-perna acima, mas não é prioridade.
- **Distância de Fréchet / DTW entre trajetória real e rota planejada** —
  mais robusto que "ponto dentro de buffer de polilinha" pra comparar
  FORMATO do trajeto, não só proximidade pontual. Relevante se o buffer
  fixo (120/200m) continuar dando falso positivo em curvas fechadas ou
  cruzamentos complexos. Não testado ainda, ideia pra fase futura.
- **Map matching por Hidden Markov Model (HMM, ex: algoritmo ST-Matching)**
  — abordagem acadêmica mais robusta que o `/match` do OSRM (que já usa uma
  variante disso internamente). Provavelmente complexidade desnecessária
  pra esse estágio.

**Escala (frota grande, não é o gargalo hoje mas fica registrado):**

- **H3 (grid hexagonal)** — ⭐ interesse específico do usuário, já anotado
  antes hoje. Pré-computar corredores conhecidos como conjuntos de células
  H3, consultar em vez de chamar OSRM em tempo real toda checagem. Só passa
  a valer a pena se o volume de chamadas OSRM virar gargalo real — hoje o
  self-hosted processou a frota inteira (243 mil ciclos, ~240 mil chamadas
  `/route`) em 996s, então não é urgente.
- **PostGIS `ST_DWithin`/`ST_Buffer`** — levar a checagem "ponto dentro do
  buffer da polilinha" pra dentro do banco em vez de JS. Ganho de
  performance, não de precisão — não resolve nenhum dos dois modos de
  falha, só otimização se algum dia for necessário.

**Referência: como telemetria comercial de frota faz isso.** Ferramentas
como Samsara/Motive/Verizon Connect/Geotab tratam "aderência de rota" como
"trajeto planejado (sequência de paradas já ordenada, um `run sheet`) +
buffer por perna", não "está perto de qualquer parada individual" — valida
que a combinação OSRM `/trip` (ordena) + corredor perna-a-perna (confirma)
é o padrão da indústria pra esse problema, não uma ideia nova.

**Recomendação:** implementar os dois fixes antes de reconsiderar o
corredor como regra primária: (1) guard de 0 pendentes (trivial, fazer
sempre), (2) `/trip` pra ordenar + corredor perna-a-perna reancorando por
parada real visitada (arquitetura nova, precisa de mais uma rodada de
implementação + teste de dia inteiro antes de ir pra produção). Até lá, o
modo teste roda com a regra de distância real via OSRM (~161 disparos) como
candidato mais maduro.
