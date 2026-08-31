// Detector de desvio de rota v2 -- 2 sinais independentes, funcoes PURAS.
// Ver docs/superpowers/specs/2026-08-12-desvio-de-rota-v2-design.md.
// Nunca importe nada de 'next'/'pg' aqui.

import type { Alerta } from "./detectores";

// 16/08: tentativa inicial de resgatar o streak=1 da "Fase Agressiva"
// (11/07, commit 2b94ca4, epoca do unico elogio real confirmado do cliente
// -- "7C13 deu certinho desvio 👏", "Melhorou", 13/07) foi CORRIGIDA no
// mesmo dia apos simular um dia real (sexta 14/08) contra o codigo atual:
// streak=1 deu 14014 disparos brutos/dia (228/347 veiculos) -- ~40x o pior
// dia ja visto neste projeto. Causa: streak=1 foi validado em 11/07 contra
// distancia em LINHA RETA (sinal suave); o motor de hoje usa distancia
// REAL de rua via OSRM (sinal ruidoso por natureza, ja documentado em
// 12/08 -- alcas de acesso fazem a distancia aumentar por 1-2 leituras
// mesmo indo certo). Os dois nunca foram validados juntos. Comparacao no
// mesmo dia real: streak=2 -> 973/dia, streak=3 -> 212/dia (proximo do
// pior dia historico). streak=2 escolhido como meio-termo -- ainda bem
// mais sensivel que o streak=3 anterior, sem a explosao do streak=1. Ver
// scripts/simular-dia-desvio-v2.mjs e scripts/comparar-streaks-desvio-v2.mjs
// (o 2o nao commitado, uso unico). Aceita conscientemente MAIS ruido de
// geometria de estrada que o streak=3 tinha (ex. caso RQP-2G33) -- ja
// documentado em [[feedback_desvio_priorizar_recall]] como tradeoff aceito.
export const LIMIAR_STREAK_AFASTANDO = 2;
export const LIMIAR_STREAK_RUA_RARA = 2;
export const LIMIAR_VISITAS_RARA = 2;
// Revertido 16/08 pra 300km (era 15km desde 12/08): mesmo resgate da Fase
// Agressiva -- o teto de deslocamento interurbano subiu de proposito de
// 25km->80km->300km em 11-12/07 (commits 77cb4f9/36df499/ac312da) porque um
// teto baixo escondia desvio real dentro da faixa normal de operacao entre
// clientes distantes. O piso de 15km (12/08) resolvia ruido de geometria em
// transito longo mas reintroduzia exatamente esse problema -- escolha
// deliberada de voltar pro valor validado que gerou o elogio de 13/07.
export const LIMIAR_TRANSITO_LONGO_M = 300_000;
// Achado real 12/08 (mesma simulação): manobra de saída/permanência no
// pátio da base produz ruído de "afastando de tudo" -- suprime avaliação
// do detector de desvio inteiro (os 2 sinais) enquanto ainda perto da base.
export const LIMIAR_CARENCIA_BASE_M = 1200;

