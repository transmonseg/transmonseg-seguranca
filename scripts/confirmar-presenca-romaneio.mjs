// scripts/confirmar-presenca-romaneio.mjs
//
// Confirma presenca em romaneio_pontos usando SO o historico de GPS real +
// a coordenada geocodificada do proprio romaneio -- sem depender de
// pontoCodigo/alvo da Unitrac. Fecha o buraco achado 11/08 (grupo do
// WhatsApp, audios): clientes sem cadastro na Unitrac tem bolinha no mapa
// (ja existia desde 01/08, ver api/alvos/route.ts) mas NUNCA viravam
// "entregue" -- a unica confirmacao existente (presencaConfirmadaCiclo, no
// motor ao vivo) exige alvoNoRaioAgora?.documento, que so existe quando ha
// alvo real da Unitrac.
//
// Desenhado como job PERIODICO separado (cron), nao como mudanca no motor
// ao vivo -- mesmo raciocinio de aprender_pontos_entrega() (migration 028):
// mais seguro mexer num job isolado que le e escreve uma coisa so, do que
// alterar a maquina de estado do motor (ja mexida 3x hoje, cada mudanca la
// teve efeito colateral real). "Automatico" pro usuario nao precisa ser
// no mesmo ciclo do motor -- rodar a cada poucos minutos ja atende.
//
// Generico por desenho (achado real 11/08, audio do cliente: "esse sistema
// vai servir outras empresas... nao sei como o sistema vai identificar de
// outra escala... por isso tem que ser endereco"): usa SO lat/lng
// geocodificado do romaneio + raio fixo, nada especifico de Nutry Max --
// funciona pra qualquer cliente/veiculo que tenha romaneio_pontos com
// coordenada.
import pg from "pg";
import { pathToFileURL } from "node:url";

const DATABASE_URL =
  process.env.DATABASE_URL ??
  "postgres://app_service:5cf0fd1c8cfc0dfdf66a19196d5e6ebc691bbc628d7e637c@localhost:5432/transmonseg";

// Mesmos limiares do motor ao vivo (raio nominal de entrega, dwell minimo
// pra "parou de verdade" -- ver BYPASS_ENTREGA_DWELL_MINIMO_SEGUNDOS em
// src/lib/detectores.ts). Duplicado aqui de proposito: este script roda
// fora do Next.js, sem acesso a src/lib/*.ts (mesmo padrao ja usado por
// scripts/ingerir-*.mjs).
// Corrigido 18/08 (Fase 2): era 50m, mas o motor ao vivo usa
// Math.max(pt.raio, RAIO_CHEGADA_MIN_M=300) desde 01/08 -- achado real:
// so 46% das paradas reais caem dentro de 100m do ponto nominal
// geocodificado. Endereco geocodificado (nunca casado por NF/placa real
// como o alvo Unitrac) e' por natureza menos preciso -- usar o mesmo piso
// de 300m do motor, nao o valor antigo de 50m.
// Corrigido 30/08 (achado real): auditoria dos 396 pendentes de 29/08 achou
// 69 casos (17%) com parada real a 296-497m do ponto -- faixa perdida pelo
// piso de 300m. Caso confirmado TOS2B69/SUPERMERCADO BOM PRECO (ITABORAI,
// relatorio Unitrac mostra parada na rua, fora do raio do cliente). Subido
// pra 500m (RAIO_PRESENCA_MIN_M em motor/route.ts), decoupled do piso de
// SUPRESSAO DE DESVIO (RAIO_CHEGADA_MIN_M em unitrac.ts, fica em 300m).
const RAIO_PADRAO_M = 500;
const DWELL_MINIMO_SEGUNDOS = 120;
const VELOCIDADE_MAX_PARADO_KMH = 5;
// So processa romaneios dos ultimos N dias -- historico antigo ja teve
// tempo de ser confirmado (ou nao vai ser, se o caminhao nunca passou la).
const JANELA_DIAS = 3;

function haversineM(lat1, lng1, lat2, lng2) {
  const R = 6371000;
  const p1 = (lat1 * Math.PI) / 180, p2 = (lat2 * Math.PI) / 180;
  const dp = ((lat2 - lat1) * Math.PI) / 180, dl = ((lng2 - lng1) * Math.PI) / 180;
  const a = Math.sin(dp / 2) ** 2 + Math.cos(p1) * Math.cos(p2) * Math.sin(dl / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(a));
}

