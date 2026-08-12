// scripts/backtest-desvio/replay-detectores-teste.ts
//
// Replay do harness que chama avaliarDesvioTeste REAL, zero
// reimplementacao.
//
// ATENCAO (11/08, achado real): avaliarDesvioTeste agora recebe
// distancias JA CALCULADAS (rota real via OSRM), nao mais lat/lng --
// ver src/lib/detectores-teste.ts e docs/analise-desvio-raiz-2026-08-11.md
// (linha reta gerava "desvio" que sumia com rota real). Este harness
// ainda usa haversine (linha reta) como aproximacao pra manter o corpus
// de 444 casos utilizavel sem depender de OSRM alcancavel da maquina que
// roda o harness -- os numeros aqui NAO refletem mais o comportamento
// real de producao (que usa OSRM). Pendente: reescrever esta funcao pra
// buscar distancia real via OSRM (precisa de tunel/acesso ao OSRM
// self-hosted do Contabo a partir de onde o harness roda) antes de
// confiar nestes numeros de novo.
import { avaliarDesvioTeste, type ParametrosDesvioTeste, type EstadoDesvioTeste } from "../../src/lib/detectores-teste";

export type PontoTrilha = { lat: number; lng: number; velocidade: number; criado_em: string };
export type ResultadoReplayTeste = { scoreMaximo: number; disparou: boolean; cicloDoDisparo: number | null };

function haversineM(lat1: number, lng1: number, lat2: number, lng2: number): number {
  const R = 6371000;
  const p1 = (lat1 * Math.PI) / 180;
  const p2 = (lat2 * Math.PI) / 180;
  const dp = ((lat2 - lat1) * Math.PI) / 180;
  const dl = ((lng2 - lng1) * Math.PI) / 180;
  const a = Math.sin(dp / 2) ** 2 + Math.cos(p1) * Math.cos(p2) * Math.sin(dl / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(a));
}

export function replayDetectoresTeste(
  params: ParametrosDesvioTeste,
  pontos: PontoTrilha[],
  destinosPorPonto: { lat: number; lng: number }[][]
): ResultadoReplayTeste {
  let estado: EstadoDesvioTeste | null = null;
  let scoreMaximo = 0;
  let cicloDoDisparo: number | null = null;

  for (let i = 0; i < pontos.length; i++) {
    const p = pontos[i];
    // id estavel = lat/lng arredondado (corpus nao carrega pontoCodigo real)
    const distanciasAtuais: Record<string, number> = {};
    for (const d of destinosPorPonto[i]) {
      const id = `${d.lat.toFixed(6)},${d.lng.toFixed(6)}`;
      distanciasAtuais[id] = haversineM(p.lat, p.lng, d.lat, d.lng);
    }
    const r = avaliarDesvioTeste(distanciasAtuais, estado, params);
    estado = r.estado;
    scoreMaximo = Math.max(scoreMaximo, estado.score);
    if (cicloDoDisparo === null && r.disparouAgora) {
      cicloDoDisparo = i;
    }
  }

  return { scoreMaximo, disparou: cicloDoDisparo !== null, cicloDoDisparo };
}
