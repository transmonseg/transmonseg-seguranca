// Backfill único de celula_frequencia_cliente a partir de posicoes_historico
// (90 dias já existentes) -- ver Task 4 do plano
// docs/superpowers/plans/2026-08-12-desvio-de-rota-v2.md. Rodar UMA VEZ,
// antes de ligar o Sinal B (rua rara) em produção (Task 6).
// Uso: node --env-file=.env.local scripts/backfill-celula-frequencia.mjs
import pg from "pg";

const conn = process.env.DATABASE_URL;
if (!conn) { console.error("DATABASE_URL ausente"); process.exit(1); }

const client = new pg.Client({ connectionString: conn, ssl: { rejectUnauthorized: false } });

try {
  await client.connect();
  console.log("conectado. agregando posicoes_historico por celula/cliente...");

  const { rowCount } = await client.query(`
    INSERT INTO celula_frequencia_cliente (cliente_id, celula, n_visitas, primeira_vez, ultima_vez)
    SELECT
      v.cliente_id,
      round(ph.lat * 1000)::text || ':' || round(ph.lng * 1000)::text AS celula,
      count(*)::int AS n_visitas,
      min(ph.criado_em)::date AS primeira_vez,
      max(ph.criado_em)::date AS ultima_vez
    FROM posicoes_historico ph
    JOIN veiculos v ON v.id = ph.veiculo_id
    WHERE ph.lat IS NOT NULL AND ph.lng IS NOT NULL
    GROUP BY v.cliente_id, celula
    ON CONFLICT (cliente_id, celula) DO UPDATE SET
      n_visitas = celula_frequencia_cliente.n_visitas + EXCLUDED.n_visitas,
      primeira_vez = LEAST(celula_frequencia_cliente.primeira_vez, EXCLUDED.primeira_vez),
      ultima_vez = GREATEST(celula_frequencia_cliente.ultima_vez, EXCLUDED.ultima_vez)
  `);

  console.log(`OK — ${rowCount} linhas de célula/cliente inseridas/atualizadas.`);
  const { rows } = await client.query(`SELECT count(*)::int AS n FROM celula_frequencia_cliente`);
  console.log("total de células conhecidas:", rows[0].n);
} catch (e) {
  console.error("ERRO:", e.message);
  process.exitCode = 1;
} finally {
  await client.end();
}
