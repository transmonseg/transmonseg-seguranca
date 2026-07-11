# Redesenho fundamentado da detecção de desvio de rota (Nutry Max), Design

**Data:** 2026-07-11
**Status:** em revisão com o usuário

## Problema

A "Fase Agressiva" de 11/07 (buffer mais apertado, teto interurbano maior, streak mínimo
baixado, limiar de risco baixado) foi feita ajustando números no feeling, respondendo a
pedidos pontuais ao longo do dia, sem validar contra dado real. Isso causou um bug de churn
(alerta fechando e reabrindo a cada ciclo, já corrigido) e deixou claro que o próprio projeto
já tinha a regra certa desde 09/07 (`docs/analise-deteccao.md`, seção 6): mudança que reduz o
limiar de disparo precisa de validação contra pelo menos 24h de dado real antes de ir pro ar.
Essa regra foi ignorada hoje.

Este documento reconstrói o desenho da detecção de desvio a partir de pesquisa (indústria,
academia, prática brasileira de gerenciamento de risco de carga), um áudio do cliente
explicando o que ele considera desvio de rota de verdade, e checagem empírica contra o banco
real da Nutry Max, em vez de continuar ajustando parâmetros no chute.

## Restrições confirmadas (não são hipóteses, são fatos verificados)

1. **Não existe rota planejada nem ordem de entrega fixa.** A Unitrac não fornece isso; o
   motorista escolhe livremente qual pendente visitar primeiro. Qualquer técnica que assuma
   "o motorista vai pro ponto mais próximo" está errada por design (foi o que quebrou a cerca
   virtual de hoje, que só verificava corredor contra os 3 pendentes mais próximos).
2. **Rua de bairro/favela não é sinal de nada em si.** No Rio de Janeiro, entrega legítima
   passa por rua secundária o tempo todo; e um assalto pode acontecer numa rua perfeitamente
   normal. Classificação de via (residencial vs. via principal) foi descartada como sinal
   depois dessa correção do usuário.
3. **Precisão real de GPS:** ~3-5m em rodovia/área aberta, 10-30m em área urbana densa
   (multipath). O buffer atual (120-200m) está bem acima do ruído puro de GPS; o ruído visto
   hoje não veio do buffer estar errado em metros, veio do corredor calculado (OSRM) escolher
   um caminho diferente do que o motorista realmente seguiu (rota alternativa legítima).
4. **Não existe threshold "correto" publicado em lugar nenhum.** Toda fonte (indústria,
   academia, gerenciadoras de risco brasileiras) trata buffer/threshold como calibração
   empírica por frota, nunca um número universal.
5. **Verificado no banco real (6 dias, 197 mil linhas de `corredor_celulas`):** só 1,2% dos
   pares origem-destino se repetem em 2+ dias diferentes, 0% em 3+ dias. A ideia de comparar
   contra o histórico da MESMA rota/par específico (tipo iBOAT/TRAOD) não tem dado suficiente
   e não vai ter tão cedo, porque os destinos da Nutry mudam demais dia a dia.
6. **Áudio do cliente (transcrito 11/07):** desvio de rota que importa é "quando ele está
   sendo roubado". Ambiguidade estrutural: sair de via expressa pode ser roubo OU corte de
   trânsito legítimo, geometricamente idêntico. Sinal concreto que o cliente destacou: chegar
   na porta do cliente e não parar, seguir por outra via, sem confirmar entrega. O próprio
   cliente reconhece que sistema 100% correto é impossível, porque o motorista sob coação pode
   não conseguir acionar o botão de pânico.
7. **Confirmado pela pesquisa (indústria + gerenciadoras de risco brasileiras como Griscargo):
   nenhum sistema no mundo alega distinguir geometricamente "corte de trânsito" de
   "abordagem".** O protocolo universal é humano: alerta dispara, a central liga pro
   motorista, escalada só depois. Isso confirma que a arquitetura "nunca fecha sozinho, humano
   sempre decide" (já implementada hoje) está certa e não deve mudar.

## Princípio geral

Não existe sistema perfeito (fato reconhecido pelo próprio cliente e por toda a pesquisa). O
objetivo não é "provar roubo", é nunca perder um caso real e dar contexto suficiente pro
operador decidir rápido. Falso positivo é aceitável (diretiva do usuário); o que não é
aceitável é alerta duplicado/ruído que não seja identificável nem pelo próprio sistema
(era o bug de churn, já corrigido) e é ruim é gastar esforço tentando "resolver
geometricamente" uma ambiguidade que a indústria inteira resolve com telefonema humano.

