# Análise: como identificar desvio de rota e parada indevida

Documento técnico do sistema da Transmonseg. Trata de COMO detectar desvio de
rota, parada indevida e sinais correlatos, aplicado à nossa realidade (dados da
Unitrac, frota Nutry/Benassi, Rio de Janeiro). Não é teoria solta: cada método
vem marcado com o que já está no ar, o que falta e onde dá mais retorno.

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

---

## 1. DESVIO DE ROTA

### 1.1 Definição operacional
O veículo está indo (ou sendo levado) para onde não deveria. Sem rota traçada,
"deveria" = em direção a um dos pontos pendentes, ou dentro do corredor habitual
daquele trajeto.

### 1.2 Métodos, do mais simples ao mais robusto

**A. Afastamento do alvo (IMPLEMENTADO hoje).**
Distância ao ponto pendente mais próximo cresce desde o ciclo anterior + rumo do
movimento oposto ao alvo + faixa local (2,5km a 25km).
- Força: funciona sem rota traçada, barato, roda a cada minuto.
- Fraqueza: usa linha reta (não a estrada real); é um proxy, não a rota.

**B. Corredor de rota real (OSRM / Google Routes) — PRÓXIMO PASSO de maior precisão.**
Traça a rota base→alvos pendentes na estrada, cria um "tubo" (buffer de 300 a
500m) em volta. Veículo fora do tubo = desvio, independente da distância ao alvo.
- É o padrão da indústria (gerenciadoras usam corredor + geocerca).
- Custo: calcular rota gasta cota de API. Mitigação: calcular a rota 1x por viagem
  (não a cada ping); a comparação posição×tubo é cálculo local de graça.
- Pré-requisito: saber a ORDEM dos alvos (a Unitrac dá `alvoordem`).

**C. Map matching / snap-to-road (HMM, ex OSRM `/match`).**
Cola a posição na via mais provável. Resolve o falso desvio causado por GPS ruim
em área urbana (prédio, viaduto) e permite comparar a SEQUÊNCIA de vias com a
esperada. Camada de limpeza antes de qualquer comparação geográfica.

**D. Corredor histórico (tubo aprendido) — melhor que a rota teórica.**
Em vez da rota que o roteirizador acha "ótima", usar o caminho que aquela placa
REALMENTE faz nesse trajeto (alpha-shape / casco côncavo dos rastros históricos).
Captura o jeito real de dirigir do motorista. Fora do tubo histórico = anomalia.
Depende de acumular histórico (semanas).

**E. Heading / rumo.**
Mudança brusca de direção, retorno (U-turn), sentido oposto sustentado ao destino.
Já usamos rumo como corroboração no método A; pode virar sinal próprio.

**F. Along-track progress travado.**
Ao longo de uma rota, o veículo deveria PROGREDIR (avançar na polilinha). Se o
progresso para mas ele continua se movendo lateralmente, é desvio mesmo sem se
afastar muito em linha reta. Requer o corredor (B).

**G. Saída de perímetro / cruzamento de fronteira.**
Sair de zona urbana para rodovia inesperada, ou cruzar a borda de um corredor
conhecido. Geocerca de corredor.

### 1.3 Nossa receita de evolução
- **Hoje:** gatilho local (afastando + rumo oposto + faixa 2,5 a 25km), persistência via "fora de rota" que mantém o alerta sem piscar.
- **Próximo nível:** corredor OSRM (tubo 300 a 500m). Mais preciso, menos dependente de distância ao alvo. Resolve os casos em que o veículo desvia mas continua "tecnicamente perto" de um ponto.
- **Maduro:** corredor histórico + along-track + score contextual.

### 1.4 Falsos positivos clássicos e como matar
| Falso positivo | Por que acontece | Antídoto |
|---|---|---|
| Deslocamento interurbano | Frota atende o estado todo; fica longe de tudo legitimamente | Teto de distância + corredor + checar se vai para a base |
| GPS ruim na cidade | Prédio/viaduto joga o ponto na rua errada | Map matching (snap-to-road) |
| Volta para a base no fim da rota | Afasta dos alvos restantes, mas é legítimo | Checar rumo para a base (indo para casa, não desviando) |
| Trânsito / congestionamento | Para ou desvia por causa de obra/acidente | Google traffic (futuro), comparação entre veículos |

