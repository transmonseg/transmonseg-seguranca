// F1-05 (ING-01, MON-02): backfill das entregas que ficaram no carro da
// escala depois de trocas JA CONFIRMADAS pela operacao no KPI
// (kpi_troca_placa), porque a rota trocar-veiculo antiga nao casava a placa
// sem hifen ("RQO5E38") com a gravada ("RQO-5E38") e respondia ok com 0.
//
// A SECO por padrao: so' le e lista linha a linha o que mudaria. So' escreve
// com --aplicar, e isso exige OK do dono (plano F1-05, "Backfill das 23
// orfas com troca confirmada, com OK"). Aplicar usa exatamente a mesma
// funcao da rota (executarTrocaVeiculo: transacao, colisao, fecha desvio
// ativo do dia do carro antigo).
//
// Uso (no Contabo, com o .env.production do monitoramento):
//   npx tsx --env-file=.env.production scripts/backfill-trocas-orfas.mjs            # a seco
//   npx tsx --env-file=.env.production scripts/backfill-trocas-orfas.mjs --aplicar  # SO' COM OK
import pg from "pg";
import { compactarPlaca, placasOrigemCompactas, executarTrocaVeiculo } from "../src/lib/troca-veiculo.ts";

// Trocas confirmadas em kpi_troca_placa (banco kpi_transmonseg) cuja placa de
// origem ainda tinha linhas sem veiculo no monitoramento em 23/10 22h.
// carga = a carga confirmada; o script so' move linhas dessa carga.
const TROCAS_CONFIRMADAS = [
  { idKpi: 48, data: "2026-10-15", carga: "PAO-9", de: "RQO5E38", para: "TOS5E38" },
  { idKpi: 53, data: "2026-10-21", carga: "PAO-7", de: "RQO5E38", para: "TOS5E38" },
  { idKpi: 55, data: "2026-10-22", carga: "PAO-9", de: "RQO5E38", para: "TOS5E38" },
  { idKpi: 57, data: "2026-10-23", carga: "PAO-7", de: "RQO5E38", para: "TOS5E38" },
  // 21/10 via "Placas do dia" (id 51, sem carga) e pelo Ao vivo (id 52, carga 100564).
  { idKpi: 52, data: "2026-10-21", carga: "100564", de: "LLD4202", para: "TUI0H19" },
];

const aplicar = process.argv.includes("--aplicar");
const conn = process.env.DATABASE_URL;
if (!conn) { console.error("DATABASE_URL ausente"); process.exit(1); }
const client = new pg.Client({ connectionString: conn, ssl: { rejectUnauthorized: false } });
await client.connect();

try {
  const { rows: frota } = await client.query("SELECT id, placa FROM veiculos");
  const cadastroCompacto = new Set(frota.map((v) => compactarPlaca(v.placa)));
  let totalLinhas = 0;
  for (const t of TROCAS_CONFIRMADAS) {
    const para = frota.find((v) => compactarPlaca(v.placa) === compactarPlaca(t.para));
    if (!para) { console.log(`[${t.data}] ${t.de} -> ${t.para}: destino fora do cadastro, pulado`); continue; }
    const origens = placasOrigemCompactas(t.de, cadastroCompacto, compactarPlaca(para.placa));
    const { rows } = await client.query(
      `SELECT id, nf, placa, veiculo_id, origem, carga_destino_codigo, modo_teste
         FROM romaneio_pontos
        WHERE romaneio_data = $1::date
          AND regexp_replace(upper(placa), '[^A-Z0-9]', '', 'g') = ANY($2::text[])
        ORDER BY nf`,
      [t.data, origens],
    );
    // Linhas da carga confirmada. O pao grava carga_destino_codigo nulo
    // (formato tabular), entao linha sem carga conta como da carga quando
    // NENHUMA linha do dia daquela placa tem carga diferente.
    const cargasDistintas = new Set(rows.map((r) => r.carga_destino_codigo).filter(Boolean));
    const daCarga = rows.filter((r) => r.carga_destino_codigo === t.carga
      || (r.carga_destino_codigo == null && (cargasDistintas.size === 0 || (cargasDistintas.size === 1 && cargasDistintas.has(t.carga)))));
    const foraDaCarga = rows.length - daCarga.length;
    const { rows: noDestino } = await client.query(
      `SELECT nf FROM romaneio_pontos WHERE romaneio_data = $1::date AND placa = $2 AND nf = ANY($3::text[])`,
      [t.data, para.placa, daCarga.map((r) => r.nf)],
    );
    console.log(`\n[${t.data}] kpi_troca_placa #${t.idKpi} ${t.de} -> ${para.placa} (carga ${t.carga}): ${daCarga.length} linha(s) mudariam` +
      `${foraDaCarga ? `, ${foraDaCarga} de outra carga ficam` : ""}${noDestino.length ? `, ${noDestino.length} NF(s) ja no destino (linha velha sai)` : ""}`);
    for (const r of daCarga) console.log(`   nf=${r.nf} placa=${r.placa} veiculo_id=${r.veiculo_id ?? "-"} origem=${r.origem} modo_teste=${r.modo_teste}`);
    totalLinhas += daCarga.length;
    if (aplicar && daCarga.length > 0) {
      const res = await executarTrocaVeiculo(client, { data: t.data, origens, nfs: daCarga.map((r) => r.nf), para: { id: para.id, placa: para.placa } });
      console.log(`   APLICADO: ${JSON.stringify(res)}`);
    }
  }
  console.log(`\nTotal: ${totalLinhas} linha(s) ${aplicar ? "trocadas" : "mudariam (a seco, nada gravado)"}.`);
} finally {
  await client.end();
}
