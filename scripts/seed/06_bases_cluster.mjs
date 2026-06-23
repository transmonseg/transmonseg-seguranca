// Seed das bases REAIS: o perímetro da base é onde a frota efetivamente
// estaciona (clusters de veículos parados), não um círculo num endereço
// geocodificado. Resolve o falso positivo de "parado fora da base".
//
// Rode de noite/madrugada (frota recolhida) pra capturar as bases certas.
// Uso: node --env-file=.env.local scripts/seed/06_bases_cluster.mjs
import pg from "pg";

const BASE = "https://datalayer.portalunitrac.com";
const conn = process.env.DATABASE_URL;
if (!conn) { console.error("DATABASE_URL ausente"); process.exit(1); }

async function jget(u) { const r = await fetch(u, { headers: { accept: "application/json" } }); return r.ok ? r.json() : null; }
async function jpost(u, b) {
  const r = await fetch(u, { method: "POST", headers: { accept: "application/json", "content-type": "application/json" }, body: JSON.stringify(b) });
  return r.ok ? r.json() : null;
}
function haversine(a, b) {
  const R = 6371000, toR = (d) => (d * Math.PI) / 180;
  const dLat = toR(b.lat - a.lat), dLng = toR(b.lng - a.lng);
  const x = Math.sin(dLat/2)**2 + Math.cos(toR(a.lat))*Math.cos(toR(b.lat))*Math.sin(dLng/2)**2;
  return 2 * R * Math.asin(Math.sqrt(x));
}
function dbscan(pts, eps, minPts) {
  const labels = new Array(pts.length).fill(-1);
  let c = 0;
  const viz = (i) => pts.map((_, j) => j).filter((j) => j !== i && haversine(pts[i], pts[j]) <= eps);
  for (let i = 0; i < pts.length; i++) {
    if (labels[i] !== -1) continue;
    const n = viz(i);
    if (n.length + 1 < minPts) { labels[i] = -2; continue; }
    labels[i] = c;
    const fila = [...n];
    while (fila.length) {
      const j = fila.shift();
      if (labels[j] === -2) labels[j] = c;
      if (labels[j] !== -1) continue;
      labels[j] = c;
      const n2 = viz(j);
      if (n2.length + 1 >= minPts) fila.push(...n2);
    }
    c++;
  }
  return labels;
}
// Nomeia a base pela região conhecida mais próxima; senão, por cliente+índice.
function nomeBase(cliente, lat, lng, i) {
  const conhecidas = [
    { nome: "Base Benassi (Irajá / Av. Brasil)", lat: -22.828, lng: -43.338, r: 1500 },
    { nome: "Base Nutry (Penha)", lat: -22.816, lng: -43.278, r: 1200 },
    { nome: "Base Nutry (Campos dos Goytacazes)", lat: -21.689, lng: -41.311, r: 2000 },
  ];
  const m = conhecidas.find((k) => haversine({ lat, lng }, k) <= k.r);
  return m ? m.nome : `Base ${cliente} ${i + 1}`;
}

const c = new pg.Client({ connectionString: conn, ssl: { rejectUnauthorized: false } });
await c.connect();

// 1. Relaxa a coluna pra aceitar polígono (idempotente) e torna raio opcional.
await c.query("ALTER TABLE bases ALTER COLUMN geom TYPE geography(geometry, 4326)");
await c.query("ALTER TABLE bases ALTER COLUMN raio_m DROP NOT NULL");

const cid = async (cod) => (await c.query("select id from clientes where cod_user_unitrac=$1", [cod])).rows[0]?.id;

// 2. Limpa as bases atuais (vamos redefinir todas pelos clusters reais).
await c.query("DELETE FROM bases");

let totalBases = 0;
for (const [nome, cod] of [["Nutry", "4096"], ["Benassi", "4586"]]) {
  const clienteId = await cid(cod);
  if (!clienteId) { console.log(`cliente ${nome} nao cadastrado, pulando`); continue; }

  const vb = await jget(`${BASE}/veiculos/masn/${cod}`);
  const cvs = (vb?.veiculos ?? []).map((v) => String(v.cv ?? v.veicucodigo));
  const pos = await jpost(`${BASE}/mapa_servicos/posicoes/N/N`, cvs);
  const parados = (pos?.Posicoes ?? [])
    .map((p) => ({ lat: parseFloat(p.posiclatitude), lng: parseFloat(p.posiclongitude), vel: parseInt(p.posicvelocidade) || 0 }))
    .filter((p) => p.lat && p.lng && p.vel === 0);

  const labels = dbscan(parados, 250, 4);
  const clusters = {};
  parados.forEach((p, i) => { if (labels[i] >= 0) (clusters[labels[i]] ??= []).push(p); });
  const ord = Object.values(clusters).sort((a, b) => b.length - a.length);

  console.log(`\n${nome}: ${parados.length} parados -> ${ord.length} base(s)`);
  const usados = new Map(); // dedup de nomes (pátios próximos ganham sufixo)
  let i = 0;
  for (const cl of ord) {
    const clat = cl.reduce((s, p) => s + p.lat, 0) / cl.length;
    const clng = cl.reduce((s, p) => s + p.lng, 0) / cl.length;
    let nomeB = nomeBase(nome, clat, clng, i);
    const n = (usados.get(nomeB) ?? 0) + 1;
    usados.set(nomeB, n);
    if (n > 1) nomeB = nomeB.replace(/\)$/, ` — pátio ${n})`);
    // perímetro = união de buffers de 70m em volta de cada veículo parado
    const wkt = `MULTIPOINT(${cl.map((p) => `${p.lng} ${p.lat}`).join(", ")})`;
    const ins = await c.query(
      `INSERT INTO bases (cliente_id, nome, geom, raio_m)
       VALUES ($1, $2, ST_Buffer(ST_GeomFromText($3, 4326)::geography, 70)::geography, NULL)
       RETURNING ST_Area(geom::geography) AS area_m2`,
      [clienteId, nomeB, wkt]
    );
    const km2 = (ins.rows[0].area_m2 / 1e6).toFixed(2);
    console.log(`  "${nomeB}" — ${cl.length} veículos, área ${km2} km²`);
    totalBases++;
    i++;
  }
}

console.log(`\nTotal de bases (polígono real): ${totalBases}`);
await c.end();
