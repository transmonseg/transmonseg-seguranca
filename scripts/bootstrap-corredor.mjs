// Semeia o tapete (corredor_celulas) com o rastro de 96h de cada veiculo ativo
// da frota, uma unica vez apos aplicar a migration 010. Depois disso o motor
// acumula sozinho (1 upsert em batch por ciclo).
// Uso: node --env-file=.env.local scripts/bootstrap-corredor.mjs
import pg from "pg";

const BASE_URL = "https://datalayer.portalunitrac.com";
// Mesmo passo/limite da lib pura (src/lib/celulas.ts) — duplicado aqui de
// proposito: scripts deste repo sao .mjs simples, sem bundler pra TS.
const PASSO_M = 80;
const SEGMENTO_MAX_M = 2500;

function haversineM(aLat, aLng, bLat, bLng) {
  const R = 6_371_000;
  const toR = (d) => (d * Math.PI) / 180;
  const dLat = toR(bLat - aLat);
  const dLng = toR(bLng - aLng);
  const a = Math.sin(dLat / 2) ** 2 + Math.cos(toR(aLat)) * Math.cos(toR(bLat)) * Math.sin(dLng / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(a));
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

async function buscarRastro(cv, horas) {
  try {
    const res = await fetch(`${BASE_URL}/mapa_servicos/rastro/${cv}/${horas}`, {
      headers: { accept: "application/json" },
    });
    if (!res.ok) return [];
    const data = await res.json();
    const posicoes = data.posicoes ?? [];
    return posicoes
      .map((p) => ({ lat: Number(p.lat), lng: Number(p.long) }))
      .filter((p) => Number.isFinite(p.lat) && Number.isFinite(p.lng) && !(p.lat === 0 && p.lng === 0));
  } catch {
    return [];
  }
}

const conn = process.env.DATABASE_URL;
if (!conn) { console.error("DATABASE_URL ausente no .env.local"); process.exit(1); }

const pool = new pg.Pool({ connectionString: conn, ssl: { rejectUnauthorized: false } });

const client = await pool.connect();
try {
  const { rows: veiculos } = await client.query(
    `SELECT cv, cliente_id FROM veiculos WHERE ativo = true`
  );

  let totalCelulas = 0;
  for (const [i, v] of veiculos.entries()) {
    const pontos = await buscarRastro(v.cv, 96);
    const celulas = new Set();
    for (let j = 0; j < pontos.length; j++) {
      if (j === 0) {
        celulas.add(celulaDe(pontos[j].lat, pontos[j].lng));
      } else {
        for (const c of celulasDoSegmento(pontos[j - 1].lat, pontos[j - 1].lng, pontos[j].lat, pontos[j].lng)) {
          celulas.add(c);
        }
      }
    }
    if (celulas.size > 0) {
      const lista = [...celulas];
      await client.query(
        `INSERT INTO corredor_celulas (cliente_id, celula, ultimo_visto)
         SELECT $1::uuid, c, current_date FROM unnest($2::text[]) AS c
         ON CONFLICT (cliente_id, celula) DO UPDATE SET ultimo_visto = current_date`,
        [v.cliente_id, lista]
      );
      totalCelulas += celulas.size;
    }
    console.log(`[${i + 1}/${veiculos.length}] cv=${v.cv}: ${pontos.length} pontos, ${celulas.size} celulas`);
    await new Promise((r) => setTimeout(r, 300)); // educado com a API Unitrac
  }
  console.log(`Concluido: ~${totalCelulas} celulas semeadas em ${veiculos.length} veiculos.`);
} finally {
  client.release();
  await pool.end();
}
