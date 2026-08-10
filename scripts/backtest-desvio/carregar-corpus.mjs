// scripts/backtest-desvio/carregar-corpus.mjs
//
// Roda DENTRO do Contabo (via ssh transmonseg-vps) ou com DATABASE_URL
// setado no ambiente local se houver tunel pro Postgres de producao.
// Extrai o corpus de casos_desvio_revisao (30 dias, ver
// docs/superpowers/specs/2026-08-10-afastando-tudo-harness-design.md) +
// os 2 casos extras TTM-7C13/TTH-0G95 (nunca dispararam, nao existem em
// casos_desvio_revisao) e escreve scripts/backtest-desvio/corpus.json.
//
// Uso: node scripts/backtest-desvio/carregar-corpus.mjs
import pg from "pg";
import { writeFileSync } from "node:fs";

const DATABASE_URL =
  process.env.DATABASE_URL ??
  "postgres://app_service:5cf0fd1c8cfc0dfdf66a19196d5e6ebc691bbc628d7e637c@localhost:5432/transmonseg";

const client = new pg.Client({ connectionString: DATABASE_URL });
await client.connect();

// Casos rotulados de casos_desvio_revisao -- origem_acao exclui acoes em
// massa (mesmo filtro ja usado em recalibrar-desvio/route.ts).
//
// REMOVIDO (10/08, achado do coordenador): filtro adicional de
// `desvio_streak>0 or fora_tapete=true` que existia aqui antes descartava
// 387 dos 421 casos elegiveis -- nao porque o caso fosse irrelevante pro
// afastando-de-tudo, mas porque esses dois campos so passaram a existir em
// `contexto_detector` a partir do commit b5c5a25 (26/07,
// montarContextoDesvio). Qualquer alerta CRIADO antes disso nunca teve
// esses campos escritos, mesmo revisado/resolvido depois dentro da janela
// de 30 dias -- lacuna de schema, nao ausencia de relevancia. Isso nao
// importa pro corpus: o motor de replay (Task 3, replay.ts) recalcula
// desvio_streak do ZERO a partir da trilha real de posicoes + destinos via
// pendentes_snapshot_log -- nunca dependeu do
// contexto_detector->>'desvio_streak' pra nada, esse campo so era usado
// aqui como filtro de montagem do corpus. Sem o filtro, o corpus volta a
// cobrir os ~421 casos elegiveis (resolvido + falso_positivo
// detector_errado/null) previstos na spec original.
const { rows: casos } = await client.query(`
  select id, veiculo_id, status_final, motivo_falso_positivo, trilha
  from casos_desvio_revisao
  where (origem_acao is null or origem_acao <> 'resolver_massa')
`);

function rotulo(c) {
  if (c.status_final === "resolvido") return "tem_que_disparar";
  if (c.status_final === "falso_positivo" && (c.motivo_falso_positivo === null || c.motivo_falso_positivo === "detector_errado")) {
    return "nao_pode_disparar";
  }
  return null; // dado_entrada_errado ou status desconhecido -- fora do corpus
}

async function destinosParaVeiculo(veiculoId, timestampIso) {
  const { rows } = await client.query(
    `select pendentes from pendentes_snapshot_log
     where veiculo_id = $1 and criado_em <= $2
     order by criado_em desc limit 1`,
    [veiculoId, timestampIso]
  );
  const pendentes = (rows[0]?.pendentes ?? []).map((p) => ({ lat: p.lat, lng: p.lng }));

  // DESVIO do brief: b.geom e' geography(Geometry,4326) armazenando
  // POLIGONOS (confirmado via ST_GeometryType em producao -- as 4 bases
  // sao ST_Polygon, nao ST_Point), entao ST_Y/ST_X direto no geom falha
  // com "Argument to ST_Y() must have type POINT". Producao real
  // (route.ts:1759,1845-1846) ja resolve isso computando centroideGeo(b.geom)
  // (media dos vertices do anel) e usa esse ponto pra alimentar
  // distDestinosM/afastouDeTudo -- ST_Centroid e' o equivalente SQL direto
  // (bases aqui sao patios simples/quase-convexos, diferenca pro
  // vertex-average de centroideGeo e' desprezivel pra distancias em escala
  // de corredor).
  const { rows: basesRows } = await client.query(
    `select ST_Y(ST_Centroid(b.geom::geometry)) as lat, ST_X(ST_Centroid(b.geom::geometry)) as lng
     from bases b join veiculos v on v.cliente_id = b.cliente_id
     where v.id = $1`,
    [veiculoId]
  );

  // Simplificacao documentada (ver spec): omite pontos de escala de rota
  // (feature recente, 09/08 em diante) -- a maioria do corpus de 30 dias e'
  // anterior a ela, e o comentario em route.ts confirma que escala so
  // afeta o calculo de afastamento v4, nao chegada/corredor -- omitir
  // subestima N em casos recentes, nao inventa destino que nao existia.
  return [...pendentes, ...basesRows];
}

const corpus = [];

for (const c of casos) {
  const r = rotulo(c);
  if (!r) continue;
  const pontos = c.trilha.map((p) => ({
    lat: p.lat, lng: p.lng, velocidade: p.velocidade, criado_em: p.criado_em,
  }));
  const destinosPorPonto = [];
  for (const p of pontos) {
    destinosPorPonto.push(await destinosParaVeiculo(c.veiculo_id, p.criado_em));
  }
  corpus.push({ id: `casos_desvio_revisao:${c.id}`, rotulo: r, pontos, destinosPorPonto });
}

// Casos extras: TTM-7C13 e TTH-0G95, motivadores da investigacao de hoje.
// Nunca dispararam (por isso nao existem em casos_desvio_revisao) -- ver
// spec pra IDs e janela de tempo exatos.
const CASOS_EXTRAS = [
  { placa: "7C13", veiculoId: "85052a19-ab73-4919-98a2-b2308a5ad7c9" },
  { placa: "0G95", veiculoId: "2c8c32f7-e7af-450d-ab89-ffd0e17766d9" },
];

for (const { placa, veiculoId } of CASOS_EXTRAS) {
  const { rows: pos } = await client.query(
    `select lat, lng, velocidade, criado_em from posicoes_historico
     where veiculo_id = $1 and criado_em >= now() - interval '4 hours'
     order by criado_em asc`,
    [veiculoId]
  );
  const pontos = pos.map((p) => ({ lat: p.lat, lng: p.lng, velocidade: p.velocidade, criado_em: p.criado_em }));
  const destinosPorPonto = [];
  for (const p of pontos) {
    destinosPorPonto.push(await destinosParaVeiculo(veiculoId, p.criado_em));
  }
  corpus.push({ id: `extra:${placa}`, rotulo: "tem_que_disparar", pontos, destinosPorPonto });
}

await client.end();

writeFileSync(new URL("./corpus.json", import.meta.url), JSON.stringify(corpus, null, 2));
console.log(`corpus.json escrito: ${corpus.length} casos (${corpus.filter((c) => c.rotulo === "tem_que_disparar").length} tem_que_disparar, ${corpus.filter((c) => c.rotulo === "nao_pode_disparar").length} nao_pode_disparar)`);
