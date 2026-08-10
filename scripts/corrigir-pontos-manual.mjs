// scripts/corrigir-pontos-manual.mjs
//
// Grava correcoes manuais de posicao em pontos_aprendidos (fonte='manual').
// Uma vez gravada, o cron noturno (aprender_pontos_entrega) nunca mais
// sobrescreve essa linha -- ver migration 034 e
// docs/superpowers/specs/2026-08-10-correcao-manual-pontos-design.md.
//
// Uso: node scripts/corrigir-pontos-manual.mjs <arquivo.csv>
// CSV precisa ter header: cliente_id,ponto_codigo,lat,lng,motivo
import pg from "pg";
import { readFileSync } from "node:fs";

const DATABASE_URL =
  process.env.DATABASE_URL ??
  "postgres://app_service:5cf0fd1c8cfc0dfdf66a19196d5e6ebc691bbc628d7e637c@localhost:5432/transmonseg";

const arquivo = process.argv[2];
if (!arquivo) {
  console.error("Uso: node scripts/corrigir-pontos-manual.mjs <arquivo.csv>");
  process.exit(1);
}

function parseCsv(texto) {
  const linhas = texto.trim().split("\n");
  const header = linhas[0].split(",");
  return linhas.slice(1).map((l) => {
    const valores = l.split(",");
    return Object.fromEntries(header.map((h, i) => [h.trim(), valores[i]?.trim()]));
  });
}

const linhas = parseCsv(readFileSync(arquivo, "utf-8"));
const client = new pg.Client({ connectionString: DATABASE_URL });
await client.connect();

let gravados = 0;
for (const l of linhas) {
  const { cliente_id, ponto_codigo, lat, lng, motivo } = l;
  if (!cliente_id || !ponto_codigo || !lat || !lng) {
    console.warn(`Pulando linha incompleta: ${JSON.stringify(l)}`);
    continue;
  }
  await client.query(
    `INSERT INTO pontos_aprendidos (cliente_id, ponto_codigo, lat, lng, raio_m, n_observacoes, primeira_observacao, ultima_observacao, fonte)
     VALUES ($1, $2, $3, $4, 30, 1, current_date, current_date, 'manual')
     ON CONFLICT (cliente_id, ponto_codigo) DO UPDATE SET
       lat = EXCLUDED.lat, lng = EXCLUDED.lng, fonte = 'manual', atualizado_em = now()`,
    [cliente_id, Number(ponto_codigo), Number(lat), Number(lng)]
  );
  gravados++;
  console.log(`Gravado: cliente=${cliente_id} ponto=${ponto_codigo} (${motivo ?? "sem motivo"})`);
}

await client.end();
console.log(`\n${gravados} correções manuais gravadas.`);
