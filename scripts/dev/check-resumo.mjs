import pg from "pg";
const c = new pg.Client({ connectionString: process.env.DATABASE_URL, ssl: { rejectUnauthorized: false } });
await c.connect();
const { rows: cli } = await c.query("select id from clientes where cod_user_unitrac='4586'");
const benId = cli[0].id;
const { rows: niveis } = await c.query(
  "select p.nivel, count(*)::int n from posicoes_atuais p join veiculos v on v.id=p.veiculo_id where v.cliente_id=$1 group by p.nivel order by n desc",
  [benId]
);
console.log("posições Benassi por nível:", niveis.map(r => `${r.nivel}=${r.n}`).join(", "));
const { rows: al } = await c.query(
  "select nivel, tipo, count(*)::int n from alertas where cliente_id=$1 and status='ativo' group by nivel, tipo",
  [benId]
);
console.log("alertas ativos Benassi:", al.map(r => `${r.nivel}/${r.tipo}=${r.n}`).join(", "));
// os jammers: o nivel da posição deles
const { rows: jam } = await c.query(
  `select v.placa, p.nivel, p.atraso_min from alertas a
   join veiculos v on v.id=a.veiculo_id join posicoes_atuais p on p.veiculo_id=a.veiculo_id
   where a.cliente_id=$1 and a.status='ativo' and a.tipo='jammer'`,
  [benId]
);
console.log("posição dos veículos com alerta jammer:", jam.map(r => `${r.placa} nivel=${r.nivel} atraso=${r.atraso_min}`).join(" | "));
await c.end();
