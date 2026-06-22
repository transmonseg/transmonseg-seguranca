// Seed: cliente Nutry Max + base Penha Circular
// Uso: node --env-file=.env.local scripts/seed/01_nutry.mjs
import pg from "pg";

const conn = process.env.DATABASE_URL;
if (!conn) { console.error("DATABASE_URL ausente no .env.local"); process.exit(1); }

const client = new pg.Client({ connectionString: conn, ssl: { rejectUnauthorized: false } });

try {
  await client.connect();

  // 1. Insere cliente (idempotente via on conflict)
  const resCliente = await client.query(`
    INSERT INTO clientes (nome, cod_user_unitrac, empresa_cod_unitrac, ativo)
    VALUES ($1, $2, $3, true)
    ON CONFLICT (cod_user_unitrac) DO NOTHING
    RETURNING id
  `, ["Nutry Max", "4096", "722"]);

  // Busca o id (pode ter sido inserido agora ou já existir)
  const { rows: clienteRows } = await client.query(
    "SELECT id FROM clientes WHERE cod_user_unitrac = $1",
    ["4096"]
  );
  const clienteId = clienteRows[0].id;

  // 2. Insere base "Penha Circular" se ainda não existe
  const lat = -22.8151;
  const lng = -43.2779;

  const { rows: baseExiste } = await client.query(
    "SELECT id FROM bases WHERE nome = $1 AND cliente_id = $2",
    ["Penha Circular", clienteId]
  );

  if (baseExiste.length === 0) {
    await client.query(`
      INSERT INTO bases (cliente_id, nome, geom, raio_m)
      VALUES ($1, $2, ST_SetSRID(ST_MakePoint($3, $4), 4326)::geography, $5)
    `, [clienteId, "Penha Circular", lng, lat, 250]);
  }

  console.log("cliente ok, base ok");
} catch (e) {
  console.error("ERRO:", e.message);
  process.exitCode = 1;
} finally {
  await client.end();
}
