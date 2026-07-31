// scripts/ingerir-cnefe.mjs
// Ingestao UNICA/manual do CNEFE (IBGE, Censo Demografico 2022) --
// endereco + coordenada real por imovel (coletado por recenseador em
// campo), muito mais preciso que o extrato OSM (vias_nomes) pra
// geocodificacao local do romaneio -- achado real 31/07, depois de
// descartar Google Geocoding (usuario recusou vincular faturamento).
//
// Fonte (baixar e descompactar antes de rodar):
// https://ftp.ibge.gov.br/Cadastro_Nacional_de_Enderecos_para_Fins_Estatisticos/Censo_Demografico_2022/Arquivos_CNEFE/CSV/UF/33_RJ.zip
//
// Confirmado real: arquivo e' puro ASCII (sem acento), separador ";",
// cabecalho na primeira linha -- parseado por NOME de coluna (nao posicao
// fixa), mais resistente a mudanca de ordem entre edicoes do CNEFE.
import pg from "pg";
import { createReadStream } from "node:fs";
import { createInterface } from "node:readline";

const ARQUIVO_ORIGEM = process.argv[2];
if (!ARQUIVO_ORIGEM) {
  console.error("Uso: node ingerir-cnefe.mjs <caminho-do-csv>");
  process.exit(1);
}
const TAMANHO_LOTE = 5000;

// Niveis de geocodificacao aceitos (NV_GEO_COORD, ver dicionario CNEFE) --
// 1/2/3 sao precisao de ENDERECO (coordenada original de campo, ajustada
// pra apartamentos no mesmo numero, ou estimada); 4/5/6 sao agregacoes
// mais grosseiras (face de quadra, localidade, setor censitario inteiro)
// -- descartados de proposito, imprecisos demais (podem errar por
// quarteirões inteiros).
const NIVEIS_ACEITOS = new Set(["1", "2", "3"]);

// Mesma normalizacao de src/lib/romaneio-geocode-local.ts (duplicado aqui
// pelo mesmo motivo de ingerir-vias-nomes.mjs -- script .mjs nao importa
// de src/lib/*.ts). Acento incluido por seguranca mesmo o dado fonte
// sendo puro ASCII (confirmado via grep no arquivo real).
const CONECTORES = new Set(["DE", "DA", "DO", "DAS", "DOS"]);

function normalizarNome(nome) {
  const semAcento = nome
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .toUpperCase()
    .trim()
    .replace(/\s+/g, " ");
  const tokens = semAcento.split(" ").filter((t) => !CONECTORES.has(t));
  return tokens.join(" ");
}

async function flushLote(client, lote) {
  if (lote.length === 0) return;
  await client.query(
    `INSERT INTO cnefe_enderecos
       (id, municipio_codigo, cep, localidade, logradouro_tipo, logradouro_nome, numero, lat, lng, nome_normalizado)
     SELECT c.id, c.municipio_codigo, c.cep, c.localidade, c.logradouro_tipo, c.logradouro_nome, c.numero, c.lat, c.lng, c.nome_normalizado
     FROM unnest($1::bigint[], $2::text[], $3::text[], $4::text[], $5::text[], $6::text[], $7::text[], $8::float8[], $9::float8[], $10::text[])
       AS c(id, municipio_codigo, cep, localidade, logradouro_tipo, logradouro_nome, numero, lat, lng, nome_normalizado)
     ON CONFLICT (id) DO NOTHING`,
    [
      lote.map((l) => l.id),
      lote.map((l) => l.municipioCodigo),
      lote.map((l) => l.cep),
      lote.map((l) => l.localidade),
      lote.map((l) => l.logradouroTipo),
      lote.map((l) => l.logradouroNome),
      lote.map((l) => l.numero),
      lote.map((l) => l.lat),
      lote.map((l) => l.lng),
      lote.map((l) => l.nomeNormalizado),
    ]
  );
}

async function main() {
  const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL, ssl: { rejectUnauthorized: false } });
  const client = await pool.connect();
  let lote = [];
  let processadas = 0;
  let ignoradas = 0;
  let colunas = null;

  try {
    const rl = createInterface({ input: createReadStream(ARQUIVO_ORIGEM, { encoding: "utf-8" }) });
    let primeiraLinha = true;
    for await (const linha of rl) {
      if (primeiraLinha) {
        colunas = linha.split(";");
        primeiraLinha = false;
        continue;
      }
      if (!linha.trim()) continue;
      const campos = linha.split(";");
      const porNome = Object.fromEntries(colunas.map((c, i) => [c, campos[i]]));

      const nivel = porNome["NV_GEO_COORD"];
      const lat = parseFloat(porNome["LATITUDE"]);
      const lng = parseFloat(porNome["LONGITUDE"]);
      const nomeSeglogr = porNome["NOM_SEGLOGR"]?.trim();

      if (!NIVEIS_ACEITOS.has(nivel) || !Number.isFinite(lat) || !Number.isFinite(lng) || !nomeSeglogr) {
        ignoradas++;
        continue;
      }

      const titulo = porNome["NOM_TITULO_SEGLOGR"]?.trim();
      const nomeCompleto = titulo ? `${titulo} ${nomeSeglogr}` : nomeSeglogr;

      lote.push({
        id: porNome["COD_UNICO_ENDERECO"],
        municipioCodigo: porNome["COD_MUNICIPIO"],
        cep: porNome["CEP"] || null,
        localidade: porNome["DSC_LOCALIDADE"] || null,
        logradouroTipo: porNome["NOM_TIPO_SEGLOGR"] || null,
        logradouroNome: nomeCompleto,
        numero: porNome["NUM_ENDERECO"] || null,
        lat,
        lng,
        nomeNormalizado: normalizarNome(nomeCompleto),
      });
      processadas++;

      if (processadas % TAMANHO_LOTE === 0) {
        await flushLote(client, lote);
        console.log(`  ${processadas} enderecos processados (${ignoradas} ignorados)`);
        lote = [];
      }
    }
    await flushLote(client, lote);
    console.log(`Concluido: ${processadas} enderecos processados, ${ignoradas} ignorados (nivel de geocodificacao grosseiro ou dado invalido).`);

    const total = await client.query(`SELECT count(*)::bigint AS n FROM cnefe_enderecos`);
    console.log("total de linhas em cnefe_enderecos:", total.rows[0].n);
  } finally {
    client.release();
    await pool.end();
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
