// Importa os poligonos das CISP (Circunscricao Integrada de Seguranca Publica —
// area de delegacia) do ISP-RJ pra tabela geofences (tipo='cisp'), pra permitir
// juntar a base BaseDPEvolucaoMensalCisp.csv (roubo de carga por CISP) com uma
// geometria real via point-in-polygon — mesmo padrao ja usado pra favela.
//
// Fonte: https://dadosabertos.rj.gov.br/dataset/isp-divisao-territorial
// (KML compactado em RAR, dentro de um KMZ — precisa dupla extracao).
// Import de uma vez so: os limites de CISP so mudam quando o ISP redesenha
// circunscricoes (ultima leva: 2019), nao precisa reimportar toda hora.
//
// Dependencias NAO ficam no package.json (so usadas por este script, uma vez):
//   npm install --no-save node-unrar-js adm-zip @xmldom/xmldom @tmcw/togeojson
// depois: node --env-file=.env.local scripts/importar-cisp.mjs
import pg from "pg";
import { createExtractorFromData } from "node-unrar-js";
import AdmZip from "adm-zip";
import { DOMParser } from "@xmldom/xmldom";
import * as toGeoJSON from "@tmcw/togeojson";

const CISP_RAR_URL = "https://www.ispdados.rj.gov.br/Arquivos/CISPkml.rar";

async function baixarEExtrairKml() {
  const r = await fetch(CISP_RAR_URL);
  if (!r.ok) throw new Error(`Download do RAR falhou: ${r.status}`);
  const rarBuf = await r.arrayBuffer();

  const extractorRar = await createExtractorFromData({ data: rarBuf });
  let kmzBuf = null;
  for (const file of extractorRar.extract({}).files) {
    if (file.fileHeader.flags.directory) continue;
    if (file.fileHeader.name.toLowerCase().endsWith(".kmz")) {
      kmzBuf = Buffer.from(file.extraction);
      break;
    }
  }
  if (!kmzBuf) throw new Error("Nenhum .kmz encontrado dentro do RAR");

  const zip = new AdmZip(kmzBuf);
  const kmlEntry = zip.getEntries().find((e) => e.entryName.toLowerCase().endsWith(".kml"));
  if (!kmlEntry) throw new Error("Nenhum .kml encontrado dentro do KMZ");
  return zip.readAsText(kmlEntry);
}

function kmlParaFeatures(kmlTexto) {
  const dom = new DOMParser().parseFromString(kmlTexto, "text/xml");
  const geojson = toGeoJSON.kml(dom);
  return geojson.features;
}

async function main() {
  console.log("Baixando e extraindo CISPkml.rar...");
  const kmlTexto = await baixarEExtrairKml();
  console.log(`KML extraido: ${(kmlTexto.length / 1024 / 1024).toFixed(1)}MB`);

  const features = kmlParaFeatures(kmlTexto);
  console.log(`Features encontradas no KML: ${features.length}`);

  const registros = [];
  for (const f of features) {
    const cispStr = (f.properties?.name ?? "").trim();
    const cisp = parseInt(cispStr, 10);
    if (!Number.isFinite(cisp) || !f.geometry) {
      console.log(`  aviso: feature sem cisp valido (name="${cispStr}"), pulando`);
      continue;
    }
    registros.push({ cisp, geometry: f.geometry });
  }
  console.log(`Registros validos (com cisp + geometria): ${registros.length}`);

  const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL, ssl: { rejectUnauthorized: false } });
  const client = await pool.connect();
  try {
    await client.query("BEGIN");

    // geofences_tipo_check so permitia 'favela'|'risco'|'ponto_seguro' — amplia
    // pra incluir 'cisp' (aditivo, nao remove nenhum valor existente).
    await client.query(`ALTER TABLE geofences DROP CONSTRAINT geofences_tipo_check`);
    await client.query(
      `ALTER TABLE geofences ADD CONSTRAINT geofences_tipo_check
       CHECK (tipo = ANY (ARRAY['favela'::text, 'risco'::text, 'ponto_seguro'::text, 'cisp'::text]))`
    );

    const del = await client.query(`DELETE FROM geofences WHERE tipo = 'cisp'`);
    console.log(`Removidos ${del.rowCount} registros antigos tipo='cisp'`);

    for (const r of registros) {
      await client.query(
        // ST_MakeValid: o KML do ISP-RJ vem com ~2 aneis auto-intersectantes
        // (achado ao vivo 07/07/2026, CISP 10 e 127) — corrige sem precisar
        // de passo manual depois.
        `INSERT INTO geofences (tipo, nome, fonte, geom, meta)
         VALUES ('cisp', $1, 'ISP-RJ (CISPkml.rar, limites 2019)',
                 ST_MakeValid(ST_Force2D(ST_SetSRID(ST_GeomFromGeoJSON($2), 4326))), $3::jsonb)`,
        [`CISP ${r.cisp}`, JSON.stringify(r.geometry), JSON.stringify({ cisp: r.cisp })]
      );
    }
    await client.query("COMMIT");
    console.log(`${registros.length} poligonos de CISP inseridos em geofences.`);
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
