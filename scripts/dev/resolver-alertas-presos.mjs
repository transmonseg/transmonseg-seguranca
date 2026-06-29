// Resolve alertas de rotina presos em veículos sem comunicação (ignição off, >120min)
import pg from "pg";
const c = new pg.Client({ connectionString: process.env.DATABASE_URL, ssl: { rejectUnauthorized: false } });
await c.connect();

const { rows: antes } = await c.query(
  "SELECT tipo, count(*)::int n FROM alertas WHERE status='ativo' GROUP BY tipo ORDER BY n DESC"
);
console.log("Alertas ativos agora:");
for (const r of antes) console.log("  " + r.tipo.padEnd(22) + r.n);

const { rowCount } = await c.query(`
  UPDATE alertas a
  SET status = 'resolvido', resolvido_em = now()
  FROM posicoes_atuais p
  WHERE a.veiculo_id = p.veiculo_id
    AND a.status = 'ativo'
    AND a.tipo NOT IN ('favela', 'jammer', 'panico')
    AND p.atraso_min > 120
    AND p.ignicao = false
`);
console.log(`\nAlertas resolvidos: ${rowCount}`);

const { rows: depois } = await c.query(
  "SELECT tipo, count(*)::int n FROM alertas WHERE status='ativo' GROUP BY tipo ORDER BY n DESC"
);
console.log("\nAlertas ativos restantes:");
for (const r of depois) console.log("  " + r.tipo.padEnd(22) + r.n);

await c.end();
