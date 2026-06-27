// Adiciona coluna fora_corredor a posicoes_atuais para debounce de desvio de rota.
// Uso: node scripts/migration-fora-corredor.mjs
import pg from "pg";
import { readFileSync } from "fs";

// Ler .env.local manualmente
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
      ADD COLUMN IF NOT EXISTS fora_corredor boolean NOT NULL DEFAULT false
  `);
  console.log("OK: coluna fora_corredor adicionada (ou ja existia)");
} finally {
  client.release();
  await pool.end();
}