// Achado real 28/08 (reclamacao no grupo "DESVIO DE ROTA" sobre volume de
// desvio incorreto na Central Unitrac; 2 dos 16 falso-positivos do dia,
// TTJ-9I18 e RQV-6I51, tem esta assinatura). Padrao no dado bruto de
// posicoes_historico: a Unitrac repete a MESMA leitura (lat/lng identicos,
// velocidade identica e > 0) por varios ciclos seguidos com `atraso_min`
// SUBINDO leitura a leitura -- e' telemetria atrasada, o veiculo esta
// rodando, so' o dado nao chegou. Quando a telemetria "volta ao normal",
// `atraso_min` despenca pra 1-3 e a posicao SALTA de uma vez o chao
// percorrido durante todo o congelamento. Caso TTJ-9I18 (28/08, UTC+2):
//
//   12:20:01 -21.690875,-41.476723 vel 86 atraso 14
//   ...      (mesmo lat/lng, mesma velocidade, atraso 15,16,18,19)
//   12:25:55 -21.690875,-41.476723 vel 86 atraso 20
//   12:27:03 -21.644320,-41.671647 vel 88 atraso  1   <- salto de 20,8km
//
// RQV-6I51 no mesmo dia: atraso 15 -> 1, salto de 16,4km numa leitura.
//
// O ciclo do salto compara `anterior` (o ponto congelado) com `pos` (o
// ponto reconciliado): ~20 minutos de deslocamento real comprimidos numa
// unica comparacao de ciclo, quando o detector foi desenhado pra ciclos de
// ~30-70s. E' o mesmo tipo de comparacao invalida que
// LIMIAR_MOVIMENTO_MINIMO_M (motor/route.ts) ja' evita pelo lado de baixo
// (movimento pequeno demais pra confiar na distancia de rua do OSRM), so'
// que pelo lado de cima. Nao e' jammer (jammer e' ignicao ligada + atraso
// >= 15min tratado por detector e cooldown proprios, e continua valendo:
// este gate suspende apenas o ciclo de avaliacao de DESVIO).
//
// Calibracao (SELECT read-only em producao). Rodada 1 usou 4 dias de
// alertas; a revisao independente mostrou que essa janela era curta demais
// (overfit) e que a condicao SO' de atraso era insuficiente -- ver abaixo.
// Numeros finais: 7 dias de alertas tipo='desvio' (195 ativo, 200 resolvido,
// 197 falso_positivo, 525 limpo), pareados com o par de leituras que formou
// o streak em posicoes_historico (8 dias, 5,56M pares consecutivos).
//
// POR QUE O ATRASO SOZINHO NAO BASTA (achado da revisao, 28/08): "atraso
// alto que cai" acontece muito sem nenhum salto de posicao -- o dado
// simplesmente se normaliza com o veiculo andando normalmente. Medido nos
// pares dentro da faixa de atraso do gate e COM movimento real (>= 50m):
// 70% andaram menos de 1km, ou seja, sao ciclos normais de ~60s, nao saltos
// de reconciliacao. Suprimi-los e' perda de recall pura. Caso concreto:
// RQU-5G33 (22/08, status `resolvido`, i.e. desvio REAL tratado pelo
// operador) tem atraso 27 -> 1 no par que leva o streak de 0->1, mas
// deslocamento de apenas 327m em 62s -- assinatura de atraso identica a dos
// casos alvo, comportamento completamente diferente. Por isso o gate exige
// TAMBEM que a posicao tenha saltado.
//
// Limiar de salto = 4000m: e' o p99.9 do deslocamento de um ciclo saudavel
// (pares com atraso <= 3 dos dois lados e movimento >= 50m): p50 = 464m,
// p95 = 1517m, p99 = 2548m. O p99.9 fica em ~4km, mas OSCILA com a janela de
// dias medida -- 3962m, 4001m e 4032m em tres medicoes diferentes (5 dias, 8
// dias, e a do revisor independente). 4000 e' o valor redondo no meio dessa
// faixa; nao ha precisao maior que isso no numero e nao adianta fingir que
// ha. Corta o RQU-5G33 (327m) e demais ciclos normais.
//
// Limiar de velocidade implicita = 150 km/h (achado da 2a revisao
// independente, 28/08): so' a distancia bruta nao basta, porque um ciclo
// pode ser longo. Dois pares reais dos ultimos 8 dias passavam do salto de
// 4km sendo fisicamente PLAUSIVEIS -- RQU-4B93 (5446m em 260s = 75 km/h) e
// RBI-0J25 (4644m em 145s = 115 km/h): rodovia de verdade, ciclo longo, nao
// artefato. Exigir tambem velocidade implicita impossivel torna a
// justificativa "este par nao pode ser um ciclo real" literalmente
// verdadeira. Distribuicao da velocidade implicita dentro do gate (711 pares
// em 8 dias): min 75 km/h, p05 240, p25 426, p50 600 km/h -- so' 4 pares
// ficam abaixo de 150 km/h, ou seja, o corte custa 0,6% da superficie do
// gate e elimina 100% dos casos plausiveis achados. 150 km/h em LINHA RETA
// sustentado por um ciclo inteiro esta ~50% acima do teto legal de caminhao
// no Brasil -- nenhum caminhao carregado faz isso. Os 2 casos alvo: 1101
// km/h e 950 km/h implicitos, ordens de grandeza acima. No sweep de alertas
// (7 dias), adicionar esta condicao nao muda NADA (0 ativo / 1 resolvido /
// 2 falso_positivo com ou sem ela) -- e' ganho de precisao de graca.
//
// NOTA sobre o dt que o chamador passa: no motor ele e' um LIMITE SUPERIOR
// do intervalo real (ver PERIODO_CICLO_MOTOR_S em route.ts), de proposito --
// dt maior => velocidade implicita menor => suprime menos. No simulador o dt
// e' exato (tem os dois timestamps). Ou seja, o conjunto de ciclos que o
// MOTOR suprime e' um SUBCONJUNTO do que a simulacao suprime; a validacao
// por simulacao e' um limite superior do impacto, que e' o lado certo pra
// sustentar "nenhum desvio real perdido".
//
// Sweep final (alertas dos 7 dias tocados pelo gate, no par que forma o
// streak). Com a condicao de salto >= 4000m:
//
//   N (piso de atraso_ant)   ativo  resolvido  falso_positivo
//   8                          0        1            2
//   9                          0        1            2
//   10                         0        1            2   <- escolhido
//   12                         0        1            2
//   15                         0        1            2
//
// ATENCAO ao ler esse sweep: o "N de 8 a 15 da o mesmo resultado" vale
// SOMENTE com a condicao de salto ligada. SEM ela (como estava na rodada 1),
// os mesmos 7 dias dao 2 `resolvido` tocados em qualquer N de 8 a 15 -- a
// janela de 4 dias da rodada 1 escondia isso. Confundir os dois cenarios foi
// exatamente o que gerou divergencia entre revisoes; os dois numeros estao
// aqui de proposito. CORRECAO de uma afirmacao errada da rodada 1: N=10 NAO
// e' "o menor limiar sem tocar desvio real" -- N=9 ja' zera os `ativo`. 10
// foi mantido por conservadorismo (menor superficie de supressao), nao por
// ser um minimo.
//
// O unico `resolvido` que continua dentro do gate e' TTJ-9I18 (21/08, atraso
// 16 -> 1, salto de 7342m em 69s = 383 km/h implicitos). E' o mesmo veiculo
// e o mesmo artefato dos casos alvo -- o par de leituras e' fisicamente
// impossivel, entao a comparacao de distancia ali nao vale nada. Validado na
// simulacao do dia 21/08: o disparo desse veiculo continua acontecendo com o
// gate ligado, so' uma leitura depois (ver relatorio, secao Rodada 2).
//
// Teto de 60min no atraso ANTERIOR: a justificativa e' EMPIRICA, nao
// tecnica. (A rodada 1 dizia "acima de 60 `pos.fresco` e' false e o ciclo nem
// e' avaliado" -- isso esta ERRADO: `fresco` e' da leitura ATUAL, e o push
// pra posicoes_atuais e' incondicional, entao uma leitura nao-fresca vira
// `anterior` normalmente no ciclo seguinte.) O motivo real e' o dado: os 2
// unicos casos com atraso_ant > 60 na janela (TML-3B11 atraso 132, RQV-3J99
// atraso 66) foram ambos classificados `ativo`/`resolvido` pelo operador --
// tratados como reais. Reconciliacao depois de MUITO tempo sem comunicacao
// e' outra categoria (jammer/sem comunicacao, com detector proprio) e fica
// deliberadamente fora deste gate.
//
// Piso de 3min pro atraso atual: e' a faixa de regime normal observada no
// proprio dado (leituras saudaveis ficam em atraso 1-3), i.e. "a telemetria
// voltou ao normal". <=2 e <=3 dao EXATAMENTE o mesmo resultado nos alertas
// da janela; 3 escolhido por ser a faixa normal completa.
//
// Custo de recall e' no maximo UM ciclo -- MAS isso depende de o chamador
// preservar o streak explicitamente. Achado da 2a revisao independente
// (28/08): no motor, `afastandoStreakNovo` nasce 0 e so' e' escrito DENTRO do
// bloco de avaliacao, entao qualquer gate que pula o bloco grava 0 em
// desvio_estado -- ou seja, os gates existentes (paradoSemSeMover,
// movimentoInsignificante, suspensoPorChegada...) ZERAM o streak, nao
// "pulam o ciclo". Pra veiculo parado isso e' inofensivo; pra ESTE gate, que
// atua sobre veiculo em movimento e potencialmente divergindo, nao e'.
// route.ts tem um ramo dedicado que restaura estadoDesvioAnterior quando
// ESTE gate suprime (ver o `else if` la'). Com isso a garantia vale de fato:
// um veiculo realmente divergindo continua divergindo no ciclo seguinte (ja'
// com os dois pontos reconciliados) e o streak retoma de onde parou -- o
// alerta sai ~1 leitura depois, nunca deixa de sair.
export const LIMIAR_ATRASO_RECONCILIACAO_MIN = 10;
export const LIMIAR_ATRASO_NORMALIZADO_MIN = 3;
export const LIMIAR_ATRASO_FRESCO_MIN = 60;
export const LIMIAR_SALTO_RECONCILIACAO_M = 4000;
export const LIMIAR_VELOCIDADE_IMPLAUSIVEL_KMH = 150;

