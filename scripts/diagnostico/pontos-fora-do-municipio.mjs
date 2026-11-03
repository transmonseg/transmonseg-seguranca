// G3 do plano de correcao 03/11 (GEO3-02/03/04/11): lista as linhas JA
// gravadas com o ponto fora do municipio do endereco. SO' LEITURA -- a sessao
// abre com default_transaction_read_only=on; apagar ou corrigir e' escrita e
// fica para o OK do dono, com backup.
//
// O que entra no CSV:
//   - romaneio_geocode_cache, enderecos: ponto em OUTRO municipio do RJ, ou
//     fora da malha a mais de 2 km do municipio esperado (folga de praia/ilha,
//     a mesma da guarda em src/lib/territorio.ts);
//   - romaneio_geocode_cache, referencias CIDADE:/BAIRRO:: cidade em outro
//     municipio; bairro fora do proprio municipio (qualquer distancia);
//   - romaneio_pontos dos dias abertos (romaneio_data >= --desde, padrao hoje
//     em Brasilia), mesmas regras dos enderecos.
//
// O CSV tem endereco de cliente: NUNCA salvar dentro do repo (repo publico).
//
// Uso (no servidor, com o .env.production do monitoramento; Node 24 le o .ts):
//   node --env-file=.env.production scripts/diagnostico/pontos-fora-do-municipio.mjs \
//     --saida /tmp/fora-do-municipio.csv [--desde 2026-11-03]
import { writeFileSync } from "node:fs";

const TOLERANCIA_FORA_DA_MALHA_M = 2000;

const local = await import(new URL("../../src/lib/romaneio-geocode-local.ts", import.meta.url).href);

function municipioDaCidade(cidadeBruta) {
  if (!cidadeBruta) return null;
  return local.municipioCodigoIbge(local.expandirCidadeTruncada(cidadeBruta));
}

/** Municipio esperado de uma chave do cache ou de um endereco do romaneio. */
export function municipioEsperadoDaChave(chave) {
  const ref = /^(CIDADE|BAIRRO):(?:(.*):)?(.+?)(?:, RJ, BRASIL)?$/i.exec(chave);
  if (ref) {
    return { tipo: ref[1].toUpperCase() === "CIDADE" ? "cidade" : "bairro", municipio: municipioDaCidade(ref[3]) };
  }
  return { tipo: "endereco", municipio: municipioDaCidade(local.extrairCidadeDoEndereco(chave)) };
}

/** null = nao entra na lista. */
export function classificar({ tipo, esperado, doPonto, distanciaM }) {
  if (!esperado) return null;
  if (doPonto === esperado) return null;
  if (doPonto) return "outro_municipio";
  if (tipo === "bairro") return "fora_da_malha";
  if (tipo === "cidade") return null; // centro de cidade fora da malha: a guarda mantem
  return distanciaM != null && distanciaM > TOLERANCIA_FORA_DA_MALHA_M ? "fora_da_malha" : null;
}

