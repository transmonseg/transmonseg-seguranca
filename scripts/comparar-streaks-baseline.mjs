// Investigacao pontual (29/08): quantificar o flapping de
// `baseline_veiculo` e escolher o limiar de streak com dado real, mesmo
// metodo usado em 16/08 pro streak de desvio (comparar-streaks-desvio-v2).
//
// Replay fiel do que o motor faz por ciclo com o baseline comportamental:
// bucketiza posicoes_historico por criado_em (todas as linhas de um ciclo
// compartilham o now() da transacao do INSERT em lote), detecta a anomalia
// contra o snapshot de baseline do INICIO do ciclo, e so DEPOIS aplica as
// amostras admitidas (mesma ordem do motor: deteccao -> flush). Reusa as
// funcoes PURAS de src/lib (Welford, z-score, admissao, tipo de viagem) --
// nao reimplementa nenhuma delas.
//
// Entrada: CSV de posicoes_historico de UM cliente (baseline_frota e' por
// cliente, entao um cliente por rodada e' exato), colunas:
//   veiculo_id,epoch_segundos,velocidade,atraso_min
// gerado por:
//   ssh transmonseg-vps "sudo -u postgres psql -d transmonseg -q -c \
//     \"COPY (SELECT p.veiculo_id, extract(epoch from p.criado_em)::bigint, \
//        p.velocidade, p.atraso_min FROM posicoes_historico p \
//        JOIN veiculos v ON v.id=p.veiculo_id WHERE v.cliente_id='<uuid>' \
//        AND p.criado_em >= now() - interval '8 days' ORDER BY p.criado_em) \
//      TO STDOUT WITH CSV\"" > cliente.csv
//
// Uso: node scripts/comparar-streaks-baseline.mjs cliente.csv [dias_warmup]
import fs from "node:fs";
import readline from "node:readline";
import {
  atualizarBaselineWelford,
  zScoreBaseline,
  decidirAdmissaoBaseline,
  classificarTipoViagem,
  BASELINE_FROTA_N_MAXIMO,
  BASELINE_MIN_AMOSTRAS_PROPRIO,
} from "../src/lib/baseline-veiculo.ts";
import { avaliarStreakBaseline, LIMIAR_STREAK_BASELINE } from "../src/lib/detectores.ts";

// Mesmos valores de detectores.ts (nao exportados de la; espelhados aqui de
// proposito pra este script nao depender de mudar a assinatura do detector).
const BASELINE_MIN_AMOSTRAS_FROTA = 20;
const BASELINE_Z_LIMIAR = 3;
const LIMIAR_ATRASO_FRESCO_MIN = 60;

const arquivo = process.argv[2];
if (!arquivo) {
  console.error("Uso: node scripts/comparar-streaks-baseline.mjs <csv> [dias_warmup]");
  process.exit(1);
}
const DIAS_WARMUP = Number(process.argv[3] ?? 2);

const LIMIARES = [1, 2, 3, 4];
// Duas politicas de reset pro ciclo NAO avaliavel (veiculo parado ou leitura
// velha) -- a diferenca entre elas e' exatamente o quanto o streak "aguenta"
// um buraco de sinal no meio de uma anomalia real.
//   "preserva": so zera quando o ciclo FOI avaliado e nao deu anomalia.
//   "zera":     zera em qualquer ciclo que nao dispare anomalia.
const POLITICAS = ["preserva", "zera"];

const baselineVeic = new Map(); // `${veic}:${tipo}` -> {n,media,variancia,excluidaDesde}
const baselineFrota = new Map(); // tipo -> {n,media,variancia}
// estado[politica].get(`${limiar}:${veic}`) = {streak, direcao}
const estado = new Map();
for (const p of POLITICAS) estado.set(p, new Map());
// disparos[politica][limiar] = Map(diaISO -> n)
const disparos = new Map();
for (const p of POLITICAS) disparos.set(p, new Map(LIMIARES.map((l) => [l, new Map()])));
// episodios[politica][limiar] = n de transicoes "nao disparava -> disparou"
const episodios = new Map();
for (const p of POLITICAS) episodios.set(p, new Map(LIMIARES.map((l) => [l, 0])));
const disparava = new Map();
for (const p of POLITICAS) disparava.set(p, new Map());
// Distribuicao do comprimento das corridas de anomalia consecutiva (politica
// "preserva") -- o numero que de fato decide o limiar.
const corridas = new Map();
const corridaAtual = new Map(); // veic -> {len, direcao}
// Controle com o codigo de producao (avaliarStreakBaseline) rodando lado a
// lado com a simulacao inline.
const estadoReal = new Map();
let disparosReais = 0;
let ciclos = 0;
let linhas = 0;
let avaliaveis = 0;
let anomalias = 0;
let veicSet = new Set();

