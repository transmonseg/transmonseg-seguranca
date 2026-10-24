// Seed: busca veículos do Unitrac para Nutry Max (4096) e Benassi (4586) e insere no banco.
// F2-15: ativo que não veio na API é marcado (sumiu_da_api_em) e tem a posição envelhecida.
// Idempotente: on conflict (cliente_id, cv) do nothing.
// Uso: node --env-file=.env.local scripts/seed/02_veiculos.mjs

import pg from "pg";
import { sincronizarVeiculo } from "./veiculos-sync.mjs";
import { tratarAusentesDaApi } from "./veiculos-ausentes.mjs";

const conn = process.env.DATABASE_URL;
if (!conn) { console.error("DATABASE_URL ausente no .env.local"); process.exit(1); }

const CLIENTES_COD = ["4096", "4586"];
const erros = [];

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

    // Um veiculo com problema NAO derruba a sincronizacao dos outros (09/10: um
    // conflito de placa abortava tudo em silencio, por horas). Erros viram ALERTA.
    let inseridos = 0;
    let atualizados = 0;
    for (const v of veiculos) {
      const cv    = String(v.cv ?? "").trim();
      const placa = String(v.placa ?? "").trim() || null;
      const grupo = String(v.gvn ?? "").trim() || null;

      if (!cv) continue; // pula veículos sem cv

      // Achado real 20/08: mesmo cv com placa nova (Mercosul) tem que atualizar a
      // placa local; grupo/perfil/ativo podem ter ajuste manual, nunca sobrescrever.
      try {
        const acao = await sincronizarVeiculo(client, { clienteId, cv, placa, grupo });
        if (acao === "inserido") inseridos++;
        else if (acao.startsWith("atualizado")) { atualizados++; console.log(`  cv ${cv}: placa -> ${placa}${acao === "atualizado_renomeando_inativo" ? " (cadastro inativo que segurava o nome foi renomeado)" : ""}`); }
      } catch (e) {
        erros.push(`${clienteNome} cv ${cv} (${placa}): ${e.message}`);
      }
    }

    console.log(`  ${inseridos} novos veículos inseridos, ${atualizados} placas atualizadas para ${clienteNome} (${veiculos.length} total na API)`);

    // F2-15 (MON-12): ativo que saiu da API fica marcado e com a posição
    // envelhecida (antes ficava "fresco" para sempre: TTT-1E20 verde desde 13/10).
    try {
      const cvsApi = new Set(veiculos.map((v) => String(v.cv ?? "").trim()).filter(Boolean));
      const r = await tratarAusentesDaApi(client, { clienteId, cvsApi });
      if (r.suspeita) console.warn(`  AVISO ${clienteNome}: ${r.suspeita} -- nenhum veículo marcado como fora da API`);
      else if (r.ausentes.length > 0) console.log(`  ${r.ausentes.length} ativo(s) fora da API: ${r.ausentes.join(", ")} (${r.envelhecidos} posição(ões) envelhecida(s)${r.marcado ? "" : "; migration 090 ainda não aplicada, sem marca"})`);
    } catch (e) {
      erros.push(`${clienteNome}: veículos fora da API não tratados: ${e.message}`);
    }
  }

} catch (e) {
  console.error("ERRO:", e.message);
  process.exitCode = 1;
} finally {
  await client.end();
}
if (erros.length > 0) {
  for (const e of erros) console.error(`ALERTA: ${e}`);
  process.exitCode = 1;
}
