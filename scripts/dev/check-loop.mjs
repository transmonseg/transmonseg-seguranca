import pg from "pg";
const c = new pg.Client({ connectionString: process.env.DATABASE_URL, ssl: { rejectUnauthorized: false } });
await c.connect();
const r = await c.query(
  "select extract(epoch from (now()-max(updated_at)))::int segundos from posicoes_atuais"
);
console.log("última atualização do banco há", r.rows[0].segundos, "segundos");
await c.end();
