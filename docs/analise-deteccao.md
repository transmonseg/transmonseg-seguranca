# Análise: como identificar desvio de rota e parada indevida

Documento técnico do sistema da Transmonseg. Trata de COMO detectar desvio de
rota, parada indevida e sinais correlatos, aplicado à nossa realidade (dados da
Unitrac, frota Nutry/Benassi, Rio de Janeiro). Não é teoria solta: cada método
vem marcado com o que já está no ar, o que falta e onde dá mais retorno.

**Atualizado em 09/07/2026** após um dia de investigação ao vivo (grupo de
WhatsApp da operação + dados reais do banco) que achou 3 problemas concretos
na identificação do desvio. Ver seção 7 — é a parte mais importante pra ler
agora, o resto do documento é contexto histórico.

---

## 0. O problema central (a base de tudo)

A Unitrac NÃO entrega rota planejada (`ult_rota` vem vazio, sem heading de plano).
A única "verdade" que temos por veículo é:

- **posição** (lat, lng, velocidade, ignição, `atraso`),
- **alvos** = pontos de entrega pendentes (com coordenada, raio, ordem),
- **base** = perímetro real de garagem/CD (polígono por cluster),
- **rastro** = histórico de posições.

Conclusão dura: **tudo é inferência**. Não existe "saiu da rota X". Existe "está
se comportando como quem não vai para nenhum dos destinos dele". Por isso a
filosofia é: **não provar roubo, levantar a mão para o operador decidir**. Reduzir
falso positivo importa tanto quanto detectar, porque alarme falso demais faz o
operador ignorar tudo (o pior cenário de uma central).

Três pilares atravessam o documento inteiro:
1. **Frescor primeiro:** posição velha (`atraso` alto) não serve para nada. Tudo começa filtrando o que é fresco.
2. **Persistência:** nada dispara em 1 ciclo. Sinal verdadeiro se sustenta por N leituras (mata o ruído de GPS).
3. **Contexto perdoa:** posto, restaurante, trânsito, parada recorrente, vários veículos parados juntos. O contexto SUBTRAI suspeita.

Um quarto pilar, que o achado de hoje (seção 7.2) deixou claro que faltava:
4. **Disparar e resolver têm que usar a MESMA régua.** Se "aproximar de qualquer
   destino cancela a suspeita" é o critério pra não disparar, tem que ser
   também o critério pra encerrar o que já disparou — senão o alerta fica
   "ativo" muito depois do comportamento suspeito ter acabado.

---

## 1. DESVIO DE ROTA — como funciona HOJE (real, não o histórico)

### 1.1 Definição operacional
O veículo está indo (ou sendo levado) para onde não deveria. Sem rota traçada,
"deveria" = em direção a um dos pontos pendentes ou a uma base.

### 1.2 As camadas implementadas

**Camada 1 — Comportamental (afastamento de TODOS os destinos), IMPLEMENTADA.**
O veículo se afasta de TODOS os destinos legítimos (alvos pendentes + bases) em
vez de progredir rumo a pelo menos um deles — aproximar de QUALQUER um cancela a
suspeita na hora. Streak mínimo de 2 leituras (~2min) pra disparar. Faixa local
2,5-25km (acima disso é deslocamento interurbano legítimo, a frota atende o
estado todo). Escalona: score 45 (streak 2) → 68 (streak 4) → 80 (fora do
tapete OU área de risco elevado).
- Força: funciona sem rota traçada, barato, roda a cada 30s.
- Fraqueza (achado 09/07, ver 7.2): o critério de RESOLVER o alerta não é o
  mesmo de disparar — ver mais abaixo.

**Camada 2 — Tapete histórico (`corredor_celulas`), IMPLEMENTADA.**
Grade de células ~100m por cliente, populada todo ciclo do motor (interpolação
a cada ~80m). Alimenta: (a) o score de risco de área quando "fora de via
conhecida", (b) o piso de cobertura mínima (`TAPETE_MIN_CELULAS`) que evita
cold-start (tapete vazio parecendo suspeito). Em produção: 150k+ células
acumuladas.

