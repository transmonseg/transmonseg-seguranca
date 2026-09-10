# Plano de melhoria -- detector de desvio de rota (09/09)

Contexto: pedido do usuario apos 3 casos reais no grupo "DESVIO DE ROTA"
(RQU-9D10, TOS-0F89, TUI-0H19 -- "desvio na Unitrac mas nao acionou em
nosso sistema"). Investigacao do dia achou 1 dispensa humana questionavel
(0F89), 1 buraco real de deteccao (parada parada longe de tudo, ja
instrumentado sem alerta, migration 077) e 1 caso que provavelmente e' so'
ruido da propria Unitrac (0H19). Este doc responde a pergunta seguinte do
usuario -- "pesquise e monte um plano de melhoria" -- revisando TUDO que
ja' foi tentado antes de propor qualquer coisa nova, pra nao reinventar o
que ja' foi testado e descartado com dado real.

## 1. Por que "nao da' certo" -- a restricao de fundo

`ult_rota` da Unitrac sempre vem vazio e `ordem` dos alvos nao e' confiavel
(confirmado em `docs/plano-evolucao.md`, sondagem original da API). **Nao
existe rota planejada de verdade pra comparar contra o trajeto real.** Todo
o resto deste documento e' sobre como aproximar isso sem esse dado.

Por isso o motor de hoje detecta desvio por COMPORTAMENTO ("afastando de
todos os destinos legitimos", `docs/plans/2026-07-06-desvio-sem-rota-design.md`),
nao por comparacao trajeto-esperado x trajeto-real. E' um proxy, nao a
pergunta certa -- mas a pergunta certa (comparar trajetos) exige saber qual
trajeto era esperado, e isso a Unitrac nao da'.

## 2. O que ja' foi tentado e por que foi descartado (nao repetir)

| Ideia | Testado em | Resultado | Motivo do descarte |
|---|---|---|---|
| Corredor OSRM sintetico pela `ordem` dos alvos | antes de 06/07 | ruido alto | `ordem` nao e' confiavel, rota inventada |
| Distancia em linha reta (sem rota real) | 11/08 | 78% ruido | geografia do Rio (baias, morros, mao unica) mente na linha reta |
| OSRM Map Matching (`/match`) sozinho, so' pra distancia | 11/08 | so' 1/58 caiu | `/table` ja usa malha viaria internamente, ganho marginal |
| Corredor (origem->destino) como regra PRIMARIA e standalone | 11/08, dia inteiro/139 veiculos | 380 disparos em 66% da frota | 2 modos de falha: (a) dispara com 0 pendentes carregados; (b) origem fixa nao acompanha rota de MULTIPLAS paradas -- depois de visitar 1-2 clientes reais, a rota da origem congelada ate' o proximo destino nao bate mais com o trajeto real |
| "Rua rara" (camada de memoria espacial fora do tapete) como sinal de alerta | 13/08 | volume alto | desligado por pedido explicito do usuario apos ver o volume de falso positivo do dia -- continua sendo CALCULADO (streak gravado) mas nunca dispara |
| "Parada fora de rota" (parado longe de qualquer destino/base) como alerta critico | 09/09 (hoje, simulacao) | 206 episodios/dia so' Nutry Max | inclui almoco, posto sem cadastro, espera de doca -- alto demais sem mais contexto; virou so' instrumentacao (migration 077) |

Conclusao chave do 11/08 (nunca implementada, "modo teste" que a testou foi
descartado inteiro e sera' refeito do zero, ver `[[project_monitoramento_transmonseg]]`):
a peca que resolve o modo de falha (b) de raiz e' **OSRM `/trip` pra ordenar
as paradas + corredor perna-a-perna reancorado pela ULTIMA PARADA REAL
CONFIRMADA** (nao pela origem fixa do dia todo). Nunca chegou a producao.

## 3. O que ja' esta' validado e funcionando hoje (nao mexer, so' construir em cima)

- **Distancia real de rua via OSRM self-hosted** (`osrm-transmonseg`, Contabo,
  porta 5001) substituindo linha reta -- base de tudo que roda hoje.
- **Streak de persistencia (>=2 ciclos)** pra nao alertar em 1 leitura ruidosa
  de GPS -- calibrado com simulacao de dia real (streak=1 dava 40x o pior
  dia ja visto).
- **Corredor como CORROBORACAO** (nao regra primaria) -- confirma um alerta
  que ja disparou por "afastando de tudo", nao decide sozinho. E' a mesma
  pergunta certa do `verificarCorredor` descontinuado, so' que usada do
  jeito que nao quebra com rota de multiplas paradas (porque so' entra
  DEPOIS que ja' ha' evidencia).
- **Tapete historico de celulas** (por onde a frota realmente passa) --
  calculado, disponivel, so' nao dispara sozinho (ver "rua rara" acima).
- **Gates de ruido especificos**, cada um com achado real documentado:
  carencia de base (manobra de patio), salto de reconciliacao de atraso,
  posicao repetida com velocidade !=0 (bug de hardware do rastreador),
  retorno sustentado a base, saida de base sem destino avaliavel.
- **Instrumentacao nova (09/09, migration 077)**: parada prolongada longe
  de qualquer destino, so' logando, ainda sem alertar.

## 4. Caminho recomendado, em fases

### Fase 0 (fazer sempre, baixo risco): calibrar com dado real antes de qualquer coisa nova
Doutrina do proprio projeto, repetida em toda melhoria dos ultimos 2 meses:
nenhum limiar novo sobe direto pra "critico" sem simular contra pelo menos
1 dia real primeiro (e' exatamente o que evitou subir "parada fora de rota"
como alerta hoje). Aplicavel a qualquer item abaixo.

### Fase 1 -- Fechar o buraco "parado longe de tudo" (semanas, baixo risco)
- Deixar a instrumentacao (migration 077) rodando pelo menos 5-7 dias uteis.
- Rodar o mesmo tipo de analise fria que gerou o doc de 20/08 (distribuicao
  de `parado_min`, quantos episodios por placa, quantos coincidem com POI
  conhecido tipo posto de combustivel -- reusar a ideia de POI check via
  Overpass do `docs/plano-evolucao.md` Fase 1B, nunca implementada) antes de
  decidir o limiar de minutos e se vira `atencao` (nao `critico`) pra nao
  competir com desvio de verdade na tela.
- Baixo risco: e' so' instrumentacao rodando, decisao de subir alerta fica
  pra depois do dado chegar.

### Fase 2 -- OSRM `/trip` + corredor perna-a-perna reancorado (arquitetura nova, maior esforco, maior ganho)
Esta e' a recomendacao mais madura que existe no historico do projeto e
nunca foi construida (11/08, "modo teste" descontinuado antes de chegar
la'). Union do que ja' foi validado:
- `/trip` (self-hosted, ja rodando, sem infra nova) ordena os pendentes
  restantes periodicamente (nao todo ciclo -- caro), devolvendo a sequencia
  eficiente de visita.
- Corredor OSRM confirma perna-a-perna: origem = ULTIMA PARADA REAL
  confirmada (nunca a posicao atual, nunca uma origem congelada do dia
  todo), destino = proxima parada da sequencia `/trip`.
- Resolve os 2 modos de falha do 11/08 ao mesmo tempo: guard de 0 pendentes
  (nao avalia sem destino nenhum) + reancoragem por parada real (nao mais
  origem fixa, entao rota de multiplas paradas passa a bater com o trajeto
  esperado a cada perna).
- Isso vira o sinal PRIMARIO de desvio, substituindo (ou rodando em
  paralelo, comparando, antes de trocar) "afastando de tudo" -- que
  continua existindo como sinal comportamental complementar (pega tambem o
  caso sem sequencia clara, ex.: 0 pendentes, afastando da base).
- Precisa de: reimplementar o que existia em `corredor-verificacao.ts`
  (removido junto com "modo teste"), harness de backtest contra pelo menos
  1 dia inteiro/frota inteira ANTES de subir (mesma disciplina que reprovou
  a v1 do corredor em 66% da frota), e revisao visual caso a caso (nunca
  delegar esse julgamento a outro classificador automatico -- instrucao
  explicita do usuario ja registrada no doc de 11/08).
- Maior esforco de todo este plano -- semanas, nao dias. Maior ganho
  tambem: e' a unica ideia no historico que ataca a causa raiz (nao ter
  rota planejada) em vez de mais um proxy comportamental.

### Fase 3 -- Reduzir ruido que compete por atencao (baixo esforco, ja' com precedente)
Nao e' deteccao, e' o operador conseguir ENXERGAR o desvio real no meio do
resto. Ja' formalizado uma vez (20/08): `favela`/`baseline_veiculo` sao 67%
do volume com 97-99% de "correto" (nao sao falso positivo, sao so' baixo
valor competindo por atencao). Continuar essa linha:
- Auditar se sobrou mais algum tipo nessa categoria depois de 09/09 (a
  franja de "parada fora de rota", quando/se virar alerta na Fase 1, entra
  direto nessa disciplina: nivel `atencao`, colapsada, nunca `critico` sem
  dado que justifique).
- Reforcar o cron de re-sync de frota (Fase 1 de `plano-evolucao.md`,
  Item 3, seed idempotente diario) -- cadastro desatualizado silenciosamente
  quebra deteccao por baixo (veiculo errado casado com placa errada), fora
  do escopo de "melhorar o detector" mas mina qualquer melhoria se nao
  tiver dado de frota correto por baixo.

### Fora de escopo por ora (YAGNI, decidido antes)
- Tabela de posicoes cruas alem do que ja existe -- celulas agregadas bastam.
- Distancia de Frechet/DTW entre trajetorias -- so' relevante se o corredor
  perna-a-perna (Fase 2) continuar dando falso positivo em curvas fechadas
  depois de implementado; nao antes.
- H3 (grid hexagonal) -- interesse ja registrado (11/08), mas so' vale a
  pena se volume de chamada OSRM virar gargalo real; hoje nao e' (243 mil
  ciclos/996s medido).
- pgRouting -- exigiria carregar a malha viaria no PostGIS (infra nova);
  OSRM externo ja resolve isso mais barato.
- Alertar por camada de memoria espacial (tapete) sozinha, sem sinal
  comportamental corroborando -- decidido contra em 06/07 (rota nova
  legitima vira falso positivo).

## 5. Ordem sugerida

1. Fase 0 e' transversal (sempre).
2. Fase 3 (ruido) pode comecar em paralelo, e' independente e barata.
3. Fase 1 (parada fora de rota) precisa so' de tempo passando com a
   instrumentacao rodando -- proxima revisao em ~1 semana.
4. Fase 2 (corredor perna-a-perna) e' o investimento maior -- vale
   confirmar com o usuario o apetite de esforco antes de comecar (varios
   dias de implementacao + backtest + revisao caso a caso), dado que e'
   arquitetura nova, nao ajuste de parametro.
