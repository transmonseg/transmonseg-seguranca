// scripts/ingerir-vias-celulas.mjs
// Ingestao UNICA/manual da classificacao viaria (via principal x rua
// estreita) -- ver docs/superpowers/specs/2026-07-21-classe-viaria-desvio-design.md.
// Le o GeoJSON ja preparado (extrato Geofabrik Sudeste -> recorte bbox RJ
// via osmium -> filtro so vias -> export linestring) e distribui cada via
// pelas celulas ~100m que ela cruza, guardando so a MELHOR classe por
// celula quando ha conflito. Rerodar so se quiser atualizar o dado (ruas
// mudam pouco -- sem automacao/cron).
import pg from "pg";
import { createReadStream } from "node:fs";
import { createInterface } from "node:readline";

const ARQUIVO_ORIGEM = process.argv[2]
  ?? "/private/tmp/claude-501/-Users-joaquimsalles/3810e1b7-13db-4270-9c6f-1a1462bdfebc/scratchpad/rj-vias.geojsonseq";
const TAMANHO_LOTE = 5000;

// ─── Duplicado de src/lib/celulas.ts (script .mjs nao importa de src/lib/*.ts) ───
const PASSO_M = 80;
const SEGMENTO_MAX_M = 2500;

function haversineM(aLat, aLng, bLat, bLng) {
  const R = 6371000;
  const toR = (d) => (d * Math.PI) / 180;
  const dLat = toR(bLat - aLat);
  const dLng = toR(bLng - aLng);
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(toR(aLat)) * Math.cos(toR(bLat)) * Math.sin(dLng / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(h));
}

function celulaDe(lat, lng) {
  return `${Math.round(lat * 1000)}:${Math.round(lng * 1000)}`;
}

function celulasDoSegmento(latA, lngA, latB, lngB) {
  const dist = haversineM(latA, lngA, latB, lngB);
  if (dist > SEGMENTO_MAX_M) return [celulaDe(latB, lngB)];
  const n = Math.max(1, Math.ceil(dist / PASSO_M));
  const set = new Set();
  for (let i = 0; i <= n; i++) {
    const t = i / n;
    set.add(celulaDe(latA + (latB - latA) * t, lngA + (lngB - lngA) * t));
  }
  return [...set];
}

// ─── Duplicado de src/lib/classificacao-viaria.ts ───
const TAXONOMIA_VIARIA = {
  motorway: "principal", motorway_link: "principal",
  trunk: "principal", trunk_link: "principal",
  primary: "principal", primary_link: "principal",
  secondary: "principal", secondary_link: "principal",
  tertiary: "intermediaria", tertiary_link: "intermediaria",
  unclassified: "intermediaria", living_street: "intermediaria",
  residential: "estreita", service: "estreita", track: "estreita",
};
const PRIORIDADE_CLASSE = { principal: 3, intermediaria: 2, estreita: 1 };

function celulasDaLinha(coords) {
  // coords: array de [lng, lat] (ordem GeoJSON)
  const set = new Set();
  if (coords.length === 1) {
    set.add(celulaDe(coords[0][1], coords[0][0]));
    return set;
  }
  for (let i = 0; i < coords.length - 1; i++) {
    const [lngA, latA] = coords[i];
    const [lngB, latB] = coords[i + 1];
    for (const c of celulasDoSegmento(latA, lngA, latB, lngB)) set.add(c);
  }
  return set;
}

async function flushLote(client, mapaLote) {
  if (mapaLote.size === 0) return;
  const celulas = [...mapaLote.keys()];
  const classes = celulas.map((c) => mapaLote.get(c));
  await client.query(
    `INSERT INTO vias_celulas (celula, classe)
     SELECT c.celula, c.classe
     FROM unnest($1::text[], $2::text[]) AS c(celula, classe)
     ON CONFLICT (celula) DO UPDATE SET classe =
       CASE
         WHEN (CASE EXCLUDED.classe WHEN 'principal' THEN 3 WHEN 'intermediaria' THEN 2 ELSE 1 END)
            > (CASE vias_celulas.classe WHEN 'principal' THEN 3 WHEN 'intermediaria' THEN 2 ELSE 1 END)
         THEN EXCLUDED.classe
         ELSE vias_celulas.classe
       END`,
    [celulas, classes]
  );
}

async function main() {
  const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL, ssl: { rejectUnauthorized: false } });
  const client = await pool.connect();
  let mapaLote = new Map();
  let viasProcessadas = 0;
  let viasIgnoradas = 0;
  let celulasNoLote = 0;

  try {
    const rl = createInterface({ input: createReadStream(ARQUIVO_ORIGEM, { encoding: "utf-8" }) });
    for await (const linhaBruta of rl) {
      const inicioJson = linhaBruta.indexOf("{");
      if (inicioJson === -1) continue;
      let feature;
      try {
        feature = JSON.parse(linhaBruta.slice(inicioJson));
      } catch {
        continue; // linha corrompida/incompleta -- pula, nao aborta o import inteiro
      }
      const tag = feature?.properties?.highway;
      const classe = tag ? TAXONOMIA_VIARIA[tag] : undefined;
      if (!classe || feature?.geometry?.type !== "LineString") {
        viasIgnoradas++;
        continue;
      }
      const coords = feature.geometry.coordinates;
      if (!Array.isArray(coords) || coords.length === 0) {
        viasIgnoradas++;
        continue;
      }
      for (const c of celulasDaLinha(coords)) {
        const atual = mapaLote.get(c);
        if (!atual || PRIORIDADE_CLASSE[classe] > PRIORIDADE_CLASSE[atual]) {
          mapaLote.set(c, classe);
        }
      }
      viasProcessadas++;
      celulasNoLote = mapaLote.size;

      if (viasProcessadas % TAMANHO_LOTE === 0) {
        await flushLote(client, mapaLote);
        console.log(`  ${viasProcessadas} vias processadas, ultimo lote: ${celulasNoLote} celulas`);
        mapaLote = new Map();
      }
    }
    await flushLote(client, mapaLote); // ultimo lote parcial
    console.log(`Concluido: ${viasProcessadas} vias processadas, ${viasIgnoradas} ignoradas (tag nao veicular/desconhecida ou geometria invalida).`);

    const contagem = await client.query(`SELECT classe, count(*)::bigint AS n FROM vias_celulas GROUP BY classe ORDER BY classe`);
    console.log("Distribuicao final por classe:", JSON.stringify(contagem.rows));
  } finally {
    client.release();
    await pool.end();
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
