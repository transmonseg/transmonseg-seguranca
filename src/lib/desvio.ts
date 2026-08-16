// Detector de desvio de rota v2 -- 2 sinais independentes, funcoes PURAS.
// Ver docs/superpowers/specs/2026-08-12-desvio-de-rota-v2-design.md.
// Nunca importe nada de 'next'/'pg' aqui.

import type { Alerta } from "./detectores";

// Revertido 16/08 pra 1 (era 3 desde 12/08): resgate da "Fase Agressiva"
// (11/07, commit 2b94ca4) que gerou o unico elogio real e confirmado do
// cliente no grupo de WhatsApp ("7C13 deu certinho desvio 👏", "Melhorou",
// 13/07) -- diretiva explicita do usuario daquela epoca, retomada aqui:
// "falso positivo aceitavel, prioridade total e nunca perder desvio real,
// detectar no PRIMEIRO ciclo". Aceita conscientemente o ruido de geometria
// de estrada que motivou o streak=3 de 12/08 (ex. caso RQP-2G33, ver
// git blame) -- ja documentado em [[feedback_desvio_priorizar_recall]] como
// tradeoff aceito, nao um bug reintroduzido por descuido.
export const LIMIAR_STREAK_AFASTANDO = 1;
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
