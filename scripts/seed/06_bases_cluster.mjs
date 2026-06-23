// Seed das bases REAIS: o perímetro é o TERRENO do local (CEASA, galpão,
// pátio logístico) desenhado no OpenStreetMap, não bolhas em volta de cada
// caminhão. Casamos os clusters de veículos parados com o polígono OSM que
// os contém. Fallback: convex hull dos veículos quando o OSM não tem o local.
//
// Rode de noite/madrugada (frota recolhida).
// Uso: node --env-file=.env.local scripts/seed/06_bases_cluster.mjs
import pg from "pg";

const BASE = "https://datalayer.portalunitrac.com";
const MIRRORS = [
  "https://overpass-api.de/api/interpreter",
  "https://overpass.kumi.systems/api/interpreter",
  "https://maps.mail.ru/osm/tools/overpass/api/interpreter",
];
const conn = process.env.DATABASE_URL;
if (!conn) { console.error("DATABASE_URL ausente"); process.exit(1); }

async function jget(u) { const r = await fetch(u, { headers: { accept: "application/json" } }); return r.ok ? r.json() : null; }
async function jpost(u, b) {
  const r = await fetch(u, { method: "POST", headers: { accept: "application/json", "content-type": "application/json" }, body: JSON.stringify(b) });
  return r.ok ? r.json() : null;
}
async function overpass(q) {
  let err;
  for (const url of MIRRORS) {
    try {
      const r = await fetch(url, {
        method: "POST",
        headers: { "Content-Type": "application/x-www-form-urlencoded", "User-Agent": "TransmonsegCentral/1.0 (mediatriforce@gmail.com)" },
        body: "data=" + encodeURIComponent(q),
      });
      if (r.ok) return r.json();
      err = "HTTP " + r.status;
    } catch (e) { err = String(e); }
  }
  throw new Error(err);
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
// point-in-polygon (anel = [{lat,lon}]); ponto = {lat,lng}
function dentro(p, anel) {
  let d = false;
  for (let i = 0, j = anel.length - 1; i < anel.length; j = i++) {
    const xi = anel[i].lon, yi = anel[i].lat, xj = anel[j].lon, yj = anel[j].lat;
    const cruza = yi > p.lat !== yj > p.lat && p.lng < ((xj - xi) * (p.lat - yi)) / (yj - yi) + xi;
    if (cruza) d = !d;
  }
  return d;
}
// Busca polígonos de terreno no OSM ao redor de um ponto.
async function poligonosOSM(lat, lng) {
  const q = `[out:json][timeout:30];
    (
      way(around:700,${lat},${lng})[landuse~"industrial|commercial|retail"];
      way(around:700,${lat},${lng})[amenity=marketplace];
      way(around:700,${lat},${lng})[name~"CEASA|Benassi|Nutry|Cargo",i];
    );
    out geom;`;
  const j = await overpass(q);
  return (j.elements ?? [])
    .filter((e) => e.type === "way" && Array.isArray(e.geometry) && e.geometry.length >= 4)
    .map((e) => ({ id: e.id, nome: e.tags?.name ?? null, anel: e.geometry }));
}
function wktPolygon(anel) {
  const pts = anel.map((p) => `${p.lon} ${p.lat}`);
  if (pts[0] !== pts[pts.length - 1]) pts.push(pts[0]); // fecha o anel
  return `POLYGON((${pts.join(", ")}))`;
}

const c = new pg.Client({ connectionString: conn, ssl: { rejectUnauthorized: false } });
await c.connect();
await c.query("ALTER TABLE bases ALTER COLUMN geom TYPE geography(geometry, 4326)");
await c.query("ALTER TABLE bases ALTER COLUMN raio_m DROP NOT NULL");
const cid = async (cod) => (await c.query("select id from clientes where cod_user_unitrac=$1", [cod])).rows[0]?.id;
await c.query("DELETE FROM bases");

let total = 0;
for (const [nome, cod] of [["Nutry", "4096"], ["Benassi", "4586"]]) {
  const clienteId = await cid(cod);
  if (!clienteId) { console.log(`${nome} nao cadastrado`); continue; }

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

  console.log(`\n${nome}: ${parados.length} parados -> ${ord.length} cluster(s)`);
  const osmUsados = new Set();
  for (const cl of ord) {
    const clat = cl.reduce((s, p) => s + p.lat, 0) / cl.length;
    const clng = cl.reduce((s, p) => s + p.lng, 0) / cl.length;

    // candidatos OSM ao redor do cluster, ranqueados por quantos veículos cobrem
    let polis = [];
    try { polis = await poligonosOSM(clat, clng); } catch (e) { console.log("  overpass falhou:", e.message); }
    const ranque = polis
      .map((pl) => ({ ...pl, cobre: cl.filter((v) => dentro(v, pl.anel)).length }))
      .filter((pl) => pl.cobre >= Math.max(3, cl.length * 0.3))
      .sort((a, b) => b.cobre - a.cobre);

    const melhor = ranque[0];
    if (melhor && osmUsados.has(melhor.id)) continue; // mesmo terreno (ex.: dentro do CEASA)

    let geomSql, src, nomeB, wkt;
    if (melhor) {
      osmUsados.add(melhor.id);
      geomSql = "ST_MakeValid(ST_GeomFromText($3, 4326))::geography";
      src = `OSM "${melhor.nome ?? melhor.id}" (${melhor.cobre}/${cl.length} veíc)`;
      nomeB = melhor.nome ? `Base ${nome} — ${melhor.nome}` : `Base ${nome}`;
      wkt = wktPolygon(melhor.anel);
    } else {
      // fallback: convex hull dos veículos do cluster + buffer 40m
      geomSql = "ST_Buffer(ST_ConvexHull(ST_GeomFromText($3, 4326))::geography, 40)::geography";
      src = "convex hull (sem terreno no OSM)";
      nomeB = `Base ${nome} (${cl.length} veíc)`;
      wkt = `MULTIPOINT(${cl.map((p) => `${p.lng} ${p.lat}`).join(", ")})`;
    }
    const ins = await c.query(
      `INSERT INTO bases (cliente_id, nome, geom, raio_m)
       VALUES ($1, $2, ${geomSql}, NULL)
       RETURNING ST_Area(geom::geography)/1e6 km2`,
      [clienteId, nomeB, wkt]
    );
    console.log(`  "${nomeB}" — ${Number(ins.rows[0].km2).toFixed(2)} km² | ${src}`);
    total++;
  }
}
console.log(`\nTotal de bases: ${total}`);
await c.end();
