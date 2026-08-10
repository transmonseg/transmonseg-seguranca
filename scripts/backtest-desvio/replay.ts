// scripts/backtest-desvio/replay.ts
//
// Maquina de estado FIEL ao motor real (avancarStreaksDesvio,
// devAvancarStreaksDesvio, ambas importadas de src/lib/detectores.ts, zero
// reimplementacao) -- rodada sobre uma trilha real de posicoes_historico
// (via casos_desvio_revisao.trilha, ver corpus.ts) com o delta de tempo
// REAL entre pontos, nao cadencia fixa. Ver
// docs/superpowers/specs/2026-08-10-afastando-tudo-harness-design.md pro
// porque disso (uma tentativa anterior em Python nao reproduziu 3 casos
// reais conhecidos por assumir cadencia fixa e zerar o streak no primeiro
// sinal contrario, em vez da histerese real).
import { avancarStreaksDesvio, devAvancarStreaksDesvio, FORA_TAPETE_STREAK_MIN } from "../../src/lib/detectores";
import type { CandidatoRegra } from "./candidatos";

const SALTO_IMPLAUSIVEL_M = 2500;

export type PontoTrilha = { lat: number; lng: number; velocidade: number; criado_em: string };
export type Destino = { lat: number; lng: number };
export type ResultadoReplay = { streakMaximo: number; disparou: boolean; cicloDoDisparo: number | null };

function haversineM(lat1: number, lng1: number, lat2: number, lng2: number): number {
  const R = 6371000;
  const p1 = (lat1 * Math.PI) / 180;
  const p2 = (lat2 * Math.PI) / 180;
  const dp = ((lat2 - lat1) * Math.PI) / 180;
  const dl = ((lng2 - lng1) * Math.PI) / 180;
  const a = Math.sin(dp / 2) ** 2 + Math.cos(p1) * Math.cos(p2) * Math.sin(dl / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(a));
}

export function replay(
  regra: CandidatoRegra,
  pontos: PontoTrilha[],
  destinosPorPonto: Destino[][]
): ResultadoReplay {
  let desvioStreak = 0;
  let aproximandoStreak = 0;
  let anterior: PontoTrilha | null = null;
  let streakMaximo = 0;
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
        fresco: true, // trilha ja filtrada por fresco no carregamento (ver corpus.ts)
        saltoImplausivel,
        distanciaAoAnteriorM,
        velocidade: p.velocidade,
      });

      if (podeAvancar) {
        const afastando = regra(distAtualM, distAnteriorM);
        const r = avancarStreaksDesvio(afastando, { desvioStreak, aproximandoStreak });
        desvioStreak = r.desvioStreak;
        aproximandoStreak = r.aproximandoStreak;
      }
    }

    streakMaximo = Math.max(streakMaximo, desvioStreak);
    if (cicloDoDisparo === null && desvioStreak >= FORA_TAPETE_STREAK_MIN) {
      cicloDoDisparo = i;
    }
    anterior = p;
  }

  return { streakMaximo, disparou: cicloDoDisparo !== null, cicloDoDisparo };
}
