import pg from "pg";
import fs from "fs";
const conn = fs.readFileSync(".env.local", "utf8").match(/DATABASE_URL=(.+)/)[1].trim();
const c = new pg.Client({ connectionString: conn, ssl: { rejectUnauthorized: false } });
await c.connect();
for (const [nome, cod] of [["Nutry", "4096"], ["Benassi", "4586"]]) {
  const r = await c.query(
    `select
       count(*) filter (where p.velocidade = 0) as parados,
       count(*) filter (where p.velocidade = 0 and exists (
         select 1 from bases b where b.cliente_id = v.cliente_id and ST_Intersects(b.geom, p.geom)
       )) as parados_na_base,
       count(*) filter (where p.local like 'Base%') as marcados_base
     from posicoes_atuais p
     join veiculos v on v.id = p.veiculo_id
     join clientes c on c.id = v.cliente_id
     where c.cod_user_unitrac = $1 and p.atraso_min <= 720`,
    [cod]
  );
  const x = r.rows[0];
  console.log(`${nome}: parados=${x.parados} | dentro do perímetro=${x.parados_na_base} | rotulados "Base"=${x.marcados_base}`);
}
await c.end();