function csv(v) {
  if (v === null || v === undefined) return "";
  const s = String(v);
  return /[",\n;]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

function hojeSP() {
  return new Intl.DateTimeFormat("en-CA", { timeZone: "America/Sao_Paulo" }).format(new Date());
}

async function main() {
  const args = process.argv.slice(2);
  const arg = (nome, padrao) => {
    const i = args.indexOf(nome);
    return i >= 0 ? args[i + 1] : padrao;
  };
  const saida = arg("--saida", null);
  const desde = arg("--desde", hojeSP());
  if (!saida) { console.error("uso: --saida <arquivo.csv> [--desde AAAA-MM-DD]"); process.exit(1); }
  if (!/^\d{4}-\d{2}-\d{2}$/.test(desde)) { console.error("--desde invalido"); process.exit(1); }
  const conn = process.env.DATABASE_URL;
  if (!conn) { console.error("DATABASE_URL ausente"); process.exit(1); }

  const { default: pg } = await import("pg");
  const client = new pg.Client({ connectionString: conn, ssl: conn.includes("localhost") || conn.includes("127.0.0.1") ? false : { rejectUnauthorized: false } });
  await client.connect();
  try {
    await client.query("SET default_transaction_read_only = on");
    await client.query("SET statement_timeout = '300s'");
    await client.query("BEGIN READ ONLY");

    const doPonto = `left join lateral (
        select m.municipio_codigo from malha_municipios_rj m
        where ST_Contains(m.geom, ST_SetSRID(ST_MakePoint(t.lng, t.lat), 4326)) limit 1
      ) mp on true`;
    const cache = await client.query(`
      select 'romaneio_geocode_cache' as tabela, t.endereco_normalizado as chave, null::text as romaneio_data,
             null::text as placa, null::text as nf, t.lat, t.lng, t.fonte, t.validado::text as validado,
             t.atualizado_em::text as gravado_em, mp.municipio_codigo as do_ponto
      from romaneio_geocode_cache t ${doPonto}
      where t.lat is not null and t.lng is not null`);
    const pontos = await client.query(`
      select 'romaneio_pontos' as tabela, t.endereco_bruto as chave, t.romaneio_data::text as romaneio_data,
             t.placa, t.nf, t.lat, t.lng, t.geocode_status as fonte, null::text as validado,
             null::text as gravado_em, mp.municipio_codigo as do_ponto, t.id::text as id
      from romaneio_pontos t ${doPonto}
      where t.romaneio_data >= $1::date and t.lat is not null and t.lng is not null`, [desde]);

    const linhas = [...cache.rows, ...pontos.rows].map((r) => {
      const { tipo, municipio } = municipioEsperadoDaChave(r.chave);
      return { ...r, tipo, esperado: municipio };
    });

    // Distancia ate o municipio esperado, so' para quem nao caiu nele.
    const medir = linhas.filter((l) => l.esperado && l.do_ponto !== l.esperado);
    const distancia = new Map();
    for (let i = 0; i < medir.length; i += 2000) {
      const lote = medir.slice(i, i + 2000);
      const { rows } = await client.query(`
        select u.i, ST_Distance(m.geom::geography, ST_SetSRID(ST_MakePoint(u.lng, u.lat), 4326)::geography) as d
        from unnest($1::int[], $2::float8[], $3::float8[], $4::text[]) as u(i, lat, lng, mun)
        join malha_municipios_rj m on m.municipio_codigo = u.mun`,
        [lote.map((_, k) => i + k), lote.map((l) => l.lat), lote.map((l) => l.lng), lote.map((l) => l.esperado)]);
      for (const r of rows) distancia.set(medir[r.i], Number(r.d));
    }
    await client.query("ROLLBACK");

    const cabecalho = ["tabela", "tipo", "motivo", "chave_ou_endereco", "id", "romaneio_data", "placa", "nf", "lat", "lng", "fonte_ou_status", "validado", "gravado_em", "municipio_esperado", "municipio_do_ponto", "distancia_km"];
    const saidaLinhas = [];
    const resumo = {};
    for (const l of linhas) {
      const distanciaM = distancia.get(l) ?? null;
      const motivo = classificar({ tipo: l.tipo, esperado: l.esperado, doPonto: l.do_ponto, distanciaM });
      if (!motivo) continue;
      const k = `${l.tabela}/${l.tipo}/${motivo}`;
      resumo[k] = (resumo[k] ?? 0) + 1;
      saidaLinhas.push([l.tabela, l.tipo, motivo, l.chave, l.id ?? "", l.romaneio_data, l.placa, l.nf, l.lat, l.lng, l.fonte, l.validado, l.gravado_em, l.esperado, l.do_ponto, distanciaM == null ? "" : (distanciaM / 1000).toFixed(1)].map(csv).join(","));
    }
    writeFileSync(saida, [cabecalho.join(","), ...saidaLinhas].join("\n") + "\n");
    console.log(`lidas: cache=${cache.rowCount} pontos(desde ${desde})=${pontos.rowCount}; fora do municipio: ${saidaLinhas.length}`);
    for (const [k, n] of Object.entries(resumo).sort()) console.log(`  ${k}: ${n}`);
    console.log(`CSV: ${saida}`);
  } finally {
    await client.end();
  }
}

if (process.argv[1]?.endsWith("pontos-fora-do-municipio.mjs")) {
  await main();
}
