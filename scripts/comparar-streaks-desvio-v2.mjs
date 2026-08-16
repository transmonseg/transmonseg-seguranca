// Investigacao pontual (16/08): simular-dia-desvio-v2.mjs contra sexta
// 14/08 com os 3 parametros revertidos (streak=1, teto=300km,
// nivel=critico) deu 14082 disparos brutos/dia (228/347 veiculos) --
// ~40x o pior dia ja documentado neste projeto. Hipotese: streak=1 foi
// validado em 11/07 contra LINHA RETA (haversine, sinal suave); hoje o
// motor usa distancia REAL de rua via OSRM (sinal ruidoso, ja documentado
// em 12/08 -- alcas de acesso fazem a distancia aumentar por 1-2 leituras
// mesmo indo certo). Os dois nunca foram testados juntos. Este script busca
// as distancias reais UMA VEZ por ciclo e testa streak=1/2/3 em paralelo no
// mesmo passe (sem rechamar OSRM 3x), teto e nivel fixos.
//
// Uso: npx tsx --env-file=.env.production scripts/comparar-streaks-desvio-v2.mjs YYYY-MM-DD
import pg from "pg";
import { avaliarAfastandoDeTudo } from "../src/lib/desvio.ts";
import { buscarDistanciasReais } from "../src/lib/distancia-real.ts";

const conn = process.env.DATABASE_URL;
if (!conn) { console.error("DATABASE_URL ausente"); process.exit(1); }
const client = new pg.Client({ connectionString: conn, ssl: { rejectUnauthorized: false } });
await client.connect();

const diaAlvo = process.argv[2];
if (!diaAlvo) { console.error("Uso: comparar-streaks-desvio-v2.mjs YYYY-MM-DD"); process.exit(1); }
const { rows: janelaRows } = await client.query(
  `SELECT (($1::text || ' 00:00:00')::timestamp AT TIME ZONE 'America/Sao_Paulo') AS inicio,
          (($1::text || ' 00:00:00')::timestamp AT TIME ZONE 'America/Sao_Paulo' + interval '1 day') AS fim`,
  [diaAlvo]
);
const inicioUTC = janelaRows[0].inicio;
const fimUTC = janelaRows[0].fim;
console.log(`Comparando streaks pro dia ${diaAlvo} (SP).`);

const { rows: veiculos } = await client.query(
  `SELECT DISTINCT ph.veiculo_id, v.placa
     FROM posicoes_historico ph
     JOIN veiculos v ON v.id = ph.veiculo_id
    WHERE ph.criado_em >= $1 AND ph.criado_em < $2`,
  [inicioUTC, fimUTC]
);
console.log(`Veículos: ${veiculos.length}`);

const LIMIARES = [1, 2, 3];
// eventosPorLimiar[limiar] = array de {veiculo_id, criado_em}
const eventosPorLimiar = new Map(LIMIARES.map((l) => [l, []]));
let totalCiclosAvaliados = 0;
let veiculosProcessados = 0;
const inicioExec = Date.now();

async function processarVeiculo({ veiculo_id, placa }) {
  const { rows: posicoes } = await client.query(
    `SELECT lat, lng, criado_em FROM posicoes_historico
      WHERE veiculo_id = $1 AND criado_em >= $2 AND criado_em < $3 ORDER BY criado_em ASC`,
    [veiculo_id, inicioUTC, fimUTC]
  );
  const { rows: snapshots } = await client.query(
    `SELECT criado_em, pendentes FROM pendentes_snapshot_log
      WHERE veiculo_id = $1 AND criado_em < $2 ORDER BY criado_em ASC`,
    [veiculo_id, fimUTC]
  );

  // Um streak independente por limiar testado (o reset-ao-disparar depende
  // do proprio limiar, entao precisam rodar em paralelo, nao dá pra
  // derivar um do outro).
  const streaks = new Map(LIMIARES.map((l) => [l, 0]));
  let anterior = null;
  let snapIdx = 0;
  let distAnteriores = null;

  for (const pos of posicoes) {
    while (snapIdx + 1 < snapshots.length && snapshots[snapIdx + 1].criado_em <= pos.criado_em) snapIdx++;
    const pendentesAgora = (snapshots[snapIdx]?.pendentes ?? []).filter((p) => p.lat != null && p.lng != null);

    if (pendentesAgora.length === 0 || !anterior) {
      anterior = pos;
      distAnteriores = null;
      for (const l of LIMIARES) streaks.set(l, 0);
      continue;
    }

    const destinos = pendentesAgora.map((p) => ({ lat: p.lat, lng: p.lng }));
    const distAtuais = await buscarDistanciasReais({ lat: pos.lat, lng: pos.lng }, destinos);
    totalCiclosAvaliados++;

    if (!distAtuais || !distAnteriores || distAtuais.length !== distAnteriores.length) {
      distAnteriores = distAtuais;
      anterior = pos;
      continue;
    }

    for (const limiar of LIMIARES) {
      // avaliarAfastandoDeTudo usa a constante do modulo (LIMIAR_STREAK_AFASTANDO)
      // pra decidir "disparou" -- aqui simulamos manualmente o streak/decaimento
      // (mesma logica da funcao) e comparamos streak contra CADA limiar.
      const r = avaliarAfastandoDeTudo(distAtuais, distAnteriores, streaks.get(limiar), { limiarTransitoLongoM: 300_000 });
      const disparou = r.streak >= limiar;
      streaks.set(limiar, disparou ? 0 : r.streak);
      if (disparou) eventosPorLimiar.get(limiar).push({ veiculo_id, placa, criado_em: pos.criado_em.toISOString() });
    }

    distAnteriores = distAtuais;
    anterior = pos;
  }

  veiculosProcessados++;
  if (veiculosProcessados % 10 === 0 || veiculosProcessados === veiculos.length) {
    const decorridoMin = ((Date.now() - inicioExec) / 60000).toFixed(1);
    console.log(`[progresso] ${veiculosProcessados}/${veiculos.length} veículos | ${totalCiclosAvaliados} ciclos | ${decorridoMin}min`);
  }
}

const CONCORRENCIA = 16;
let cursor = 0;
async function worker() {
  while (cursor < veiculos.length) {
    const v = veiculos[cursor++];
    await processarVeiculo(v);
  }
}
await Promise.all(Array.from({ length: CONCORRENCIA }, () => worker()));

console.log(`\nCiclos avaliados: ${totalCiclosAvaliados}\n`);
for (const limiar of LIMIARES) {
  const eventos = eventosPorLimiar.get(limiar);
  const veiculosAfetados = new Set(eventos.map((e) => e.veiculo_id)).size;
  console.log(`LIMIAR_STREAK_AFASTANDO=${limiar}: ${eventos.length} disparos brutos | ${veiculosAfetados}/${veiculos.length} veículos afetados`);
}

await client.end();