const FONTES_GEOCODIFICADAS = new Set(["cnefe", "nominatim", "google", "local"]);

// Extraida do loop original (ver Step 4) -- mesma logica de streak, so
// que agora tambem acumula a posicao media real (lat/lng) da sequencia
// vencedora, pra poder corrigir/confirmar romaneio_cliente_codigo_geocode
// com onde o veiculo REALMENTE parou (Fase 2), nao so o timestamp de
// presenca (que ja existia, ver header do arquivo).
//
// Achado real 30/08 (auditoria "pendente demais" no grupo KPI AJUSTES):
// dwellAtualS incrementava +30s FIXO por leitura qualificada -- MESMO bug
// ja corrigido em src/app/api/motor/route.ts (achado TOS-1H26, 28/08),
// mas este script roda FORA do Next.js (sem import de lib nenhuma, ver
// header do arquivo) entao o fix de la' nunca chegou aqui. A cadencia
// real de posicoes_historico varia (30s a 60s+, nunca fixa) -- 30s fixo
// SUBESTIMA o dwell real sempre que a cadencia real e' maior, empurrando
// paradas genuinamente >=120s pra baixo do limiar. Medido em producao:
// ~1700 entregas com parada real medida em minutos (ate 33min, 0m de
// distancia) continuavam "pendente" porque o crontab deste script tinha
// ficado apontando pra um diretorio removido por 2 dias (ver commit) --
// nesse meio tempo NENHUMA leitura nova era feita, entao o bug de +30s
// fixo nao tinha nem chance de aparecer isolado; destravado o cron, ele
// ficou visivel: mesmo rodando, boa parte do backlog nao confirmava por
// causa deste calculo. Agora usa o tempo real decorrido entre a leitura
// atual e a anterior (ambas ja "dentro"), nao mais um incremento fixo.
export function calcularStreakMaximoComPosicao(trilha, pontoLat, pontoLng, raioM, velMaxKmh, dwellMinimoS) {
  let dwellAtualS = 0;
  let dwellMaxS = 0;
  let somaLat = 0, somaLng = 0, contagem = 0;
  let somaLatMax = 0, somaLngMax = 0, contagemMax = 0;
  let entrouEm = null;

  for (let i = 0; i < trilha.length; i++) {
    const ponto = trilha[i];
    const dentro = haversineM(ponto.lat, ponto.lng, pontoLat, pontoLng) <= raioM && ponto.velocidade <= velMaxKmh;
    if (dentro) {
      if (entrouEm === null) {
        entrouEm = i;
        dwellAtualS = 0;
        somaLat = 0; somaLng = 0; contagem = 0;
      } else {
        const dtS = (new Date(ponto.criado_em).getTime() - new Date(trilha[i - 1].criado_em).getTime()) / 1000;
        dwellAtualS += dtS > 0 ? dtS : 0;
      }
      somaLat += ponto.lat; somaLng += ponto.lng; contagem++;
      if (dwellAtualS > dwellMaxS) {
        dwellMaxS = dwellAtualS;
        somaLatMax = somaLat; somaLngMax = somaLng; contagemMax = contagem;
      }
    } else {
      entrouEm = null;
      dwellAtualS = 0;
    }
  }

  if (dwellMaxS < dwellMinimoS || contagemMax === 0) {
    return { dwellMaxS, posicaoReal: null };
  }
  return { dwellMaxS, posicaoReal: { lat: somaLatMax / contagemMax, lng: somaLngMax / contagemMax } };
}

// Decide a proxima escrita em romaneio_cliente_codigo_geocode dado o
// estado atual (null se a linha nao existe ainda) e a posicao real
// confirmada por dwell. Ver design doc, secao "Decisao", item 3.
export function proximaEscritaCache(existente, posicaoReal) {
  if (existente === null) {
    return { lat: posicaoReal.lat, lng: posicaoReal.lng, fonte: "dwell_confirmado", n_observacoes: 1, novaLinha: true };
  }
  if (FONTES_GEOCODIFICADAS.has(existente.fonte)) {
    return { lat: posicaoReal.lat, lng: posicaoReal.lng, fonte: "dwell_confirmado", n_observacoes: 1, novaLinha: false };
  }
  // ja e dwell_confirmado -- media ponderada
  const n = existente.n_observacoes;
  return {
    lat: (existente.lat * n + posicaoReal.lat) / (n + 1),
    lng: (existente.lng * n + posicaoReal.lng) / (n + 1),
    fonte: "dwell_confirmado",
    n_observacoes: n + 1,
    novaLinha: false,
  };
}