export function ehSaltoDeReconciliacaoDeAtraso(
  atrasoAnteriorMin: number | null | undefined,
  atrasoAtualMin: number | null | undefined,
  movimentoRealM: number | null | undefined,
  dtSegundos: number | null | undefined
): boolean {
  if (
    atrasoAnteriorMin == null ||
    atrasoAtualMin == null ||
    movimentoRealM == null ||
    dtSegundos == null ||
    // Sem intervalo utilizavel nao da' pra afirmar que o par e'
    // fisicamente impossivel -- na duvida, avalia (nunca suprime).
    !(dtSegundos > 0)
  ) {
    return false;
  }
  const velocidadeImplicitaKmh = (movimentoRealM / dtSegundos) * 3.6;
  return (
    atrasoAnteriorMin >= LIMIAR_ATRASO_RECONCILIACAO_MIN &&
    atrasoAnteriorMin <= LIMIAR_ATRASO_FRESCO_MIN &&
    atrasoAtualMin <= LIMIAR_ATRASO_NORMALIZADO_MIN &&
    movimentoRealM >= LIMIAR_SALTO_RECONCILIACAO_M &&
    velocidadeImplicitaKmh >= LIMIAR_VELOCIDADE_IMPLAUSIVEL_KMH
  );
}

// ─── Gate de "retorno sustentado a base" (achado real 28/08) ─────────────
//
// Reclamacao real da equipe no resumo de fim de dia do grupo DESVIO DE ROTA:
// "tivemos muitos desvios de rota em que principalmente [em] veiculos que
// estavam retornando para a base". Confirmado no dado (READ-ONLY,
// desvio_disparo_log + posicoes_historico, 5 dias): 20,3% dos 12.492
// disparos de afastando_geral acontecem com TODAS as bases do cliente a mais
// de LIMIAR_DESTINO_RELEVANTE_M (50km, motor/route.ts). Nesses, o filtro de
// 50km -- criado em 13/08 pra impedir que uma base distante MASCARE uma
// divergencia local real -- tira a propria base do conjunto avaliado
// justamente quando o veiculo esta voltando pra ela. Sobram so' os pontos de
// entrega pendentes, e voltar pra base afasta de TODOS eles ao mesmo tempo:
// afastouDeTodos fica true sem nenhum contrapeso.
//
// POR QUE NAO SE RESOLVE ISSO SO' TIRANDO A BASE DO FILTRO DE 50KM (a
// solucao obvia, e a hipotese do brief): porque ela reintroduz o problema de
// 13/08 em escala industrial. Medicao no dado real (5 dias, 12.492 disparos
// pareados com posicoes_historico e com o status do alerta):
//
//   disparos com todas as bases > 50km ........................ 2.536
//   ... desses, base APROXIMANDO no par que fechou o streak .... 1.967
//   ... entre eles, disparos de alerta ativo/resolvido ......... 113
//   incidentes reais (veiculo+30min, alerta ativo/resolvido) ... 299
//   incidentes que ficariam TOTALMENTE sem alerta .............. 44 (14,7%)
//
// A 60-130km da base, a variacao da distancia ate ela e' dominada pelo rumo
// geral da rodovia, nao pelo comportamento local do motorista -- que e'
// exatamente o raciocinio de 13/08. "Base aproximou neste ciclo" nao
// distingue nada: acontece em 78% dos disparos com base filtrada, reais e
// falsos igualmente. Perder 14,7% dos desvios reais e' inaceitavel
// ([[feedback_desvio_priorizar_recall]]: aceitar falso positivo, nunca perder
// desvio real), entao o fix simples foi descartado.
//
// O QUE DISTINGUE DE VERDADE: nao o sinal de um ciclo, e sim a persistencia.
// Um retorno a base de verdade e' uma aproximacao ininterrupta por muitos
// minutos, em que quase todo metro rodado vira metro a menos de base. Sweep
// dos mesmos 5 dias (parametros: janela, monotonicidade, queda minima e
// fracao do caminho convertida em aproximacao):
//
//   janela  monotonia   fracao   supr. ruido   supr. REAIS   incid. perdidos
//   300s    estrita     >=0.5    372 (3,1%)    16            1
//   420s    estrita     >=0.5    628 (5,2%)    16            2
//   600s    estrita     >=0.5    574 (4,8%)    7             2
//   900s    estrita     >=0.5    331 (2,8%)    0             0
//   1200s   estrita     >=0.5    162 (1,4%)    0             0
//   900s    estrita     >=0.7    260 (2,2%)    0             0
//   900s    >=0.9       >=0.5    515 (4,3%)    6             1
//
// 15 minutos de queda ESTRITA (nenhuma leitura da janela pode aumentar a
// distancia) e' onde a curva cruza zero: nenhum dos 507 disparos de alerta
// real dos 5 dias sobrevive a esse teste, enquanto 331 disparos de ruido
// sim. Janela mais curta (10min, 7min) ja' pega desvio real -- a margem esta
// no comprimento da janela, nao nos outros parametros (com 900s, exigir
// fracao 0,3 ou 0,7 nao muda o lado de recall: 0 em ambos).
//
// Deliberadamente NAO se ignora leitura "parada" na checagem de
// monotonicidade: tolerar passos < 50m parece razoavel, mas triplica a
// superficie do gate e volta a pegar desvio real (com janela de 900s:
// 25 disparos reais e 11 incidentes perdidos). Uma unica leitura afastando
// derruba o gate -- e' de proposito.
//
// Custo maximo de recall por construcao: o chamador aplica isto DEPOIS de
// avaliarAfastandoDeTudo e NAO mexe no streak. Assim que o veiculo deixa de
// se aproximar da base o gate para de valer e o alerta sai no mesmo ciclo,
// com o streak ja' acumulado -- nao ha atraso nem reinicio.
export const RETORNO_BASE_JANELA_S = 900;
export const RETORNO_BASE_SPAN_MIN_S = 600;
export const RETORNO_BASE_MIN_LEITURAS = 5;
export const RETORNO_BASE_QUEDA_MIN_M = 1000;
export const RETORNO_BASE_FRACAO_CAMINHO_MIN = 0.5;

