// scripts/corrigir-pontos-manual.mjs
//
// Grava correcoes manuais de posicao em pontos_aprendidos (fonte='manual').
// Uma vez gravada, o cron noturno (aprender_pontos_entrega) nunca mais
// sobrescreve essa linha -- ver migration 034 e
// docs/superpowers/specs/2026-08-10-correcao-manual-pontos-design.md.
//
// Uso: node scripts/corrigir-pontos-manual.mjs <arquivo.csv> [--dry-run]
// CSV precisa ter header: cliente_id,ponto_codigo,lat,lng,motivo
//
// --dry-run faz todo o parsing e validacao, imprime o que SERIA gravado,
// mas nao conecta no banco nem escreve nada -- use pra revisar a lista
// real de correcoes antes de rodar de verdade.
//
// Todas as linhas sao gravadas dentro de uma unica transacao: se
// qualquer linha falhar (ex: cliente_id que nao existe -- violacao de
// foreign key), a transacao inteira e desfeita e nada fica gravado
// parcialmente.
import pg from "pg";
import { readFileSync } from "node:fs";

const DATABASE_URL =
  process.env.DATABASE_URL ??
  "postgres://app_service:5cf0fd1c8cfc0dfdf66a19196d5e6ebc691bbc628d7e637c@localhost:5432/transmonseg";

const args = process.argv.slice(2);
const dryRun = args.includes("--dry-run");
const arquivo = args.find((a) => !a.startsWith("--"));
if (!arquivo) {
  console.error("Uso: node scripts/corrigir-pontos-manual.mjs <arquivo.csv> [--dry-run]");
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

function validarLinhas(linhas) {
  const validas = [];
  for (const l of linhas) {
    const { cliente_id, ponto_codigo, lat, lng, motivo } = l;
    if (!cliente_id || !ponto_codigo || !lat || !lng) {
      console.warn(`Pulando linha incompleta: ${JSON.stringify(l)}`);
      continue;
    }
    const pontoCodigoNum = Number(ponto_codigo);
    const latNum = Number(lat);
    const lngNum = Number(lng);
    if (!Number.isFinite(pontoCodigoNum) || !Number.isFinite(latNum) || !Number.isFinite(lngNum)) {
      console.warn(`Pulando linha com valor numérico inválido: ${JSON.stringify(l)}`);
      continue;
    }
    if (latNum < -90 || latNum > 90 || lngNum < -180 || lngNum > 180) {
      console.warn(`Pulando linha com coordenada fora de faixa válida: ${JSON.stringify(l)}`);
      continue;
    }
    if (!Number.isInteger(pontoCodigoNum)) {
      console.warn(`Pulando linha com ponto_codigo não-inteiro: ${JSON.stringify(l)}`);
      continue;
    }
    validas.push({ cliente_id, pontoCodigoNum, latNum, lngNum, motivo });
  }
  return validas;
}

const linhas = parseCsv(readFileSync(arquivo, "utf-8"));
const validas = validarLinhas(linhas);

if (dryRun) {
  console.log(`[dry-run] ${validas.length} correções seriam gravadas:\n`);
  for (const { cliente_id, pontoCodigoNum, latNum, lngNum, motivo } of validas) {
    console.log(
      `[dry-run] Gravaria: cliente=${cliente_id} ponto=${pontoCodigoNum} lat=${latNum} lng=${lngNum} (${motivo ?? "sem motivo"})`
    );
  }
  console.log(`\n[dry-run] ${validas.length} correções manuais seriam gravadas. Nenhuma escrita feita.`);
  process.exit(0);
}

const client = new pg.Client({ connectionString: DATABASE_URL });
await client.connect();

let gravados = 0;
try {
  await client.query("BEGIN");
  for (const { cliente_id, pontoCodigoNum, latNum, lngNum, motivo } of validas) {
    await client.query(
      `INSERT INTO pontos_aprendidos (cliente_id, ponto_codigo, lat, lng, raio_m, n_observacoes, primeira_observacao, ultima_observacao, fonte)
       VALUES ($1, $2, $3, $4, 30, 1, current_date, current_date, 'manual')
       ON CONFLICT (cliente_id, ponto_codigo) DO UPDATE SET
         lat = EXCLUDED.lat, lng = EXCLUDED.lng, fonte = 'manual',
         raio_m = 30, n_observacoes = 1,
         primeira_observacao = current_date, ultima_observacao = current_date,
         atualizado_em = now()`,
      [cliente_id, pontoCodigoNum, latNum, lngNum]
    );
    gravados++;
    console.log(`Gravado: cliente=${cliente_id} ponto=${pontoCodigoNum} (${motivo ?? "sem motivo"})`);
  }
  await client.query("COMMIT");
  console.log(`\n${gravados} correções manuais gravadas.`);
} catch (err) {
  await client.query("ROLLBACK");
  console.error(`\nErro na linha ${gravados + 1} -- transação desfeita, nada foi gravado: ${err.message}`);
  process.exitCode = 1;
} finally {
  await client.end();
}
