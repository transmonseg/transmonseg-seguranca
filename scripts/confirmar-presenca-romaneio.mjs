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

function databaseUrl() {
  const url = process.env.DATABASE_URL;
  if (!url) throw new Error("DATABASE_URL não definida (use --env-file=.env.production)");
  return url;
}

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
export const RAIO_PADRAO_M = 500;
// Achado real 30/08 (auditoria dos 396 pendentes de 29/08, bucket 500m-2km):
// 27% (40 de 150) sao o MESMO caminhao fazendo UMA parada real que serve
// VARIOS clientes vizinhos (caso mais claro: TTM-2G02 entregando 4 pontos
// diferentes na Estrada da Gavea/Rocinha a partir da mesma parada, cada um
// a 545-830m do proprio geocode -- rua estreita, caminhao nao entra,
// entrega a pe). Nenhum aumento de raio POR PONTO resolve isso sozinho:
// cada ponto teria que ter um raio absurdo pra alcancar a parada real, o
// que criaria falso positivo com qualquer parada aleatoria perto.
// Corroboracao por vizinhanca: se OUTRO ponto do MESMO romaneio
// (veiculo+dia) ja foi confirmado (por dwell direto ou por esta mesma
// vizinhanca) e esta a <=RAIO_VIZINHANCA_M do geocode deste ponto ainda
// pendente, confirma tambem -- evidencia real e' "o caminhao esteve
// comprovadamente nesta area hoje", nao um palpite de raio generico.
// NAO escreve em romaneio_cliente_codigo_geocode (a posicao "emprestada"
// do vizinho nao e o local real DESTE cliente -- so serve pra tirar do
// pendente/mapa, nunca pra aprender geocode errado).
const RAIO_VIZINHANCA_M = 800;
export const DWELL_MINIMO_SEGUNDOS = 120;
export const VELOCIDADE_MAX_PARADO_KMH = 5;
// So processa romaneios dos ultimos N dias -- historico antigo ja teve
// tempo de ser confirmado (ou nao vai ser, se o caminhao nunca passou la).
const JANELA_DIAS = 3;

export function haversineM(lat1, lng1, lat2, lng2) {
  const R = 6371000;
  const p1 = (lat1 * Math.PI) / 180, p2 = (lat2 * Math.PI) / 180;
  const dp = ((lat2 - lat1) * Math.PI) / 180, dl = ((lng2 - lng1) * Math.PI) / 180;
  const a = Math.sin(dp / 2) ** 2 + Math.cos(p1) * Math.cos(p2) * Math.sin(dl / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(a));
}

// F4-11 (GEO-08): "cnefe_similaridade" e' o CNEFE por nome parecido (antes
// gravado como "cnefe") -- continua geocodificacao, troca pelo dwell real.
// F4-02 (GEO-29), achado 23/10: faltavam photon, photon_rua e
// unitrac_aprendido (e cnefe_bairro, que a cascata tambem grava). A ancora
// dessas fontes caia no ramo de MEDIA com o dwell e nascia "dwell n=2" no
// mesmo dia (RQ: 2.824 de 3.590 ancoras n>=2; Nutry: 713 com n=2 e
// primeira=ultima observacao) -- metade texto, metade parada real.
export const FONTES_GEOCODIFICADAS = new Set([
  "cnefe", "cnefe_similaridade", "cnefe_bairro", "nominatim", "google", "local",
  "photon", "photon_rua", "unitrac_aprendido",
]);

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

// Chave de endereco do cache de geocode -- MESMA normalizacao de
// normalizarEndereco() em src/lib/romaneio-geocode.ts. Duplicada aqui pelo
// mesmo motivo dos limiares acima: este script roda fora do Next.js, sem
// acesso a src/lib/*.ts. Se um dia divergir, o efeito e MISS de cache
// (recomputa/regrava por endereco), nunca hit em ancora de outro endereco.
export function normalizarEnderecoChave(enderecoBruto) {
  return (enderecoBruto ?? "").trim().toUpperCase().replace(/\s+/g, " ");
}

// Guarda de divergencia (31/08): mesmo com a chave por endereco (migration
// 069), a media ponderada so faz sentido entre paradas do MESMO lugar. Uma
// posicao real a mais de DIVERGENCIA_MAX_M da ancora ja gravada nao e "a
// mesma parada medida de novo" -- e outro lugar (GPS ruim, endereco
// ambiguo, ponto emprestado). Nesses casos nao escreve nada: mantem a
// ancora existente. Vale como cinto de seguranca do rechaveamento -- foi
// exatamente esse ramo de media que produziu a coordenada envenenada da
// NUTRIMED (~60km de qualquer endereco real, ver migration 069).
export const DIVERGENCIA_MAX_M = 2000;

