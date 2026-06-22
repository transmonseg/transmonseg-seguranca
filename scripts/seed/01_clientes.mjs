// Seed: insere clientes Nutry Max e Benassi, e a base "Penha Circular" da Nutry.
// Idempotente: clientes com on conflict do nothing; base checada por (nome, cliente_id).
// Uso: node --env-file=.env.local scripts/seed/01_clientes.mjs

import pg from "pg";

const conn = process.env.DATABASE_URL;
if (!conn) { console.error("DATABASE_URL ausente no .env.local"); process.exit(1); }

const client = new pg.Client({ connectionString: conn, ssl: { rejectUnauthorized: false } });

try {
  await client.connect();

  // --- Clientes ---
  await client.query(`
    INSERT INTO clientes (nome, cod_user_unitrac, empresa_cod_unitrac, ativo)
    VALUES
      ('Nutry Max', '4096', '722',  true),
      ('Benassi',   '4586', null,   true)
    ON CONFLICT (cod_user_unitrac) DO NOTHING
  `);

  // --- Base Nutry Max: Penha Circular ---
  const { rows: [nutry] } = await client.query(
    "SELECT id FROM clientes WHERE cod_user_unitrac = '4096'"
  );
  if (!nutry) throw new Error("cliente Nutry Max não encontrado após insert");

  const { rows: baseExist } = await client.query(
    "SELECT id FROM bases WHERE nome = $1 AND cliente_id = $2",
    ["Penha Circular", nutry.id]
  );

  if (baseExist.length === 0) {
    await client.query(`
      INSERT INTO bases (cliente_id, nome, geom, raio_m)
      VALUES (
        $1,
        'Penha Circular',
        ST_SetSRID(ST_MakePoint($2, $3), 4326)::geography,
        250
      )
    `, [nutry.id, -43.2779, -22.8151]);
    console.log("2 clientes ok, 1 base ok");
  } else {
    console.log("2 clientes ok, 1 base ok (já existia)");
  }

} catch (e) {
  console.error("ERRO:", e.message);
  process.exitCode = 1;
} finally {
  await client.end();
}
