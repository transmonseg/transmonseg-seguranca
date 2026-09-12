// Reaudita o cache de geocodificacao do KPI (kpi_romaneio_geocode_cache)
// contra as camadas territoriais do monitoramento e reporta o que esta fora
// do municipio ou do bairro esperado -- sem gravar nada no banco do KPI.
//
// Achado real 12/09 (auditoria do KPI Nutry Max do dia 11/09): 304 enderecos
// outliers, 294 deles marcados confiavel=true; reverse geocode independente
// confirmou 100 em municipio errado. 26 NFs do dia 11/09 cairam nesses
// enderecos e 21 viraram "NAO FOI AO CLIENTE".
//
// Por que arquivo-em/arquivo-fora (Ruling 4, ver task-7-brief.md): o app do
// KPI nao tem DATABASE_URL -- ele fala com o banco via PostgREST -- e a
// credencial de banco do monitoramento, que ALCANCA o banco kpi_transmonseg,
// nao tem GRANT em kpi_romaneio_geocode_cache (permission denied). Corrigir
// isso seria mudar permissao em producao, o que nao foi autorizado aqui.
// Entao o cache e' extraido A PARTE (dump via psql na VPS, ver comando
// abaixo) e este script so' conecta no banco `transmonseg` (DATABASE_URL do
// proprio repo, mesmo padrao de scripts/carregar-malha-municipios.ts) pra
// rodar as funcoes SQL de territorio. A saida e' um arquivo .sql de UPDATEs
// que ALGUEM AINDA PRECISA RODAR contra kpi_transmonseg -- este script nunca
// escreve la.
//
// Como gerar o TSV de entrada (roda no monitoramento, le o banco do KPI):
//   ssh transmonseg-vps "sudo -u postgres psql -d kpi_transmonseg -t -A -F\$'\t' \
//     -c 'SELECT endereco, lat, lng FROM kpi_romaneio_geocode_cache'" > cache.tsv
//
// Uso (sempre dry-run -- nunca escreve no KPI; a aplicacao do .sql gerado e'
// um passo humano, separado, depois de conferir o relatorio):
//   npx tsx scripts/auditar-geocode-territorio.ts <cache.tsv> <saida.sql>
import { readFileSync, writeFileSync } from "node:fs";
import { Client } from "pg";
import { validarTerritorio, type DepsTerritorio } from "@/lib/territorio";
import { expandirCidadeTruncada, municipioCodigoIbge } from "@/lib/romaneio-geocode-local";

type LinhaCache = { endereco: string; lat: number; lng: number };

/** "VIA, NUM - BAIRRO, CIDADE - complemento" -> bairro e cidade. */
function partesDoEndereco(e: string): { bairro: string | null; cidade: string | null } {
  const seg = e.split(" - ");
  if (seg.length < 2 || !seg[1].includes(",")) return { bairro: null, cidade: null };
  const i = seg[1].lastIndexOf(",");
  return { bairro: seg[1].slice(0, i).trim(), cidade: seg[1].slice(i + 1).trim() };
}

function lerTsv(caminho: string): LinhaCache[] {
  const texto = readFileSync(caminho, "utf8");
  const linhas = texto.split("\n").filter((l) => l.length > 0);
  return linhas.map((linha, i) => {
    const campos = linha.split("\t");
    if (campos.length !== 3) {
      throw new Error(
        `linha ${i + 1} do TSV nao tem 3 campos (achou ${campos.length}) -- ` +
          `provavel tab dentro do endereco corrompendo o parsing: ${linha.slice(0, 120)}`,
      );
    }
    const [endereco, latStr, lngStr] = campos;
    const lat = Number(latStr);
    const lng = Number(lngStr);
    if (!Number.isFinite(lat) || !Number.isFinite(lng)) {
      throw new Error(`linha ${i + 1} do TSV com lat/lng invalido: ${linha.slice(0, 120)}`);
    }
    return { endereco, lat, lng };
  });
}

/** Escapa aspas simples pra literal SQL. */
function sqlLit(s: string): string {
  return `'${s.replace(/'/g, "''")}'`;
}