// Decide a proxima escrita em romaneio_cliente_codigo_geocode dado o
// estado atual (null se a linha nao existe ainda) e a posicao real
// confirmada por dwell. Ver design doc, secao "Decisao", item 3.
// Retorna null quando a decisao e NAO escrever.
//
// F4-02: `dia` e' o dia do romaneio (YYYY-MM-DD). n_observacoes passa a
// contar DIAS com parada real: so' soma quando o dia e' posterior a
// ultima_observacao (duas NFs do mesmo cliente no mesmo dia, ou a mesma NF
// recontada, sao UMA observacao). Fonte que nao e' geocodificacao nem
// dwell (manual, verificacao_manual, cadastro_unitrac... -- D-34: manual >
// cadastro Unitrac com parada > dwell) nunca e' tocada pelo dwell, e fonte
// desconhecida tambem nao (antes caia na media e virava "dwell n=2").
export function proximaEscritaCache(existente, posicaoReal, dia) {
  if (existente === null) {
    return { lat: posicaoReal.lat, lng: posicaoReal.lng, fonte: "dwell_confirmado", n_observacoes: 1, novaLinha: true };
  }
  if (FONTES_GEOCODIFICADAS.has(existente.fonte)) {
    return { lat: posicaoReal.lat, lng: posicaoReal.lng, fonte: "dwell_confirmado", n_observacoes: 1, novaLinha: false };
  }
  if (existente.fonte !== "dwell_confirmado") return null;
  if (dia && existente.ultima_observacao && String(existente.ultima_observacao).slice(0, 10) >= dia) {
    return null;
  }
  // ja e dwell_confirmado -- media ponderada, mas so se for o mesmo lugar
  if (haversineM(existente.lat, existente.lng, posicaoReal.lat, posicaoReal.lng) > DIVERGENCIA_MAX_M) {
    return null;
  }
  const n = existente.n_observacoes;
  return {
    lat: (existente.lat * n + posicaoReal.lat) / (n + 1),
    lng: (existente.lng * n + posicaoReal.lng) / (n + 1),
    fonte: "dwell_confirmado",
    n_observacoes: n + 1,
    novaLinha: false,
  };
}

// Menor distancia (m) entre (lat,lng) e qualquer ponto ja confirmado do
// MESMO romaneio (veiculo+dia). null se a lista estiver vazia -- sem
// nenhum vizinho confirmado ainda, nao ha corroboracao possivel.
export function distanciaVizinhoConfirmadoMaisProximo(pontosConfirmados, lat, lng) {
  let menor = null;
  for (const c of pontosConfirmados) {
    const d = haversineM(lat, lng, c.lat, c.lng);
    if (menor === null || d < menor) menor = d;
  }
  return menor;
}

// F2-10 (MON-07), achado 23/10: o servidor roda em Europe/Berlin e o node-pg
// converte DATE em Date na MEIA-NOITE LOCAL -- `toISOString().slice(0, 10)`
// devolvia o dia ANTERIOR (234 de 400 linhas do log com dia=22 para romaneio
// de 23), e a vizinhanca corroborava a NF pendente de HOJE com as confirmacoes
// de ONTEM do mesmo veiculo. A consulta agora le romaneio_data como texto; se
// mesmo assim chegar um Date (outro caminho), usa os componentes LOCAIS, que
// sao exatamente os do DATE no banco em qualquer fuso.
export function diaDoRomaneio(valor) {
  if (typeof valor === "string") return valor.slice(0, 10);
  const d = valor;
  const mm = String(d.getMonth() + 1).padStart(2, "0");
  const dd = String(d.getDate()).padStart(2, "0");
  return `${d.getFullYear()}-${mm}-${dd}`;
}

export const SQL_PENDENTES = `SELECT id, veiculo_id, nf, romaneio_data::text AS romaneio_data, lat, lng, cliente_codigo, endereco_bruto
       FROM romaneio_pontos
      WHERE presenca_confirmada_em IS NULL
        AND lat IS NOT NULL AND lng IS NOT NULL
        AND romaneio_data >= current_date - $1::int
        AND romaneio_data <= current_date + 1
      ORDER BY romaneio_data, id`;

