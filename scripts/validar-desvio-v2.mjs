// Valida o detector de desvio v2 contra dado real: (1) volume de disparo
// num dia de frota inteira via replay de posicoes_historico +
// pendentes_snapshot_log, (2) recall contra casos_desvio_revisao
// confirmados 'resolvido'. Ver Task 8 do plano
// docs/superpowers/plans/2026-08-12-desvio-de-rota-v2.md.
//
// IMPORTANTE: pendentes_snapshot_log e casos_desvio_revisao só existem no
// banco de produção (Contabo) -- são tabelas alimentadas pelo motor rodando
// de verdade contra a frota real, não existem no banco local de dev. Rodar
// este script via SSH: ssh transmonseg-vps "cd /srv/transmonseg/temp &&
// npx tsx --env-file=.env.production scripts/validar-desvio-v2.mjs"
//
// Achado real 12/08 (1a tentativa morreu 2x): sem limite de data, o replay
// processa posicoes_historico INTEIRO (todo o arquivo grande, nao so
// "hoje") sequencialmente, 1 veiculo por vez -- inviavel (~14h estimado).
// Fix: janela de 3 dias (cobre com folga a retencao de 2 dias de
// casos_desvio_revisao, unico consumidor que precisa de dado historico
// aqui) + pool de 16 workers em paralelo, mesmo padrao ja validado em
// scripts/simular-dia-desvio-v2.mjs.
//
// Uso: npx tsx --env-file=<.env> scripts/validar-desvio-v2.mjs
// (tsx, não node puro -- este script importa .ts direto de src/lib/)
import pg from "pg";
import { avaliarAfastandoDeTudo, avaliarRuaRara } from "../src/lib/desvio.ts";
import { celulaDe } from "../src/lib/celulas.ts";

const conn = process.env.DATABASE_URL;
if (!conn) { console.error("DATABASE_URL ausente"); process.exit(1); }
const client = new pg.Client({ connectionString: conn, ssl: { rejectUnauthorized: false } });
await client.connect();

async function tabelaExiste(nome) {
  const { rows } = await client.query(
    `SELECT EXISTS (SELECT 1 FROM information_schema.tables WHERE table_schema='public' AND table_name=$1) AS existe`,
    [nome]
  );
  return rows[0].existe;
}

for (const t of ["pendentes_snapshot_log", "casos_desvio_revisao", "posicoes_historico", "celula_frequencia_cliente"]) {
  if (!(await tabelaExiste(t))) {
    console.error(`ERRO: tabela "${t}" não existe neste banco. Este script precisa rodar contra o Contabo (produção) -- ver comentário no topo do arquivo.`);
    await client.end();
    process.exit(1);
  }
}

const { rows: janela } = await client.query(
  `SELECT min(criado_em) AS min, max(criado_em) AS max, count(*)::int AS n FROM pendentes_snapshot_log`
);
console.log("Janela de pendentes_snapshot_log:", janela[0]);
const { rows: janelaCasos } = await client.query(
  `SELECT min(criado_em) AS min, max(criado_em) AS max, count(*)::int AS n FROM casos_desvio_revisao`
);
console.log("Janela de casos_desvio_revisao (retenção curta, 2 dias):", janelaCasos[0]);

const JANELA_DIAS = 3;
const inicioJanela = new Date(Date.now() - JANELA_DIAS * 24 * 60 * 60 * 1000);
console.log(`\nReplay limitado aos últimos ${JANELA_DIAS} dias (desde ${inicioJanela.toISOString()}) -- cobre com folga a retenção de casos_desvio_revisao.`);

// 1. Replay por veiculo, cruzando posicoes_historico com o snapshot de
// pendentes mais recente <= aquele timestamp (aproximacao -- snapshot e
// throttled, nao existe 1 por ciclo exato).
const { rows: veiculos } = await client.query(
  `SELECT DISTINCT veiculo_id FROM posicoes_historico WHERE criado_em >= $1`,
  [inicioJanela]
);
console.log(`Veículos com posição na janela: ${veiculos.length}`);

let totalDisparos = 0;
let disparosAfastando = 0;
let disparosRuaRara = 0;
const disparosPorVeiculo = new Map();

// Cache de frequencia de celula POR CLIENTE (poucos clientes, muitos
// veiculos por cliente) -- mesmo padrao de simular-dia-desvio-v2.mjs.
const freqPorVeiculo = new Map();
async function getFreqVeiculo(veiculo_id) {
  if (freqPorVeiculo.has(veiculo_id)) return freqPorVeiculo.get(veiculo_id);
  const { rows: freq } = await client.query(
    `SELECT f.celula, f.n_visitas
       FROM celula_frequencia_cliente f
       JOIN veiculos v ON v.cliente_id = f.cliente_id
      WHERE v.id = $1`,
    [veiculo_id]
  );
  const freqMap = new Map(freq.map((r) => [r.celula, r.n_visitas]));
  freqPorVeiculo.set(veiculo_id, freqMap);
  return freqMap;
}

