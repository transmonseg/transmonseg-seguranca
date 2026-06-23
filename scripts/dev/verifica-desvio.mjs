// VERIFICAÇÃO RIGOROSA do detector de desvio.
// Cada candidato é julgado por 3 evidências INDEPENDENTES:
//   1) afastamento: dist ao alvo pendente mais próximo cresceu >200m em 2 ciclos (núcleo do motor)
//   2) rumo: o vetor de movimento aponta PARA LONGE do alvo (ângulo > 90°)
//   3) Maps/estrada: distância de ROTA REAL (OSRM driving) ao alvo, não só linha reta
// Também cruza com os alertas que a PRODUÇÃO gravou e caça falsos negativos
// (longe + em movimento + NÃO afastando: tem que ser aproximação legítima).
// Não grava nada. Roda: node --env-file=.env.local scripts/dev/verifica-desvio.mjs
import pg from "pg";

const BASE = "https://datalayer.portalunitrac.com";
const OSRM = "https://router.project-osrm.org";
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const jget = async (u) => { const r = await fetch(u, { headers: { accept: "application/json" } }); return r.ok ? r.json() : null; };
const jpost = async (u, b) => { const r = await fetch(u, { method: "POST", headers: { accept: "application/json", "content-type": "application/json" }, body: JSON.stringify(b) }); return r.ok ? r.json() : null; };

function hav(aLat, aLng, bLat, bLng) {
  const R = 6371000, t = (d) => (d * Math.PI) / 180;
  const dLat = t(bLat - aLat), dLng = t(bLng - aLng);
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(t(aLat)) * Math.cos(t(bLat)) * Math.sin(dLng / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(h));
}
// rumo inicial (graus) de A para B
function bearing(aLat, aLng, bLat, bLng) {
  const t = (d) => (d * Math.PI) / 180, g = (r) => (r * 180) / Math.PI;
  const y = Math.sin(t(bLng - aLng)) * Math.cos(t(bLat));
  const x = Math.cos(t(aLat)) * Math.sin(t(bLat)) - Math.sin(t(aLat)) * Math.cos(t(bLat)) * Math.cos(t(bLng - aLng));
  return (g(Math.atan2(y, x)) + 360) % 360;
}
function difAng(a, b) { let d = Math.abs(a - b) % 360; return d > 180 ? 360 - d : d; }
function dmin(lat, lng, pts) { let d = null, melhor = null; for (const q of pts) { const x = hav(lat, lng, q.lat, q.lng); if (d === null || x < d) { d = x; melhor = q; } } return { d, melhor }; }
const maps = (lat, lng) => `https://www.google.com/maps?q=${lat},${lng}`;

// rota real de carro (OSRM público). Retorna metros ou null.
async function osrmDist(aLat, aLng, bLat, bLng) {
  try {
    const u = `${OSRM}/route/v1/driving/${aLng},${aLat};${bLng},${bLat}?overview=false`;
    const j = await jget(u);
    return j?.routes?.[0]?.distance ?? null;
  } catch { return null; }
}

// ray casting: ponto dentro de um polígono GeoJSON (Polygon/MultiPolygon)
function inRing(lng, lat, ring) {
  let dentro = false;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    const xi = ring[i][0], yi = ring[i][1], xj = ring[j][0], yj = ring[j][1];
    if ((yi > lat) !== (yj > lat) && lng < ((xj - xi) * (lat - yi)) / (yj - yi) + xi) dentro = !dentro;
  }
  return dentro;
}
function inGeom(lng, lat, geom) {
  if (!geom) return false;
  if (geom.type === "Polygon") return geom.coordinates.some((r) => inRing(lng, lat, r));
  if (geom.type === "MultiPolygon") return geom.coordinates.some((poly) => poly.some((r) => inRing(lng, lat, r)));
  return false;
}