function diaDe(epoch) {
  return new Date(epoch * 1000).toISOString().slice(0, 10);
}

function inc(mapa, chave) {
  mapa.set(chave, (mapa.get(chave) ?? 0) + 1);
}

let inicioEpoch = null;
let fimWarmup = null;

function processarCiclo(cicloRows, epoch) {
  ciclos++;
  const dia = diaDe(epoch);
  const contando = fimWarmup !== null && epoch >= fimWarmup;
  const admitidas = [];

  for (const r of cicloRows) {
    const { veiculo, velocidade, atraso } = r;
    veicSet.add(veiculo);
    const fresco = atraso < LIMIAR_ATRASO_FRESCO_MIN;
    const avaliavel = fresco && velocidade > 0;

    let ehAnomalia = false;
    let direcao = null;
    let tipo = null;
    let usaProprio = false;
    let bp = null;

    if (avaliavel) {
      avaliaveis++;
      tipo = classificarTipoViagem(velocidade);
      bp = baselineVeic.get(`${veiculo}:${tipo}`) ?? { n: 0, media: 0, variancia: 0, excluidaDesde: null };
      const bf = baselineFrota.get(tipo) ?? { n: 0, media: 0, variancia: 0 };
      usaProprio = bp.n >= BASELINE_MIN_AMOSTRAS_PROPRIO;
      const baseline = usaProprio ? bp : bf;
      const minAmostras = usaProprio ? BASELINE_MIN_AMOSTRAS_PROPRIO : BASELINE_MIN_AMOSTRAS_FROTA;
      const z = zScoreBaseline(velocidade, baseline, minAmostras);
      if (z !== null && Number.isFinite(z) && Math.abs(z) >= BASELINE_Z_LIMIAR) {
        ehAnomalia = true;
        direcao = z > 0 ? "alta" : "baixa";
      }
      if (ehAnomalia) anomalias++;
    }

    // --- streaks (as 2 politicas, os 4 limiares, no mesmo passe) ---
    for (const politica of POLITICAS) {
      const st = estado.get(politica);
      for (const limiar of LIMIARES) {
        const chave = `${limiar}:${veiculo}`;
        const atual = st.get(chave) ?? { streak: 0, direcao: null };
        let novo;
        if (ehAnomalia) {
          novo = {
            streak: atual.direcao === direcao ? atual.streak + 1 : 1,
            direcao,
          };
        } else if (politica === "zera" || avaliavel) {
          novo = { streak: 0, direcao: null };
        } else {
          novo = atual;
        }
        st.set(chave, novo);
        // O motor so' avalia (e so' pode alertar) quando o ciclo e'
        // avaliavel E anomalo -- streak preservado num buraco de sinal nao
        // dispara nada sozinho, so' evita perder a contagem.
        const dispara = ehAnomalia && novo.streak >= limiar;
        if (dispara && contando) {
          inc(disparos.get(politica).get(limiar), dia);
          const antes = disparava.get(politica).get(chave) ?? false;
          if (!antes) episodios.get(politica).set(limiar, episodios.get(politica).get(limiar) + 1);
        }
        disparava.get(politica).set(chave, dispara);
      }
    }

    // --- controle: o CODIGO DE PRODUCAO de verdade, no mesmo passe ---
    // Se este numero nao bater com "preserva/limiar=LIMIAR_STREAK_BASELINE"
    // acima, a simulacao esta mentindo sobre o que foi implementado.
    if (avaliavel) {
      const anteriorReal = estadoReal.get(veiculo) ?? { streak: 0, direcao: null };
      const r = avaliarStreakBaseline(
        {
          velocidadeMediaViagemKmh: velocidade,
          baselineProprio: bp,
          baselineFrota: baselineFrota.get(tipo) ?? { n: 0, media: 0, variancia: 0 },
          minAmostrasProprio: BASELINE_MIN_AMOSTRAS_PROPRIO,
        },
        anteriorReal
      );
      estadoReal.set(veiculo, r.estado);
      if (r.alerta !== null && contando) disparosReais++;
    }

    // --- distribuicao de comprimento de corrida (politica "preserva") ---
    const c = corridaAtual.get(veiculo) ?? { len: 0, direcao: null };
    if (ehAnomalia) {
      corridaAtual.set(veiculo, {
        len: c.direcao === direcao ? c.len + 1 : 1,
        direcao,
      });
    } else if (avaliavel) {
      if (c.len > 0 && contando) inc(corridas, c.len);
      corridaAtual.set(veiculo, { len: 0, direcao: null });
    }

    // --- admissao no baseline (identica ao motor: usa a anomalia CRUA) ---
    if (avaliavel) {
      const decisao = decidirAdmissaoBaseline({
        usaBaselineProprio: usaProprio,
        ehAnomalia,
        excluidaDesde: bp.excluidaDesde,
        agora: new Date(epoch * 1000),
      });
      if (decisao.admitir) {
        admitidas.push({ veiculo, tipo, velocidade });
      } else if (decisao.marcarExclusaoAgora) {
        baselineVeic.set(`${veiculo}:${tipo}`, { ...bp, excluidaDesde: new Date(epoch * 1000).toISOString() });
      }
    }
  }

  // Flush do ciclo (mesma ordem/semantica do motor)
  for (const a of admitidas) {
    const chave = `${a.veiculo}:${a.tipo}`;
    const atual = baselineVeic.get(chave) ?? { n: 0, media: 0, variancia: 0, excluidaDesde: null };
    baselineVeic.set(chave, { ...atualizarBaselineWelford(atual, a.velocidade), excluidaDesde: null });
    const atualF = baselineFrota.get(a.tipo) ?? { n: 0, media: 0, variancia: 0 };
    baselineFrota.set(a.tipo, atualizarBaselineWelford(atualF, a.velocidade, BASELINE_FROTA_N_MAXIMO));
  }
}

