// Consulta ao Overpass API (OSM) para verificar se existe POI legitimo
// (posto, restaurante, farmacia etc.) num raio de 80m ao redor de um ponto.
// Resultado cacheado 7 dias na tabela poi_cache para nao saturar a API.
//
// CONTRATO (revisao final de branch 27/08, achado I3): o boolean devolvido e
// sempre um VEREDITO ("tem POI" / "nao tem POI"). Quando a checagem nao pode
// ser feita -- Overpass fora do ar, timeout, HTTP de erro, corpo invalido, ou
// falha de pool/query no poi_cache -- a funcao LANCA. Quem chama decide o
// fail-open (os dois motores assumem POI presente e marcam o ciclo como nao
// confiavel). Nunca devolva `false` por falha: "nao consegui checar" virando
// "nao ha POI" libera os 3 detectores de parada pra frota inteira de uma vez.
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

    // Falha de consulta (rede, timeout, HTTP != 2xx, JSON invalido) LANCA --
    // nunca vira `false` silencioso. Achado da revisao final de branch (27/08,
    // I3): a versao anterior engolia o erro de fetch e devolvia false, entao
    // os dois motores (motor/route.ts e motor-romaneio/route.ts) tinham um
    // `catch { temPOI = true; ... }` que so disparava por falha de
    // pool/query no poi_cache -- praticamente NUNCA por queda real do
    // Overpass. Efeito pratico do bug: durante uma instabilidade do Overpass,
    // "nao consegui checar" virava "confirmei que nao ha POI", o que (a)
    // libera os 3 detectores de parada pra frota inteira ao mesmo tempo
    // (flood de falso positivo, exatamente o que aquele catch existia pra
    // evitar) e (b) na Central Romaneio deixava `overpassFalhou` false, entao
    // o gate de auto-resolve considerava o ciclo confiavel e podia FECHAR
    // sozinho um alerta de parada real.
    //
    // Contrato pros chamadores: `true`/`false` = veredito de verdade; excecao
    // = "nao deu pra checar", trate como o caminho de falha que voce ja tem.
    // Os dois call sites atuais ja faziam exatamente isso (fail-open,
    // temPOI=true) pro caminho de erro de pool/DB -- nenhum precisou mudar,
    // so passaram a ser acionados pelo caso que importa.
    let temPoi = false;
    let res: Response;
    try {
      res = await fetch(OVERPASS_URL, {
        method: "POST",
        headers: { "Content-Type": "application/x-www-form-urlencoded" },
        body: `data=${encodeURIComponent(query)}`,
        signal: AbortSignal.timeout(6000),
      });
    } catch (err) {
      throw new Error(`Overpass indisponivel (rede/timeout): ${String(err)}`);
    }
    if (!res.ok) {
      // 429 (rate limit) e 504 (gateway timeout) sao os dois modos de falha
      // recorrentes do overpass-api.de publico -- ambos sao "nao consegui
      // checar", nunca "nao ha POI".
      throw new Error(`Overpass respondeu HTTP ${res.status}`);
    }
    try {
      const json = (await res.json()) as { elements?: { tags?: { total?: number } }[] };
      const total = json.elements?.[0]?.tags?.total;
      temPoi = typeof total === "number" ? total > 0 : (json.elements?.length ?? 0) > 0;
    } catch (err) {
      throw new Error(`Overpass devolveu corpo invalido: ${String(err)}`);
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
