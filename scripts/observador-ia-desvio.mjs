// Observador de desvio via IA local (Ollama, llama3.2:3b) -- MODO SOMBRA.
// Pedido do usuario (27/07): rodar uma IA fraca so OBSERVANDO os veiculos
// em rota e anotando a opiniao dela, sem influenciar nada do sistema real
// ainda. Depois de uma semana comparando a opiniao dela com o que o
// cliente marcou como falso/resolvido de verdade e' que se decide se ela
// ajuda pra valer -- ver scripts/migrations/contabo/004_observacoes_ia_desvio.sql.
//
// Mesmo padrao de coleta de dado real (posicao + alvos pendentes direto da
// Unitrac) de scripts/verificacao-independente-desvio.mjs -- so Nutry Max
// (cod_user_unitrac 4096) por ora. Roda local no proprio Contabo, chama o
// Ollama em 127.0.0.1:11434 (nunca exposto publicamente).
//
// Uso: node --env-file=.env.production scripts/observador-ia-desvio.mjs
import pg from "pg";

const BASE_URL = "https://datalayer.portalunitrac.com";
const OLLAMA_URL = "http://127.0.0.1:11434/api/generate";
const OLLAMA_MODEL = "llama3.2:3b";
const COD_USER_UNITRAC_NUTRY = "4096";

const VELOCIDADE_MIN_KMH = 5;
const ATRASO_MAX_MIN = 60;
const FETCH_TIMEOUT_MS = 15000;
const OLLAMA_TIMEOUT_MS = 45000;
// Teto de quantos veiculos observar por rodada -- inferencia em CPU e' lenta
// (~10-20s por veiculo); nao vale rodar a frota inteira de uma vez e
// competir com o motor real por CPU. Roda em lotes pequenos, com cadencia
// do agendador externo cuidando de cobrir a frota ao longo do tempo.
const MAX_VEICULOS_POR_RODADA = 10;

const pool = new pg.Pool({
  connectionString: process.env.DATABASE_URL,
  max: 1,
  connectionTimeoutMillis: 8000,
  query_timeout: 8000,
  statement_timeout: 8000,
});

function haversineM(lat1, lng1, lat2, lng2) {
  const R = 6371000;
  const toRad = (d) => (d * Math.PI) / 180;
  const dLat = toRad(lat2 - lat1);
  const dLng = toRad(lng2 - lng1);
  const a =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.sin(dLng / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(a));
}

async function fetchComTimeout(url, opts, timeoutMs = FETCH_TIMEOUT_MS) {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const res = await fetch(url, { ...opts, signal: ctrl.signal });
    if (!res.ok) throw new Error(`HTTP ${res.status} em ${url}`);
    return await res.json();
  } finally {
    clearTimeout(t);
  }
}

async function buscarPosicoes(cvs) {
  const data = await fetchComTimeout(`${BASE_URL}/mapa_servicos/posicoes/N/N`, {
    method: "POST",
    headers: { accept: "application/json", "content-type": "application/json" },
    body: JSON.stringify(cvs),
  });
  return data.Posicoes ?? [];
}

async function buscarAlvos(cvs) {
  const data = await fetchComTimeout(`${BASE_URL}/mapa_servicos/alvos`, {
    method: "POST",
    headers: { accept: "application/json", "content-type": "application/json" },
    body: JSON.stringify(cvs),
  });
  return data.alvos ?? [];
}

function normalizarPosicao(p) {
  return {
    cv: String(p.veicucodigo),
    placa: p.veicuplaca,
    lat: parseFloat(p.posiclatitude),
    lng: parseFloat(p.posiclongitude),
    velocidade: parseInt(p.posicvelocidade) || 0,
    ignicao: p.posicignicao === "1",
    atraso: parseInt(p.atraso) || 0,
  };
}

// Pergunta pro modelo local, em portugues simples, com os numeros ja
// calculados (nao pede pra ele fazer conta geometrica sozinho -- modelo
// pequeno e' ruim nisso, so pede opiniao sobre o que ja foi calculado).
async function perguntarOllama(situacao) {
  const prompt = `Você observa veículos de entrega em tempo real. Responda em UMA frase curta e direta, em português: você acha que este veículo está fazendo um desvio de rota suspeito, ou é um comportamento normal de entrega? Justifique em poucas palavras.

Placa: ${situacao.placa}
Velocidade atual: ${situacao.velocidade} km/h
Destino conhecido mais próximo: ${Math.round(situacao.distMinM)}m de distância
Nos últimos minutos, a distância até esse destino: ${situacao.piorando ? "AUMENTOU (se afastando)" : "diminuiu ou ficou igual (aproximando)"}
Total de destinos pendentes (entregas + bases): ${situacao.totalDestinos}`;

  const inicio = Date.now();
  const data = await fetchComTimeout(
    OLLAMA_URL,
    {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ model: OLLAMA_MODEL, prompt, stream: false }),
    },
    OLLAMA_TIMEOUT_MS
  );
  const tempoMs = Date.now() - inicio;
  const resposta = (data.response ?? "").trim();
  // Heuristica bem simples so pra popular achou_desvio (campo informativo,
  // NAO usado pra nada automatico) -- procura "sim"/"suspeito"/"desvio" no
  // inicio da resposta. Leitura humana do texto completo (opiniao_ia) e'
  // sempre a fonte real, este campo e' so pra facilitar filtro/contagem.
  const inicioResposta = resposta.toLowerCase().slice(0, 30);
  const achouDesvio = /\b(sim|suspeit|desvio)\b/.test(inicioResposta) && !/\bnão\b/.test(inicioResposta);
  return { resposta, tempoMs, achouDesvio };
}

