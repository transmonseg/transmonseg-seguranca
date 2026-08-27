// Simula um dia inteiro (America/Sao_Paulo) dos 3 DETECTORES DE PARADA da
// Central Romaneio -- parada_anomala, parada_longa, parada_fora_tapete --
// rodando sobre o trajeto REAL de cada veículo com romaneio naquele dia.
// Irmão de simular-dia-desvio-v2.mjs, que cobre o outro sinal (desvio v2) e
// serviu de molde pra este.
//
// Por que existe: a disciplina permanente deste projeto é "validar contra dia
// real antes de deploy", e até 27/08 o único simulador cobria só o detector de
// desvio -- não importava calcularNoClienteRomaneio/avaliarParadasRomaneio
// (task B1) nem lia romaneio_pontos. Ou seja: os 3 detectores novos, que
// passaram a rodar pra frota inteira, não tinham COMO ser validados contra dia
// real. Este script fecha esse buraco.
//
// LEITURA PURA: só SELECT. Nenhum INSERT/UPDATE/DELETE em nenhuma tabela --
// inclusive o poi_cache, que é lido mas nunca escrito (ver "temPOIProximo"
// abaixo). Pode rodar contra produção sem risco.
//
// Uso: npx tsx --env-file=.env.local scripts/simular-dia-paradas-romaneio.mjs [YYYY-MM-DD]
// Sem argumento, simula o dia de HOJE.
//
// ─────────────────────────────────────────────────────────────────────────
// FIDELIDADE DOS INSUMOS -- leia antes de tirar conclusão de qualquer número
// ─────────────────────────────────────────────────────────────────────────
// A DECISÃO é 100% fiel: as funções puras vêm importadas da própria rota
// (calcularNoClienteRomaneio, avaliarParadasRomaneio, avaliarDentroTapete,
// decidirEscopoDoVeiculo de src/app/api/motor-romaneio/route.ts), que por sua
// vez chamam detectarParadaLonga/Anomala/ForaTapete de src/lib/detectores.ts.
// Nada de regra é reimplementado aqui. O que varia é a fidelidade dos INSUMOS:
//
// FIÉIS (mesma fonte e mesma fórmula da produção):
//   - pontos do romaneio  : romaneio_pontos do dia + montarPontosDeRomaneio(l, [])
//                           -- inclusive o `[]` literal da task B2.
//   - noCliente           : calcularNoClienteRomaneio sobre a posição real.
//   - foraDaBase          : ST_Contains contra o polígono real de `bases`.
//   - dentroTapete        : avaliarDentroTapete sobre corredor_celulas do cliente.
//   - emOperacao/madrugada: mesmas funções/fuso.
//   - estavEmMovimento    : velocidade máxima nos 10min ANTES do início da parada.
//   - escopo por cliente  : decidirEscopoDoVeiculo (guard de cliente do achado I5).
//
// APROXIMADOS (documente a limitação ao citar os números):
//   - parado_desde  : produção lê posicoes_atuais.parado_desde (mantido pela
//                     Central em tempo real); aqui é RECONSTRUÍDO como o
//                     primeiro de uma sequência de leituras com velocidade=0
//                     em posicoes_historico. Buraco de gravação no histórico
//                     pode encurtar ou partir uma parada -- tende a SUBestimar
//                     paradoMin, ou seja, a subcontar disparos.
//   - temPOIProximo : produção consulta o Overpass ao vivo (e grava cache);
//                     aqui SÓ o poi_cache é lido (SELECT), porque escrever é
//                     proibido neste script. Cache miss => temPOI=false, que é
//                     o lado que MAIS dispara -- então o volume aqui é um TETO
//                     pros 3 detectores, nunca um piso.
//   - vizinhosParados: produção usa posicoes_atuais do instante; aqui é
//                     reconstruído de posicoes_historico com janela de ±5min
//                     em torno da leitura (mesmo raio de 250m). Aproximação
//                     grosseira dos dois lados.
//   - tapete        : corredor_celulas é lido AGORA, não como estava naquele
//                     dia (a tabela é cumulativa; hoje ela cobre mais que no
//                     dia simulado => tende a subcontar parada_fora_tapete).
//
// OMITIDOS (com efeito conhecido e limitado):
//   - riscoAreaAtual = 0 sempre. Ele NÃO decide se parada_fora_tapete dispara,
//     só o `nivel` (critico vs atencao) -- ver detectarParadaForaTapete. O
//     volume medido aqui é exato; a severidade é que fica subestimada.
//   - cooldown de re-disparo (deveSuprimirRedisparoParada) e silenciamento por
//     falso positivo: dependem de ação de operador, que não é simulável. Este
//     script reporta os EPISÓDIOS (1 por veículo/tipo/parada contínua), que é
//     a unidade que o operador vê -- e também o total de leituras, pra dar a
//     ordem de grandeza do que o dedup da rota está segurando.
import pg from "pg";
import {
  calcularNoClienteRomaneio,
  avaliarParadasRomaneio,
  avaliarDentroTapete,
  decidirEscopoDoVeiculo,
} from "../src/app/api/motor-romaneio/route.ts";
import { montarPontosDeRomaneio } from "../src/lib/romaneio.ts";
import { emHorarioOperacao, PARADA_FORA_TAPETE_MIN } from "../src/lib/detectores.ts";
import { haversineM } from "../src/lib/unitrac.ts";
import { vizinhanca3x3 } from "../src/lib/celulas.ts";