**Camada 3 — "Fora do tapete mesmo aproximando", DESATIVADA em 09/07/2026.**
Tentativa de fechar o ponto cego "aproximando de um destino mas por caminho
nunca percorrido antes" — substituiu um cálculo por linha reta base→destino que
tinha o mesmo problema (ver 7.1 pra história completa). Motivo real da
desativação: em rotas rurais/serra (Nova Friburgo, Teresópolis, Saquarema) o
tapete não tem cobertura suficiente, e qualquer variação legítima de caminho
(trânsito, GPS, entrega nova) virava "via nunca percorrida" — virou metade do
ruído de desvio do dia. `CAMADA3_TAPETE_ATIVA = false` em `detectores.ts`; o
motor continua computando e persistindo `fora_tapete_streak` (dado útil pra
redesenhar com calma — ver 7.1 pra ideias de correção).

**Score de risco de área (`calcularRiscoArea`), IMPLEMENTADA.**
Favela + tiroteio recente (Fogo Cruzado, <1,5km) + roubo de carga do CISP +
corredor rodoviário de risco + fator horário multiplicativo — nunca dispara
sozinho, só acelera a escalada do gatilho comportamental (Camada 1).

### 1.3 O que NÃO está implementado (próximos passos de maior precisão)

**Corredor de rota real (OSRM / Google Routes).**
Traça a rota base→alvos pendentes na estrada, cria um "tubo" (buffer de 300 a
500m) em volta. Veículo fora do tubo = desvio, independente da distância ao
alvo. É o padrão da indústria (gerenciadoras usam corredor + geocerca).
Pré-requisito: saber a ORDEM dos alvos (a Unitrac dá `alvoordem`, não usado
ainda). Custo: calcular rota 1x por viagem (não a cada ping).

**Map matching / snap-to-road pro RASTRO (não pro desvio) — parcialmente feito.**
`rastro-matching.ts` já cola saltos grandes de GPS na rua real via OSRM
`/route` (não `/match` — teto de tamanho do servidor público inviabiliza
`/match` pra trace de centenas de pontos). Corrigido hoje (ver 7.3): prioriza
saltos mais recentes quando excede o teto de chamadas, e o teto subiu de 200
pra 350.

**Along-track progress travado.**
Ao longo de uma rota, o veículo deveria PROGREDIR. Se o progresso para mas ele
continua se movendo lateralmente, é desvio mesmo sem se afastar muito em linha
reta. Requer o corredor real (item acima).

### 1.4 Falsos positivos clássicos e como matar
| Falso positivo | Por que acontece | Antídoto |
|---|---|---|
| Deslocamento interurbano | Frota atende o estado todo; fica longe de tudo legitimamente | Teto de 25km (implementado) |
| Rota rural/serra sem tapete | Tapete não cobre a via ainda, caminho legítimo vira "desconhecido" | Camada 3 desativada até redesenhar (ver 7.1) |
| Volta para a base no fim da rota | Resolve só por distância absoluta (2,5km), não por comportamento | Achado 09/07 (ver 7.2), correção pendente |
| Rota já terminada, parado longe da base | Nada resta pra comparar, alerta antigo nunca resolve | Achado 09/07 (ver 7.2), correção pendente |
| Entrega feita mas Unitrac não confirmou | Perímetro exato da Unitrac não bate com onde o caminhão realmente para | Info de "parado no cliente" implementada (ver 7.4); confirmação automática tentada e revertida (ver 7.1) |

---

## 2. PARADA INDEVIDA

### 2.1 Definição
Parada que NÃO é entrega (alvo), NÃO é base, e NÃO é parada legítima (posto, comida,
trânsito), em local e hora que não fazem sentido.

### 2.2 Anatomia de uma parada (as 4 perguntas) — IMPLEMENTADO
1. **Está realmente parado?** Velocidade 0 sustentada, `parado_desde` (reseta com >~50m de movimento).
2. **ONDE parou?** Base → ok. Raio de alvo → entrega, ok. POI legítimo (Overpass) → perdoa. Via de fluxo/zona de risco → soma suspeita.
3. **HÁ QUANTO tempo?** Limiar por contexto (cidade vs estrada).
4. **QUE HORA é?** Madrugada/fora de operação pesa mais.

`detectarParadaAnomala` e o POI check via Overpass (`temPOIProximo`) já estão
no ar — o que a versão anterior deste documento listava como "maior lacuna"
já foi implementado numa sessão anterior.