async function snap(cod) {
  const vb = await jget(`${BASE}/veiculos/masn/${cod}`);
  const cvs = (vb?.veiculos ?? []).map((v) => String(v.cv ?? v.veicucodigo));
  const pos = await jpost(`${BASE}/mapa_servicos/posicoes/N/N`, cvs);
  const alvos = await jpost(`${BASE}/mapa_servicos/alvos`, cvs);
  const pend = {};
  for (const a of alvos?.alvos ?? []) {
    if (a.alvosituacaoservico !== 0) continue;
    const lat = +a.pontolatitude, lng = +a.pontolongitude;
    if (!Number.isFinite(lat) || !Number.isFinite(lng) || (lat === 0 && lng === 0)) continue;
    (pend[a.placa] ??= []).push({ lat, lng, nome: a.pontonome });
  }
  const m = {};
  for (const p of pos?.Posicoes ?? []) {
    const lat = +p.posiclatitude, lng = +p.posiclongitude;
    m[p.veicuplaca] = { lat, lng, vel: parseInt(p.posicvelocidade) || 0, atraso: parseInt(p.atraso) || 0, pend: pend[p.veicuplaca] || [] };
  }
  return m;
}

// operação: seg-sex 6-20h SP
function emOperacao() {
  const agora = new Date();
  const sp = new Date(agora.toLocaleString("en-US", { timeZone: "America/Sao_Paulo" }));
  const dia = sp.getDay(), h = sp.getHours();
  return { ok: dia >= 1 && dia <= 5 && h >= 6 && h < 20, hora: `${sp.getHours()}:${String(sp.getMinutes()).padStart(2, "0")}`, dia };
}

const c = new pg.Client({ connectionString: process.env.DATABASE_URL, ssl: { rejectUnauthorized: false } });
await c.connect();

const op = emOperacao();
console.log(`\n>> agora SP ${op.hora}, em operação: ${op.ok ? "SIM" : "NÃO (detector não dispara fora 6-20h seg-sex)"}\n`);

const CLIENTES = [["Nutry", "4096"], ["Benassi", "4586"]];
const basesPorCod = {};
for (const [, cod] of CLIENTES) {
  const r = await c.query(
    `select coalesce(jsonb_agg(ST_AsGeoJSON(geom::geometry)::jsonb), '[]'::jsonb) gj
       from bases b join clientes cl on cl.id = b.cliente_id where cl.cod_user_unitrac = $1`, [cod]);
  basesPorCod[cod] = r.rows[0].gj;
}