// Mesmos valores das constantes locais da rota (route.ts) -- não são regra de
// detecção, são parâmetros do contexto que a rota monta.
const RAIO_CONGESTION_M = 250;
const JANELA_VIZINHOS_MS = 5 * 60 * 1000;

const conn = process.env.DATABASE_URL;
if (!conn) { console.error("DATABASE_URL ausente"); process.exit(1); }
const client = new pg.Client({ connectionString: conn, ssl: { rejectUnauthorized: false } });
await client.connect();

// Dia alvo em America/Sao_Paulo, convertido pra janela UTC pelo próprio
// Postgres (mesmo padrão de simular-dia-desvio-v2.mjs).
const diaAlvo = process.argv[2] ?? new Date().toLocaleString("en-CA", { timeZone: "America/Sao_Paulo" }).slice(0, 10);
const { rows: janelaRows } = await client.query(
  `SELECT (($1::text || ' 00:00:00')::timestamp AT TIME ZONE 'America/Sao_Paulo') AS inicio,
          (($1::text || ' 00:00:00')::timestamp AT TIME ZONE 'America/Sao_Paulo' + interval '1 day') AS fim`,
  [diaAlvo]
);
const inicioUTC = janelaRows[0].inicio;
const fimUTC = janelaRows[0].fim;
console.log(`Simulando PARADAS do dia ${diaAlvo} (SP), de ${inicioUTC.toISOString()} ate ${fimUTC.toISOString()} (UTC).`);

// ─── Romaneio do dia (mesma fonte da rota) ────────────────────────────────
const { rows: linhasRomaneio } = await client.query(
  `SELECT veiculo_id, placa, nf, cliente_nome, lat, lng, presenca_confirmada_em
     FROM romaneio_pontos
    WHERE romaneio_data = $1::date AND modo_teste = false AND veiculo_id IS NOT NULL`,
  [diaAlvo]
);
if (linhasRomaneio.length === 0) {
  console.log(`Nenhuma linha de romaneio em ${diaAlvo} -- nada a simular.`);
  await client.end();
  process.exit(0);
}
const romaneioPorVeiculo = new Map();
for (const l of linhasRomaneio) {
  const lista = romaneioPorVeiculo.get(l.veiculo_id) ?? [];
  lista.push(l);
  romaneioPorVeiculo.set(l.veiculo_id, lista);
}
const veiculoIds = [...romaneioPorVeiculo.keys()];

const { rows: veiculos } = await client.query(
  `SELECT v.id, v.placa, v.cliente_id, c.cod_user_unitrac
     FROM veiculos v JOIN clientes c ON c.id = v.cliente_id
    WHERE v.id = ANY($1::uuid[])`,
  [veiculoIds]
);
const infoPorVeiculo = new Map(veiculos.map((v) => [v.id, v]));
console.log(`Veiculos com romaneio no dia: ${veiculoIds.length} (${linhasRomaneio.length} linhas de romaneio).`);