## Arquitetura proposta

Continua em camadas independentes, cada uma barata e testável isoladamente. Mudanças em
relação ao que está em produção hoje:

### 1. Camada comportamental (Camada 1, mantém sem mudança de lógica)

Afastar de TODOS os destinos pendentes ao mesmo tempo, sem depender de ordem. É a única regra
que já era correta por design, dado que não existe ordem de entrega. Score/streak devem ser
recalibrados via backtesting (seção "Calibração"), não chutados de novo.

### 2. Corredor de rota real / cerca virtual (mantém como principal, com um ajuste)

Continua sendo a defesa principal contra o ponto cego geométrico da Camada 1 (afastar de TODOS
exige poucos pendentes pra ser preciso). Ajuste necessário: parar de restringir a verificação
aos "3 pendentes mais próximos" (assume ordem que não existe) e verificar contra TODOS os
pendentes acessíveis dentro do orçamento de chamadas por ciclo, priorizando por afastamento
comportamental (Camada 1) quando o orçamento não cobrir todos.

### 3. NOVO: histórico próprio por rota específica (adiado, não descartado)

Dado real mostra que não há repetição suficiente ainda (1,2% em 2+ dias). Mantém a coleta
(`corredor_celulas`, migration 014, já rodando) e liga automaticamente, PAR A PAR, só quando
aquele par específico já tiver sido visto em 3+ dias diferentes. Sem intervenção manual: o
sistema vai ligando sozinho conforme os pares acumularem repetição.

### 4. NOVO: baseline comportamental por veículo/motorista (substitui a intenção original do item 3)

Como a rota não repete mas o VEÍCULO opera todo dia, agrega por motorista/veículo em vez de
por rota: percentis de velocidade por tipo de via, tempo parado, número de paradas, duração
média de parada, distância por viagem, horário. Classificação simples de tipo de viagem
(entrega urbana curta / urbana longa / rodoviária) por regra, não clustering. Baseline por
`(veículo, tipo_viagem, feature)` usando mediana/MAD (robusto a outlier) em janela rolante de
30-90 dias. Anomalia = desvio da mediana normalizado pelo MAD, combinado por soma ponderada.
Cold start (menos de 2-4 semanas de dado do veículo): cai pro baseline da frota inteira do
mesmo tipo de viagem, com peso proporcional a quanto histórico próprio já existe (shrinkage).
100% SQL/TypeScript, sem infraestrutura de ML.

### 5. NOVO: bypass de entrega sem parar

Sinal concreto trazido pelo áudio do cliente e validado pela pesquisa (stay-point detection
pra logística urbana usa parâmetros bem mais apertados que os genéricos de mobilidade: raio
~30m, tempo mínimo ~2-3min, exigindo velocidade caindo perto de zero, não só posição parada
dentro do raio maior do alvo). Entrou no raio de um pendente, velocidade não caiu perto de
zero pelo tempo mínimo, saiu sem a Unitrac confirmar entrega: sinal OPERACIONAL primeiro
(não vira alerta de segurança sozinho). Só escala pra alerta de segurança se corroborado por
um segundo sinal (desvio comportamental logo depois, parada não planejada em outro lugar, ou
padrão repetido na mesma rota).

### 6. Score de risco de área (mantém, com melhoria futura registrada mas não neste ciclo)

Continua favela + tiroteio + roubo de carga por CISP + corredor de rodovia + fator horário.
Oportunidade real encontrada na pesquisa e que ninguém no mercado faz: cruzar o alerta com
dado de trânsito real (Waze/Google) pra saber se havia congestionamento genuíno na rota
original na hora (reduz severidade se sim, sustenta se não). Fica registrado como melhoria de
médio prazo (depende de avaliar custo/acesso ao Waze for Cities ou Google Roads API), fora do
escopo imediato deste redesenho.

### 7. Parada anômala e jammer (mantêm, mas pesam mais na fusão final)

Toda a pesquisa (inclusive boletim do FBI sobre jammer em roubo de carga) confirma: o crime
acontece PARADO, o desvio geométrico é só o sintoma que leva até lá. Jammer correlacionado com
desvio é o sinal de maior confiança documentado. A fusão final (item abaixo) deve refletir
isso nos pesos.

