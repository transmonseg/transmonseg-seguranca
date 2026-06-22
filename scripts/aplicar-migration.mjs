// Aplica uma migration SQL no Supabase via conexão Postgres direta.
// Uso: node --env-file=.env.local scripts/aplicar-migration.mjs 001_init.sql
// (Node+pg porque PowerShell corrompe UTF-8 em SQL acentuado.)
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";
import pg from "pg";

const arg = process.argv[2];
if (!arg) { console.error("informe o arquivo .sql (ex: 001_init.sql)"); process.exit(1); }

const dir = path.dirname(fileURLToPath(import.meta.url));
const sqlPath = path.join(dir, "migrations", arg);
const sql = readFileSync(sqlPath, "utf8");

const conn = process.env.DATABASE_URL;
if (!conn) { console.error("DATABASE_URL ausente no .env.local"); process.exit(1); }

const client = new pg.Client({ connectionString: conn, ssl: { rejectUnauthorized: false } });

try {
  await client.connect();
  console.log("conectado ao banco. aplicando", arg, "...");
  await client.query(sql);
  console.log("OK — migration aplicada.");
  const { rows } = await client.query(
    "select table_name from information_schema.tables where table_schema='public' order by table_name"
  );
  console.log("tabelas em public:", rows.map(r => r.table_name).join(", "));
} catch (e) {
  console.error("ERRO:", e.message);
  process.exitCode = 1;
} finally {
  await client.end();
}
