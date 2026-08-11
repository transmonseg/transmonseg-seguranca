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
