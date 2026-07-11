// Backtest da CERCA VIRTUAL de rota (Fase 1 do plano de 10/07) contra dado
// real do dia, ANTES de implementar em producao -- regra da sessao: nunca
// mudar logica de deteccao sem validar contra dado historico real.
//
// Metodo: para cada veiculo da Nutry que completou a rota hoje, traca a rota
// OSRM na ORDEM REAL das entregas (dataRealizado) comecando na base, e mede
// quantos pontos do rastro real do dia caem fora do buffer (300m e 600m).
// O veiculo comprovadamente visitou todos os pontos, entao todo ponto fora
// e um falso positivo em potencial da cerca. Este metodo SUPERESTIMA o falso
// positivo (producao recalcula o corredor por trecho a partir da posicao
// atual, bem mais justo) -- se ate o teto for baixo, a cerca e viavel.
//
// Uso: node --env-file=.env.local scripts/backtest-cerca-virtual.mjs
import pg from "pg";

const BASE_URL = "https://datalayer.portalunitrac.com";
const BUFFERS_M = [300, 600];
const MAX_VEICULOS = 8;
const THROTTLE_MS = 1100; // politica OSRM publico 1 req/s

function haversineM(aLat, aLng, bLat, bLng) {
  const R = 6371000;
  const toR = (d) => (d * Math.PI) / 180;
  const dLat = toR(bLat - aLat);
  const dLng = toR(bLng - aLng);
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(toR(aLat)) * Math.cos(toR(bLat)) * Math.sin(dLng / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(h));
}

function distanciaAoSegmentoM(ponto, origem, destino) {
  const latRef = (origem.lat + destino.lat + ponto.lat) / 3;
  const mLat = 111320;
  const mLng = 111320 * Math.cos((latRef * Math.PI) / 180);
  const toXY = (p) => ({ x: (p.lng - origem.lng) * mLng, y: (p.lat - origem.lat) * mLat });
  const d = toXY(destino), p = toXY(ponto);
  const lenSq = d.x * d.x + d.y * d.y;
  if (lenSq === 0) return Math.sqrt(p.x * p.x + p.y * p.y);
  let t = (p.x * d.x + p.y * d.y) / lenSq;
  t = Math.max(0, Math.min(1, t));
  return Math.sqrt((p.x - t * d.x) ** 2 + (p.y - t * d.y) ** 2);
}

// Distancia minima de um ponto a polilinha inteira. Otimizacao: pula
// segmentos cujo inicio esta a >5km (impossivel estar a <600m).
function distMinAPolilinha(ponto, poli) {
  let min = Infinity;
  for (let i = 0; i < poli.length - 1; i++) {
    if (haversineM(ponto.lat, ponto.lng, poli[i].lat, poli[i].lng) > 5000) continue;
    const d = distanciaAoSegmentoM(ponto, poli[i], poli[i + 1]);
    if (d < min) min = d;
  }
  if (min === Infinity) {
    for (let i = 0; i < poli.length - 1; i++) {
      const d = distanciaAoSegmentoM(ponto, poli[i], poli[i + 1]);
      if (d < min) min = d;
    }
  }
  return min;
}

async function rotaOSRM(waypoints) {
  const coords = waypoints.map((w) => `${w.lng},${w.lat}`).join(";");
  const url = `https://router.project-osrm.org/route/v1/driving/${coords}?geometries=geojson&overview=full`;
  const res = await fetch(url, { signal: AbortSignal.timeout(15000) });
  if (!res.ok) return null;
  const data = await res.json();
  const c = data.routes?.[0]?.geometry?.coordinates;
  if (data.code !== "Ok" || !c || c.length < 2) return null;
  return c.map(([lng, lat]) => ({ lat, lng }));
}

const client = new pg.Client({ connectionString: process.env.DATABASE_URL, ssl: { rejectUnauthorized: false } });
await client.connect();

// Nutry identificada por nome
const { rows: nomeRows } = await client.query(`select id, nome from clientes where ativo = true`);
const nutry = nomeRows.find((r) => /nutry/i.test(r.nome));
if (!nutry) { console.log("cliente Nutry nao encontrado:", nomeRows); process.exit(1); }
console.log("cliente Nutry:", nutry.id);

const { rows: bases } = await client.query(
  `select nome, ST_X(ST_Centroid(geom::geometry)) as lng, ST_Y(ST_Centroid(geom::geometry)) as lat
   from bases where cliente_id = $1`, [nutry.id]
);
if (bases.length === 0) { console.log("sem base cadastrada pra Nutry"); process.exit(1); }
const base = { lat: bases[0].lat, lng: bases[0].lng };
console.log("base:", bases[0].nome, base);