async function main() {
  const agora = new Date().toLocaleTimeString("pt-BR");

  let veiculos, bases;
  try {
    ({ rows: veiculos } = await pool.query(
      `select v.id, v.cv, v.placa
       from veiculos v
       join clientes c on c.id = v.cliente_id
       where c.cod_user_unitrac = $1 and v.ativo`,
      [COD_USER_UNITRAC_NUTRY]
    ));
    ({ rows: bases } = await pool.query(
      `select b.id, ST_Y(ST_Centroid(b.geom::geometry)) as lat, ST_X(ST_Centroid(b.geom::geometry)) as lng
       from bases b
       join clientes c on c.id = b.cliente_id
       where c.cod_user_unitrac = $1`,
      [COD_USER_UNITRAC_NUTRY]
    ));
  } catch (e) {
    console.log(`[${agora}] ERRO ao consultar Postgres: ${e.message}`);
    await pool.end();
    return;
  }
  const destinosBase = bases.map((b) => ({ id: `base:${b.id}`, lat: b.lat, lng: b.lng }));

  if (veiculos.length === 0) {
    console.log(`[${agora}] Nenhum veiculo ativo encontrado para Nutry Max.`);
    await pool.end();
    return;
  }

  const cvs = veiculos.map((v) => v.cv);
  const porCv = new Map(veiculos.map((v) => [v.cv, v]));

  let posicoesBrutas, alvosBrutos;
  try {
    [posicoesBrutas, alvosBrutos] = await Promise.all([buscarPosicoes(cvs), buscarAlvos(cvs)]);
  } catch (e) {
    console.log(`[${agora}] ERRO ao consultar Unitrac: ${e.message}`);
    await pool.end();
    return;
  }

  const alvosPorPlaca = new Map();
  for (const a of alvosBrutos) {
    if (Number(a.alvosituacaoservico) !== 0) continue;
    const lat = parseFloat(a.pontolatitude);
    const lng = parseFloat(a.pontolongitude);
    if (!Number.isFinite(lat) || !Number.isFinite(lng)) continue;
    const id = `alvo:${a.pontocodigo ?? a.alvocodigo ?? `${lat.toFixed(5)},${lng.toFixed(5)}`}`;
    const lista = alvosPorPlaca.get(a.placa) ?? [];
    lista.push({ id, lat, lng });
    alvosPorPlaca.set(a.placa, lista);
  }

  const emRota = [];
  for (const posBruta of posicoesBrutas) {
    const pos = normalizarPosicao(posBruta);
    const veiculo = porCv.get(pos.cv);
    if (!veiculo) continue;
    const ok = pos.ignicao && pos.velocidade > VELOCIDADE_MIN_KMH && pos.atraso < ATRASO_MAX_MIN;
    if (!ok) continue;
    const alvos = alvosPorPlaca.get(pos.placa) ?? [];
    if (alvos.length === 0) continue;
    emRota.push({ veiculo, pos, destinos: [...alvos, ...destinosBase] });
  }

  console.log(`[${agora}] ${veiculos.length} ativo(s), ${emRota.length} em rota -- observando ate ${MAX_VEICULOS_POR_RODADA} nesta rodada`);

  const lote = emRota.slice(0, MAX_VEICULOS_POR_RODADA);
  for (const { veiculo, pos, destinos } of lote) {
    const distancias = destinos.map((d) => haversineM(pos.lat, pos.lng, d.lat, d.lng));
    const distMinM = Math.min(...distancias);

    // Sem estado entre rodadas (diferente do script de heuristica) -- "piorando"
    // aqui e' so informativo pro prompt, calculado comparando com a MENOR
    // distancia salva na ultima observacao deste veiculo (se houver, ultimas 15min).
    const { rows: ultimaObs } = await pool.query(
      `select dist_min_m from observacoes_ia_desvio
       where veiculo_id = $1 and criado_em > now() - interval '15 minutes'
       order by criado_em desc limit 1`,
      [veiculo.id]
    );
    const piorando = ultimaObs.length > 0 && distMinM > ultimaObs[0].dist_min_m;

    let opiniao;
    try {
      opiniao = await perguntarOllama({
        placa: veiculo.placa,
        velocidade: pos.velocidade,
        distMinM,
        piorando,
        totalDestinos: destinos.length,
      });
    } catch (e) {
      console.log(`  ${veiculo.placa}: ERRO no Ollama (${e.message}) -- pulando`);
      continue;
    }

    const { rows: alertaMotor } = await pool.query(
      `select 1 from alertas where tipo='desvio' and status in ('ativo','reconhecido') and veiculo_id = $1 limit 1`,
      [veiculo.id]
    );
    const motorApontou = alertaMotor.length > 0;

    await pool.query(
      `insert into observacoes_ia_desvio
         (veiculo_id, placa, lat, lng, dist_min_m, ciclos_piorando, opiniao_ia, achou_desvio, motor_apontou_desvio, tempo_resposta_ms)
       values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)`,
      [veiculo.id, veiculo.placa, pos.lat, pos.lng, distMinM, piorando ? 1 : 0, opiniao.resposta, opiniao.achouDesvio, motorApontou, opiniao.tempoMs]
    );

    console.log(
      `  ${veiculo.placa}: IA=${opiniao.achouDesvio ? "SUSPEITO" : "normal"} | motor=${motorApontou ? "desvio ativo" : "sem alerta"} | ${opiniao.tempoMs}ms | "${opiniao.resposta.slice(0, 80)}"`
    );
  }

  await pool.end();
}

const watchdog = setTimeout(() => {
  console.error("Watchdog: script excedeu 10min, forcando saida.");
  process.exit(1);
}, 600000);

main()
  .catch(async (e) => {
    console.error("Erro fatal:", e);
    try {
      await pool.end();
    } catch {}
    process.exit(1);
  })
  .finally(() => clearTimeout(watchdog));
