// Integração com OSRM público (router.project-osrm.org) para cálculo de
// corredores de rota. Gratuito, sem chave, mas com rate limit não documentado.
// O motor limita chamadas por ciclo para não saturar.
//
// Corredor: série de pontos [lat, lng] ao longo da rota real.
// Verificação se veículo está no corredor: distância mínima ao ponto mais
// próximo da série <= RAIO_CORREDOR_M. Mais simples que buffer PostGIS e
// rápido o suficiente para o tamanho das frotas (~50-200 veículos por ciclo).

import { haversineM } from "./unitrac";

const OSRM_URL = "https://router.project-osrm.org/route/v1/driving";
export const RAIO_CORREDOR_M = 400;

// Hash compacto dos alvos pendentes — usado para detectar mudança de rota.
// Ordena por (ordem ASC) para estabilidade, arredonda a 3 casas (~111m).
export function hashAlvos(alvos: { lat: number; lng: number; ordem: number }[]): string {
  return alvos
    .slice()
    .sort((a, b) => a.ordem - b.ordem)
    .map((a) => `${a.lat.toFixed(3)},${a.lng.toFixed(3)}`)
    .join("|");
}

// Busca rota no OSRM: origem + até 19 destinos (limite OSRM ~25 waypoints).
// Retorna array de [lat, lng] ao longo da rota ou null em caso de falha.
export async function buscarRotaOSRM(
  pontos: { lat: number; lng: number }[]
): Promise<[number, number][] | null> {
  if (pontos.length < 2) return null;

  const waypoints = pontos
    .slice(0, 20)
    .map((p) => `${p.lng},${p.lat}`)
    .join(";");

  try {
    const res = await fetch(
      `${OSRM_URL}/${waypoints}?overview=full&geometries=geojson`,
      { signal: AbortSignal.timeout(8000) }
    );
    if (!res.ok) return null;

    const json = (await res.json()) as {
      code?: string;
      routes?: { geometry?: { coordinates?: [number, number][] } }[];
    };
    if (json.code !== "Ok") return null;

    const coords = json.routes?.[0]?.geometry?.coordinates;
    if (!Array.isArray(coords) || coords.length === 0) return null;

    // OSRM retorna [lng, lat] — inverter para [lat, lng]
    return coords.map(([lng, lat]) => [lat, lng] as [number, number]);
  } catch {
    return null;
  }
}

// Distância mínima em metros do ponto (lat, lng) ao corredor de rota.
// Itera pelos pontos da rota e retorna a menor distância encontrada.
export function distanciaAoCorredorM(
  lat: number,
  lng: number,
  pontosRota: [number, number][]
): number {
  if (pontosRota.length === 0) return Infinity;
  let minDist = Infinity;
  for (const [pLat, pLng] of pontosRota) {
    const d = haversineM(lat, lng, pLat, pLng);
    if (d < minDist) minDist = d;
  }
  return minDist;
}

// Extrai o centroide aproximado de uma geometria GeoJSON (media dos vertices).
type GeoJSONGeomSimple =
  | { type: "Polygon"; coordinates: number[][][] }
  | { type: "MultiPolygon"; coordinates: number[][][][] };

export function centroideGeo(
  geom: GeoJSONGeomSimple | null
): { lat: number; lng: number } | null {
  if (!geom) return null;
  const anel =
    geom.type === "Polygon"
      ? geom.coordinates[0]
      : geom.type === "MultiPolygon"
        ? geom.coordinates[0]?.[0]
        : null;
  if (!anel || anel.length === 0) return null;
  const lat = anel.reduce((s, c) => s + c[1], 0) / anel.length;
  const lng = anel.reduce((s, c) => s + c[0], 0) / anel.length;
  return { lat, lng };
}
