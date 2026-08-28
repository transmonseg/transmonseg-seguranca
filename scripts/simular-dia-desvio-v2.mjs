// Simula um dia inteiro (America/Sao_Paulo), frota inteira, com o detector
// de desvio v2 rodando EXATAMENTE como em produção (mesmas funções:
// buscarDistanciasReais via OSRM real, avaliarAfastandoDeTudo,
// avaliarRuaRara, celulaDe) -- reusa o codigo de src/lib, nao reimplementa
// nada. Objetivo: listar TODO disparo que teria acontecido naquele dia, pra
// revisão manual caso a caso (nunca confiar só em contagem agregada).
//
// Roda contra pendentes_snapshot_log (o que estava pendente de verdade
// em cada momento) + posicoes_historico (trajeto real). Precisa do OSRM
// self-hosted acessível (rodar no próprio Contabo).
//
// Uso: npx tsx --env-file=.env.production scripts/simular-dia-desvio-v2.mjs [YYYY-MM-DD]
// Sem argumento, simula o dia de HOJE (comportamento original).
//
// Gates opcionais (28/08) -- DESLIGADOS por padrao, pra que o baseline deste
// script continue exatamente o mesmo de todas as calibracoes anteriores
// (LIMIAR_STREAK_AFASTANDO em 16/08, etc). Ligando-os, a simulacao fica mais
// perto do motor real, que ja aplica os dois:
//   GATE_MOVIMENTO_MINIMO=1  -> LIMIAR_MOVIMENTO_MINIMO_M (50m, achado 13/08)
//   GATE_RECONCILIACAO=1     -> ehSaltoDeReconciliacaoDeAtraso (achado 28/08)
// Em ambos, o ciclo e' pulado sem zerar/decrementar o streak (mesmo
// comportamento do motor: `anterior`/`distAnteriores` seguem avancando).
import pg from "pg";
import { avaliarAfastandoDeTudo, avaliarRuaRara, ehSaltoDeReconciliacaoDeAtraso } from "../src/lib/desvio.ts";
import { celulaDe } from "../src/lib/celulas.ts";
import { buscarDistanciasReais } from "../src/lib/distancia-real.ts";

const conn = process.env.DATABASE_URL;
if (!conn) { console.error("DATABASE_URL ausente"); process.exit(1); }
const client = new pg.Client({ connectionString: conn, ssl: { rejectUnauthorized: false } });
await client.connect();

// Dia alvo em America/Sao_Paulo: argv[2] (YYYY-MM-DD) ou hoje, convertido
// pra uma janela [00h, 24h) em UTC via o proprio Postgres (evita bug de
// fuso do JS Date pra datas arbitrarias).
const diaAlvo = process.argv[2] ?? new Date().toLocaleString("en-CA", { timeZone: "America/Sao_Paulo" }).slice(0, 10);
const { rows: janelaRows } = await client.query(
  `SELECT (($1::text || ' 00:00:00')::timestamp AT TIME ZONE 'America/Sao_Paulo') AS inicio,
          (($1::text || ' 00:00:00')::timestamp AT TIME ZONE 'America/Sao_Paulo' + interval '1 day') AS fim`,
  [diaAlvo]
);
const inicioUTC = janelaRows[0].inicio;
const fimUTC = janelaRows[0].fim;
console.log(`Simulando o dia ${diaAlvo} (SP), de ${inicioUTC.toISOString()} até ${fimUTC.toISOString()} (UTC).`);

const { rows: veiculos } = await client.query(
  `SELECT DISTINCT ph.veiculo_id, v.placa, v.cliente_id
     FROM posicoes_historico ph
     JOIN veiculos v ON v.id = ph.veiculo_id
    WHERE ph.criado_em >= $1 AND ph.criado_em < $2`,
  [inicioUTC, fimUTC]
);
console.log(`Veículos com posição nesse dia: ${veiculos.length}`);