### 2.3 Classificação urbano × estrada — IMPLEMENTADO
Velocidade sustentada + distância da base nas últimas ~2h decide o limiar de tempo.

### 2.4 Clusters de parada (DBSCAN) — NÃO IMPLEMENTADO
Paradas recorrentes no mesmo ponto deveriam subtrair suspeita automaticamente
(aprendizado sem cadastro manual). Ainda depende de acumular histórico
suficiente por placa.

### 2.5 Escalada — IMPLEMENTADO
Parada de atenção vira crítica se: tempo dobrou, OU baú abriu ali, OU sinal
caiu ali (jammer), OU zona vermelha, OU tiroteio recente no trecho.

---

## 3. SINAIS CORRELATOS

- **Jammer** (IMPLEMENTADO o básico): salto súbito de `atraso` com ignição ligada. Falta correlação MULTI-VEÍCULO (2+ placas perdendo sinal no mesmo trecho/hora = jammer na via, não falha individual).
- **Baú aberto fora de ponto** (IMPLEMENTADO).
- **Pânico** (IMPLEMENTADO).
- **Excesso de velocidade** (IMPLEMENTADO).
- **Tiroteio / operação próxima** (IMPLEMENTADO, Fogo Cruzado ao vivo).
- **Entrega fantasma** (NÃO IMPLEMENTADO): alvo marcado feito pela Unitrac SEM o veículo ter passado no raio = possível conluio. Inverso do problema de "entrega feita mas não confirmada" (ver 1.4/7.1) — aqui é a Unitrac confirmando de menos, lá é confirmando sem o veículo ter ido.
- **Isca eletrônica** (NÃO IMPLEMENTADO, depende de a operação usar).

---

## 4. FUSÃO: de sinais para decisão

- **Hierarquia:** físico (pânico, baú, jammer) > geográfico (desvio, parada) > contextual.
- **Frescor antes de tudo.**
- **Contexto perdoa:** POI por perto, parada recorrente, comparação entre veículos.
- **Persistência N-pings obrigatória.**
- **Score contextual RJ:** Baixada Fluminense ~52% dos roubos, Duque de Caxias ~36%; noite/madrugada ~57%; segunda-feira ~40%. Corredores quentes: Av. Brasil/BR-101, BR-040, Dutra/BR-116, Arco Metropolitano, Linha Vermelha, Zona Oeste.
- **Encadeamento > evento isolado:** jammer → fora de rota → zona vermelha é uma cadeia de alta confiança.
- **Human-in-the-loop** (IMPLEMENTADO): reconhecer/resolver/falso positivo vira rótulo.

---

## 5. Onde estamos de verdade (09/07/2026)

**JÁ NO AR:**
- Desvio Camada 1 (comportamental) + Camada 2 (tapete, alimenta risco de área) + score de risco de área.
- Parada anômala completa (4 perguntas, POI check, classificação urbano/estrada, escalada).
- Jammer, pânico, baú, excesso de velocidade, tiroteio próximo, roubo de carga por CISP.
- Fluxo do operador (gera rótulos).
- Rastro corrigido pra rua real via OSRM, priorizando os saltos mais recentes quando excede o teto (hoje).
- Info de "parado no cliente" (tempo parado + distância ao ponto mais próximo + perímetro visual) — hoje, puramente informativo.
- Resolver do desvio com aproximação sustentada (`aproximando_streak`, migration 013) — ver 7.2, implementado e no ar.
- **Histerese no streak** (`avancarStreaksDesvio`): 1 leitura de aproximação congela em vez de zerar — detecção mais cedo em serra (ver design `docs/plans/2026-07-09-desvio-corredor-verificacao-design.md`).
- **Verificação por corredor real antes de alertar** (`lib/corredor-verificacao.ts`): rota OSRM/Valhalla até os 3 pendentes mais próximos, buffer adaptativo, cache por veículo, throttle 1 req/s, fail-open, flag `CAMADA_CORREDOR_ATIVA`. `desvio_inicio` agora aponta o ponto real de saída do corredor quando conhecido.
- **Coleta de par origem-destino no tapete** (migration 014) — só coleta, base pra religar a Camada 3 no formato iBOAT.