// Guard de cliente do achado I5: os 3 detectores só valem pros clientes de
// CLIENTES_COM_MOTOR_ROMANEIO_PARALELO.
const veiculosNoEscopo = veiculoIds.filter((id) => {
  const info = infoPorVeiculo.get(id);
  if (!info) return false;
  // qtdAlvosUnitracDoVeiculo só afeta avaliaDesvio (que este script não
  // simula) -- 0 é neutro aqui.
  return decidirEscopoDoVeiculo({ qtdAlvosUnitracDoVeiculo: 0, codUserUnitrac: info.cod_user_unitrac ?? null }).avaliaParadas;
});
console.log(`Veiculos NO ESCOPO de parada (guard de cliente, achado I5): ${veiculosNoEscopo.length}`);
if (veiculosNoEscopo.length === 0) { await client.end(); process.exit(0); }

const clienteIds = [...new Set(veiculosNoEscopo.map((id) => infoPorVeiculo.get(id).cliente_id))];

// ─── Tapete (corredor_celulas) por cliente ────────────────────────────────
const contagemTapetePorCliente = new Map();
{
  const { rows } = await client.query(
    `SELECT cliente_id, count(*)::bigint AS n FROM corredor_celulas
      WHERE cliente_id = ANY($1::uuid[]) GROUP BY cliente_id`,
    [clienteIds]
  );
  for (const r of rows) contagemTapetePorCliente.set(r.cliente_id, Number(r.n));
}

// ─── Posições paradas da frota do cliente (pra vizinhosParados) ───────────
const paradosPorCliente = new Map();
{
  const { rows } = await client.query(
    `SELECT v.cliente_id, ph.veiculo_id, ph.lat, ph.lng, ph.criado_em
       FROM posicoes_historico ph JOIN veiculos v ON v.id = ph.veiculo_id
      WHERE v.cliente_id = ANY($1::uuid[]) AND ph.criado_em >= $2 AND ph.criado_em < $3
        AND ph.velocidade = 0 AND ph.lat IS NOT NULL AND ph.lng IS NOT NULL
      ORDER BY ph.criado_em ASC`,
    [clienteIds, inicioUTC, fimUTC]
  );
  for (const r of rows) {
    const lista = paradosPorCliente.get(r.cliente_id) ?? [];
    lista.push({ veiculo_id: r.veiculo_id, lat: r.lat, lng: r.lng, t: r.criado_em.getTime() });
    paradosPorCliente.set(r.cliente_id, lista);
  }
}
function vizinhosParadosEm(clienteId, veiculoId, lat, lng, tMs) {
  const lista = paradosPorCliente.get(clienteId) ?? [];
  const outros = new Set();
  // Lista ordenada por tempo; varredura simples com corte pela janela.
  for (const p of lista) {
    if (p.t < tMs - JANELA_VIZINHOS_MS) continue;
    if (p.t > tMs + JANELA_VIZINHOS_MS) break;
    if (p.veiculo_id === veiculoId) continue;
    if (haversineM(lat, lng, p.lat, p.lng) <= RAIO_CONGESTION_M) outros.add(p.veiculo_id);
  }
  return outros.size;
}

// ─── poi_cache (LEITURA pura -- ver nota de fidelidade no cabeçalho) ──────
const poiCache = new Map();
{
  const { rows } = await client.query(`SELECT lat, lng, tem_poi FROM poi_cache`);
  for (const r of rows) poiCache.set(`${r.lat}:${r.lng}`, r.tem_poi);
}
console.log(`poi_cache carregado: ${poiCache.size} celulas conhecidas (miss => temPOI=false, ver cabecalho).`);
function temPOICacheado(lat, lng) {
  const k = `${Math.round(lat * 1000) / 1000}:${Math.round(lng * 1000) / 1000}`;
  return poiCache.get(k) ?? false;
}

const eventos = [];       // 1 por episódio (veiculo/tipo/parada contínua)
let leiturasComDisparo = 0;
let disparosBrutos = 0;   // 1 por leitura x tipo
let totalLeituras = 0;
let veiculosProcessados = 0;

function horaSP(d) {
  return parseInt(new Intl.DateTimeFormat("pt-BR", { timeZone: "America/Sao_Paulo", hour: "numeric", hour12: false }).format(d), 10);
}

