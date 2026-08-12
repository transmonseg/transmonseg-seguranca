// Distância REAL de rua (nunca linha reta) via OSRM /table self-hosted.
// Ver docs/superpowers/specs/2026-08-12-desvio-de-rota-v2-design.md,
// componente 1. Puramente uma chamada de rede -- sem lógica de decisão.

const OSRM_LOCAL_URL = process.env.OSRM_LOCAL_URL ?? "http://127.0.0.1:5001";
const DEADLINE_MS = 5000;

export async function buscarDistanciasReais(
  posAtual: { lat: number; lng: number },
  destinos: { lat: number; lng: number }[]
): Promise<number[] | null> {
  if (destinos.length === 0) return [];

  const coords = [posAtual, ...destinos].map((p) => `${p.lng},${p.lat}`).join(";");
  const destIdx = destinos.map((_, i) => i + 1).join(";");

  try {
    const res = await fetch(
      `${OSRM_LOCAL_URL}/table/v1/driving/${coords}?sources=0&destinations=${destIdx}&annotations=distance`,
      { signal: AbortSignal.timeout(DEADLINE_MS) }
    );
    if (!res.ok) return null;

    const data = (await res.json()) as { code: string; distances?: (number | null)[][] };
    if (data.code !== "Ok" || !data.distances || !data.distances[0]) return null;

    const linha = data.distances[0];
    if (linha.length !== destinos.length || linha.some((d) => d === null)) return null;
    return linha as number[];
  } catch {
    return null;
  }
}
