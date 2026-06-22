// Seed: busca veículos do Unitrac para Nutry Max (4096) e Benassi (4586) e insere no banco.
// Idempotente: on conflict (cliente_id, cv) do nothing.
// Uso: node --env-file=.env.local scripts/seed/02_veiculos.mjs

import pg from "pg";

const conn = process.env.DATABASE_URL;
if (!conn) { console.error("DATABASE_URL ausente no .env.local"); process.exit(1); }

const CLIENTES_COD = ["4096", "4586"];

async function buscarVeiculos(cod) {
  const url = `https://datalayer.portalunitrac.com/veiculos/masn/${cod}`;
  const res = await fetch(url, { headers: { accept: "application/json" } });
  if (!res.ok) throw new Error(`Unitrac retornou ${res.status} para cod ${cod}`);
  const data = await res.json();
  if (!Array.isArray(data.veiculos)) throw new Error(`Campo 'veiculos' ausente para cod ${cod}`);
  return data.veiculos;
}

const client = new pg.Client({ connectionString: conn, ssl: { rejectUnauthorized: false } });

try {
  await client.connect();

  for (const cod of CLIENTES_COD) {
    // Busca cliente no banco
    const { rows } = await client.query(
      "SELECT id, nome FROM clientes WHERE cod_user_unitrac = $1",
      [cod]
    );
    if (rows.length === 0) {
      throw new Error(`Cliente cod_user_unitrac=${cod} não encontrado. Rode 01_clientes.mjs primeiro.`);
    }
    const { id: clienteId, nome: clienteNome } = rows[0];

    // Busca veículos na API Unitrac
    console.log(`Buscando veículos do Unitrac para ${clienteNome} (cod=${cod})...`);
    const veiculos = await buscarVeiculos(cod);
    console.log(`  API retornou ${veiculos.length} veículos`);

    // Insere em lote (um por um com on conflict do nothing)
    let inseridos = 0;
    for (const v of veiculos) {
      const cv    = String(v.cv ?? "").trim();
      const placa = String(v.placa ?? "").trim() || null;
      const grupo = String(v.gvn ?? "").trim() || null;

      if (!cv) continue; // pula veículos sem cv

      const res = await client.query(`
        INSERT INTO veiculos (cliente_id, cv, placa, grupo, perfil, ativo)
        VALUES ($1, $2, $3, $4, 'auto', true)
        ON CONFLICT (cliente_id, cv) DO NOTHING
        RETURNING id
      `, [clienteId, cv, placa, grupo]);

      if (res.rows.length > 0) inseridos++;
    }

    console.log(`  ${inseridos} novos veículos inseridos para ${clienteNome} (${veiculos.length} total na API)`);
  }

} catch (e) {
  console.error("ERRO:", e.message);
  process.exitCode = 1;
} finally {
  await client.end();
}
