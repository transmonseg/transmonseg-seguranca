// scripts/backtest-desvio/replay-score.ts
//
// Candidato de redesenho estrutural (achado real 11/08, casos TTM-7C13 e
// TTH-0G95 reanalisados com dado real): o streak binario de 2 leituras
// CONSECUTIVAS quebra fácil com ziguezague normal de rua real (0G95:
// contagem de destinos crescendo oscila 10,9,4,7,4,8,4 de 14 -- nunca 2
// seguidas acima do limiar, mesmo com tendencia real de afastamento
// 2669m->3023m). E o piso fixo de 2500m (DESVIO_MIN_M) bloqueia 100% do
// caso 7C13 (nunca passou de 505m de ALGUM destino, mesmo afastando de
// outros 12).
//
// Design: em vez de streak binario + piso rigido, um integrador com
// vazamento (leaky bucket) -- cada ciclo soma uma fracao continua
// (quantos destinos cresceram / N) amortecida por um fator de proximidade
// suave (perto de QUALQUER destino amortece, mas nao zera 100% como o
// piso atual) -- dispara quando o score acumulado passa um limiar.
// Ruido de 1 ciclo (ex: parou no farol, destinos oscilam) nao reseta tudo
// como o streak binario faria -- so reduz um pouco a taxa de acumulo.
import { devAvancarStreaksDesvio } from "../../src/lib/detectores";

const SALTO_IMPLAUSIVEL_M = 2500;
const AFASTAMENTO_MARGEM_M = 50;

export type PontoTrilha = { lat: number; lng: number; velocidade: number; criado_em: string };
export type Destino = { lat: number; lng: number };
export type ResultadoReplayScore = { scoreMaximo: number; disparou: boolean; cicloDoDisparo: number | null };

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

export type ParametrosScore = {
  decay: number; // 0-1, quanto do score anterior sobrevive por ciclo (leaky)
  limiar: number; // score acumulado pra disparar
  proximidadeMinM: number; // abaixo disso, fator = 0 (amortecimento total, tipo o "chegou")
  proximidadeMaxM: number; // acima disso, fator = 1 (sem amortecimento)
};

export function replayComScore(
  params: ParametrosScore,
  pontos: PontoTrilha[],
  destinosPorPonto: Destino[][]
): ResultadoReplayScore {
  let score = 0;
  let anterior: PontoTrilha | null = null;
  let scoreMaximo = 0;
  let cicloDoDisparo: number | null = null;

  for (let i = 0; i < pontos.length; i++) {
    const p = pontos[i];
    const destinos = destinosPorPonto[i];
    const distAtualM = destinos.map((d) => haversineM(p.lat, p.lng, d.lat, d.lng));

    if (anterior && destinos.length > 0) {
      const distAnteriorM = destinos.map((d) => haversineM(anterior!.lat, anterior!.lng, d.lat, d.lng));
      const distanciaAoAnteriorM = haversineM(anterior.lat, anterior.lng, p.lat, p.lng);
      const saltoImplausivel = distanciaAoAnteriorM > SALTO_IMPLAUSIVEL_M;
      const podeAvancar = devAvancarStreaksDesvio({
        fresco: true,
        saltoImplausivel,
        distanciaAoAnteriorM,
        velocidade: p.velocidade,
      });

      if (podeAvancar && distAtualM.length > 0) {
        const n = distAtualM.length;
        const cresceram = distAtualM.filter((d, idx) => d > distAnteriorM[idx] + AFASTAMENTO_MARGEM_M).length;
        const fracaoCresceram = cresceram / n;
        const menorDistAtual = Math.min(...distAtualM);
        const fatorProximidade = clamp01(
          (menorDistAtual - params.proximidadeMinM) / (params.proximidadeMaxM - params.proximidadeMinM)
        );
        const contribuicao = fracaoCresceram * fatorProximidade;
        score = score * params.decay + contribuicao;
      } else if (podeAvancar) {
        score = score * params.decay;
      }
    }

    scoreMaximo = Math.max(scoreMaximo, score);
    if (cicloDoDisparo === null && score >= params.limiar) {
      cicloDoDisparo = i;
    }
    anterior = p;
  }

  return { scoreMaximo, disparou: cicloDoDisparo !== null, cicloDoDisparo };
}
