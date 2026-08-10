// scripts/geocodificar-planilha-nutrymax.ts
//
// Geocodifica os enderecos da planilha oficial de clientes Nutry Max (10/08)
// usando a MESMA cadeia de producao do romaneio (CNEFE -> OSM local ->
// Google [sem chave] -> Nominatim, ver src/lib/romaneio-geocode.ts) -- zero
// reimplementacao, so troca o transporte de dados: Supabase REST (usado
// em api/romaneio/processar-geocode/route.ts) por `pg` direto, porque este
// script roda fora do Next.js.
//
// Uso: npx tsx scripts/geocodificar-planilha-nutrymax.ts <planilha.csv> <saida.csv>
// CSV de entrada precisa ter header: Codigo,Loja,Nome Razão Social,Nome Fantasia,Endereco,Bairro,Municipio,CEP
import pg from "pg";
import { readFileSync, writeFileSync } from "node:fs";
import {
  geocodificarEndereco,
  geocodificarCnefe,
  geocodificarLocal,
  geocodificarGoogle,
  geocodificarNominatim,
} from "../src/lib/romaneio-geocode";
import { extrairCidadeDoEndereco, expandirCidadeTruncada } from "../src/lib/romaneio-geocode-local";

const DATABASE_URL =
  process.env.DATABASE_URL ??
  "postgres://app_service:5cf0fd1c8cfc0dfdf66a19196d5e6ebc691bbc628d7e637c@localhost:5432/transmonseg";

const ARQUIVO_ENTRADA = process.argv[2];
const ARQUIVO_SAIDA = process.argv[3];
if (!ARQUIVO_ENTRADA || !ARQUIVO_SAIDA) {
  console.error("Uso: npx tsx scripts/geocodificar-planilha-nutrymax.ts <planilha.csv> <saida.csv>");
  process.exit(1);
}

