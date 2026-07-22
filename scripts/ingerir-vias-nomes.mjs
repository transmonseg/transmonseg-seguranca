// scripts/ingerir-vias-nomes.mjs
// Ingestao UNICA/manual de nomes de rua -> coordenada, pra geocodificacao
// local do romaneio -- ver docs/superpowers/specs/2026-07-22-geocodificacao-local-romaneio-design.md.
// Le o MESMO GeoJSON ja usado pra vias_celulas. Multiplas linhas com o
// mesmo nome sao esperadas (candidatos pra desambiguacao por cidade).
import pg from "pg";
import { createReadStream } from "node:fs";
import { createInterface } from "node:readline";

const ARQUIVO_ORIGEM = process.argv[2]
  ?? "/private/tmp/claude-501/-Users-joaquimsalles/3810e1b7-13db-4270-9c6f-1a1462bdfebc/scratchpad/rj-vias.geojsonseq";
const TAMANHO_LOTE = 5000;

// Duplicado de src/lib/romaneio-geocode-local.ts (script .mjs nao importa
// de src/lib/*.ts).
const PREFIXOS_VIA = new Set([
  "RUA", "R", "AV", "AVENIDA", "TRAVESSA", "TRAV", "ESTRADA", "EST",
  "RODOVIA", "ROD", "ALAMEDA", "AL", "PRACA", "PC", "LARGO",
]);

function normalizarNomeRua(rua) {
  const semAcento = rua
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .toUpperCase()
    .trim()
    .replace(/\s+/g, " ");
  const tokens = semAcento.split(" ");
  if (tokens.length > 1 && PREFIXOS_VIA.has(tokens[0])) {
    return tokens.slice(1).join(" ");
  }
  return semAcento;
}

function pontoMedio(coords) {
  // Media aritmetica simples das coordenadas do LineString -- nao
  // ponderada por comprimento de trecho, aproximacao suficiente pro
  // porte tipico de rua dessas cidades.
  let somaLat = 0, somaLng = 0;
  for (const [lng, lat] of coords) { somaLat += lat; somaLng += lng; }
  return { lat: somaLat / coords.length, lng: somaLng / coords.length };
}

async function flushLote(client, lote) {
  if (lote.length === 0) return;
  await client.query(
    `INSERT INTO vias_nomes (nome_normalizado, lat, lng)
     SELECT c.nome, c.lat, c.lng
     FROM unnest($1::text[], $2::float8[], $3::float8[]) AS c(nome, lat, lng)`,
    [lote.map((l) => l.nome), lote.map((l) => l.lat), lote.map((l) => l.lng)]
  );
}

async function main() {
  const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL, ssl: { rejectUnauthorized: false } });
  const client = await pool.connect();
  let lote = [];
  let viasProcessadas = 0;
  let viasIgnoradas = 0;

  try {
    const rl = createInterface({ input: createReadStream(ARQUIVO_ORIGEM, { encoding: "utf-8" }) });
    for await (const linhaBruta of rl) {
      const inicioJson = linhaBruta.indexOf("{");
      if (inicioJson === -1) continue;
      let feature;
      try {
        feature = JSON.parse(linhaBruta.slice(inicioJson));
      } catch {
        continue;
      }
      const nomeOsm = feature?.properties?.name ?? feature?.properties?.official_name;
      if (!nomeOsm || feature?.geometry?.type !== "LineString") {
        viasIgnoradas++;
        continue;
      }
      const coords = feature.geometry.coordinates;
      if (!Array.isArray(coords) || coords.length === 0) {
        viasIgnoradas++;
        continue;
      }
      const { lat, lng } = pontoMedio(coords);
      lote.push({ nome: normalizarNomeRua(nomeOsm), lat, lng });
      viasProcessadas++;

      if (viasProcessadas % TAMANHO_LOTE === 0) {
        await flushLote(client, lote);
        console.log(`  ${viasProcessadas} vias processadas`);
        lote = [];
      }
    }
    await flushLote(client, lote);
    console.log(`Concluido: ${viasProcessadas} vias processadas, ${viasIgnoradas} ignoradas (sem nome ou geometria invalida).`);

    const total = await client.query(`SELECT count(*)::bigint AS n FROM vias_nomes`);
    console.log("total de linhas em vias_nomes:", total.rows[0].n);
  } finally {
    client.release();
    await pool.end();
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
