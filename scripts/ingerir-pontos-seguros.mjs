// Popula geofences (tipo='ponto_seguro') com postos de gasolina do RJ via
// Overpass API (OSM, amenity=fuel). Achado da auditoria de 25/07: a tabela
// ja suporta esse tipo desde a migration original, nunca foi usada. Cada
// posto vira um circulo de 80m (ST_Buffer sobre geography). Roda uma vez,
// sem cron -- mesmo espirito de vias_celulas/vias_nomes.
import pg from "pg";
import fs from "fs";

const env = fs.readFileSync(".env.local", "utf8");
const url = env.match(/^DATABASE_URL=(.+)$/m)[1].trim();
const pool = new pg.Pool({ connectionString: url });

// Bbox generoso do estado do RJ (south, west, north, east).
const BBOX = "-23.4,-44.9,-20.7,-40.9";
const OVERPASS_URL = "https://overpass-api.de/api/interpreter";
const QUERY = `[out:json][timeout:120];node["amenity"="fuel"](${BBOX});out body;`;

console.log("Consultando Overpass...");
// Overpass API retorna 406 pra requests sem User-Agent identificavel
// (fetch nativo do Node nao manda um por padrao) -- descoberto rodando
// contra a API real.
const res = await fetch(OVERPASS_URL, {
  method: "POST",
  headers: {
    "Content-Type": "text/plain",
    "User-Agent": "ingerir-pontos-seguros/1.0 (monitoramento-transmonseg)",
  },
  body: QUERY,
});
if (!res.ok) throw new Error(`Overpass falhou: ${res.status}`);
const data = await res.json();
const postos = (data.elements ?? []).filter((el) => el.type === "node" && Number.isFinite(el.lat) && Number.isFinite(el.lon));
console.log(`${postos.length} postos de gasolina encontrados no RJ.`);

const RAIO_M = 80;
let inseridos = 0;
for (const p of postos) {
  const nome = p.tags?.name ?? "Posto sem nome";
  await pool.query(
    `INSERT INTO geofences (tipo, nome, fonte, geom, meta)
     VALUES ('ponto_seguro', $1, 'osm',
       ST_Buffer(ST_SetSRID(ST_MakePoint($2, $3), 4326)::geography, $4)::geometry,
       jsonb_build_object('osm_id', $5::text, 'amenity', 'fuel'))`,
    [nome, p.lon, p.lat, RAIO_M, p.id]
  );
  inseridos++;
}
console.log(`${inseridos} geofences ponto_seguro inseridas.`);
await pool.end();
