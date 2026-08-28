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
// p95 = 1517m, p99 = 2548m, p99.9 = 3962m em 8 dias (3961.8m; a mesma medida
// em 5 dias deu 4115m). Acima disso o par nao e' fisicamente um ciclo de
// ~60s: os 2 casos alvo dao 20,8km em 68s (1101 km/h implicitos) e 16,4km em
// 62s (950 km/h). Corta o RQU-5G33 (327m) e demais ciclos normais.
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
// Sem a condicao de salto (como estava na rodada 1) os mesmos 7 dias dao
// 2 `resolvido` tocados em qualquer N >= 9 -- a janela de 4 dias da rodada 1
// escondia isso. CORRECAO de uma afirmacao errada da rodada 1: N=10 NAO e'
// "o menor limiar sem tocar desvio real" -- N=9 ja' zera os `ativo`, e com
// a condicao de salto qualquer N entre 8 e 15 da o mesmo resultado nos
// alertas. 10 foi mantido por conservadorismo (menor superficie de
// supressao), nao por ser um minimo.
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
// Custo de recall e' no maximo UM ciclo: igual a movimentoInsignificante, o
// gate nao zera nem decrementa o streak, so' pula a avaliacao deste ciclo.
// Um veiculo realmente divergindo continua divergindo no ciclo seguinte (ja'
// com os dois pontos reconciliados) e o streak retoma de onde parou -- o
// alerta sai ~1 leitura depois, nunca deixa de sair.
export const LIMIAR_ATRASO_RECONCILIACAO_MIN = 10;
export const LIMIAR_ATRASO_NORMALIZADO_MIN = 3;
export const LIMIAR_ATRASO_FRESCO_MIN = 60;
export const LIMIAR_SALTO_RECONCILIACAO_M = 4000;

export function ehSaltoDeReconciliacaoDeAtraso(
  atrasoAnteriorMin: number | null | undefined,
  atrasoAtualMin: number | null | undefined,
  movimentoRealM: number | null | undefined
): boolean {
  if (atrasoAnteriorMin == null || atrasoAtualMin == null || movimentoRealM == null) return false;
  return (
    atrasoAnteriorMin >= LIMIAR_ATRASO_RECONCILIACAO_MIN &&
    atrasoAnteriorMin <= LIMIAR_ATRASO_FRESCO_MIN &&
    atrasoAtualMin <= LIMIAR_ATRASO_NORMALIZADO_MIN &&
    movimentoRealM >= LIMIAR_SALTO_RECONCILIACAO_M
  );
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