const GATE_MOVIMENTO_MINIMO = process.env.GATE_MOVIMENTO_MINIMO === "1";
const GATE_RECONCILIACAO = process.env.GATE_RECONCILIACAO === "1";
const LIMIAR_MOVIMENTO_MINIMO_M = 50;
console.log(`Gates: GATE_MOVIMENTO_MINIMO=${GATE_MOVIMENTO_MINIMO} GATE_RECONCILIACAO=${GATE_RECONCILIACAO}`);

function haversineM(lat1, lng1, lat2, lng2) {
  const R = 6371000;
  const toRad = (g) => (g * Math.PI) / 180;
  const dLat = toRad(lat2 - lat1);
  const dLng = toRad(lng2 - lng1);
  const a =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.sin(dLng / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(a));
}

let totalSuprimidosMovimento = 0;
let totalSuprimidosReconciliacao = 0;

const eventos = [];
let totalCiclosAvaliados = 0;
let totalFalhasOSRM = 0;
let veiculosProcessados = 0;
const inicioExec = Date.now();

// Cache de frequência de célula POR CLIENTE (poucos clientes, muitos
// veículos por cliente) -- evita reconsultar a mesma tabela centenas de
// vezes.
const freqPorCliente = new Map();
async function getFreqCliente(clienteId) {
  if (freqPorCliente.has(clienteId)) return freqPorCliente.get(clienteId);
  const { rows: freq } = await client.query(
    `SELECT celula, n_visitas FROM celula_frequencia_cliente WHERE cliente_id = $1`,
    [clienteId]
  );
  const freqMap = new Map(freq.map((r) => [r.celula, r.n_visitas]));
  freqPorCliente.set(clienteId, freqMap);
  return freqMap;
}

async function processarVeiculo({ veiculo_id, placa, cliente_id }) {
  const { rows: posicoes } = await client.query(
    `SELECT lat, lng, velocidade, atraso_min, criado_em FROM posicoes_historico
      WHERE veiculo_id = $1 AND criado_em >= $2 AND criado_em < $3 ORDER BY criado_em ASC`,
    [veiculo_id, inicioUTC, fimUTC]
  );
  const { rows: snapshots } = await client.query(
    `SELECT criado_em, pendentes FROM pendentes_snapshot_log
      WHERE veiculo_id = $1 AND criado_em < $2 ORDER BY criado_em ASC`,
    [veiculo_id, fimUTC]
  );
  const freqMap = await getFreqCliente(cliente_id);

  let afastandoStreak = 0;
  let ruaRaraStreak = 0;
  let anterior = null;
  let snapIdx = 0;
  let distAnteriores = null;

  for (const pos of posicoes) {
    while (snapIdx + 1 < snapshots.length && snapshots[snapIdx + 1].criado_em <= pos.criado_em) snapIdx++;
    const pendentesAgora = (snapshots[snapIdx]?.pendentes ?? []).filter((p) => p.lat != null && p.lng != null);

    if (pendentesAgora.length === 0 || !anterior) {
      anterior = pos;
      distAnteriores = null;
      afastandoStreak = 0;
      ruaRaraStreak = 0;
      continue;
    }

    const destinos = pendentesAgora.map((p) => ({ lat: p.lat, lng: p.lng }));
    const distAtuais = await buscarDistanciasReais({ lat: pos.lat, lng: pos.lng }, destinos);
    totalCiclosAvaliados++;

    if (!distAtuais || !distAnteriores || distAtuais.length !== distAnteriores.length) {
      totalFalhasOSRM += distAtuais ? 0 : 1;
      distAnteriores = distAtuais;
      anterior = pos;
      continue;
    }

    // Gates de supressao de CICLO (nao mexem no streak) -- ver cabecalho.
    // Precisam rodar depois do OSRM porque `distAnteriores` do proximo ciclo
    // continua sendo a distancia deste ponto (o motor tambem grava a posicao
    // em posicoes_atuais mesmo quando suspende a avaliacao).
    const movimentoRealM = haversineM(anterior.lat, anterior.lng, pos.lat, pos.lng);
    const suprimidoPorMovimento = GATE_MOVIMENTO_MINIMO && movimentoRealM < LIMIAR_MOVIMENTO_MINIMO_M;
    const suprimidoPorReconciliacao =
      GATE_RECONCILIACAO && ehSaltoDeReconciliacaoDeAtraso(anterior.atraso_min, pos.atraso_min);
    if (suprimidoPorMovimento || suprimidoPorReconciliacao) {
      if (suprimidoPorMovimento) totalSuprimidosMovimento++;
      else totalSuprimidosReconciliacao++;
      distAnteriores = distAtuais;
      anterior = pos;
      continue;
    }

    const afastando = avaliarAfastandoDeTudo(distAtuais, distAnteriores, afastandoStreak);
    afastandoStreak = afastando.streak;

    const celula = celulaDe(pos.lat, pos.lng);
    const nVisitas = freqMap.get(celula) ?? 0;
    const ruaRara = avaliarRuaRara(nVisitas, afastando.aproximandoAlgum, ruaRaraStreak);
    ruaRaraStreak = ruaRara.streak;

    if (afastando.disparou || ruaRara.disparou) {
      eventos.push({
        veiculo_id,
        placa,
        tipo: afastando.disparou ? "afastando_geral" : "rua_rara_frota",
        criado_em: pos.criado_em.toISOString(),
        lat: pos.lat,
        lng: pos.lng,
        maps: `https://www.google.com/maps?q=${pos.lat},${pos.lng}`,
        pendentes_no_momento: pendentesAgora.length,
        n_visitas_celula: nVisitas,
        streak: afastando.disparou ? afastando.streak : ruaRara.streak,
      });
      // Reseta o streak do sinal que disparou -- mesmo comportamento que
      // teria em produção (o alerta já foi contado; próximo disparo do
      // mesmo tipo exige novo streak, não fica repetindo a cada ciclo).
      if (afastando.disparou) afastandoStreak = 0;
      if (ruaRara.disparou) ruaRaraStreak = 0;
    }

    distAnteriores = distAtuais;
    anterior = pos;
  }

  veiculosProcessados++;
  if (veiculosProcessados % 5 === 0 || veiculosProcessados === veiculos.length) {
    const decorridoMin = ((Date.now() - inicioExec) / 60000).toFixed(1);
    console.log(`[progresso] ${veiculosProcessados}/${veiculos.length} veículos | ${totalCiclosAvaliados} ciclos avaliados | ${eventos.length} disparos até agora | ${decorridoMin}min decorridos`);
  }
}