// Veiculos da Nutry que completaram rota hoje (entregas feitas = total >= 5)
const { rows: veics } = await client.query(
  `select v.cv, v.placa, p.entregas_feitas, p.entregas_total
   from veiculos v join posicoes_atuais p on p.veiculo_id = v.id
   where v.cliente_id = $1 and p.entregas_total >= 5 and p.entregas_feitas = p.entregas_total
   order by p.entregas_total desc
   limit ${MAX_VEICULOS}`, [nutry.id]
);
console.log(`\nveiculos no backtest (${veics.length}):`, veics.map(v => `${v.placa}(${v.entregas_total} entregas)`).join(", "));
await client.end();

const dorme = (ms) => new Promise((r) => setTimeout(r, ms));

const resumo = [];
for (const v of veics) {
  // Alvos com ordem real de realizacao
  const resAlvos = await fetch(`${BASE_URL}/mapa_servicos/alvos`, {
    method: "POST",
    headers: { accept: "application/json", "content-type": "application/json" },
    body: JSON.stringify([String(v.cv)]),
  });
  const alvosData = await resAlvos.json();
  const alvos = (alvosData.alvos ?? [])
    .filter((a) => Number.isFinite(a.pontolatitude) && Number.isFinite(a.pontolongitude) && a.alvodatarealizado && !String(a.alvodatarealizado).startsWith("0001"))
    .sort((a, b) => String(a.alvodatarealizado).localeCompare(String(b.alvodatarealizado)));
  // dedup por pontocodigo consecutivo (varias NFs no mesmo endereco)
  const pontos = [];
  for (const a of alvos) {
    const p = { lat: a.pontolatitude, lng: a.pontolongitude };
    const ultimo = pontos[pontos.length - 1];
    if (!ultimo || haversineM(ultimo.lat, ultimo.lng, p.lat, p.lng) > 30) pontos.push(p);
  }
  if (pontos.length < 3) { console.log(`\n${v.placa}: so ${pontos.length} pontos realizados com coordenada, pulando`); continue; }

  const waypoints = [base, ...pontos, base];
  await dorme(THROTTLE_MS);
  const rota = await rotaOSRM(waypoints);
  if (!rota) { console.log(`\n${v.placa}: OSRM falhou pra rota do dia (${waypoints.length} waypoints), pulando`); continue; }

  // Rastro do dia (16h cobre desde ~6h BRT)
  const resRastro = await fetch(`${BASE_URL}/mapa_servicos/rastro/${v.cv}/16`, { headers: { accept: "application/json" } });
  const rastroData = await resRastro.json();
  const rastro = (rastroData.posicoes ?? [])
    .map((p) => ({ lat: Number(p.lat), lng: Number(p.long) }))
    .filter((p) => Number.isFinite(p.lat) && Number.isFinite(p.lng) && !(p.lat === 0 && p.lng === 0));
  if (rastro.length < 20) { console.log(`\n${v.placa}: rastro curto (${rastro.length} pontos), pulando`); continue; }

  const stats = { placa: v.placa, entregas: v.entregas_total, waypoints: waypoints.length, rastro: rastro.length };
  for (const buf of BUFFERS_M) {
    let fora = 0, maxRun = 0, run = 0, episodios = 0;
    for (const p of rastro) {
      const d = distMinAPolilinha(p, rota);
      if (d > buf) {
        fora++;
        run++;
        if (run === 1) episodios++;
        if (run > maxRun) maxRun = run;
      } else {
        run = 0;
      }
    }
    stats[`fora_${buf}m`] = fora;
    stats[`pct_${buf}m`] = ((fora / rastro.length) * 100).toFixed(1) + "%";
    stats[`episodios_${buf}m`] = episodios;
    stats[`maxRun_${buf}m`] = maxRun;
  }
  resumo.push(stats);
  console.log(`\n${v.placa} (${v.entregas_total} entregas, ${rastro.length} pontos de rastro, rota ${rota.length} vertices):`);
  console.log(`  300m: ${stats.fora_300m} fora (${stats.pct_300m}), ${stats.episodios_300m} episodios, maior sequencia ${stats.maxRun_300m}`);
  console.log(`  600m: ${stats.fora_600m} fora (${stats.pct_600m}), ${stats.episodios_600m} episodios, maior sequencia ${stats.maxRun_600m}`);
}

console.log("\n\n=== RESUMO GERAL ===");
console.table(resumo.map(({ placa, entregas, pct_300m, episodios_300m, maxRun_300m, pct_600m, episodios_600m, maxRun_600m }) =>
  ({ placa, entregas, pct_300m, episodios_300m, maxRun_300m, pct_600m, episodios_600m, maxRun_600m })));