export type LeituraRetornoBase = {
  // epoch em segundos (ordem crescente)
  tSegundos: number;
  // distancia em linha reta ate a base mais proxima do cliente
  distBaseM: number;
  // deslocamento real desde a leitura anterior (0 na primeira)
  deslocamentoM: number;
};

export function ehRetornoSustentadoABase(leituras: LeituraRetornoBase[]): boolean {
  if (leituras.length < RETORNO_BASE_MIN_LEITURAS) return false;
  const primeira = leituras[0];
  const ultima = leituras[leituras.length - 1];
  if (ultima.tSegundos - primeira.tSegundos < RETORNO_BASE_SPAN_MIN_S) return false;
  let caminhoM = 0;
  for (let i = 1; i < leituras.length; i++) {
    // Queda ESTRITA em TODA leitura da janela -- uma unica leitura que
    // aumenta a distancia ate a base derruba o gate (ver comentario acima).
    if (!(leituras[i].distBaseM < leituras[i - 1].distBaseM)) return false;
    caminhoM += leituras[i].deslocamentoM;
  }
  const quedaM = primeira.distBaseM - ultima.distBaseM;
  if (quedaM < RETORNO_BASE_QUEDA_MIN_M) return false;
  if (!(caminhoM > 0)) return false;
  return quedaM / caminhoM >= RETORNO_BASE_FRACAO_CAMINHO_MIN;
}

