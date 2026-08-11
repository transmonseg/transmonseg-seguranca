// scripts/backtest-desvio/replay-detectores-teste.ts
//
// Replay do harness que chama avaliarDesvioTeste REAL (Task 2), zero
// reimplementacao -- ao contrario dos prototipos anteriores
// (replay-media-delta.ts etc), que reimplementavam a logica pra testar a
// IDEIA antes dela existir como codigo de producao. Agora que
// src/lib/detectores-teste.ts existe, o harness precisa validar O CODIGO
// DE VERDADE, nao uma copia.
import { avaliarDesvioTeste, type ParametrosDesvioTeste, type DestinoTeste, type EstadoDesvioTeste } from "../../src/lib/detectores-teste";

export type PontoTrilha = { lat: number; lng: number; velocidade: number; criado_em: string };
export type ResultadoReplayTeste = { scoreMaximo: number; disparou: boolean; cicloDoDisparo: number | null };

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
    const destinos: DestinoTeste[] = destinosPorPonto[i].map((d) => ({
      id: `${d.lat.toFixed(6)},${d.lng.toFixed(6)}`,
      lat: d.lat,
      lng: d.lng,
    }));
    const r = avaliarDesvioTeste({ lat: p.lat, lng: p.lng }, destinos, estado, params);
    estado = r.estado;
    scoreMaximo = Math.max(scoreMaximo, estado.score);
    if (cicloDoDisparo === null && r.disparouAgora) {
      cicloDoDisparo = i;
    }
  }

  return { scoreMaximo, disparou: cicloDoDisparo !== null, cicloDoDisparo };
}