const DRY_RUN = process.argv.includes("--dry-run");

async function main() {
  const pool = new pg.Pool({ connectionString: DATABASE_URL });

  const { rows: pendentes } = await pool.query(
    `SELECT id, veiculo_id, nf, romaneio_data, lat, lng, cliente_codigo
       FROM romaneio_pontos
      WHERE presenca_confirmada_em IS NULL
        AND lat IS NOT NULL AND lng IS NOT NULL
        AND romaneio_data >= current_date - $1::int
        AND romaneio_data <= current_date + 1`,
    [JANELA_DIAS]
  );
  console.log(`${pendentes.length} pontos de romaneio sem presenca confirmada, na janela de ${JANELA_DIAS} dias.`);

  // Busca cliente_id por veiculo_id em lote (uma query so), antes do loop
  // principal -- evita N queries repetidas pro mesmo veiculo (mesmo padrao
  // de trilhaPorChave abaixo). Usado pra escrever no cache de geocode por
  // (cliente_id, cliente_codigo).
  const veiculoIdsUnicos = [...new Set(pendentes.map((p) => p.veiculo_id).filter(Boolean))];
  const clienteIdPorVeiculo = new Map();
  if (veiculoIdsUnicos.length > 0) {
    const { rows: veiculosRows } = await pool.query(
      `SELECT id, cliente_id FROM veiculos WHERE id = ANY($1::uuid[])`,
      [veiculoIdsUnicos]
    );
    for (const v of veiculosRows) clienteIdPorVeiculo.set(v.id, v.cliente_id);
  }

  // Agrupa por (veiculo_id, dia) e busca a trilha UMA VEZ por par --
  // muitos pontos do mesmo romaneio compartilham veiculo+dia. Achado real
  // 11/08: versao original buscava a trilha por PONTO (uma query por NF),
  // com milhares de pontos pendentes isso nao terminava em tempo
  // razoavel -- mesma trilha sendo buscada dezenas de vezes.
  const trilhaPorChave = new Map();
  async function trilhaDoDia(veiculoId, dia) {
    const chave = `${veiculoId}:${dia}`;
    if (trilhaPorChave.has(chave)) return trilhaPorChave.get(chave);
    const { rows } = await pool.query(
      `SELECT lat, lng, velocidade, criado_em FROM posicoes_historico
        WHERE veiculo_id = $1
          AND (criado_em AT TIME ZONE 'America/Sao_Paulo')::date = $2::date
        ORDER BY criado_em ASC`,
      [veiculoId, dia]
    );
    trilhaPorChave.set(chave, rows);
    return rows;
  }

  let confirmados = 0;
  let processados = 0;
  for (const p of pendentes) {
    processados++;
    if (processados % 500 === 0) console.log(`  ${processados}/${pendentes.length}... (${trilhaPorChave.size} trilhas em cache)`);

    const trilha = await trilhaDoDia(p.veiculo_id, p.romaneio_data);
    if (trilha.length === 0) continue;

    // Dwell: maior sequencia CONSECUTIVA de leituras dentro do raio E com
    // velocidade baixa. Nao precisa ser a MESMA leitura sempre parada no
    // pixel exato -- so dentro do raio de entrega, devagar, por tempo
    // suficiente. Estima segundos pela diferenca real entre leituras (nao
    // conta leitura fixa) -- posicoes_historico nao tem cadencia fixa.
    // Usa a funcao extraida (Task 1, testada) -- tambem devolve a posicao
    // media real (posicaoReal) da sequencia vencedora, pra corrigir o
    // cache de geocode com onde o veiculo REALMENTE parou (Fase 2).
    const { dwellMaxS, posicaoReal } = calcularStreakMaximoComPosicao(
      trilha, p.lat, p.lng, RAIO_PADRAO_M, VELOCIDADE_MAX_PARADO_KMH, DWELL_MINIMO_SEGUNDOS
    );

    if (dwellMaxS >= DWELL_MINIMO_SEGUNDOS && posicaoReal !== null) {
      let sufixoCache = "";
      let proxima = null;
      const clienteId = clienteIdPorVeiculo.get(p.veiculo_id);
      if (clienteId && p.cliente_codigo) {
        const { rows: cacheRows } = await pool.query(
          `SELECT lat, lng, fonte, n_observacoes FROM romaneio_cliente_codigo_geocode WHERE cliente_id = $1 AND cliente_codigo = $2`,
          [clienteId, p.cliente_codigo]
        );
        const existente = cacheRows[0] ?? null;
        proxima = proximaEscritaCache(existente, posicaoReal);
        sufixoCache = proxima.novaLinha ? " [cache: nova ancora]" : existente && existente.fonte === "dwell_confirmado" ? ` [cache: media atualizada, n=${proxima.n_observacoes}]` : " [cache: corrigido de geocodificacao pra dwell real]";
      }

      // As 2 escritas (upsert do cache + update de presenca) precisam
      // acontecer juntas, numa transacao -- se o processo morresse entre
      // uma e outra (2 pool.query() separadas, sem transacao), o proximo
      // ciclo reprocessaria este ponto (presenca_confirmada_em ainda NULL),
      // recalcularia a MESMA posicaoReal, e chamaria proximaEscritaCache de
      // novo -- so que agora existente.fonte ja seria "dwell_confirmado"
      // (da escrita anterior que teve sucesso), caindo no ramo de media
      // ponderada CONTRA SI MESMA (mesma trilha, mesmo dado), inflando
      // n_observacoes por uma unica observacao fisica real. BEGIN/COMMIT
      // garantem que ou as duas escritas acontecem juntas, ou nenhuma.
      if (!DRY_RUN) {
        const client = await pool.connect();
        try {
          await client.query("BEGIN");
          if (proxima) {
            await client.query(
              `INSERT INTO romaneio_cliente_codigo_geocode (cliente_id, cliente_codigo, lat, lng, fonte, n_observacoes, primeira_observacao, ultima_observacao)
               VALUES ($1, $2, $3, $4, $5, $6, current_date, current_date)
               ON CONFLICT (cliente_id, cliente_codigo) DO UPDATE SET
                 lat = EXCLUDED.lat, lng = EXCLUDED.lng, fonte = EXCLUDED.fonte,
                 n_observacoes = EXCLUDED.n_observacoes, ultima_observacao = current_date`,
              [clienteId, p.cliente_codigo, proxima.lat, proxima.lng, proxima.fonte, proxima.n_observacoes]
            );
          }
          await client.query(
            `UPDATE romaneio_pontos SET presenca_confirmada_em = now() WHERE id = $1 AND presenca_confirmada_em IS NULL`,
            [p.id]
          );
          await client.query("COMMIT");
        } catch (err) {
          await client.query("ROLLBACK");
          throw err;
        } finally {
          client.release();
        }
      }
      confirmados++;
      const prefixo = DRY_RUN ? "[dry-run] Confirmaria" : "Confirmado";
      console.log(`${prefixo}: veiculo=${p.veiculo_id} nf=${p.nf} dia=${p.romaneio_data.toISOString().slice(0,10)} dwell~${dwellMaxS}s${sufixoCache}`);
    }
  }

  console.log(`\n${confirmados} presencas ${DRY_RUN ? "seriam confirmadas (dry-run, nada gravado)" : "confirmadas neste ciclo"}.`);
  await pool.end();
}

// Guarda de entrypoint: so roda main() quando o arquivo e executado
// diretamente (node scripts/confirmar-presenca-romaneio.mjs), nao quando
// e importado (ex.: pelo teste, que importa pra pegar as 2 funcoes
// exportadas). Usa pathToFileURL em vez de montar `file://${argv[1]}` na
// mao -- argv[1] pode vir relativo (ex.: `node scripts/foo.mjs`, invocacao
// usada de verdade neste repo, ver docs/superpowers/plans/2026-08-11-*)
// e o path deste projeto tem espaco ("MONITORAMENTO TEMP"), que precisa
// ser %20-encoded pra bater com import.meta.url -- comparacao ingenua
// falha silenciosamente nos dois casos (main() nunca roda, sem erro).
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((err) => {
    console.error(err);
    process.exit(1);
  });
}
