import pg from "pg";
const c = new pg.Client({ connectionString: process.env.DATABASE_URL, ssl: { rejectUnauthorized: false } });
await c.connect();

const { rows } = await c.query(`
  SELECT
    date_trunc('day', created_at AT TIME ZONE 'America/Sao_Paulo') as dia,
    nivel,
    count(*)::int n
  FROM alertas
  WHERE created_at > now() - interval '5 days'
  GROUP BY dia, nivel
  ORDER BY dia DESC, nivel
`);

console.log("Alertas por dia (horário Brasília):");
for (const r of rows) {
  const d = new Date(r.dia).toLocaleDateString("pt-BR");
  console.log(`  ${d}  ${r.nivel.padEnd(8)}  ${r.n}`);
}

const { rows: tipos } = await c.query(`
  SELECT
    date_trunc('day', created_at AT TIME ZONE 'America/Sao_Paulo') as dia,
    tipo,
    count(*)::int n
  FROM alertas
  WHERE created_at > now() - interval '5 days' AND nivel='critico'
  GROUP BY dia, tipo
  ORDER BY dia DESC, tipo
`);
console.log("\nCríticos por tipo por dia:");
for (const r of tipos) {
  const d = new Date(r.dia).toLocaleDateString("pt-BR");
  console.log(`  ${d}  ${r.tipo.padEnd(20)}  ${r.n}`);
}

// Queda drástica? Pegar volume por hora dos últimos 3 dias
const { rows: horas } = await c.query(`
  SELECT
    date_trunc('hour', created_at AT TIME ZONE 'America/Sao_Paulo') as hora,
    count(*)::int n
  FROM alertas
  WHERE created_at > now() - interval '3 days'
  GROUP BY hora
  ORDER BY hora DESC
  LIMIT 72
`);
console.log("\nVolume por hora (últimas 72h):");
let ultimaData = "";
for (const r of horas) {
  const h = new Date(r.hora);
  const d = h.toLocaleDateString("pt-BR");
  const hh = h.getHours().toString().padStart(2, "0");
  if (d !== ultimaData) { console.log(`  --- ${d} ---`); ultimaData = d; }
  const bar = "█".repeat(Math.min(r.n, 40));
  console.log(`  ${hh}h  ${bar} ${r.n}`);
}

await c.end();