---

## 2. PARADA INDEVIDA

A parte que o cliente mais sente, porque hoje só avisamos parada de 90 minutos.
Uma parada SUSPEITA de 15 minutos num lugar ermo passa batido. É a maior lacuna.

### 2.1 Definição
Parada que NÃO é entrega (alvo), NÃO é base, e NÃO é parada legítima (posto, comida,
trânsito), em local e hora que não fazem sentido.

### 2.2 Anatomia de uma parada (as 4 perguntas)

**1) Está realmente parado?**
Velocidade 0 sustentada. Rastrear `parado_desde` (reseta quando move mais de ~50m).
Persistência: ignorar semáforo/trânsito curto.

**2) ONDE parou?** (a pergunta que mais decide)
- Na base → ok (só `parada_longa` avisa acima de 90min).
- No raio de um alvo (`pontoraio`) → entrega, ok.
- Perto de POI legítimo (posto/restaurante/lanchonete/borracharia, via Overpass num raio ~80m) → **perdoa**. Cachear por coordenada.
- Parado em via de FLUXO (rodovia/avenida expressa) → suspeito (ninguém para numa rodovia sem motivo).
- Dentro de zona de risco (favela / hotspot de roubo de carga) → forte.
- Na residência do motorista (os "endereços" do `area/722` da Unitrac) → uso indevido / desvio.
- Lugar ermo nunca visitado → suspeito.

**3) HÁ QUANTO tempo?** (limiar por contexto)
- Cidade: ~12min. Estrada: ~25min (sugeridos pelo fundador).
- `parada_longa` 90min em qualquer lugar (já existe) para a equipe contatar.

**4) QUE HORA é?**
Madrugada e fora de operação pesam mais (57% dos roubos no RJ são noite/madrugada).

### 2.3 Classificação urbano × estrada (sem cadastro manual)
Velocidade sustentada + distância da base nas últimas ~2h. Acima de 80km/h
sustentado ou mais de 60km da base = ESTRADA (limiar de tempo maior). Senão CIDADE.
Necessário porque parar 15min é normal numa rua de entrega e MUITO suspeito numa rodovia.

### 2.4 Clusters de parada (DBSCAN) — aprendizado barato
Paradas RECORRENTES no mesmo ponto (um cliente, um pátio, a casa de apoio) são
legítimas: o sistema aprende e SUBTRAI suspeita. Parada NOVA num lugar nunca visto
pela placa = sobe a suspeita. Distingue rotina de anomalia sem cadastro.

### 2.5 Escalada (parada anômala vira crítico)
Uma parada de atenção vira crítica se: o tempo dobrou, OU o baú abriu ali, OU o
sinal caiu ali (jammer), OU está dentro de zona vermelha, OU houve tiroteio recente
no trecho.

---

## 3. SINAIS CORRELATOS (o "esse tipo de coisa")

- **Jammer (bloqueador):** salto súbito de `atraso` com ignição ainda ligada. Confirmação forte por correlação MULTI-VEÍCULO: 2+ placas perdem sinal no mesmo trecho/hora = jammer ativo na via (não falha individual). IMPLEMENTADO o básico; falta a correlação multi-veículo.
- **Coação vs conluio (assinatura de ruído):** roubo real = perda ABRUPTA de sinal + ignição ligada + brusquidão. Conluio (motorista combinado) = queda LIMPA + parada calma + sem pânico + reincidência histórica. Mesma "perda de sinal", intenções opostas; a assinatura separa.
- **Baú aberto fora de ponto** (IMPLEMENTADO): abertura longe de alvo/base.
- **Pânico** (IMPLEMENTADO): botão acionado.
- **Excesso de velocidade** (IMPLEMENTADO).
- **Tiroteio / operação próxima** (IMPLEMENTADO): cruzamento com Fogo Cruzado ao vivo.
- **Entrega fantasma:** alvo marcado feito (`situacao=1`, NF baixada) SEM o veículo ter passado no raio = conluio. Inverso do positivo normal; aqui suspeitar é legítimo.
- **Isca eletrônica** (se a operação usar): afastamento isca↔veículo = transbordo de carga.

