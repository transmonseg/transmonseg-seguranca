// Diagnóstico: por que o detector de desvio parou em 27/06
import pg from "pg";
const c = new pg.Client({ connectionString: process.env.DATABASE_URL, ssl: { rejectUnauthorized: false } });
await c.connect();

// 1. Estado atual de veículos em desvio na posicoes_atuais
const { rows: emDesvio } = await c.query(`
  SELECT v.placa, v.cv, p.dist_alvo_m, p.dist_alvo_anterior_m,
         p.lat, p.lng, p.velocidade, p.ignicao, p.entregas_total, p.entregas_feitas,
         p.nivel, p.parado_desde
  FROM posicoes_atuais p
  JOIN veiculos v ON v.id = p.veiculo_id
  WHERE p.entregas_total > 0 AND p.entregas_feitas < p.entregas_total
    AND p.ignicao = true
    AND p.atraso_min < 60
  ORDER BY p.dist_alvo_m DESC NULLS LAST
  LIMIT 20
`);
console.log("=== VEÍCULOS EM OPERAÇÃO COM ENTREGAS PENDENTES ===");
console.log(`Total: ${emDesvio.length} veículos`);
for (const r of emDesvio) {
  const dist = r.dist_alvo_m ? `${Math.round(r.dist_alvo_m)}m` : "null";
  const distAnt = r.dist_alvo_anterior_m ? `${Math.round(r.dist_alvo_anterior_m)}m` : "null";
  const cresc = (r.dist_alvo_m && r.dist_alvo_anterior_m)
    ? (r.dist_alvo_m - r.dist_alvo_anterior_m > 200 ? " AFASTANDO" : " ok")
    : " (sem historico)";
  console.log(`  ${r.placa}  dist=${dist}  ant=${distAnt}${cresc}  v=${r.velocidade}  nivel=${r.nivel}`);
}

// 2. Colunas de posicoes_atuais para ver o que existe
const { rows: cols } = await c.query(`
  SELECT column_name, data_type
  FROM information_schema.columns
  WHERE table_name = 'posicoes_atuais'
  ORDER BY ordinal_position
`);
console.log("\n=== COLUNAS posicoes_atuais ===");
for (const r of cols) console.log(`  ${r.column_name}: ${r.data_type}`);

// 3. Alertas de desvio mais recentes (antes de sumirem)
const { rows: ultDesvios } = await c.query(`
  SELECT a.desde, v.placa, a.motivo, a.score, a.nivel
  FROM alertas a
  JOIN veiculos v ON v.id = a.veiculo_id
  WHERE a.tipo = 'desvio'
  ORDER BY a.created_at DESC
  LIMIT 10
`);
console.log("\n=== ÚLTIMOS ALERTAS DE DESVIO ===");
if (ultDesvios.length === 0) {
  console.log("(nenhum encontrado)");
} else {
  for (const r of ultDesvios) {
    console.log(`  ${r.placa}  ${r.desde}  score=${r.score}  ${r.motivo?.slice(0, 60)}`);
  }
}

// 4. Quantos veículos têm dist_alvo_m nulo vs preenchido
const { rows: [stats] } = await c.query(`
  SELECT
    count(*) total,
    count(dist_alvo_m) com_dist,
    count(dist_alvo_anterior_m) com_dist_ant,
    avg(dist_alvo_m)::int dist_media,
    count(*) FILTER (WHERE dist_alvo_m > 2500 AND dist_alvo_m < 25000) candidatos_desvio
  FROM posicoes_atuais p
  JOIN veiculos v ON v.id = p.veiculo_id
  WHERE v.ativo = true
`);
console.log("\n=== ESTATÍSTICAS dist_alvo_m ===");
console.log(stats);

await c.end();