let processados = 0;
const inicioExec = Date.now();

async function processarVeiculo({ veiculo_id }) {
  const { rows: posicoes } = await client.query(
    `SELECT lat, lng, criado_em FROM posicoes_historico WHERE veiculo_id = $1 AND criado_em >= $2 ORDER BY criado_em ASC`,
    [veiculo_id, inicioJanela]
  );
  const { rows: snapshots } = await client.query(
    `SELECT criado_em, pendentes FROM pendentes_snapshot_log WHERE veiculo_id = $1 AND criado_em >= $2 ORDER BY criado_em ASC`,
    [veiculo_id, inicioJanela]
  );
  const freqMap = await getFreqVeiculo(veiculo_id);

  let afastandoStreak = 0;
  let ruaRaraStreak = 0;
  let anterior = null;
  let snapIdx = 0;

  for (const pos of posicoes) {
    while (snapIdx + 1 < snapshots.length && snapshots[snapIdx + 1].criado_em <= pos.criado_em) snapIdx++;
    const pendentesAgora = (snapshots[snapIdx]?.pendentes ?? []).filter((p) => p.lat != null && p.lng != null);
    if (pendentesAgora.length === 0 || !anterior) {
      anterior = pos;
      continue;
    }

    // Simplificacao de backtest (documentada na Task 8): distancia
    // aproximada (haversine) em vez de OSRM real, pra nao fazer ~milhoes
    // de chamadas de rede no replay -- serve pra medir VOLUME relativo,
    // nao pra validar precisao de distancia (essa ja foi validada
    // separadamente em 11/08, ver docs/analise-desvio-raiz-2026-08-11.md).
    const dist = (a, b) => Math.sqrt((a.lat - b.lat) ** 2 + (a.lng - b.lng) ** 2) * 111_000;
    const distAtuais = pendentesAgora.map((p) => dist(pos, p));
    const distAnteriores = pendentesAgora.map((p) => dist(anterior, p));

    const afastando = avaliarAfastandoDeTudo(distAtuais, distAnteriores, afastandoStreak);
    afastandoStreak = afastando.streak;

    const celula = celulaDe(pos.lat, pos.lng);
    const nVisitas = freqMap.get(celula) ?? 0;
    const ruaRara = avaliarRuaRara(nVisitas, afastando.aproximandoAlgum, ruaRaraStreak);
    ruaRaraStreak = ruaRara.streak;

    if (afastando.disparou || ruaRara.disparou) {
      totalDisparos++;
      if (afastando.disparou) disparosAfastando++;
      if (ruaRara.disparou) disparosRuaRara++;
      disparosPorVeiculo.set(veiculo_id, (disparosPorVeiculo.get(veiculo_id) ?? 0) + 1);
    }
    anterior = pos;
  }

  processados++;
  if (processados % 20 === 0 || processados === veiculos.length) {
    const decorridoMin = ((Date.now() - inicioExec) / 60000).toFixed(1);
    console.log(`[progresso] ${processados}/${veiculos.length} veículos | ${totalDisparos} disparos até agora | ${decorridoMin}min decorridos`);
  }
}

const CONCORRENCIA = 16;
let cursor = 0;
async function worker() {
  while (cursor < veiculos.length) {
    const v = veiculos[cursor++];
    await processarVeiculo(v);
  }
}
await Promise.all(Array.from({ length: CONCORRENCIA }, () => worker()));

console.log(`\nTotal de disparos no replay: ${totalDisparos} (afastando: ${disparosAfastando}, rua rara: ${disparosRuaRara})`);
console.log(`Veiculos com >=1 disparo: ${disparosPorVeiculo.size} / ${veiculos.length}`);

// 2. Recall contra casos confirmados 'resolvido'.
const { rows: casosReais } = await client.query(
  `SELECT alerta_id, veiculo_id, criado_em FROM casos_desvio_revisao WHERE status_final = 'resolvido'`
);
console.log(`\nCasos confirmados 'resolvido' na janela disponivel: ${casosReais.length}`);
let cobertos = 0;
const naoCobertos = [];
for (const caso of casosReais) {
  if (disparosPorVeiculo.has(caso.veiculo_id)) cobertos++;
  else naoCobertos.push(caso);
}
console.log(`Recall aproximado (veiculo teve >=1 disparo na janela do caso confirmado): ${cobertos}/${casosReais.length}`);
if (naoCobertos.length > 0) {
  console.warn("\nAVISO: nem todo caso confirmado teve disparo correspondente -- revisar manualmente antes de considerar pronto (prioridade é recall, não perder desvio real).");
  console.log("Casos SEM disparo correspondente:", JSON.stringify(naoCobertos, null, 2));
}

await client.end();