async function processarVeiculo(veiculoId) {
  const info = infoPorVeiculo.get(veiculoId);
  const { rows: posicoes } = await client.query(
    `SELECT lat, lng, velocidade, criado_em FROM posicoes_historico
      WHERE veiculo_id = $1 AND criado_em >= $2 AND criado_em < $3
        AND lat IS NOT NULL AND lng IS NOT NULL
      ORDER BY criado_em ASC`,
    [veiculoId, inicioUTC, fimUTC]
  );
  veiculosProcessados++;
  if (posicoes.length === 0) return;
  totalLeituras += posicoes.length;

  // Pontos do romaneio -- MESMA chamada da rota, inclusive o [] literal.
  const pontos = montarPontosDeRomaneio(
    (romaneioPorVeiculo.get(veiculoId) ?? []).map((l) => ({
      nf: l.nf, clienteNome: l.cliente_nome, lat: l.lat, lng: l.lng, presencaConfirmadaEm: l.presenca_confirmada_em,
    })),
    []
  );

  // foraDaBase de verdade (ST_Contains contra o polígono da base), em lote pro
  // veículo inteiro -- mesma pergunta que a rota faz por ciclo.
  const dentroDeBase = new Set();
  {
    const { rows } = await client.query(
      `SELECT p.i FROM unnest($1::float8[], $2::float8[]) WITH ORDINALITY AS p(lat, lng, i)
         JOIN veiculos v ON v.id = $3::uuid
         JOIN bases b ON b.cliente_id = v.cliente_id
        WHERE ST_Contains(b.geom::geometry, ST_SetSRID(ST_MakePoint(p.lng, p.lat), 4326))`,
      [posicoes.map((p) => p.lat), posicoes.map((p) => p.lng), veiculoId]
    );
    for (const r of rows) dentroDeBase.add(Number(r.i) - 1);
  }

  // Células do tapete relevantes pro trajeto deste veículo (mesmo recorte da
  // rota: vizinhanca3x3 das posições).
  const celulasInteresse = new Set();
  for (const p of posicoes) for (const c of vizinhanca3x3(p.lat, p.lng)) celulasInteresse.add(c);
  const celulasCliente = new Set();
  if (celulasInteresse.size > 0) {
    const { rows } = await client.query(
      `SELECT celula FROM corredor_celulas WHERE cliente_id = $1::uuid AND celula = ANY($2::text[])`,
      [info.cliente_id, [...celulasInteresse]]
    );
    for (const r of rows) celulasCliente.add(r.celula);
  }

  // Episódios abertos por tipo neste veículo (dedup: a rota mantém 1 alerta
  // ativo por veiculo+tipo até resolver).
  const episodioAberto = new Map();

  let paradoDesdeMs = null;
  let anterior = null;

  for (let i = 0; i < posicoes.length; i++) {
    const pos = posicoes[i];
    const tMs = pos.criado_em.getTime();

    if (pos.velocidade === 0) {
      if (paradoDesdeMs === null) paradoDesdeMs = tMs;
    } else {
      paradoDesdeMs = null;
      episodioAberto.clear(); // voltou a andar: alerta de parada morre
    }

    const noCliente = calcularNoClienteRomaneio(
      { lat: pos.lat, lng: pos.lng, velocidade: pos.velocidade },
      pontos
    );

    if (pos.velocidade !== 0 || paradoDesdeMs === null) { anterior = pos; continue; }

    const paradoMin = Math.round((tMs - paradoDesdeMs) / 60000);
    const emOperacao = emHorarioOperacao(pos.criado_em);
    const foraDaBase = !dentroDeBase.has(i);
    const candidatoParada = emOperacao && foraDaBase && !noCliente && paradoMin >= PARADA_FORA_TAPETE_MIN;
    if (!candidatoParada) { anterior = pos; continue; }

    const dentroTapete = avaliarDentroTapete({
      confiavel: true,
      contagemCelulasCliente: contagemTapetePorCliente.get(info.cliente_id) ?? 0,
      celulasCliente,
      lat: pos.lat,
      lng: pos.lng,
    });

    // estavEmMovimento: velocidade máxima nos 10min ANTES do início da parada
    // (mesma janela da rota), lida da própria série em memória.
    let estavEmMovimento = false;
    {
      const jIni = paradoDesdeMs - 10 * 60_000;
      let vmax = 0;
      for (let j = i; j >= 0; j--) {
        const t = posicoes[j].criado_em.getTime();
        if (t >= paradoDesdeMs) continue;
        if (t < jIni) break;
        vmax = Math.max(vmax, posicoes[j].velocidade ?? 0);
      }
      estavEmMovimento = vmax >= 30;
    }

    const mesmoPonto =
      anterior != null &&
      Math.round(anterior.lat * 10000) === Math.round(pos.lat * 10000) &&
      Math.round(anterior.lng * 10000) === Math.round(pos.lng * 10000);

    const alertas = avaliarParadasRomaneio({
      paradoMin,
      emOperacao,
      foraDaBase,
      noCliente,
      estavEmMovimento,
      esMadrugada: horaSP(pos.criado_em) >= 0 && horaSP(pos.criado_em) < 5,
      temPOIProximo: temPOICacheado(pos.lat, pos.lng),
      jaParedoNoCicloAnterior: anterior != null && anterior.velocidade === 0 && mesmoPonto,
      vizinhosParados: vizinhosParadosEm(info.cliente_id, veiculoId, pos.lat, pos.lng, tMs),
      dentroTapete,
      riscoAreaAtual: 0, // omitido de propósito -- só afeta `nivel`, ver cabeçalho
    });

    if (alertas.length > 0) leiturasComDisparo++;
    disparosBrutos += alertas.length;

    for (const a of alertas) {
      const chaveEpisodio = `${a.tipo}:${paradoDesdeMs}`;
      if (episodioAberto.has(chaveEpisodio)) continue;
      episodioAberto.set(chaveEpisodio, true);
      eventos.push({
        placa: info.placa,
        veiculo_id: veiculoId,
        tipo: a.tipo,
        nivel: a.nivel,
        quando: pos.criado_em.toISOString(),
        hora_sp: pos.criado_em.toLocaleString("pt-BR", { timeZone: "America/Sao_Paulo" }),
        motivo: a.motivo,
        parado_min: paradoMin,
        parado_desde: new Date(paradoDesdeMs).toISOString(),
        lat: pos.lat,
        lng: pos.lng,
        maps: `https://www.google.com/maps?q=${pos.lat},${pos.lng}`,
        no_cliente: noCliente,
        dentro_tapete: dentroTapete,
        estava_em_movimento: estavEmMovimento,
        pontos_romaneio: pontos.length,
      });
    }
    anterior = pos;
  }
}