const rl = readline.createInterface({ input: fs.createReadStream(arquivo), crlfDelay: Infinity });
let cicloEpoch = null;
let cicloRows = [];
for await (const linha of rl) {
  if (!linha) continue;
  linhas++;
  const [veiculo, ep, vel, atr] = linha.split(",");
  const epoch = Number(ep);
  if (inicioEpoch === null) {
    inicioEpoch = epoch;
    fimWarmup = inicioEpoch + DIAS_WARMUP * 86400;
  }
  if (cicloEpoch !== null && epoch !== cicloEpoch) {
    processarCiclo(cicloRows, cicloEpoch);
    cicloRows = [];
  }
  cicloEpoch = epoch;
  cicloRows.push({ veiculo, velocidade: Number(vel), atraso: Number(atr) });
}
if (cicloRows.length > 0) processarCiclo(cicloRows, cicloEpoch);

const diasMedidos = [...disparos.get("preserva").get(1).keys()].sort();
console.log(`Linhas: ${linhas} | ciclos: ${ciclos} | veiculos: ${veicSet.size}`);
console.log(`Ciclos avaliaveis (fresco && vel>0): ${avaliaveis} | anomalias cruas: ${anomalias} (${((anomalias / avaliaveis) * 100).toFixed(2)}%)`);
console.log(`Warmup: ${DIAS_WARMUP} dia(s). Dias medidos: ${diasMedidos.join(", ")}`);
console.log("");
for (const politica of POLITICAS) {
  console.log(`### politica de reset: ${politica}`);
  console.log("limiar | disparos_totais | por_dia | episodios | reducao_vs_streak1");
  const base = [...disparos.get(politica).get(1).values()].reduce((a, b) => a + b, 0);
  for (const limiar of LIMIARES) {
    const total = [...disparos.get(politica).get(limiar).values()].reduce((a, b) => a + b, 0);
    const porDia = (total / diasMedidos.length).toFixed(0);
    const ep = episodios.get(politica).get(limiar);
    const red = base > 0 ? (100 - (total / base) * 100).toFixed(1) : "-";
    console.log(`${limiar}      | ${total} | ${porDia} | ${ep} | ${red}%`);
  }
  console.log("");
}
console.log(`### controle: src/lib/detectores.ts avaliarStreakBaseline (LIMIAR_STREAK_BASELINE=${LIMIAR_STREAK_BASELINE})`);
console.log(`disparos: ${disparosReais} (deve bater com preserva/limiar=${LIMIAR_STREAK_BASELINE} acima)`);
console.log("");
console.log("### comprimento das corridas de anomalia consecutiva (mesma direcao)");
const tot = [...corridas.values()].reduce((a, b) => a + b, 0);
let acum = 0;
for (const len of [...corridas.keys()].sort((a, b) => a - b)) {
  const n = corridas.get(len);
  acum += n;
  console.log(`len=${len}: ${n} corridas (${((n / tot) * 100).toFixed(2)}%) | acumulado ${((acum / tot) * 100).toFixed(2)}%`);
}
console.log(`total de corridas: ${tot}`);