**DESATIVADO, aguardando redesenho:**
- Camada 3 do desvio (fora do tapete) — ver 7.1. O dado de par O-D (migration 014) já está sendo acumulado pro redesenho.

**REVERTIDO (implementado e removido no mesmo dia):**
- Confirmação de entrega por proximidade — ver 7.1. Migration fica no banco, código removido.

**PRÓXIMO, alto valor (ordem de retorno):**
1. **Tratar "rota já terminada" como estado próprio** do desvio (padrão 1 da seção 7.2) — o resolver por aproximação sustentada já ajuda quando o veículo volta a se mover em direção a algo, mas um veículo que termina a rota e fica parado sem nunca retomar não resolve sozinho (intencional, por segurança — mas ainda precisa de um tratamento explícito pro operador não ficar com alertas antigos acumulados sem contexto).
2. Religar a Camada 3 no formato iBOAT (por par O-D, com o dado da migration 014 acumulado) e cobertura mínima POR REGIÃO.
3. Correlação multi-veículo do jammer.

**DEPOIS (aprendizado, exige histórico):**
- Corredor histórico (alpha-shape), clusters DBSCAN de parada, entrega fantasma, ML de sequência.

---

## 6. Recomendação de fundo

Interpretável e barato primeiro, com fusão e human-in-the-loop maduros, só
então ML. Isso vale ainda mais depois do dia de hoje: a Camada 3 foi uma
mudança bem-intencionada, testada com unitário e cenário sintético, mas que
não tinha dado real suficiente da operação rural pra validar antes do deploy
— e virou metade do ruído do dia. Regra prática daqui pra frente: qualquer
mudança em desvio que reduz o limiar de disparo (mais sensível) precisa ser
validada contra pelo menos 24h de dado real da frota INTEIRA (não só o caso
que motivou a mudança) antes de ir pro ar, dado o histórico de 2 incidentes
no mesmo dia (Camada 3 e a tentativa de auto-resolver ao parar).

---

## 7. Achados ao vivo de 09/07/2026 (o mais importante do documento)

### 7.1 Camada 3 (tapete) — implementada, causou incidente, desativada

Contexto: o cliente reportou "muito falso positivo de nível absurdo" com
prints/vídeos/áudios reais do grupo de WhatsApp da operação (Erica e Elloisy).
Cruzando com o banco:
- **74 alertas Camada 1 vs 75 Camada 3 nas últimas 6h** — quase metade do
  ruído total vinha da Camada 3, lançada na mesma manhã.
- TTM-7C14, TTM-2G01 e TUS-1A47 disparavam e resolviam "fora de via conhecida"
  **a cada 2 minutos, o dia inteiro** — essas placas rodam rotas rurais/serra
  (Nova Friburgo, Teresópolis, Saquarema) onde o tapete não tinha cobertura
  suficiente pra distinguir "via nova" de "via desconhecida de verdade".

**Ação tomada:** `CAMADA3_TAPETE_ATIVA = false`. O motor não parou de
COLETAR o dado (`fora_tapete_streak` continua sendo computado e persistido) —
só parou de usá-lo pra disparar alerta. Isso significa que quando formos
redesenhar, já vamos ter semanas de dado real de cobertura pra calibrar o
limiar certo, em vez de adivinhar de novo.

**Ideias pra quando redesenhar** (nenhuma implementada ainda):
- Cobertura mínima (`TAPETE_MIN_CELULAS`) POR REGIÃO/cliente, não um número
  fixo global — uma operação 100% urbana pode confiar no tapete com bem menos
  histórico que uma rural/serra.
- Em vez de "fora do tapete = crítico", considerar "fora do tapete" como mais
  um fator do SCORE DE RISCO DE ÁREA (que já existe e já é multiplicativo),
  não um gatilho binário próprio.
- Olhar pro streak em MINUTOS de estrada nova percorrida, não em número de
  leituras — 2 leituras (~2min) numa rodovia a 80km/h é 2,6km de estrada
  "nova"; 2 leituras numa rua de bairro a 20km/h é 660m. A mesma contagem de
  leituras significa coisas bem diferentes dependendo da velocidade.

