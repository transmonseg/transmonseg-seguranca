// Seed: favelas/comunidades do RESTO do estado do RJ (fora da capital) → geofences
// Fonte: IBGE — Aglomerados Subnormais 2010 (cobre todos os municípios), via WFS GeoServer.
// A capital (cd_geocodm 3304557) é deixada de fora: lá já usamos o SABREN (mais detalhado).
// Uso: node --env-file=.env.local scripts/seed/05_favelas_estado.mjs
import pg from "pg";

const conn = process.env.DATABASE_URL;
if (!conn) { console.error("DATABASE_URL ausente no .env.local"); process.exit(1); }

const CAPITAL = "3304557"; // município do Rio de Janeiro (coberto pelo SABREN)
const WFS =
  "https://geoservicos.ibge.gov.br/geoserver/CGEO/ows?service=WFS&version=2.0.0" +
  "&request=GetFeature&typeNames=CGEO:AglomeradosSubnormais2010_Limites" +
  "&cql_filter=uf=%2733%27&outputFormat=application/json";

const client = new pg.Client({ connectionString: conn, ssl: { rejectUnauthorized: false } });

try {
  console.log("Baixando aglomerados subnormais do RJ (IBGE 2010)...");
  const resp = await fetch(WFS, { headers: { accept: "application/json" } });
  if (!resp.ok) throw new Error(`WFS IBGE retornou HTTP ${resp.status}`);
  const geojson = await resp.json();
  const todas = geojson.features ?? [];
  console.log(`Total no RJ: ${todas.length}`);

  const fora = todas.filter((f) => String(f.properties?.cd_geocodm) !== CAPITAL);
  console.log(`Fora da capital (a inserir): ${fora.length}`);

  await client.connect();

  // Idempotência: remove o que este seed inseriu antes.
  await client.query("DELETE FROM geofences WHERE fonte = 'ibge2010'");

  let inseridos = 0, pulados = 0;
  for (const f of fora) {
    const p = f.properties ?? {};
    const nome = p.nm_agsn ?? "sem nome";
    const municipio = p.nm_municip ?? null;
    const geomJson = JSON.stringify(f.geometry);
    try {
      await client.query(
        `INSERT INTO geofences (tipo, nome, fonte, cliente_id, geom, meta)
         VALUES ('favela', $1, 'ibge2010', NULL,
                 ST_MakeValid(ST_GeomFromGeoJSON($2))::geography,
                 $3::jsonb)`,
        [nome, geomJson, JSON.stringify({ nome, municipio, populacao: p.populacao ?? null, fonte: "IBGE 2010" })]
      );
      inseridos++;
    } catch (err) {
      console.warn(`  ⚠ pulado — "${nome}" (${municipio}): ${err.message}`);
      pulados++;
    }
  }

  console.log(`\nInseridos: ${inseridos} | pulados: ${pulados}`);

  const tot = await client.query("SELECT count(*) FROM geofences WHERE tipo='favela'");
  console.log(`Total de áreas de risco no banco agora: ${tot.rows[0].count}`);
} catch (e) {
  console.error("ERRO:", e.message);
  process.exitCode = 1;
} finally {
  await client.end();
}