async function main() {
  const [tsvPath, sqlOutPath] = process.argv.slice(2);
  if (!tsvPath || !sqlOutPath) {
    console.error(
      "uso: npx tsx scripts/auditar-geocode-territorio.ts <cache.tsv> <saida.sql>",
    );
    process.exit(1);
  }

  const rows = lerTsv(tsvPath);
  console.log(`cache: ${rows.length} enderecos (lido de ${tsvPath})`);

  const monit = new Client({ connectionString: process.env.DATABASE_URL });
  await monit.connect();
  try {
    const deps: DepsTerritorio = {
      async municipioDaCoordenada(lat: number, lng: number) {
        const r = await monit.query<{ municipio_codigo: string }>(
          "SELECT * FROM municipio_da_coordenada($1, $2)",
          [lat, lng],
        );
        return r.rows[0]?.municipio_codigo ?? null;
      },
      // bairroNormalizado ja chega normalizado por validarTerritorio (que usa
      // a mesma normalizarBairro de @/lib/territorio antes de chamar esta
      // funcao) -- este script nunca reimplementa a normalizacao, so' repassa
      // o parametro pra funcao SQL, igual ao adapter da rota
      // (src/app/api/romaneio/geocode/territorio-deps.ts).
      async distanciaAoBairro(lat: number, lng: number, bairroNormalizado: string) {
        const r = await monit.query<{ distancia_ao_bairro: number | null }>(
          "SELECT distancia_ao_bairro($1, $2, $3) AS distancia_ao_bairro",
          [lat, lng, bairroNormalizado],
        );
        const v = r.rows[0]?.distancia_ao_bairro;
        return typeof v === "number" ? v : null;
      },
    };

    const marcar: { endereco: string; motivo: string }[] = [];
    // Paraleliza em lotes -- ~8.700 linhas x 2 chamadas SQL cada, uma por
    // vez seria lento demais; nao muda o resultado, so' a ordem de chegada.
    const TAMANHO_LOTE = 20;
    for (let i = 0; i < rows.length; i += TAMANHO_LOTE) {
      const lote = rows.slice(i, i + TAMANHO_LOTE);
      const resultados = await Promise.all(
        lote.map(async (r) => {
          const { bairro, cidade } = partesDoEndereco(r.endereco);
          const municipioCodigo = cidade
            ? municipioCodigoIbge(expandirCidadeTruncada(cidade)) ?? null
            : null;
          const t = await validarTerritorio(
            { lat: r.lat, lng: r.lng },
            { municipioCodigo, bairro },
            deps,
          );
          return t.ok ? null : { endereco: r.endereco, motivo: t.motivo };
        }),
      );
      for (const res of resultados) if (res) marcar.push(res);
    }

    const porMotivo = marcar.reduce<Record<string, number>>((a, m) => {
      a[m.motivo] = (a[m.motivo] ?? 0) + 1;
      return a;
    }, {});
    console.log(`a marcar: ${marcar.length}`, porMotivo);
    for (const m of marcar.slice(0, 40)) console.log(`  ${m.motivo} | ${m.endereco.slice(0, 90)}`);

    const sql = [
      "-- Gerado por scripts/auditar-geocode-territorio.ts (dry-run) -- NAO",
      "-- aplicado automaticamente. Revisar o relatorio antes de rodar isto",
      "-- contra kpi_transmonseg.",
      `-- ${marcar.length} linha(s), gerado em ${new Date().toISOString()}.`,
      "BEGIN;",
      ...marcar.map(
        (m) =>
          `UPDATE kpi_romaneio_geocode_cache SET confiavel = false, motivo = ${sqlLit(m.motivo)} WHERE endereco = ${sqlLit(m.endereco)};`,
      ),
      "COMMIT;",
      "",
    ].join("\n");
    writeFileSync(sqlOutPath, sql, "utf8");
    console.log(`\nSQL gerado em ${sqlOutPath} (${marcar.length} UPDATE(s)) -- nada foi aplicado.`);
    console.log("Este script nunca escreve no banco do KPI. Aplicar o .sql e' um passo humano separado.");
  } finally {
    await monit.end();
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
