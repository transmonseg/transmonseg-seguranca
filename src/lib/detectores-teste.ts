// src/lib/detectores-teste.ts
//
// Motor de desvio do "modo teste" (spec
// docs/superpowers/specs/2026-08-11-modo-teste-desvio-zero-design.md,
// secao 2). Codigo proprio, isolado -- NAO importa nada de
// src/lib/detectores.ts. Duas regras mais simples foram tentadas e
// descartadas com dado real antes desta (ver a spec, secao 2, e
// docs/analise-desvio-raiz-2026-08-11.md): "menor distancia global"
// (falso-positiva ao passar reto por um cliente rumo a outro) e "todos os
// destinos precisam crescer" (nunca dispara nos casos reais de desvio).
//
// Regra final: MEDIA do delta de distancia (atual - anterior) entre
// TODOS os destinos pendentes que existiam tanto no ciclo anterior quanto
// no atual (casados por id -- um destino que sumiu, por ter sido
// entregue, simplesmente para de contribuir, sem caso especial). Sobe um
// score com decaimento (nao streak binario), amortecido por um fator de
// proximidade (nao piso rigido).

export type DestinoTeste = { id: string; lat: number; lng: number };

export type EstadoDesvioTeste = {
  score: number;
  distanciasAnteriores: Record<string, number>;
};

export type ParametrosDesvioTeste = {
  margemRuidoM: number;
  decay: number;
  limiar: number;
  proximidadeMinM: number;
  proximidadeMaxM: number;
  contribMaxM: number;
};

// Afinado contra o harness real (444 casos, scripts/backtest-desvio/
// index-detectores-teste.mjs chamando avaliarDesvioTeste de verdade, zero
// reimplementacao -- ver Task 3 da implementacao). Bate o criterio de
// aceite (recall >= baseline pct80 E taxa de disparo espurio <= baseline
// pct80, ao mesmo tempo): recall 76.1% (vs 75.2% baseline), taxa de
// disparo espurio 47.2% (vs 50.5% baseline). Ver
// scripts/backtest-desvio/relatorio-detectores-teste.md pro relatorio
// completo.
//
// Consequencia pratica de proximidadeMinM:0 / proximidadeMaxM:500 (revisao
// final da branch, 2026-08-11): a faixa de amortecimento por proximidade
// ficou estreita e colada na chegada -- so amortece de fato dentro de
// ~500m de um destino pendente; fora disso (a maior parte do tempo em
// transito) a contribuicao roda sem amortecimento nenhum. Na pratica, leia
// o detector como "3 ciclos seguidos de afastamento medio liquido do
// conjunto de destinos pendentes", nao como um amortecedor gradual ao
// longo de toda a faixa 500-2500m originalmente imaginada no design.
export const PARAMS_DESVIO_TESTE_PADRAO: ParametrosDesvioTeste = {
  margemRuidoM: 30,
  decay: 0.6,
  limiar: 1.65,
  proximidadeMinM: 0,
  proximidadeMaxM: 500,
  contribMaxM: 50,
};

function haversineM(lat1: number, lng1: number, lat2: number, lng2: number): number {
  const R = 6371000;
  const p1 = (lat1 * Math.PI) / 180;
  const p2 = (lat2 * Math.PI) / 180;
  const dp = ((lat2 - lat1) * Math.PI) / 180;
  const dl = ((lng2 - lng1) * Math.PI) / 180;
  const a = Math.sin(dp / 2) ** 2 + Math.cos(p1) * Math.cos(p2) * Math.sin(dl / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(a));
}

function clamp01(x: number): number {
  return Math.max(0, Math.min(1, x));
}

export function avaliarDesvioTeste(
  posAtual: { lat: number; lng: number },
  destinos: DestinoTeste[],
  estadoAnterior: EstadoDesvioTeste | null,
  params: ParametrosDesvioTeste = PARAMS_DESVIO_TESTE_PADRAO
): { estado: EstadoDesvioTeste; disparouAgora: boolean } {
  const scoreAnterior = estadoAnterior?.score ?? 0;
  const distanciasAnteriores = estadoAnterior?.distanciasAnteriores ?? {};

  const distanciasAtuais: Record<string, number> = {};
  const deltas: number[] = [];
  for (const d of destinos) {
    const distAtual = haversineM(posAtual.lat, posAtual.lng, d.lat, d.lng);
    distanciasAtuais[d.id] = distAtual;
    const distAnterior = distanciasAnteriores[d.id];
    if (distAnterior !== undefined) {
      deltas.push(distAtual - distAnterior);
    }
  }

  let novoScore = scoreAnterior * params.decay;
  if (deltas.length > 0) {
    const mediaDelta = deltas.reduce((a, b) => a + b, 0) / deltas.length;
    if (mediaDelta > params.margemRuidoM) {
      const menorDistAtual = Math.min(...Object.values(distanciasAtuais));
      const fatorProximidade = clamp01(
        (menorDistAtual - params.proximidadeMinM) / (params.proximidadeMaxM - params.proximidadeMinM)
      );
      const contribuicao = Math.min(mediaDelta, params.contribMaxM) / params.contribMaxM;
      novoScore = scoreAnterior * params.decay + contribuicao * fatorProximidade;
    }
  }

  const disparouAgora = scoreAnterior < params.limiar && novoScore >= params.limiar;

  return {
    estado: { score: novoScore, distanciasAnteriores: distanciasAtuais },
    disparouAgora,
  };
}