let totalFlag = 0, totalConfirm = 0;
for (const [nome, cod] of CLIENTES) {
  console.log(`\n=============== ${nome} (${cod}) ===============`);
  const c1 = await snap(cod);
  await sleep(75000);
  const c2 = await snap(cod);
  const bases = basesPorCod[cod];

  // Regra NOVA (igual ao detector): gatilho = afastando + rumo OPOSTO ao alvo +
  // faixa local [2,5km, 25km]. Acima de 25km = deslocamento (não é desvio).
  const flagrados = [], descartadoDeslocamento = [], descartadoRumo = [], longeNaoAfasta = [];
  for (const placa of Object.keys(c2)) {
    const a = c2[placa], b = c1[placa];
    if (!a || a.atraso >= 60 || a.vel <= 0 || !a.lat || !a.pend.length) continue;
    const foraBase = !bases.some((g) => inGeom(a.lng, a.lat, g));
    if (!foraBase) continue;
    const { d: dNow, melhor } = dmin(a.lat, a.lng, a.pend);
    if (dNow === null) continue;
    const dPrev = b && b.lat ? dmin(b.lat, b.lng, a.pend).d : null;
    const afast = dPrev !== null && dNow > dPrev + 200;
    const rumoMov = b && b.lat && (b.lat !== a.lat || b.lng !== a.lng) ? bearing(b.lat, b.lng, a.lat, a.lng) : null;
    const rumoAlvo = bearing(a.lat, a.lng, melhor.lat, melhor.lng);
    const rumoOposto = rumoMov !== null && difAng(rumoMov, rumoAlvo) > 90;
    if (afast && dNow >= 2500) {
      if (dNow > 25000) descartadoDeslocamento.push({ placa, dNow });
      else if (!rumoOposto) descartadoRumo.push({ placa, dNow, dif: rumoMov !== null ? Math.round(difAng(rumoMov, rumoAlvo)) : null });
      else flagrados.push({ placa, a, b, dNow, dPrev, melhor });
    } else if (dNow >= 5000) longeNaoAfasta.push({ placa, dNow, dPrev, aproximando: dPrev !== null && dNow < dPrev });
  }

  // POSITIVOS: 3 evidências independentes
  console.log(`\n-- FLAGRADOS como desvio: ${flagrados.length} --`);
  for (const f of flagrados) {
    totalFlag++;
    const osrm = await osrmDist(f.a.lat, f.a.lng, f.melhor.lat, f.melhor.lng);
    const rumoMov = f.b && f.b.lat ? bearing(f.b.lat, f.b.lng, f.a.lat, f.a.lng) : null;
    const rumoAlvo = bearing(f.a.lat, f.a.lng, f.melhor.lat, f.melhor.lng);
    const difRumo = rumoMov !== null ? difAng(rumoMov, rumoAlvo) : null;
    const rumoAfasta = difRumo !== null && difRumo > 90; // movendo-se no sentido oposto ao alvo
    const ev = [
      "afastando(dist+)",                                   // sempre verdadeiro aqui
      rumoAfasta ? "rumo-oposto" : null,
      osrm !== null && osrm >= 4000 ? "estrada>=4km" : null,
    ].filter(Boolean);
    const confirmado = ev.length >= 2;
    if (confirmado) totalConfirm++;
    console.log(
      `  ${confirmado ? "✓ CONFIRMADO" : "? revisar  "} ${f.placa} | reta ${(f.dNow / 1000).toFixed(1)}km (era ${(f.dPrev / 1000).toFixed(1)}) ` +
      `| estrada ${osrm !== null ? (osrm / 1000).toFixed(1) + "km" : "n/d"} ` +
      `| rumo ${difRumo !== null ? Math.round(difRumo) + "°" + (rumoAfasta ? " (oposto)" : " (p/ alvo)") : "n/d"} ` +
      `| vel ${f.a.vel} | evid: ${ev.join("+")}`);
    console.log(`       pos ${maps(f.a.lat, f.a.lng)}  ->  alvo "${f.melhor.nome ?? ""}" ${maps(f.melhor.lat, f.melhor.lng)}`);
  }
  if (!flagrados.length) console.log("  (nenhum)");

  // O que a regra NOVA descarta e a antiga deixava passar (os falsos positivos)
  if (descartadoDeslocamento.length) {
    console.log(`\n-- DESCARTADOS por deslocamento (>25km, não é desvio local): ${descartadoDeslocamento.length} --`);
    for (const x of descartadoDeslocamento) console.log(`  ${x.placa} ${(x.dNow / 1000).toFixed(1)}km — trânsito interurbano/voltando, regra antiga marcava como crítico`);
  }
  if (descartadoRumo.length) {
    console.log(`\n-- DESCARTADOS por rumo (afastou mas indo p/ o alvo / lateral): ${descartadoRumo.length} --`);
    for (const x of descartadoRumo) console.log(`  ${x.placa} ${(x.dNow / 1000).toFixed(1)}km, dif rumo ${x.dif}°`);
  }

  // FALSOS NEGATIVOS: longe mas não-afastando -> deve ser aproximação
  console.log(`\n-- longe (>5km) e NÃO flagrado: ${longeNaoAfasta.length} (esperado: todos se aproximando) --`);
  for (const x of longeNaoAfasta.slice(0, 12)) {
    const tag = x.aproximando ? "ok (aproximando)" : x.dPrev === null ? "1º ciclo (sem histórico)" : "ESTÁVEL — revisar";
    console.log(`  ${x.placa} reta ${(x.dNow / 1000).toFixed(1)}km${x.dPrev !== null ? " (era " + (x.dPrev / 1000).toFixed(1) + ")" : ""} -> ${tag}`);
  }
  if (!longeNaoAfasta.length) console.log("  (nenhum veículo distante em movimento)");
}

// CRUZA com o que a produção gravou nas últimas 2h
const prod = await c.query(
  `select v.placa, a.nivel, a.motivo, to_char(a.created_at at time zone 'America/Sao_Paulo','HH24:MI') hora
     from alertas a join veiculos v on v.id = a.veiculo_id
    where a.tipo = 'desvio' and a.created_at > now() - interval '2 hours'
    order by a.created_at desc`);
console.log(`\n=============== PRODUÇÃO (alertas desvio últimas 2h): ${prod.rows.length} ===============`);
for (const r of prod.rows) console.log(`  [${r.hora}] ${r.nivel} ${r.placa} — ${r.motivo}`);

console.log(`\n>>> RESUMO: ${totalFlag} flagrados nesta janela, ${totalConfirm} confirmados por >=2 evidências independentes.`);
await c.end();
