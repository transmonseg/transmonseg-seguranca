import pg from "pg";
const c = new pg.Client({ connectionString: process.env.DATABASE_URL, ssl: { rejectUnauthorized: false } });
await c.connect();
const niv = await c.query("select nivel, count(*)::int n from posicoes_atuais group by nivel order by n desc");
console.log("níveis:", niv.rows.map(r => `${r.nivel}=${r.n}`).join(", "));
const ent = await c.query("select count(*)::int n from posicoes_atuais where entregas_total > 0");
console.log("veículos com entregas hoje:", ent.rows[0].n);
const loc = await c.query("select count(*)::int n from posicoes_atuais where local is not null and local <> 'Em deslocamento'");
console.log("veículos com endereço geocodado:", loc.rows[0].n);
console.log("\nexemplos (com entregas):");
const ex = await c.query(
  "select v.placa, p.nivel, p.entregas_feitas f, p.entregas_total t, p.local from posicoes_atuais p join veiculos v on v.id=p.veiculo_id where p.entregas_total>0 order by (p.entregas_total-p.entregas_feitas) desc limit 8"
);
for (const r of ex.rows) console.log(`  ${r.placa} [${r.nivel}] ${r.f}/${r.t} (faltam ${r.t - r.f}) | ${r.local ?? "-"}`);
await c.end();
