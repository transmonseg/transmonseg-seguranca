import pg from "pg";
const c = new pg.Client({ connectionString: process.env.DATABASE_URL, ssl: { rejectUnauthorized: false } });
await c.connect();
const { rows } = await c.query(
  `select cl.nome cliente, a.tipo, count(*)::int n
   from alertas a join clientes cl on cl.id=a.cliente_id
   where a.status='ativo' group by cl.nome, a.tipo order by cl.nome, n desc`
);
console.log("alertas ativos por cliente e tipo:");
for (const r of rows) console.log(`  ${r.cliente.padEnd(12)} ${r.tipo.padEnd(14)} ${r.n}`);
// consistência: vermelho por cliente vs alertas críticos
const { rows: niv } = await c.query(
  `select cl.nome, p.nivel, count(*)::int n from posicoes_atuais p
   join veiculos v on v.id=p.veiculo_id join clientes cl on cl.id=v.cliente_id
   where p.nivel in ('vermelho','amarelo') group by cl.nome, p.nivel order by cl.nome`
);
console.log("\nposições vermelho/amarelo por cliente:");
for (const r of niv) console.log(`  ${r.nome.padEnd(12)} ${r.nivel.padEnd(10)} ${r.n}`);
await c.end();
