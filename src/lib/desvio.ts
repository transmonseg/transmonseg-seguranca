// Detector de desvio de rota v2 -- 2 sinais independentes, funcoes PURAS.
// Ver docs/superpowers/specs/2026-08-12-desvio-de-rota-v2-design.md.
// Nunca importe nada de 'next'/'pg' aqui.

import type { Alerta } from "./detectores";

export const LIMIAR_STREAK_AFASTANDO = 3;
export const LIMIAR_STREAK_RUA_RARA = 2;
export const LIMIAR_VISITAS_RARA = 2;

export type ResultadoAfastando = { streak: number; disparou: boolean; aproximandoAlgum: boolean };

// Sinal A: o veiculo se afastou (distancia REAL de rua, ja calculada pelo
// chamador) de TODOS os destinos (pendentes + base) por N leituras
// seguidas. Sem decaimento -- distancia real de rua e mais estavel que
// linha reta, entao um streak binario simples deve bastar (validar contra
// dia real na Task 8 antes de considerar o parametro final).
export function avaliarAfastandoDeTudo(
  distanciasAtuais: number[],
  distanciasAnteriores: number[],
  streakAnterior: number
): ResultadoAfastando {
  if (
    distanciasAtuais.length === 0 ||
    distanciasAnteriores.length === 0 ||
    distanciasAtuais.length !== distanciasAnteriores.length
  ) {
    return { streak: 0, disparou: false, aproximandoAlgum: false };
  }

  const aproximandoAlgum = distanciasAtuais.some((d, i) => d < distanciasAnteriores[i]);
  const afastouDeTodos = distanciasAtuais.every((d, i) => d > distanciasAnteriores[i]);

  const streak = afastouDeTodos ? streakAnterior + 1 : 0;
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
export function montarAlertaDesvio(
  afastando: { disparou: boolean; streak: number },
  ruaRara: { disparou: boolean; streak: number; celula: string; nVisitas: number }
): Alerta | null {
  if (afastando.disparou) {
    return {
      nivel: "atencao",
      tipo: "desvio",
      motivo: "Afastando de todos os clientes pendentes e da base (distância real de rua)",
      score: 60,
      origemDesvio: "afastando_geral",
    };
  }
  if (ruaRara.disparou) {
    return {
      nivel: "atencao",
      tipo: "desvio",
      motivo: `Entrou em trecho raramente percorrido pela frota (célula ${ruaRara.celula}, ${ruaRara.nVisitas} visita(s) no histórico)`,
      score: 55,
      origemDesvio: "rua_rara_frota",
    };
  }
  return null;
}
