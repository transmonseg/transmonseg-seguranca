// Adiciona coluna rumo (heading em graus, 0=Norte) a posicoes_atuais.
// Uso: node scripts/migration-rumo.mjs
import pg from "pg";
import { readFileSync } from "fs";

try {
  const env = readFileSync(".env.local", "utf8");
  for (const line of env.split("\n")) {
    const m = line.match(/^([A-Z_][A-Z0-9_]*)=(.*)$/);
    if (m) process.env[m[1]] = m[2].replace(/^["']|["']$/g, "");
  }
} catch { /* sem .env.local */ }

const pool = new pg.Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: { rejectUnauthorized: false },
});

const client = await pool.connect();
try {
  await client.query(`
    ALTER TABLE posicoes_atuais
      ADD COLUMN IF NOT EXISTS rumo smallint
  `);
  console.log("OK: coluna rumo adicionada (ou ja existia)");
} finally {
  client.release();
  await pool.end();
}
