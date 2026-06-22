// Teste do orquestrador: valida o detector de favela colocando um veículo
// dentro da Rocinha temporariamente e conferindo a query batch. Restaura ao fim.
import pg from "pg";
const c = new pg.Client({ connectionString: process.env.DATABASE_URL, ssl: { rejectUnauthorized: false } });
await c.connect();

const { rows: [v] } = await c.query(
  "select p.veiculo_id, pl.placa, ST_AsText(p.geom) geomtxt, p.atraso_min from posicoes_atuais p join veiculos pl on pl.id=p.veiculo_id where p.geom is not null limit 1"
);
console.log("veículo de teste:", v.placa);

// força a posição dentro da Rocinha
await c.query(
  "update posicoes_atuais set geom=ST_SetSRID(ST_MakePoint(-43.245,-22.988),4326)::geography, atraso_min=0 where veiculo_id=$1",
  [v.veiculo_id]
);

// roda a MESMA query do detector do motor
const { rows } = await c.query(
  `select pl.placa, g.nome from posicoes_atuais p
   join veiculos pl on pl.id=p.veiculo_id
   join geofences g on g.tipo='favela' and ST_Intersects(g.geom, p.geom)
   where p.atraso_min<=60 and p.veiculo_id=$1`,
  [v.veiculo_id]
);
console.log("detector de favela:", rows.length ? `DETECTOU ${rows[0].placa} dentro de "${rows[0].nome}"` : "NÃO detectou (PROBLEMA)");

// restaura a posição original
await c.query(
  "update posicoes_atuais set geom=ST_GeomFromText($2,4326)::geography, atraso_min=$3 where veiculo_id=$1",
  [v.veiculo_id, v.geomtxt, v.atraso_min]
);
console.log("posição original restaurada");
await c.end();
