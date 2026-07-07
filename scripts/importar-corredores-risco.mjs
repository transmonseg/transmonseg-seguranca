// Importa os corredores de rodovia de alto risco de roubo de carga na regiao
// metropolitana do Rio (BR-040, BR-101, BR-116, Arco Metropolitano/BR-493 —
// apontados pelos relatorios anuais Firjan/NTC&Logistica como os corredores
// mais criticos do RJ) pra tabela geofences (tipo='risco'), como camada
// estatica curada — nao existe fonte publica de "pontos criticos de roubo de
// carga" por km de rodovia (achado da pesquisa 07/07), entao a geometria vem
// do OpenStreetMap (via Overpass) e o "por que essas 4 vias" vem dos
// relatorios de mercado.
//
// Import de uma vez so, rerodar so se quiser trocar a lista de corredores.
// Sem dependencia nova: so fetch + pg.
import pg from "pg";

const OVERPASS_URL = "https://overpass-api.de/api/interpreter";
// Bounding box da regiao metropolitana do Rio — onde as rotas da frota
// (Nutry/Benassi) de fato circulam. Nao busca a rodovia inteira ate a
// divisa do estado (ex.: BR-040 perto de Petropolis/MG) pra nao trazer
// trecho irrelevante pro caso de uso.
const BBOX = "-23.1,-43.8,-22.5,-42.9";
const CORREDORES = ["BR-040", "BR-101", "BR-116", "BR-493"];

const espera = (ms) => new Promise((r) => setTimeout(r, ms));

// Overpass publico tem rate limit agressivo entre chamadas seguidas (429) —
// retry com backoff simples, poucas chamadas totais (4 corredores) entao
// nao precisa de nada sofisticado.
async function buscarCorredor(ref, tentativa = 1) {
  const query = `[out:json][timeout:60];(way["ref"="${ref}"](${BBOX}););out geom;`;
  const r = await fetch(OVERPASS_URL, {
    method: "POST",
    // Overpass exige User-Agent identificavel (politica de uso do OSM) —
    // sem isso responde 406.
    headers: {
      "Content-Type": "application/x-www-form-urlencoded",
      "User-Agent": "transmonseg-seguranca/1.0 (import unico de corredores de risco)",
    },
    body: `data=${encodeURIComponent(query)}`,
    signal: AbortSignal.timeout(90000),
  });
  if ((r.status === 429 || r.status === 502 || r.status === 503 || r.status === 504) && tentativa < 6) {
    console.log(`  ${r.status} (transitorio), esperando ${tentativa * 15}s e tentando de novo...`);
    await espera(tentativa * 15000);
    return buscarCorredor(ref, tentativa + 1);
  }
  if (!r.ok) throw new Error(`Overpass falhou pra ${ref}: ${r.status}`);
  const j = await r.json();
  const ways = (j.elements ?? []).filter((e) => e.type === "way" && Array.isArray(e.geometry));
  if (ways.length === 0) return null;
  return {
    type: "MultiLineString",
    coordinates: ways.map((w) => w.geometry.map((pt) => [pt.lon, pt.lat])),
  };
}

async function main() {
  const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL, ssl: { rejectUnauthorized: false } });
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const del = await client.query(`DELETE FROM geofences WHERE tipo = 'risco'`);
    console.log(`Removidos ${del.rowCount} registros antigos tipo='risco'`);

    for (const ref of CORREDORES) {
      console.log(`Buscando ${ref}...`);
      if (ref !== CORREDORES[0]) await espera(8000); // educado com o servidor publico
      const geometry = await buscarCorredor(ref);
      if (!geometry) {
        console.log(`  aviso: nenhum segmento encontrado pra ${ref}, pulando`);
        continue;
      }
      console.log(`  ${geometry.coordinates.length} segmentos`);
      await client.query(
        `INSERT INTO geofences (tipo, nome, fonte, geom, meta)
         VALUES ('risco', $1, 'OpenStreetMap/Overpass (corredor curado — Firjan/NTC 2026)',
                 ST_Force2D(ST_SetSRID(ST_GeomFromGeoJSON($2), 4326)), $3::jsonb)`,
        [`Corredor de risco: ${ref}`, JSON.stringify(geometry), JSON.stringify({ corredor: ref })]
      );
    }
    await client.query("COMMIT");
    console.log("Corredores de risco importados.");
  } catch (e) {
    await client.query("ROLLBACK");
    throw e;
  } finally {
    client.release();
    await pool.end();
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