// F4-02 (OPS-08 parte 2): a trilha filtrava `(criado_em AT TIME ZONE
// 'America/Sao_Paulo')::date = $2` -- a expressao em cima da coluna nao usa a
// faixa de tempo do indice (veiculo_id, criado_em): lia TODO o historico do
// veiculo (medido 24/10: 224.628 linhas, 3,5 s, para devolver 2.840) e eram
// ~600 ms por chamada, ~85 h de banco somadas. A faixa [00:00, 24:00) do dia
// em BRT devolve exatamente as mesmas linhas (2.840 = 2.840) em ~14 ms.
export const SQL_TRILHA = `SELECT lat, lng, velocidade, criado_em FROM posicoes_historico
        WHERE veiculo_id = $1
          AND criado_em >= ($2::date::timestamp AT TIME ZONE 'America/Sao_Paulo')
          AND criado_em <  (($2::date + 1)::timestamp AT TIME ZONE 'America/Sao_Paulo')
        ORDER BY criado_em ASC`;
export function paramsTrilha(veiculoId, dia) {
  return [veiculoId, dia];
}

// F4-02: na RQ o cliente_codigo e' a propria NF (21.118 de 21.118 linhas em
// 24/10) -- cada ancora nasce e nunca e' reaproveitada (~2 mil/dia). Ate o
// F4-09 trazer um codigo de cliente estavel, nao grava ancora quando o
// codigo e' a NF. A presenca continua sendo confirmada normalmente.
export function deveGravarAncora(p) {
  if (p.cliente_codigo == null || String(p.cliente_codigo).trim() === "") return false;
  return String(p.cliente_codigo).trim() !== String(p.nf ?? "").trim();
}

// F2-10: metodo da presenca ("dwell" = parada no proprio endereco;
// "vizinhanca" = emprestada de outro ponto confirmado do mesmo romaneio).
// A coluna presenca_metodo vem da migration contabo/088; enquanto ela nao
// existir, o UPDATE e' o mesmo de sempre (o metodo continua so' no log).
const METODOS_PRESENCA = new Set(["dwell", "vizinhanca"]);
export function sqlMarcarPresenca(id, metodo, temColunaMetodo) {
  if (!METODOS_PRESENCA.has(metodo)) throw new Error(`metodo de presenca desconhecido: ${metodo}`);
  if (temColunaMetodo) {
    return {
      sql: `UPDATE romaneio_pontos SET presenca_confirmada_em = now(), presenca_metodo = $2 WHERE id = $1 AND presenca_confirmada_em IS NULL`,
      params: [id, metodo],
    };
  }
  return {
    sql: `UPDATE romaneio_pontos SET presenca_confirmada_em = now() WHERE id = $1 AND presenca_confirmada_em IS NULL`,
    params: [id],
  };
}

// F4-02 (GEO-29): confirma a presenca por dwell e, SO' se o UPDATE afetou a
// linha, grava a ancora -- antes a ancora era gravada mesmo quando outra
// execucao ja tinha confirmado o ponto (UPDATE com 0 linhas), e a mesma
// observacao entrava de novo na media (47% dos NF-dias "Confirmado" mais de
// uma vez no log). A ancora e' lida DENTRO da transacao, com FOR UPDATE.
// `ancora` = { clienteId, clienteCodigo, enderecoChave, posicaoReal, dia }
// ou null (sem codigo/endereco, ou RQ com codigo = NF).
export async function confirmarDwell(client, { id, temColunaMetodo, ancora }) {
  await client.query("BEGIN");
  try {
    const marcar = sqlMarcarPresenca(id, "dwell", temColunaMetodo);
    const res = await client.query(marcar.sql, marcar.params);
    if (res.rowCount !== 1) {
      await client.query("ROLLBACK");
      return { confirmado: false, proxima: null, existente: null };
    }
    let proxima = null;
    let existente = null;
    if (ancora) {
      const { rows } = await client.query(
        `SELECT lat, lng, fonte, n_observacoes, ultima_observacao::text AS ultima_observacao
           FROM romaneio_cliente_codigo_geocode
          WHERE cliente_id = $1 AND cliente_codigo = $2 AND endereco_chave = $3
          FOR UPDATE`,
        [ancora.clienteId, ancora.clienteCodigo, ancora.enderecoChave]
      );
      existente = rows[0] ?? null;
      proxima = proximaEscritaCache(existente, ancora.posicaoReal, ancora.dia);
      if (proxima) {
        await client.query(
          `INSERT INTO romaneio_cliente_codigo_geocode (cliente_id, cliente_codigo, endereco_chave, lat, lng, fonte, n_observacoes, primeira_observacao, ultima_observacao)
           VALUES ($1, $2, $3, $4, $5, $6, $7, $8::date, $8::date)
           ON CONFLICT (cliente_id, cliente_codigo, endereco_chave) DO UPDATE SET
             lat = EXCLUDED.lat, lng = EXCLUDED.lng, fonte = EXCLUDED.fonte,
             n_observacoes = EXCLUDED.n_observacoes,
             ultima_observacao = GREATEST(romaneio_cliente_codigo_geocode.ultima_observacao, EXCLUDED.ultima_observacao)`,
          [ancora.clienteId, ancora.clienteCodigo, ancora.enderecoChave, proxima.lat, proxima.lng, proxima.fonte, proxima.n_observacoes, ancora.dia]
        );
      }
    }
    await client.query("COMMIT");
    return { confirmado: true, proxima, existente };
  } catch (err) {
    await client.query("ROLLBACK");
    throw err;
  }
}

