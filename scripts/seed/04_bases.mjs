// Seed das bases adicionais: Nutry Campos + as 2 bases da Benassi (Av. Brasil).
// Idempotente (checa por nome+cliente). A Nutry Penha já vem do 01_clientes.mjs.
import pg from "pg";

async function geocode(q) {
  try {
    const r = await fetch(
      `https://nominatim.openstreetmap.org/search?q=${encodeURIComponent(q)}&format=json&limit=1`,
      { headers: { "User-Agent": "TransmonsegCentral/1.0" } }
    );
    const d = await r.json();
    if (d[0]) return { lat: parseFloat(d[0].lat), lng: parseFloat(d[0].lon) };
  } catch {}
  return null;
}

const c = new pg.Client({ connectionString: process.env.DATABASE_URL, ssl: { rejectUnauthorized: false } });
await c.connect();

const cid = async (cod) => (await c.query("select id from clientes where cod_user_unitrac=$1", [cod])).rows[0]?.id;

async function upsertBase(clienteId, nome, lat, lng, raio) {
  const ex = await c.query("select id from bases where cliente_id=$1 and nome=$2", [clienteId, nome]);
  if (ex.rows[0]) { console.log("já existe:", nome); return; }
  await c.query(
    "insert into bases (cliente_id, nome, geom, raio_m) values ($1,$2,ST_SetSRID(ST_MakePoint($3,$4),4326)::geography,$5)",
    [clienteId, nome, lng, lat, raio]
  );
  console.log("inserida:", nome, `(${lat}, ${lng}) r=${raio}`);
}

const nutry = await cid("4096");
const benassi = await cid("4586");

// Nutry — base Campos (Rua Waldemar Campos, 12, Campos dos Goytacazes/RJ)
const campos = await geocode("Rua Waldemar Campos, Campos dos Goytacazes, Rio de Janeiro");
console.log("geocode Campos:", campos);
if (campos) await upsertBase(nutry, "Campos (Waldemar Campos)", campos.lat, campos.lng, 300);
else console.log("ATENÇÃO: geocode de Campos falhou, cadastrar manualmente depois");

// Benassi — 2 bases na Av. Brasil (RJ)
await upsertBase(benassi, "Base Benassi (Av. Brasil)", -22.8288, -43.3420, 630);
await upsertBase(benassi, "CD Benassi (Iraja)", -22.8280, -43.3383, 150);

console.log("\nbases por cliente:");
const r = await c.query(
  "select cl.nome cliente, b.nome base, b.raio_m from bases b join clientes cl on cl.id=b.cliente_id order by cl.nome"
);
for (const x of r.rows) console.log(`  ${x.cliente} -> ${x.base} (r=${x.raio_m}m)`);
await c.end();
