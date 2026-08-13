// Corrige posicao atual/anterior via map matching real do OSRM (/match,
// Hidden Markov Model) antes do calculo de distancia -- ver
// docs/superpowers/specs/2026-08-13-osrm-match-desvio-design.md. Ao
// contrario de /table (distancia-real.ts), que encaixa cada ponto
// independentemente na rua mais proxima, /match encaixa a TRAJETORIA
// inteira de uma vez, evitando o artefato de "delta uniforme entre
// destinos completamente diferentes" achado em 4 casos reais no dia
// 13/08 -- puramente uma chamada de rede, sem logica de decisao (quem
// chama decide QUANDO usar isso, ver route.ts).

const OSRM_LOCAL_URL = process.env.OSRM_LOCAL_URL ?? "http://127.0.0.1:5001";
const DEADLINE_MS = 5000;

export type PosicaoCorrigida = { lat: number; lng: number };
export type ResultadoMatch = { atual: PosicaoCorrigida; anterior: PosicaoCorrigida; confidence: number };

type TracePoint = { location: [number, number]; matchings_index: number } | null;
type RespostaMatch = { code: string; matchings?: { confidence: number }[]; tracepoints?: TracePoint[] };

export async function corrigirPosicoesComMatch(
  pontos: { lat: number; lng: number; timestamp: Date }[]
): Promise<ResultadoMatch | null> {
  if (pontos.length < 2) return null;

  const coords = pontos.map((p) => `${p.lng},${p.lat}`).join(";");
  const timestamps = pontos.map((p) => Math.floor(p.timestamp.getTime() / 1000)).join(";");

  try {
    const res = await fetch(
      `${OSRM_LOCAL_URL}/match/v1/driving/${coords}?timestamps=${timestamps}&annotations=false&overview=false`,
      { signal: AbortSignal.timeout(DEADLINE_MS) }
    );
    if (!res.ok) return null;

    const data = (await res.json()) as RespostaMatch;
    if (data.code !== "Ok" || !data.matchings || !data.tracepoints) return null;

    const validos = data.tracepoints.filter((tp): tp is NonNullable<TracePoint> => tp !== null);
    if (validos.length < 2) return null;

    const tpAtual = validos[validos.length - 1];
    const tpAnterior = validos[validos.length - 2];
    const confidence = data.matchings[tpAtual.matchings_index]?.confidence;
    if (confidence == null) return null;

    return {
      atual: { lat: tpAtual.location[1], lng: tpAtual.location[0] },
      anterior: { lat: tpAnterior.location[1], lng: tpAnterior.location[0] },
      confidence,
    };
  } catch {
    return null;
  }
}