function sufixoDaAncora(ancora, existente, proxima) {
  if (!ancora) return "";
  if (proxima === null) {
    if (existente && existente.fonte === "dwell_confirmado") return " [cache: dia ja contado ou divergencia >2km, nao gravado]";
    return ` [cache: fonte ${existente?.fonte ?? "?"} protegida, nao gravado]`;
  }
  if (proxima.novaLinha) return " [cache: nova ancora]";
  if (existente && existente.fonte === "dwell_confirmado") return ` [cache: media atualizada, n=${proxima.n_observacoes}]`;
  return " [cache: corrigido de geocodificacao pra dwell real]";
}

const DRY_RUN = process.argv.includes("--dry-run");

async function main() {
  const pool = new pg.Pool({ connectionString: databaseUrl() });

  const { rows: pendentes } = await pool.query(SQL_PENDENTES, [JANELA_DIAS]);
  const { rows: colunaMetodo } = await pool.query(
    `SELECT 1 FROM information_schema.columns
      WHERE table_schema = 'public' AND table_name = 'romaneio_pontos' AND column_name = 'presenca_metodo'`
  );
  const temColunaMetodo = colunaMetodo.length > 0;
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
    const { rows } = await pool.query(SQL_TRILHA, paramsTrilha(veiculoId, dia));
    trilhaPorChave.set(chave, rows);
    return rows;
  }

  // Pontos ja confirmados do MESMO romaneio (veiculo+dia), pra corroboracao
  // por vizinhanca (Passo 2). Comeca com o que ja estava confirmado no
  // banco ANTES deste ciclo; cada confirmacao (direta ou por vizinhanca)
  // deste ciclo tambem entra aqui, pra encadear (ex.: A confirma direto,
  // B corrobora com A, C corrobora com B -- ordem de processamento nao
  // importa, Passo 2 roda so depois que TODO o Passo 1 terminou).
  const confirmadosPorChave = new Map();
  async function confirmadosDoDia(veiculoId, diaISO) {
    const chave = `${veiculoId}:${diaISO}`;
    if (confirmadosPorChave.has(chave)) return confirmadosPorChave.get(chave);
    const { rows } = await pool.query(
      `SELECT lat, lng FROM romaneio_pontos
        WHERE veiculo_id = $1 AND romaneio_data = $2::date
          AND presenca_confirmada_em IS NOT NULL
          AND lat IS NOT NULL AND lng IS NOT NULL`,
      [veiculoId, diaISO]
    );
    confirmadosPorChave.set(chave, rows);
    return rows;
  }
  function registrarConfirmado(veiculoId, diaISO, lat, lng) {
    const chave = `${veiculoId}:${diaISO}`;
    const lista = confirmadosPorChave.get(chave) ?? [];
    lista.push({ lat, lng });
    confirmadosPorChave.set(chave, lista);
  }

  const aindaPendentes = [];
  let confirmados = 0;
  let processados = 0;
  for (const p of pendentes) {
    processados++;
    if (processados % 500 === 0) console.log(`  ${processados}/${pendentes.length}... (${trilhaPorChave.size} trilhas em cache)`);

    const diaISO = diaDoRomaneio(p.romaneio_data);
    const trilha = await trilhaDoDia(p.veiculo_id, diaISO);
    if (trilha.length === 0) {
      aindaPendentes.push(p);
      continue;
    }

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
      const clienteId = clienteIdPorVeiculo.get(p.veiculo_id);
      // Chave do cache inclui o endereco desde a migration 069 -- um mesmo
      // cliente_codigo pode entregar em N enderecos reais diferentes (caso
      // real: SODEXO em 25 enderecos, NUTRIMED em 9 hospitais), e ate a 068
      // todos compartilhavam a MESMA linha, virando media entre lugares
      // distintos.
      const enderecoChave = normalizarEnderecoChave(p.endereco_bruto);
      const ancora = clienteId && enderecoChave && deveGravarAncora(p)
        ? { clienteId, clienteCodigo: p.cliente_codigo, enderecoChave, posicaoReal, dia: diaISO }
        : null;

      // Presenca + ancora numa transacao so' (ver confirmarDwell): ou as
      // duas acontecem juntas, ou nenhuma -- e a ancora so' quando o UPDATE
      // da presenca afetou a linha (F4-02).
      let sufixoCache = "";
      if (!DRY_RUN) {
        const client = await pool.connect();
        let r;
        try {
          r = await confirmarDwell(client, { id: p.id, temColunaMetodo, ancora });
        } finally {
          client.release();
        }
        if (!r.confirmado) {
          console.log(`Ja confirmado por outra execucao: veiculo=${p.veiculo_id} nf=${p.nf} dia=${diaISO} (ancora nao gravada)`);
          continue;
        }
        sufixoCache = sufixoDaAncora(ancora, r.existente, r.proxima);
      } else if (ancora) {
        const { rows: cacheRows } = await pool.query(
          `SELECT lat, lng, fonte, n_observacoes, ultima_observacao::text AS ultima_observacao FROM romaneio_cliente_codigo_geocode WHERE cliente_id = $1 AND cliente_codigo = $2 AND endereco_chave = $3`,
          [clienteId, p.cliente_codigo, enderecoChave]
        );
        const existente = cacheRows[0] ?? null;
        sufixoCache = sufixoDaAncora(ancora, existente, proximaEscritaCache(existente, posicaoReal, diaISO));
      }
      confirmados++;
      registrarConfirmado(p.veiculo_id, diaISO, p.lat, p.lng);
      const prefixo = DRY_RUN ? "[dry-run] Confirmaria" : "Confirmado";
      console.log(`${prefixo}: veiculo=${p.veiculo_id} nf=${p.nf} dia=${diaISO} dwell~${dwellMaxS}s${sufixoCache}`);
    } else {
      aindaPendentes.push(p);
    }
  }

  // Passo 2: corroboracao por vizinhanca (achado real 30/08, ver comentario
  // de RAIO_VIZINHANCA_M). So roda pros que sobraram do Passo 1 -- dwell
  // direto sempre tem prioridade, e' evidencia mais forte (parada
  // encostada no PROPRIO endereco, nao emprestada de vizinho).
  let confirmadosVizinhanca = 0;
  for (const p of aindaPendentes) {
    const diaISO = diaDoRomaneio(p.romaneio_data);
    const confirmadosMesmoRomaneio = await confirmadosDoDia(p.veiculo_id, diaISO);
    const dist = distanciaVizinhoConfirmadoMaisProximo(confirmadosMesmoRomaneio, p.lat, p.lng);
    if (dist === null || dist > RAIO_VIZINHANCA_M) continue;

    // Deliberadamente NAO escreve em romaneio_cliente_codigo_geocode --
    // a posicao emprestada e' de OUTRO cliente, gravar como ancora deste
    // corromperia o geocode aprendido dele (ver comentario da constante).
    if (!DRY_RUN) {
      const marcar = sqlMarcarPresenca(p.id, "vizinhanca", temColunaMetodo);
      const res = await pool.query(marcar.sql, marcar.params);
      // F4-02: outra execucao ja confirmou -- nao conta de novo no log.
      if (res.rowCount !== 1) continue;
    }
    confirmadosVizinhanca++;
    registrarConfirmado(p.veiculo_id, diaISO, p.lat, p.lng);
    const prefixo = DRY_RUN ? "[dry-run] Confirmaria" : "Confirmado";
    console.log(`${prefixo} por vizinhanca: veiculo=${p.veiculo_id} nf=${p.nf} dia=${diaISO} dist_vizinho~${Math.round(dist)}m`);
  }

  console.log(`\n${confirmados} presencas ${DRY_RUN ? "seriam confirmadas" : "confirmadas"} por dwell direto, ${confirmadosVizinhanca} por vizinhanca neste ciclo${DRY_RUN ? " (dry-run, nada gravado)" : ""}.`);
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