---

## 4. FUSÃO: de sinais para decisão

Detectar é metade. A outra metade é COMBINAR sem afogar o operador.

- **Hierarquia:** sinal físico (pânico, baú, jammer) > geográfico (desvio, parada) > contextual. Físico é quase certeza; geográfico é suspeita; contextual ajusta o peso.
- **Frescor antes de tudo.**
- **Contexto perdoa (subtrai score):** POI por perto, trânsito real (Google), parada recorrente, e a comparação entre veículos (vários parados na mesma via = trânsito, ignora; um só parado em local ermo = suspeito).
- **Persistência N-pings obrigatória.**
- **Score contextual com números reais do RJ:** Baixada Fluminense concentra ~52% dos roubos, Duque de Caxias ~36%; noite/madrugada ~57%; segunda-feira ~40%. Corredores quentes: Av. Brasil/BR-101, BR-040, Dutra/BR-116, Arco Metropolitano, Linha Vermelha, Zona Oeste. O MESMO evento pesa mais na Baixada às 3h de uma segunda.
- **Encadeamento > evento isolado:** jammer → fora de rota → zona vermelha é uma CADEIA de alta confiança. Detectar sequências vale mais que somar eventos soltos.
- **Human-in-the-loop:** cada alerta que o operador trata (reconhecer / resolver / falso positivo, JÁ IMPLEMENTADO) vira rótulo. É o combustível do ML futuro e o que afina os limiares.

---

## 5. Onde estamos e o que falta (mapa de fogo)

**JÁ NO AR:**
- Desvio por afastamento + rumo oposto + faixa local (com anti-pisca).
- `parada_longa` (90min, qualquer lugar) para contato.
- Favela (point-in-polygon) e tiroteio próximo ao vivo (Fogo Cruzado).
- Jammer, pânico, baú, excesso de velocidade.
- Roubo de carga por município (ISP-RJ) como camada de risco.
- Fluxo do operador (gera rótulos).

**PRÓXIMO, alto valor e barato (ordem de retorno):**
1. **Parada anômala de verdade** (12/25min, fora de POI/base/alvo, com peso por zona e hora). É a maior lacuna: hoje uma parada suspeita curta não dispara nada.
2. **POI check via Overpass** (perdoa posto/comida) para a parada não virar alarme falso.
3. **Score contextual RJ** (peso por Baixada/corredor/madrugada/segunda).
4. **Corredor OSRM** (tubo) para o desvio ficar preciso de verdade.
5. **Persistência N-pings explícita** e **correlação multi-veículo do jammer**.

**DEPOIS (aprendizado, exige histórico):**
- Corredor histórico (alpha-shape), clusters DBSCAN de parada, perfil de horário por placa, ML de sequência (LSTM autoencoder / change-point) para o score de anomalia.

---

## 6. Recomendação

A maior alavanca AGORA não é mais sofisticação no desvio (que já está bom), e sim
fechar o buraco da **parada anômala**: detectar a parada curta e suspeita (fora de
ponto, fora de POI, em hora/zona ruim), com o POI check para não encher de falso
positivo, e o score contextual do RJ para priorizar. Isso é barato (Overpass é
grátis, os números do RJ já temos) e transforma o sistema de "avisa quem parou 1h30"
para "avisa quem parou onde e quando não devia". Depois disso, o corredor OSRM eleva
o desvio do nível "proxy bom" para "rastreamento preciso".

Princípio que vale para tudo: começar interpretável e barato, com fusão e human-in-
the-loop maduros, e só então subir para ML. Modelo complexo sem baseline limpo é
caixa-preta que ninguém confia numa central.