**Confirmação de entrega por proximidade** (Feature A do plano original, ver
`docs/plans/2026-07-08-entrega-proximidade-e-desvio-tapete-*.md`): motor
detectava veículo parado ≥5min a ≤500m de um pendente não confirmado pela
Unitrac, e mostrava uma faixa "Confirmar/Descartar" pro operador. Foi
implementada, colocada no ar, e **revertida no mesmo dia a pedido do
cliente** — código removido (não só desativado), migration 012 continua no
banco (tabela `entregas_confirmacao_manual`, aditiva, não destrutiva). O
motivo exato da reversão não ficou claro na conversa (o cliente pediu
"reverter tudo" sem detalhar um bug específico), mas o PROBLEMA que ela
tentava resolver continua real e foi confirmado de novo mais tarde no mesmo
dia (ver 7.4) — só que a solução que o cliente descreveu de próprio punho
("criar um perímetro, falar quanto tempo ele tá no cliente") pedia
INFORMAÇÃO pro operador decidir, não confirmação automática. Isso é
exatamente o que foi implementado em 7.4, sem repetir a mesma forma que foi
revertida.

### 7.2 Resolver do desvio desconectado do disparo — CORRIGIDO (padrão 2)

Puxando os 11 alertas de desvio ativos no momento (`status IN ('ativo',
'reconhecido')`) e cruzando com a posição/alvos reais:

**Padrão 1 — rota já terminada:** 6 de 8 veículos PARADOS mostrando "desvio
ativo" já tinham TODOS os alvos com `situacao=1` (feito) e estavam parados a
**15-28km** de qualquer ponto conhecido (não perto de nada, nem cliente nem
base). Exemplo: MSK-3752 parado 27min, ponto mais próximo (já entregue) a
17,3km; GSK-0G53 parado 49min, ponto mais próximo a 28,5km.

Explicação: quando `temPendentes=false`, o único "destino" que sobra pro
sistema comparar é a base. O alerta só resolve (`foraDeRota`) quando fica a
menos de 2.500m de ALGUM destino. Motorista que termina a rota e para longe
da base (almoço, descanso, esperando próxima rota — tudo legítimo) fica com
"desvio ativo" travado indefinidamente, mesmo sem fazer nada de errado.