// ─── Gate de "saida da base sem destino avaliavel" (achado real 31/08) ───
//
// Reclamacao real no grupo "DESVIO DE ROTA" (31/08, com fotos de 4 veiculos
// -- TTY-1A57, TTK-8A87, RQP-4A68, TTI-6E49): desvio marcado logo ao SAIR da
// base, seguindo pela via principal rumo ao primeiro cliente, operador
// confirmando "romaneio ja consta no sistema" e "nao desviou em nenhum
// momento".
//
// MECANISMO. O filtro de LIMIAR_DESTINO_RELEVANTE_M (50km, motor/route.ts,
// achado de 13/08) tira do conjunto avaliado todo destino a mais de 50km, pra
// impedir que um destino muito distante MASCARE divergencia local. Em rota
// LONGA (primeiro cliente do romaneio a >50km da base -- rotina em Nutry Max)
// isso remove TODOS os clientes pendentes de uma vez, e sobra so' a base no
// conjunto. A partir dai "afastar de TODOS os destinos relevantes" degenera
// em "afastar da base" -- que e' exatamente o que progredir na rota significa.
// emCarenciaDeBase (1200m, achado de 12/08 pra manobra de patio) e' curto
// demais: no disparo real de 31/08 o veiculo ja estava a 8,5km da base na
// primeira leitura do streak.
//
// ESCOPO -- POR QUE ISTO **NAO** COBRE "VEICULO SEM NENHUM PENDENTE".
// Medicao read-only (18 dias, alertas com motivo "Afastando de todos%"
// pareados com o desvio_disparo_log do ciclo e com pendentes_snapshot_log):
// dos 1.026 alertas em que o conjunto avaliado ficou SEM nenhum cliente
// pendente, ha duas populacoes completamente diferentes --
//
//   A) HAVIA pendentes, todos filtrados pelos 50km ..... 250 alertas
//      ... tratados individualmente por operador (resolver_individual) ... 1
//   B) NAO havia pendente nenhum (romaneio ausente/concluido) ... 776
//      ... tratados individualmente por operador ......................... 6
//
// Em (B) o afastamento da base e' informacao de verdade: sem pendentes, o
// veiculo deveria estar indo PRA base, e os 6 casos reais estao espalhados de
// 1,3km a 46,9km dela -- nenhum criterio de distancia os separa do ruido.
// Suprimir (B) custaria recall real ([[feedback_desvio_priorizar_recall]]),
// entao (B) fica DELIBERADAMENTE fora deste gate: exige-se
// `temPendenteForaDoRaio`, i.e. o conjunto ficou degenerado por causa do
// filtro de 50km, nao por ausencia de rota. (Dois dos 4 veiculos da
// reclamacao de 31/08 -- TTK-8A87 e TTI-6E49 -- caem em (B), com
// alvos_api_ok=true e ZERO pendentes o dia inteiro: aquilo e' problema de
// dado de entrada/romaneio, causa raiz diferente, tratada em outro lugar.)
//
// PISO DE DISTANCIA DA BASE. Dentro de (A) ainda existe 1 caso real tratado
// individualmente: RQU-0B47 (25/08), a 1.922m da base, 114s depois de sair
// dela -- exatamente o cenario que o brief manda preservar (motorista pega a
// via errada logo na saida, antes de qualquer cliente entrar nos 50km). Por
// isso o gate so' vale ALEM da area local da base. Sweep do piso, sempre
// dentro de (A), em 18 dias (suprimidos: falso_positivo / limpo / ativo /
// resolvido-individual-por-operador):
//
//   piso     fp   limpo  ativo  resolv_individual
//   1.200m   15    186     18      1   <- perde o RQU-0B47
//   2.000m   14    115     17      0
//   3.000m   13    102     17      0
//   5.000m   12     92     16      0   <- escolhido
//   8.000m   11     78     15      0
//
// 5.000m e' 2,6x a distancia do unico caso real da classe (nao e' o menor
// valor que zera a perda -- 2.000m ja' zera; 5.000m foi escolhido pela
// margem, porque zerar em 2.000m seria ajustar o parametro a UM ponto de
// dado). Todos os disparos da reclamacao de 31/08 que caem em (A) estavam a
// 5,9km-37km da base.
//
// STREAK ELEVADO EM VEZ DE SUPRESSAO CEGA. Mesmo dentro do escopo acima o
// gate nao cala o sinal pra sempre: ele exige mais evidencia. Dentro de (A) e
// alem do piso, o ruido morre cedo e um afastamento que PERSISTE continua
// disparando. Sweep do limiar (mesmos 18 dias, suprimidos = os que nao
// alcancam o limiar):
//
//   limiar   fp   limpo  ativo  resolv_individual
//   4         3     59     11      0
//   6         3     74     14      0
//   8         4     82     15      0   <- escolhido
//   10        5     85     15      0
//   sem teto 12     92     16      0
//
// 8 ciclos (~4min de afastamento continuo, ciclo de ~30s) pega ~89% do ruido
// e ainda deixa uma rede de seguranca: divergencia real sustentada nesse
// estado sai com atraso maximo de 6 leituras, nunca deixa de sair. Do 8 pro
// "sem teto" ganha-se pouco (8 fp + 10 limpo) e perde-se a rede inteira.
//
// EXIGE EVIDENCIA POSITIVA DE PROGRESSO. A regra central do detector e'
// "nunca dispara indo em direcao a um destino" -- e' o filtro de 50km que
// tira do conjunto justamente os destinos aos quais o veiculo esta indo. O
// gate so' age quando o veiculo esta DE FATO se aproximando (linha reta,
// sem custo de OSRM) de algum dos pendentes que o filtro removeu, i.e.
// quando ha evidencia de que ele esta progredindo na rota, nao so' ausencia
// de evidencia contraria. Custo dessa exigencia extra no dado real (18d,
// dentro de (A) e alem do piso): a supressao de ruido cai de 82 pra 75
// `limpo`, e a supressao de alertas fechados em lote por operador cai de 15
// pra 12 -- barato pelo ganho de justificativa.
//
// RISCO RESIDUAL, REPORTADO DE PROPOSITO: 12 alertas de (A) que passam por
// todas as condicoes acima foram fechados por `resolver_massa` COM
// operador_id (resolucao em lote) nos 18 dias e seriam suprimidos. Nenhum
// deles foi aberto e julgado individualmente, e todos tem a mesma assinatura
// estrutural do ruido (streak 2, janela de saida matinal), mas resolucao em
// lote e' acao de operador -- fica registrado como custo possivel de ~0,7
// alerta/dia, contra ~6/dia de ruido removido.
//
// NAO mexe no streak (mesma disciplina do gate de retorno a base): o
// chamador aplica isto DEPOIS de avaliarAfastandoDeTudo, entao o streak
// continua acumulando normalmente e o alerta sai no ciclo em que qualquer
// uma das condicoes deixar de valer (um cliente entrou nos 50km, o streak
// alcancou o limiar, ...) -- sem reinicio e sem atraso adicional.
export const LIMIAR_SAIDA_BASE_MIN_M = 5000;
export const LIMIAR_STREAK_SEM_DESTINO_AVALIAVEL = 8;

