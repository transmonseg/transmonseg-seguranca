// Consulta ao Overpass API (OSM) para verificar se existe POI legitimo
// (posto, restaurante, farmacia etc.) num raio de 80m ao redor de um ponto.
// Resultado cacheado 7 dias na tabela poi_cache para nao saturar a API.
//
// Tipos de amenity considerados "parada legitima" de caminhao:
//   fuel (posto), restaurant, fast_food, pharmacy, supermarket, bank,
//   hospital, bus_station, parking, car_wash, car_service, atm

import pg from "pg";

const AMENITIES = [
  "fuel", "restaurant", "fast_food", "pharmacy", "supermarket",
  "bank", "hospital", "bus_station", "parking", "car_wash", "atm",
].join("|");

const OVERPASS_URL = "https://overpass-api.de/api/interpreter";
const RAIO_M = 80;
const CACHE_DIAS = 7;

// Arredonda lat/lng a 3 casas decimais (~111m de resolucao) para maximizar cache hits.
function arredondar(v: number): number {
  return Math.round(v * 1000) / 1000;
}

export async function temPOIProximo(
  lat: number,
  lng: number,
  pool: pg.Pool
): Promise<boolean> {
  const latR = arredondar(lat);
  const lngR = arredondar(lng);

  const pgClient = await pool.connect();
  try {
    // Verificar cache
    const { rows } = await pgClient.query<{ tem_poi: boolean; atualizado_em: Date }>(
      `SELECT tem_poi, atualizado_em FROM poi_cache WHERE lat = $1 AND lng = $2`,
      [latR, lngR]
    );
    if (rows.length > 0) {
      const idadeMs = Date.now() - rows[0].atualizado_em.getTime();
      const idadeDias = idadeMs / (1000 * 60 * 60 * 24);
      if (idadeDias < CACHE_DIAS) return rows[0].tem_poi;
    }

    // Consultar Overpass
    const query =
      `[out:json][timeout:5];` +
      `(node[amenity~"${AMENITIES}"](around:${RAIO_M},${lat},${lng});` +
      `way[amenity~"${AMENITIES}"](around:${RAIO_M},${lat},${lng});` +
      `);out count;`;

    let temPoi = false;
    try {
      const res = await fetch(OVERPASS_URL, {
        method: "POST",
        headers: { "Content-Type": "application/x-www-form-urlencoded" },
        body: `data=${encodeURIComponent(query)}`,
        signal: AbortSignal.timeout(6000),
      });
      if (res.ok) {
        const json = (await res.json()) as { elements?: { tags?: { total?: number } }[] };
        const total = json.elements?.[0]?.tags?.total;
        temPoi = typeof total === "number" ? total > 0 : (json.elements?.length ?? 0) > 0;
      }
    } catch {
      // Falha de rede: retorna false (conservador — pode disparar falso positivo)
      return false;
    }

    // Gravar no cache
    await pgClient.query(
      `INSERT INTO poi_cache (lat, lng, tem_poi, atualizado_em)
       VALUES ($1, $2, $3, now())
       ON CONFLICT (lat, lng) DO UPDATE SET tem_poi=$3, atualizado_em=now()`,
      [latR, lngR, temPoi]
    );

    return temPoi;
  } finally {
    pgClient.release();
  }
}