// Mesmo throttle de processar-geocode/route.ts -- respeita 1 req/s do
// Nominatim publico.
const ESPERA_ENTRE_CHAMADAS_MS = 1100;
function esperar(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function parseCsvLine(linha: string): string[] {
  const campos: string[] = [];
  let atual = "";
  let dentroAspas = false;
  for (let i = 0; i < linha.length; i++) {
    const c = linha[i];
    if (c === '"') {
      dentroAspas = !dentroAspas;
    } else if (c === "," && !dentroAspas) {
      campos.push(atual);
      atual = "";
    } else {
      atual += c;
    }
  }
  campos.push(atual);
  return campos;
}

function parseCsv(texto: string): Record<string, string>[] {
  const linhas = texto.trim().split("\n");
  const header = parseCsvLine(linhas[0]);
  return linhas.slice(1).map((l) => {
    const valores = parseCsvLine(l);
    return Object.fromEntries(header.map((h, i) => [h.trim(), (valores[i] ?? "").trim()]));
  });
}

function csvEscape(v: string): string {
  if (v.includes(",") || v.includes('"') || v.includes("\n")) {
    return `"${v.replace(/"/g, '""')}"`;
  }
  return v;
}

async function main() {
  const linhas = parseCsv(readFileSync(ARQUIVO_ENTRADA, "utf-8"));
  console.log(`${linhas.length} linhas carregadas de ${ARQUIVO_ENTRADA}`);

  const pool = new pg.Pool({ connectionString: DATABASE_URL });

  const buscarCache = async (chave: string) => {
    const { rows } = await pool.query<{ lat: number; lng: number; fonte: string }>(
      `SELECT lat, lng, fonte FROM romaneio_geocode_cache WHERE endereco_normalizado = $1`,
      [chave]
    );
    return rows[0] ?? null;
  };
  const salvarCache = async (chave: string, r: { lat: number; lng: number; fonte: string }) => {
    await pool.query(
      `INSERT INTO romaneio_geocode_cache (endereco_normalizado, lat, lng, fonte, atualizado_em)
       VALUES ($1, $2, $3, $4, now())
       ON CONFLICT (endereco_normalizado) DO UPDATE SET lat=$2, lng=$3, fonte=$4, atualizado_em=now()`,
      [chave, r.lat, r.lng, r.fonte]
    );
  };
  const geocodificarNominatimThrottled = async (endereco: string) => {
    await esperar(ESPERA_ENTRE_CHAMADAS_MS);
    return geocodificarNominatim(endereco);
  };
  const buscarCandidatosPorNome = async (nomeNormalizado: string) => {
    const { rows } = await pool.query<{ lat: number; lng: number }>(
      `SELECT lat, lng FROM vias_nomes WHERE nome_sem_conectores = $1`,
      [nomeNormalizado]
    );
    return rows;
  };
  const buscarCnefePorRuaNumero = async (nomeNormalizado: string, numero: string) => {
    const { rows } = await pool.query<{ lat: number; lng: number }>(
      `SELECT lat, lng FROM cnefe_enderecos WHERE nome_normalizado = $1 AND numero = $2 LIMIT 50`,
      [nomeNormalizado, numero]
    );
    return rows;
  };
  const buscarCnefePorRua = async (nomeNormalizado: string) => {
    const { rows } = await pool.query<{ lat: number; lng: number }>(
      `SELECT lat, lng FROM cnefe_enderecos WHERE nome_normalizado = $1 LIMIT 200`,
      [nomeNormalizado]
    );
    return rows;
  };
  const buscarCnefePorSimilaridade = async (nomeNormalizado: string) => {
    const { rows } = await pool.query<{ lat: number; lng: number }>(
      `SELECT * FROM cnefe_buscar_por_similaridade($1, $2)`,
      [nomeNormalizado, 5]
    );
    return rows;
  };

  const cidadesUnicas = [
    ...new Set(
      linhas
        .map((l) => extrairCidadeDoEndereco(`${l.Endereco}, ${l.Bairro}, ${l.Municipio}`))
        .filter((c): c is string => c !== null)
        .map(expandirCidadeTruncada)
    ),
  ];
  const pontosCidade = new Map<string, { lat: number; lng: number }>();
  console.log(`Resolvendo ${cidadesUnicas.length} cidades unicas...`);
  for (const cidade of cidadesUnicas) {
    const chaveCidade = `CIDADE:${cidade.toUpperCase()}`;
    const doCache = await buscarCache(chaveCidade);
    if (doCache) {
      pontosCidade.set(cidade, { lat: doCache.lat, lng: doCache.lng });
      continue;
    }
    const ponto = await geocodificarNominatimThrottled(cidade);
    if (ponto) {
      await salvarCache(chaveCidade, { ...ponto, fonte: "nominatim" });
      pontosCidade.set(cidade, ponto);
    }
  }
  console.log(`${pontosCidade.size}/${cidadesUnicas.length} cidades resolvidas.`);

  const resultados: Record<string, string>[] = [];
  let ok = 0;
  let falhou = 0;
  for (let i = 0; i < linhas.length; i++) {
    const l = linhas[i];
    const enderecoBruto = `${l.Endereco}, ${l.Bairro}, ${l.Municipio}`;
    const cidadeBruta = extrairCidadeDoEndereco(enderecoBruto);
    const cidade = cidadeBruta ? expandirCidadeTruncada(cidadeBruta) : null;
    const pontoCidade = cidade ? pontosCidade.get(cidade) ?? null : null;

    const geocode = await geocodificarEndereco(enderecoBruto, pontoCidade, {
      buscarCache,
      salvarCache,
      geocodificarCnefeDep: (endereco, ponto) =>
        geocodificarCnefe(endereco, ponto, {
          buscarPorRuaNumero: buscarCnefePorRuaNumero,
          buscarPorRua: buscarCnefePorRua,
          buscarPorSimilaridade: buscarCnefePorSimilaridade,
        }),
      geocodificarLocalDep: (endereco, ponto) => geocodificarLocal(endereco, ponto, buscarCandidatosPorNome),
      geocodificarGoogle,
      geocodificarNominatim: geocodificarNominatimThrottled,
    });

    if (geocode) ok++;
    else falhou++;

    resultados.push({
      ...l,
      geocode_lat: geocode ? String(geocode.lat) : "",
      geocode_lng: geocode ? String(geocode.lng) : "",
      geocode_fonte: geocode ? geocode.fonte : "",
    });

    if ((i + 1) % 25 === 0) console.log(`${i + 1}/${linhas.length} (ok=${ok} falhou=${falhou})`);
  }

  const header = Object.keys(resultados[0]);
  const csvLinhas = [header.join(",")];
  for (const r of resultados) {
    csvLinhas.push(header.map((h) => csvEscape(r[h] ?? "")).join(","));
  }
  writeFileSync(ARQUIVO_SAIDA, csvLinhas.join("\n") + "\n", "utf-8");

  console.log(`\nConcluido: ${ok} geocodificados, ${falhou} sem resultado. Salvo em ${ARQUIVO_SAIDA}`);
  await pool.end();
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
