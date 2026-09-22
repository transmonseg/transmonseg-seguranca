// Ajustes na LISTA DE DESTINOS do detector de desvio (21/09).
//
// Diagnostico com o gabarito do grupo (303 alertas casados, 189 falsos): o
// "afastando de todos" dispara sem nenhum cliente na lista em 24% dos falsos
// (57% desde 14/09) e em 1 dos 108 corretos. Duas origens dessa lista vazia de
// clientes:
//   (a) o veiculo nao tem NENHUM pendente na Unitrac (sai da base sem romaneio
//       carregado, romaneio so' no romaneio, rota concluida) -- 24 falsos;
//   (b) tem pendentes, mas todos a mais de 50 km (rota longa) e o filtro de
//       13/08 (LIMIAR_DESTINO_RELEVANTE_M) deixa so' a base -- 14 falsos, 0
//       corretos.
// (a) vira alerta REBAIXADO (nivel atencao, origem "sem_destinos"): nada some da
// tela, so' perde prioridade. (b) ganha o cliente pendente mais proximo na
// avaliacao, para "afastando de todos" exigir afastar tambem dele.

import type { Alerta } from "./detectores";

export const SCORE_DESVIO_SEM_DESTINOS = 45;
export const MOTIVO_DESVIO_SEM_DESTINOS =
  "Veiculo em movimento sem destinos carregados (sem pendentes na Unitrac)";

// Teto de sanidade: um pendente a mais de 500 km e' coordenada ruim/outlier
// (as duas bases da Nutry Max ficam a ~300 km uma da outra) e faria o OSRM
// falhar; ignora como antes.
export const CLIENTE_DISTANTE_TETO_M = 500_000;

// (0) Fallback pro ROMANEIO quando a Unitrac nao tem NENHUM pendente pro
// veiculo (22/09, correcao pendente desde 22/08 -- ver
// docs/investigacoes/2026-08-21-marcacoes-faltantes.md, opcao 2 da "Proposta
// de fix" e o "Adendo"). Achado de 21/08, fechado em 22/08: a Central nunca
// usa o romaneio pra alimentar os destinos do desvio (decisao de 31/07) --
// veiculo com romaneio carregado mas SEM alvo na Unitrac (carro do pao, placa
// sem rastreador, romaneio ainda nao processado) fica com ZERO pendentes o
// dia inteiro. So' 21/08: 14 veiculos nesse estado. No gabarito do grupo
// (303 alertas casados), "lista sem nenhum cliente" e' 25% dos falsos.
//
// Deliberadamente um FALLBACK PURO: so' entra em acao quando a Unitrac ja
// nao tem nada pra oferecer (pontosVeiculoParaDesvio vazio) -- nunca mistura
// com pontos Unitrac quando eles existem, nunca inventa destino (sao pontos
// REAIS do romaneio do dia, ja geocodificados, com presenca_confirmada_em
// checado -- mesma garantia que o `pendentes` da Unitrac tem contra
// entregas ja feitas). Essa correcao roda ANTES do rebaixamento "sem
// destinos" (deveRebaixarDesvioSemDestinos, acima): so cai nele quando NEM
// Unitrac NEM romaneio tem pendente.
export type PontoRomaneioParaFallback = {
  nf: string;
  lat: number;
  lng: number;
  presencaConfirmadaEm: string | null;
};

export function deveUsarRomaneioComoFallbackDeDesvio(e: {
  flagAtiva: boolean;
  nPendentesUnitrac: number;
  nPontosRomaneioDisponiveis: number;
}): boolean {
  return e.flagAtiva && e.nPendentesUnitrac === 0 && e.nPontosRomaneioDisponiveis > 0;
}

export function pontosRomaneioDisponiveisParaDesvio(
  romaneioDoVeiculo: PontoRomaneioParaFallback[] | undefined
): PontoRomaneioParaFallback[] {
  if (!romaneioDoVeiculo) return [];
  return romaneioDoVeiculo.filter((rp) => !rp.presencaConfirmadaEm);
}

// (a) So' rebaixa o sinal "afastando de todos" com ZERO pendente de cliente
// (pontosVeiculoParaDesvio vazio). rua_rara e demais origens nao sao tocadas.
export function deveRebaixarDesvioSemDestinos(e: {
  flagAtiva: boolean;
  origemDesvio: string | undefined;
  nPendentesCliente: number;
}): boolean {
  return e.flagAtiva && e.origemDesvio === "afastando_geral" && e.nPendentesCliente === 0;
}

export function rebaixarDesvioSemDestinos(alerta: Alerta): Alerta {
  return {
    nivel: "atencao",
    tipo: alerta.tipo,
    motivo: MOTIVO_DESVIO_SEM_DESTINOS,
    score: SCORE_DESVIO_SEM_DESTINOS,
    origemDesvio: "sem_destinos",
  };
}

// (b) Indice (em `destinos`, montado como [pendentes..., bases..., escala...])
// do pendente de cliente MAIS PROXIMO (linha reta) a incluir na avaliacao, ou
// null quando nao se aplica: ja ha' cliente relevante, nao ha' pendente, ou o
// mais proximo excede o teto.
export function indiceClienteDistanteParaIncluir(e: {
  distRetaM: number[];
  nPendentes: number;
  indicesRelevantes: number[];
  tetoM?: number;
}): number | null {
  if (e.nPendentes <= 0) return null;
  if (e.indicesRelevantes.some((i) => i < e.nPendentes)) return null;
  const teto = e.tetoM ?? CLIENTE_DISTANTE_TETO_M;
  let melhor: number | null = null;
  let melhorDist = Infinity;
  for (let i = 0; i < e.nPendentes; i++) {
    const d = e.distRetaM[i];
    if (!Number.isFinite(d) || d > teto) continue;
    if (d < melhorDist) {
      melhorDist = d;
      melhor = i;
    }
  }
  return melhor;
}

// Insere o indice preservando a ordem original de `destinos` (o motor mapeia
// destinosRelevantes[k] <-> distancias[k] e usa `i < nPendentes` pra identificar
// pendente).
export function indicesComClienteDistante(indicesRelevantes: number[], indiceExtra: number | null): number[] {
  if (indiceExtra == null) return indicesRelevantes;
  return [...indicesRelevantes, indiceExtra].sort((a, b) => a - b);
}
