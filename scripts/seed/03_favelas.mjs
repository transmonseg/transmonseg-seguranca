// Seed: favelas do SABREN (Rio de Janeiro) → geofences
// Uso: node --env-file=.env.local scripts/seed/03_favelas.mjs
import pg from "pg";

const conn = process.env.DATABASE_URL;
if (!conn) { console.error("DATABASE_URL ausente no .env.local"); process.exit(1); }

const BASE_URL =
  "https://pgeo3.rio.rj.gov.br/arcgis/rest/services/SABREN/Limites_de_Favelas/FeatureServer/13/query";
const PARAMS_BASE =
  "where=1%3D1&outFields=nome%2Cbairro%2Ccomplexo&returnGeometry=true&outSR=4326&f=geojson";

async function buscarPagina(offset) {
  const url = `${BASE_URL}?${PARAMS_BASE}&resultOffset=${offset}&resultRecordCount=1000`;
  const resp = await fetch(url, { headers: { "accept": "application/json" } });
  if (!resp.ok) {
    throw new Error(`API SABREN retornou HTTP ${resp.status} (offset=${offset})`);
  }
  return resp.json();
}

const client = new pg.Client({ connectionString: conn, ssl: { rejectUnauthorized: false } });

try {
  await client.connect();

  // 1. Coleta todas as features (paginando se necessário)
  const todasFeatures = [];
  let offset = 0;
  while (true) {
    console.log(`Buscando SABREN offset=${offset}...`);
    const geojson = await buscarPagina(offset);
    const features = geojson.features ?? [];
    todasFeatures.push(...features);
    console.log(`  → ${features.length} features nesta página (total acumulado: ${todasFeatures.length})`);

    // Para paginação se vier menos do que o máximo ou não houver exceededTransferLimit
    const excedeu = geojson.exceededTransferLimit === true;
    if (!excedeu || features.length === 0) break;
    offset += features.length;
  }

  console.log(`Total de features coletadas: ${todasFeatures.length}`);

  // 2. Limpa favelas antigas do SABREN (idempotência)
  await client.query("DELETE FROM geofences WHERE fonte = 'sabren'");
  console.log("Registros antigos do SABREN removidos.");

  // 3. Insere cada feature, pulando geometrias inválidas
  let inseridos = 0;
  let pulados = 0;

  for (const feature of todasFeatures) {
    const props = feature.properties ?? {};
    const nome = props.nome ?? props.NOME ?? "sem nome";
    const bairro = props.bairro ?? props.BAIRRO ?? null;
    const complexo = props.complexo ?? props.COMPLEXO ?? null;
    const geomJson = JSON.stringify(feature.geometry);

    try {
      await client.query(`
        INSERT INTO geofences (tipo, nome, fonte, cliente_id, geom, meta)
        VALUES (
          'favela',
          $1,
          'sabren',
          NULL,
          ST_GeomFromGeoJSON($2)::geography,
          $3::jsonb
        )
      `, [
        nome,
        geomJson,
        JSON.stringify({ nome, bairro, complexo })
      ]);
      inseridos++;
    } catch (err) {
      console.warn(`  ⚠ Polígono inválido pulado — "${nome}": ${err.message}`);
      pulados++;
    }
  }

  console.log(`\nFavelas inseridas: ${inseridos}`);
  if (pulados > 0) console.log(`Polígonos inválidos pulados: ${pulados}`);
  else console.log("Nenhum polígono inválido.");
} catch (e) {
  console.error("ERRO:", e.message);
  process.exitCode = 1;
} finally {
  await client.end();
}