for (const id of veiculosNoEscopo) {
  await processarVeiculo(id);
  if (veiculosProcessados % 5 === 0) {
    console.log(`[progresso] ${veiculosProcessados}/${veiculosNoEscopo.length} veiculos | ${eventos.length} episodios ate agora`);
  }
}

eventos.sort((a, b) => a.quando.localeCompare(b.quando));

console.log(`\nLeituras de GPS avaliadas: ${totalLeituras}`);
console.log(`Leituras em que ao menos 1 detector disparou: ${leiturasComDisparo}`);
console.log(`Disparos brutos (leitura x tipo, ANTES do dedup por episodio): ${disparosBrutos}`);
console.log(`\nEPISODIOS (o que o operador veria como card) no dia ${diaAlvo}: ${eventos.length}`);
for (const tipo of ["parada_anomala", "parada_longa", "parada_fora_tapete"]) {
  console.log(`  ${tipo}: ${eventos.filter((e) => e.tipo === tipo).length}`);
}
console.log(`Veiculos distintos com >=1 episodio: ${new Set(eventos.map((e) => e.veiculo_id)).size} / ${veiculosNoEscopo.length}`);

const porPlaca = new Map();
for (const e of eventos) porPlaca.set(e.placa, (porPlaca.get(e.placa) ?? 0) + 1);
console.log("\n--- Episodios por placa ---");
for (const [placa, n] of [...porPlaca.entries()].sort((a, b) => b[1] - a[1])) console.log(`  ${placa}: ${n}`);

console.log("\n--- Lista completa (JSON) ---");
console.log(JSON.stringify(eventos, null, 2));

await client.end();
