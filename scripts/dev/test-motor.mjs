// Teste do orquestrador: confere o que o motor gravou no banco.
import pg from "pg";
const c = new pg.Client({ connectionString: process.env.DATABASE_URL, ssl: { rejectUnauthorized: false } });
await c.connect();
const q = async (sql) => (await c.query(sql)).rows;

console.log("posicoes_atuais:", (await q("select count(*)::int n from posicoes_atuais"))[0].n);
console.log("níveis:", (await q("select nivel, count(*)::int n from posicoes_atuais group by nivel order by n desc")).map(r => `${r.nivel}=${r.n}`).join(", "));
console.log("com parado_desde:", (await q("select count(*)::int n from posicoes_atuais where parado_desde is not null"))[0].n);
console.log("com geom:", (await q("select count(*)::int n from posicoes_atuais where geom is not null"))[0].n);
console.log("alertas (status/tipo):", (await q("select status, tipo, count(*)::int n from alertas group by status, tipo order by n desc")).map(r => `${r.status}/${r.tipo}=${r.n}`).join(", "));

console.log("\nalertas ativos:");
for (const a of await q("select v.placa, c.nome cliente, a.nivel, a.tipo, a.motivo from alertas a join veiculos v on v.id=a.veiculo_id join clientes c on c.id=a.cliente_id where a.status='ativo' limit 10")) {
  console.log(`  ${a.placa} (${a.cliente}) [${a.nivel}/${a.tipo}] ${a.motivo}`);
}
await c.end();