export function ehSaidaDeBaseSemDestinoAvaliavel(args: {
  // ha ao menos um cliente pendente DENTRO do raio de relevancia (conjunto
  // avaliado nao esta degenerado) -- se sim, o gate nunca vale.
  temPendenteRelevante: boolean;
  // havia cliente(s) pendente(s) com coordenada valida, e nenhum sobreviveu
  // ao filtro de 50km. False cobre "veiculo sem pendente nenhum", que fica
  // fora do gate de proposito (populacao B do comentario acima).
  temPendenteForaDoRaio: boolean;
  // o veiculo se aproximou (linha reta, neste ciclo) de algum dos pendentes
  // que o filtro de 50km removeu. Sem essa evidencia positiva de progresso o
  // gate nao age.
  aproximandoDePendenteForaDoRaio: boolean;
  // distancia em linha reta ate a base mais proxima do cliente.
  distBaseM: number | null;
  streakAfastando: number;
}): boolean {
  const {
    temPendenteRelevante,
    temPendenteForaDoRaio,
    aproximandoDePendenteForaDoRaio,
    distBaseM,
    streakAfastando,
  } = args;
  // Na duvida (sem distancia de base conhecida), NUNCA suprime.
  if (distBaseM == null || !Number.isFinite(distBaseM)) return false;
  if (temPendenteRelevante) return false;
  if (!temPendenteForaDoRaio) return false;
  if (!aproximandoDePendenteForaDoRaio) return false;
  if (distBaseM < LIMIAR_SAIDA_BASE_MIN_M) return false;
  return streakAfastando < LIMIAR_STREAK_SEM_DESTINO_AVALIAVEL;
}

