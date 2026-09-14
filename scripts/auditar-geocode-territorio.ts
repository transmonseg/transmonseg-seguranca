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
import {
  expandirCidadeTruncada,
  municipioCodigoIbge,
  extrairBairroDoEndereco,
  extrairCidadeDoEndereco,
  extrairNumeroDoEndereco,
} from "@/lib/romaneio-geocode-local";

type LinhaCache = { endereco: string; lat: number; lng: number };

// Fix 12/09 (Finding 6): usar as MESMAS funcoes que a rota de geocode de
// verdade usa (extrairBairroDoEndereco/extrairCidadeDoEndereco em
// romaneio-geocode-local.ts) em vez de um parser local proprio
// (partesDoEndereco, removido). O parser local divergia quando o proprio
// NOME DA RUA tinha " - " embutido (faixa de numeracao CNEFE, ex. "RUA
// PEREIRA NUNES - DE 212 AO FIM - LADO") -- ancorava no primeiro " - " do
// endereco inteiro em vez de a partir da primeira virgula, lia bairro/cidade
// do segmento errado, nao achava hull nem codigo IBGE e aprovava em
// silencio (fail-open escondendo divergencia real). Usar a biblioteca
// garante que os dois nunca podem divergir de novo.

// Fix 12/09 (Finding 2): kpi_romaneio_geocode_cache e' uma tabela UNICA
// compartilhada por Nutry Max e Rio Quality (chave so' `endereco`, sem
// coluna de cliente) -- e o escopo combinado com o usuario pra guarda
// territorial e' SO' Nutry Max (ver src/lib/territorio.ts). Rio Quality
// monta o endereco bruto de geocodificacao com montarEnderecoBrutoCompleto
// (KPI/src/lib/kpi-rioquality/parse-planilhas.ts): `"${rua}, - ${bairro},
// ${cidade} - ${uf}"` -- SEM numero (Rio Quality nunca manda numero de
// casa), diferente de todo endereco da Nutry Max (parse-romaneio.ts: linha
// bruta do PDF, sempre com numero real ou "S/N"). extrairNumeroDoEndereco
// retorna null exatamente quando o segmento entre a 1a virgula e o " - "
// esta vazio -- o unico jeito de isso acontecer e' o produtor da Rio
// Quality. Confirmado em producao (12/09, kpi_transmonseg, read-only):
// exatamente 416 das 8.744 linhas do cache tem numero vazio, e as MESMAS
// 416 (nenhuma a mais, nenhuma a menos) terminam em " - RJ" (o sufixo fixo
// que montarEnderecoBrutoCompleto grava no lugar do complemento de entrega
// da Nutry Max) -- os dois criterios colapsam pro mesmo conjunto exato,
// confirmando que e' o discriminador certo, nao coincidencia dos 2 exemplos
// do achado. Os 3 anchors de verificacao (GALEAO/PACIENCIA/PEDRA, todos com
// numero real ou "S/N") sobrevivem ao filtro.
export function enderecoDaRioQuality(endereco: string): boolean {
  return extrairNumeroDoEndereco(endereco) === null;
}

// Fix 3 (Fase 2, 13/09): kpi_romaneio_geocode_cache tambem e' usada por Porte
// Frio (src/lib/kpi-portefrio/agregacao.ts:enderecoCompleto, KPI repo --
// `${endereco}, ${numero} - ${bairro}, ${cidade} - ${uf}`). Quando o numero
// parseado (parse-romaneio.ts do Porte Frio, linha ~246) e' vazio, o formato
// colapsa com o de Rio Quality e enderecoDaRioQuality ja exclui (mesmo motivo
// errado, mesmo resultado certo). O caso perigoso e' Porte Frio COM numero
// real: o formato fica byte-a-byte igual ao da Nutry Max (numero real,
// virgula, hifen, bairro, cidade, hifen, sufixo) -- NAO HA discriminador de
// forma pra separar os dois (ver auditar-geocode-territorio.test.ts, describe
// "enderecoDaRioQuality"). Nao inventamos heuristica fragil pra isso porque
// qualquer regra baseada em forma teria a mesma taxa de erro do parser: zero
// informacao decisiva sobrou no texto.
// Exposicao hoje (13/09): 0 geracoes Porte Frio em kpi_romaneio_geracoes (47
// nutrimax, 1 rioquality) -- verificado antes desta mudanca. O fix real,
// quando Porte Frio for pra producao, e' uma coluna `cliente` em
// kpi_romaneio_geocode_cache (a tabela e' compartilhada, chaveada so' por
// `endereco`) -- nao existe hoje. Ate la, este aviso torna o risco visivel
// pra quem le a saida do script, em vez de fingir que o filtro atual cobre
// os 3 clientes.
export const AVISO_LIMITACAO_PORTFRIO =
  "ATENCAO: este script so' consegue excluir enderecos no formato Rio " +
  "Quality (numero sempre vazio). Porte Frio usa a MESMA tabela " +
  "kpi_romaneio_geocode_cache e, quando o numero parseado do romaneio dele " +
  "e' um numero real (nao vazio), o formato do endereco e' identico ao da " +
  "Nutry Max -- esses enderecos NAO sao excluidos e caem no bucket Nutry " +
  "Max sem deteccao possivel por forma. Hoje (13/09) a exposicao e' zero " +
  "(0 geracoes Porte Frio em kpi_romaneio_geracoes), mas isso muda no dia " +
  "em que Porte Frio gerar o primeiro romaneio. Correcao real: adicionar " +
  "uma coluna `cliente` em kpi_romaneio_geocode_cache antes disso acontecer.";

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

  console.warn(AVISO_LIMITACAO_PORTFRIO);

  const todasAsLinhas = lerTsv(tsvPath);
  const rows = todasAsLinhas.filter((r) => !enderecoDaRioQuality(r.endereco));
  const excluidosRioQuality = todasAsLinhas.length - rows.length;
  console.log(
    `cache: ${todasAsLinhas.length} enderecos (lido de ${tsvPath}) -- ` +
      `${excluidosRioQuality} excluidos por serem formato Rio Quality (fora de escopo, Finding 2), ` +
      `${rows.length} considerados (formato Nutry Max)`,
  );

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
      // Fix 1 (Fase 2, 13/09): municipioCodigo repassado como 4o argumento
      // posicional pra 084_distancia_ao_bairro_municipio.sql -- mesma funcao
      // que a rota real chama via RPC (territorio-deps.ts), so' que aqui via
      // psql direto. null mantem o comportamento fail-open antigo.
      async distanciaAoBairro(lat: number, lng: number, bairroNormalizado: string, municipioCodigo: string | null) {
        const r = await monit.query<{ distancia_ao_bairro: number | null }>(
          "SELECT distancia_ao_bairro($1, $2, $3, $4) AS distancia_ao_bairro",
          [lat, lng, bairroNormalizado, municipioCodigo],
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
          const bairro = extrairBairroDoEndereco(r.endereco);
          const cidade = extrairCidadeDoEndereco(r.endereco);
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

if (process.env.VITEST !== "true") {
  main().catch((e) => {
    console.error(e);
    process.exit(1);
  });
}