### 8. Nunca auto-resolve (já implementado hoje, mantém sem mudança)

Confirmado como a prática universal da indústria (central liga pro motorista antes de
escalar). Não é exagero de segurança, é o padrão do setor.

## Fusão e calibração

Não existe peso "correto" publicado em lugar nenhum (confirmado por toda a pesquisa). A fusão
dos sinais (desvio comportamental + corredor + baseline de veículo + bypass de entrega + área
de risco + parada + jammer) deve ser calibrada com os rótulos que os operadores JÁ geram
(Reconhecer / Resolver / Falso positivo), nunca mais no chute.

Método concreto e leve (sem ML pesado), baseado em prática documentada de calibração de
threshold via feedback humano (conformal risk control / active learning) e de segmentação sem
overfitting (shrinkage bayesiano hierárquico):

- Cada segmento de contexto (ex.: por faixa horária, por tipo de via, por veículo) tem seu
  próprio threshold/peso, mas puxado em direção ao valor global proporcionalmente a quantos
  alertas rotulados aquele segmento já tem (Beta-Binomial simples, sem infraestrutura nova).
- Regra prática: não recalibrar um segmento com menos de ~20-30 alertas rotulados.
- O harness de backtesting (replay de posições históricas + rótulos reais já registrados)
  vira parte permanente do processo: qualquer mudança futura de threshold/streak/buffer passa
  por ele antes de ir pro ar, em vez de feedback anedótico no meio do dia. Isso é a correção
  direta do que deu errado hoje.

## O que fica de fora deste ciclo (registrado, não esquecido)

- Correlação com trânsito real (Waze/Google) para reduzir falso positivo de corte de
  trânsito legítimo. Ninguém no mercado faz isso hoje; fica como diferencial futuro.
- Map-matching probabilístico completo (HMM tipo Newson-Krumm). Mais robusto que o corredor
  atual, mas reescrita grande; só vale a pena se o corredor+baseline por veículo não bastar
  depois de calibrado com dado real.
- Histórico por par origem-destino específico (item 3): liga sozinho conforme o dado
  acumular, sem necessidade de decisão manual futura.

## Testes e validação

- TDD como em todo o projeto: cenário sintético primeiro, depois implementação.
- Harness de backtesting novo: replay de janelas históricas reais (posições + alertas +
  rótulos de operador já no banco) medindo precision/recall de qualquer configuração antes de
  decidir mudar algo em produção. Esse harness é o item que mais precisa existir, porque é a
  ausência dele que causou o problema de hoje.
- Nenhuma mudança de sensibilidade (buffer, streak, threshold) entra em produção sem passar
  por esse harness primeiro, revivendo a regra que já estava escrita em
  `docs/analise-deteccao.md` desde 09/07 e foi ignorada hoje.

## Fontes principais da pesquisa

- Pesquisa anterior (09/07): `~/pesquisas/pesquisa-desvio-rota-sem-rota-planejada-2026-07-09.md`
  (iBOAT, corredor multi-destino, limites do OSRM público).
- GPS accuracy urbano vs. rodovia: Fleet1st, Logistimatics, Tripela (2025-2026).
- Newson & Krumm, "Hidden Markov Map Matching Through Noise and Sparseness" (ACM SIGSPATIAL
  2009).
- Gerenciamento de risco de carga no Brasil: Griscargo, RotaExata, Sascar, Ituran, dissertação
  PUC-Rio (Bezerra, roteirização com restrição de risco de roubo).
- Cargo theft / jammer: boletim FBI Cyber Division, GPSPatron, project44 Theft Prevention
  (2026).
- Calibração de threshold: CALIBURN (arXiv 2605.24696, conformal risk control), ALFred (arXiv
  2508.09058, active learning), shrinkage bayesiano (Gelman).
- Stay-point / bypass de entrega: Li et al. (2008), Threshold settings for TRIP/STOP detection
  in GPS traces, patente US12450551 (fleet stop filtering).
- Baseline comportamental por motorista: Verisk DrivingDNA, patente "driver telematic
  signature" (US11037378), práticas de UBI (LexisNexis, Damoov).
- Áudio do cliente Nutry Max, transcrito em 11/07/2026 (Whisper local).
- Achado empírico próprio: consulta a `corredor_celulas` no banco de produção, 11/07/2026.
