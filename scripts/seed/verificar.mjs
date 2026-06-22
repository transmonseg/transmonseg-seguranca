// Verificação do banco após seed
// Uso: node --env-file=.env.local scripts/seed/verificar.mjs
import pg from "pg";

const conn = process.env.DATABASE_URL;
if (!conn) { console.error("DATABASE_URL ausente no .env.local"); process.exit(1); }

const client = new pg.Client({ connectionString: conn, ssl: { rejectUnauthorized: false } });

try {
  await client.connect();

  const { rows: [cl] } = await client.query("SELECT count(*) FROM clientes");
  const { rows: [ba] } = await client.query("SELECT count(*) FROM bases");
  const { rows: veiculos } = await client.query(`
    SELECT c.nome, count(v.id) as total
    FROM clientes c
    LEFT JOIN veiculos v ON v.cliente_id = c.id
    GROUP BY c.nome ORDER BY c.nome
  `);
  const { rows: [fav] } = await client.query("SELECT count(*) FROM geofences WHERE tipo = 'favela'");

  console.log("=== VERIFICACAO DO BANCO ===");
  console.log("Clientes:", cl.count);
  console.log("Bases:", ba.count);
  console.log("Veiculos por cliente:");
  for (const r of veiculos) console.log(`  ${r.nome}: ${r.total}`);
  console.log("Geofences tipo favela:", fav.count);

} catch (e) {
  console.error("ERRO:", e.message);
  process.exitCode = 1;
} finally {
  await client.end();
}