export type ResultadoAfastando = { streak: number; disparou: boolean; aproximandoAlgum: boolean };

// Sinal A: o veiculo se afastou (distancia REAL de rua, ja calculada pelo
// chamador) de TODOS os destinos (pendentes + base) por N leituras
// seguidas. Sem decaimento -- distancia real de rua e mais estavel que
// linha reta, entao um streak binario simples deve bastar (validar contra
// dia real na Task 8 antes de considerar o parametro final).
export function avaliarAfastandoDeTudo(
  distanciasAtuais: number[],
  distanciasAnteriores: number[],
  streakAnterior: number,
  opts?: { limiarTransitoLongoM?: number }
): ResultadoAfastando {
  if (
    distanciasAtuais.length === 0 ||
    distanciasAnteriores.length === 0 ||
    distanciasAtuais.length !== distanciasAnteriores.length
  ) {
    return { streak: 0, disparou: false, aproximandoAlgum: false };
  }

  const aproximandoAlgum = distanciasAtuais.some((d, i) => d < distanciasAnteriores[i]);
  const emTransitoLongo =
    Math.min(...distanciasAtuais) > (opts?.limiarTransitoLongoM ?? LIMIAR_TRANSITO_LONGO_M);
  const afastouDeTodos = !emTransitoLongo && distanciasAtuais.every((d, i) => d > distanciasAnteriores[i]);

  // Achado real 13/08 (analise do dia inteiro via desvio_disparo_log, apos
  // ja ter filtrado ruido de GPS/movimento insignificante e destino
  // distante): o proprio comentario acima ja documentava que distancia
  // real de rua NAO e perfeitamente monotona nem numa divergencia real
  // (alças de acesso e contornos de rodovia fazem 1-2 leituras "aproximar"
  // por acaso mesmo indo na direcao errada) -- mas o streak era reset
  // TOTAL na primeira leitura assim, perdendo QUALQUER divergencia real
  // acumulada ate ali por causa de um unico blip de geometria. Prioridade
  // e recall (aceita falso positivo, nunca perde desvio real) -- decai 1
  // em vez de zerar quando aproximou de algum destino (mas continua
  // evaluavel, i.e. nao em transito longo): precisa de 3 leituras
  // NAO-diverentes seguidas pra apagar um streak de 3, nao mais so' 1.
  // emTransitoLongo continua zerando na hora -- não é ruido, é "fora da
  // zona onde a avaliacao local faz sentido agora".
  const streak = afastouDeTodos ? streakAnterior + 1 : emTransitoLongo ? 0 : Math.max(0, streakAnterior - 1);
  return { streak, disparou: streak >= LIMIAR_STREAK_AFASTANDO, aproximandoAlgum };
}