// Paralelismo real: N veículos em voo ao mesmo tempo (cada um sequencial
// internamente, o streak exige ordem). OSRM self-hosted sem throttle
// aguenta isso tranquilo (já processou a frota inteira em ~1000s num
// teste anterior, ver docs/analise-desvio-raiz-2026-08-11.md).
const CONCORRENCIA = 16;
let cursor = 0;
async function worker() {
  while (cursor < veiculos.length) {
    const v = veiculos[cursor++];
    await processarVeiculo(v);
  }
}
await Promise.all(Array.from({ length: CONCORRENCIA }, () => worker()));

console.log(`\nCiclos avaliados (com >=2 leituras e pendentes): ${totalCiclosAvaliados}`);
console.log(`Falhas de OSRM (ciclos pulados): ${totalFalhasOSRM}`);
console.log(`Ciclos suprimidos por movimento < ${LIMIAR_MOVIMENTO_MINIMO_M}m: ${totalSuprimidosMovimento}`);
console.log(`Ciclos suprimidos por salto de reconciliacao de atraso: ${totalSuprimidosReconciliacao}`);
console.log(`\nTotal de desvios que teriam disparado no dia ${diaAlvo}: ${eventos.length}`);
console.log(`  afastando_geral: ${eventos.filter((e) => e.tipo === "afastando_geral").length}`);
console.log(`  rua_rara_frota: ${eventos.filter((e) => e.tipo === "rua_rara_frota").length}`);
console.log(`Veículos distintos com >=1 disparo: ${new Set(eventos.map((e) => e.veiculo_id)).size} / ${veiculos.length}`);

console.log("\n--- Lista completa (JSON) ---");
console.log(JSON.stringify(eventos, null, 2));

await client.end();
