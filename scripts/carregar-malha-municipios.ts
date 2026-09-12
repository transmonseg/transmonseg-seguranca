// Popula malha_municipios_rj com a malha municipal oficial do IBGE.
// Idempotente: pode rodar quantas vezes quiser, faz upsert por codigo.
// Uso: npx tsx scripts/carregar-malha-municipios.ts
import { Client } from "pg";

const URL_IBGE =
  "https://servicodados.ibge.gov.br/api/v3/malhas/estados/33" +
  "?formato=application/vnd.geo+json&intrarregiao=municipio&qualidade=intermediaria";

type Feature = { properties: { codarea: string }; geometry: unknown };

async function main() {
  const res = await fetch(URL_IBGE);
  if (!res.ok) throw new Error(`IBGE respondeu ${res.status}`);
  const geojson = (await res.json()) as { features: Feature[] };
  if (!Array.isArray(geojson.features) || geojson.features.length === 0) {
    throw new Error("resposta do IBGE sem features");
  }

  const client = new Client({ connectionString: process.env.DATABASE_URL });
  await client.connect();
  try {
    for (const f of geojson.features) {
      const codigo = f.properties?.codarea;
      if (!codigo) throw new Error("feature sem codarea");
      await client.query(
        `INSERT INTO malha_municipios_rj (municipio_codigo, geom)
         VALUES ($1, ST_Multi(ST_SetSRID(ST_GeomFromGeoJSON($2), 4326)))
         ON CONFLICT (municipio_codigo) DO UPDATE SET geom = EXCLUDED.geom`,
        [codigo, JSON.stringify(f.geometry)],
      );
    }
    const { rows } = await client.query("SELECT count(*)::int AS n FROM malha_municipios_rj");
    console.log(`malha_municipios_rj: ${rows[0].n} municipios`);
  } finally {
    await client.end();
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