export type ResultadoRuaRara = { streak: number; disparou: boolean };

// Sinal B: o veiculo entrou numa celula rara no historico da FROTA
// (celula_frequencia_cliente.n_visitas <= LIMIAR_VISITAS_RARA) e nao esta
// aproximando de nenhum destino pendente no mesmo ciclo (requisito
// explicito do usuario: nunca disparar indo em direcao a um cliente, MESMO
// por rua rara/estreita).
export function avaliarRuaRara(
  nVisitasHistorico: number,
  aproximandoAlgum: boolean,
  streakAnterior: number,
  limiarVisitas: number = LIMIAR_VISITAS_RARA
): ResultadoRuaRara {
  const condicao = nVisitasHistorico <= limiarVisitas && !aproximandoAlgum;
  const streak = condicao ? streakAnterior + 1 : 0;
  return { streak, disparou: streak >= LIMIAR_STREAK_RUA_RARA };
}

// Monta o Alerta final. Se os dois sinais dispararem no mesmo ciclo,
// "afastando de tudo" tem prioridade (sinal mais direto/menos ambiguo).
//
// nivel="critico" pros dois desde 16/08 (era "atencao"): resgate da Fase
// Agressiva (11/07) -- todo desvio comportamental ja nascia critico
// (vermelho) naquela epoca, sem escala intermediaria "atencao"
// (amarelo/observando). Reverte a diretiva original do usuario, que tinha
// sido invertida na pratica pelas camadas de agosto (placar, modo teste).
export function montarAlertaDesvio(
  afastando: { disparou: boolean; streak: number },
  ruaRara: { disparou: boolean; streak: number; celula: string; nVisitas: number }
): Alerta | null {
  if (afastando.disparou) {
    return {
      nivel: "critico",
      tipo: "desvio",
      motivo: "Afastando de todos os clientes pendentes e da base (distância real de rua)",
      score: 60,
      origemDesvio: "afastando_geral",
    };
  }
  if (ruaRara.disparou) {
    return {
      nivel: "critico",
      tipo: "desvio",
      motivo: `Entrou em trecho raramente percorrido pela frota (célula ${ruaRara.celula}, ${ruaRara.nVisitas} visita(s) no histórico)`,
      score: 55,
      origemDesvio: "rua_rara_frota",
    };
  }
  return null;
}