**Padrão 2 — voltando pra base de verdade, resolve não acompanha:** caso
mais claro, **TUL-1C38** — reconstruí o rastro (últimas 2h) e a distância até
a base caiu **monotonicamente em 10 leituras seguidas: 8,26km → 8,26 → 8,25
→ 8,25 → 7,05 → 5,82 → 4,82 → 3,94 → 3,12 → 2,12km**, ao longo de uns 20min
de trajeto. Ou seja: o veículo estava indo em linha reta pra base o tempo
todo. Mesmo assim, o alerta de desvio ficou "ativo" (motivo: "Afastando-se de
todos os 2 destinos... fora de via conhecida da frota") durante TODO esse
trajeto, só porque a distância absoluta não tinha cruzado a linha dos 2.500m
ainda.

**Por que isso acontece:** o critério de DISPARAR (Camada 1) é comportamental
— "aproximar de QUALQUER destino cancela a suspeita". Mas o critério de
RESOLVER um alerta já ativo (`foraDeRota`, em `detectores.ts`) é puramente
geográfico — "só some quando ficar a menos de 2.500m de algo". São duas
réguas diferentes pro mesmo conceito. Resultado: um veículo pode estar
100% comportado (aproximando sustentado de um destino legítimo há 20 minutos)
e MESMO ASSIM aparecer com alerta crítico ativo o tempo todo, só porque a
base fica longe.

**Por que NÃO dá pra simplesmente "resolver quando aproximar" (already
tentado e corrigido pelo cliente nesta mesma conversa):** um veículo PARADO
pode ser um roubo em andamento (parou pra transferir carga) — resolver ao
parar esconderia exatamente o pior cenário. O mesmo raciocínio se aplica aqui
com mais nuance: resolver no PRIMEIRO sinal de aproximação também seria
arriscado (sequestro pode fingir se aproximar de um destino por 1-2 leituras
pra "limpar" o alerta e depois desviar de novo).

**Correção implementada (mesmo dia, `aproximando_streak`, migration 013):**
exige aproximação SUSTENTADA — 2 leituras CONSECUTIVAS sem afastar de tudo
(mesmo mínimo já usado pra disparar), não só "está a menos de 2.500m". Um
sequestro que finge aproximar por 1 leitura não tem persistência suficiente
pra resolver; um retorno real e sustentado à base (como o TUL-1C38, 10
leituras seguidas) agora resolve logo nas 2 primeiras leituras de
aproximação, muito antes de fisicamente chegar perto. Não muda nada da
Camada 1 (permanece calibrada como estava); só conserta a lógica de "quando
parar de mostrar como ativo". `foraDeRota()` em `detectores.ts` — testado
(unitário) contra o cenário exato do TUL-1C38.

**Padrão "rota terminada" (item 1 acima) continua SEM correção própria.** A
aproximação sustentada ajuda quando o veículo volta a se mover em direção a
algo, mas um veículo que termina a rota e fica parado sem nunca retomar
movimento não resolve sozinho — **intencional**: parado pode ser um roubo em
andamento, e o cliente já rejeitou explicitamente qualquer auto-resolve
baseado só em estar parado. Fica como um estado que precisa de julgamento do
operador (a info de "parado no cliente", seção 7.4, ajuda nisso); um
tratamento mais elaborado (ex.: estado "fim de rota" explícito) continua como
próximo passo, não implementado.

### 7.3 Rastro — corrigido

Achado: em janela de 48h (opção real da UI), TTM-2G01 tinha **314 saltos
grandes** de GPS contra um teto de 200 chamadas de correção — e como a
seleção era cronológica (mais antigos primeiro), sobravam sem corrigir
exatamente os saltos MAIS RECENTES, o trecho que o operador olha ao investigar
um desvio recém-disparado. `priorizarIndices()` agora ordena por recência
antes de aplicar o teto; teto também subiu de 200 pra 350 (rede/OSRM não é o
gargalo — 0 falhas numa amostra real testada).

### 7.4 "Parado no cliente" — informação, sem decisão automática

Em vez de recriar a confirmação automática de entrega (revertida em 7.1),
implementado: no card do veículo parado, mostra "Parado há Xmin" e, se
houver ponto de entrega conhecido a ≤3km, a distância e o nome dele + um
círculo do raio real da Unitrac no mapa. Reaproveita dado já buscado
(`parado_desde`, alvos já carregados no drawer) — zero fetch novo, zero
mudança de detecção. Puramente pra dar contexto visual rápido pro operador
decidir, sem o sistema confirmar nada sozinho.

**Refinamento (mesmo dia): pontos de entrega muito próximos podem ser
ambíguos.** Puxando 309 pares de pontos DIFERENTES (pontoCodigo distinto) de
15 veículos reais: só 2 pares têm o raio se tocando (0,6%, raro), mas um
deles é grave — dois clientes a **2 metros** um do outro, distância que
nenhum GPS comum distingue. `pontoMaisProximoQualquer` agora deduplica por
ponto/endereço (várias NFs no mesmo endereço não contam como ambíguo) e,
quando 2+ pontos DIFERENTES ficam a distância parecida da posição
(margem de 30m, o dobro do erro típico de GPS), retorna TODOS os candidatos
em vez de escolher 1 arbitrariamente — o card mostra "pode ser: X ou Y" e o
mapa desenha um círculo pra cada. Mesma cautela de sempre: informação, não
decisão automática.

### 7.5 Rastro lento e perímetro só no ponto mais próximo — corrigido

Achado real: o teto de correção do rastro (subido pra 350 na seção 7.3) fez
o TEMPO de resposta piorar bastante pra veículos com muitos saltos de GPS —
TTK-4D15 (322 saltos em 24h) levava **12,7 segundos** só no ajuste de rua
(OSRM), sentido como "demora muito" ao clicar no veículo. Fix: `/api/rastro`
ganhou `?bruto=1` (pula o ajuste, só remove picos de GPS) — o front busca o
bruto primeiro (aparece em ~1,3s, medido ao vivo) e o ajustado em paralelo
por fora do carregamento principal, trocando sozinho quando terminar.

Também: o círculo de perímetro (7.4) só aparecia no ponto mais próximo de um
veículo parado. Agora aparece em QUALQUER ponto de entrega ao dar zoom de
rua (nível 15+), cor conforme o status (pendente/entregue/outro) — pedido
do cliente pra poder conferir o perímetro de qualquer cliente na rota, não
só o mais próximo.
