// scripts/recalcular-ancoras-dwell.mjs
//
// F4-02 (GEO-29): recalcula as ancoras de romaneio_cliente_codigo_geocode a
// partir da EVIDENCIA real -- a trilha GPS de cada dia de romaneio --, depois
// das correcoes do cron confirmar-presenca-romaneio (fontes geocodificadas
// que faltavam, ancora so' com UPDATE efetivo, n = dias distintos).
//
// Por que recalcular: ate 23/10 a ancora "dwell_confirmado" nascia com n=2 no
// mesmo dia quando a ancora anterior era photon/photon_rua/unitrac_aprendido
// (media geocode+dwell), execucoes sobrepostas recontavam a mesma parada, e
// duas NFs do mesmo cliente no mesmo dia somavam 2. A precedencia do ponto
// unico (D-34: manual > cadastro Unitrac com parada > dwell n>=2 >
// exato/interpolado) precisa de um n que signifique "dias com parada real".
//
// Evidencia usada: SO' a trilha (posicoes_historico) do proprio dia do
// romaneio, com os MESMOS limiares do cron (raio 500 m, velocidade <= 5 km/h,
// dwell >= 120 s). NAO usa presenca_confirmada_em: as 33.759 confirmacoes
// antigas "por vizinhanca" (F2-10, contaminadas pelo dia de ontem) nao sao
// evidencia de parada neste endereco.
//
// Nunca inventa ponto: ancora sem nenhuma parada na trilha fica como esta';
// fonte protegida (manual, cadastro_unitrac...) nunca e' tocada; mudanca
// acima de 150 m vai para a fila de revisao e nao e' aplicada sozinha. RQ
// (cliente_codigo = NF) fica de fora ate o F4-09.
//
// Uso (so' leitura por padrao -- D-33: o 1o lote passa pelo dono):
//   node --env-file=.env.production scripts/recalcular-ancoras-dwell.mjs \
//     [--cliente <uuid>] [--de 2026-07-31] [--ate 2026-10-24] [--saida dir]
// Aplicar (PENDENTE DONO, depois de ler o relatorio do a seco):
//   ... --aplicar --limite 200 [--categorias n_cai,move_pouco,n_sobe,vira_dwell]
//   (padrao: so' n_cai)
//   grava antes um backup JSON das linhas que vai mudar em <saida>/backup-*.json
//   e so' atualiza a linha se ela continua igual ao que foi lido (lat, lng,
//   fonte, n). Rollback: scripts/recalcular-ancoras-dwell.mjs --restaurar <backup.json>
import pg from "pg";
import fs from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
import {
  calcularStreakMaximoComPosicao, normalizarEnderecoChave, haversineM, deveGravarAncora,
  FONTES_GEOCODIFICADAS, RAIO_PADRAO_M, VELOCIDADE_MAX_PARADO_KMH, DWELL_MINIMO_SEGUNDOS,
  DIVERGENCIA_MAX_M, SQL_TRILHA, paramsTrilha,
} from "./confirmar-presenca-romaneio.mjs";

const IGUAL_M = 30;
const REVISAO_M = 150;

// Uma observacao por dia: duas NFs do mesmo cliente/endereco no mesmo dia sao
// a mesma parada (fica a de maior dwell). Ordem cronologica.
export function umaObservacaoPorDia(registros) {
  const porDia = new Map();
  for (const r of registros) {
    if (!r.posicaoReal || r.dwellMaxS < DWELL_MINIMO_SEGUNDOS) continue;
    const atual = porDia.get(r.dia);
    if (!atual || r.dwellMaxS > atual.dwellMaxS) porDia.set(r.dia, r);
  }
  return [...porDia.values()].sort((a, b) => (a.dia < b.dia ? -1 : a.dia > b.dia ? 1 : 0));
}

// Mesma regra do cron (proximaEscritaCache), dia a dia: o 1o dia abre a
// ancora, cada dia seguinte a ate 2 km da media entra na media ponderada.
export function dobrarObservacoes(observacoes) {
  let atual = null;
  for (const o of observacoes) {
    if (atual === null) {
      atual = { lat: o.posicaoReal.lat, lng: o.posicaoReal.lng, n: 1, primeira: o.dia, ultima: o.dia };
      continue;
    }
    if (haversineM(atual.lat, atual.lng, o.posicaoReal.lat, o.posicaoReal.lng) > DIVERGENCIA_MAX_M) continue;
    const n = atual.n;
    atual = {
      lat: (atual.lat * n + o.posicaoReal.lat) / (n + 1),
      lng: (atual.lng * n + o.posicaoReal.lng) / (n + 1),
      n: n + 1,
      primeira: atual.primeira,
      ultima: o.dia,
    };
  }
  return atual;
}

// Categorias: igual | n_cai | n_sobe | move_pouco | vira_dwell (aplicaveis,
// mudanca <= 150 m); revisao (> 150 m) | sem_evidencia |
// geocodificada_sem_parada | protegida (nunca aplicadas por este script).
// Por padrao o --aplicar so' aplica n_cai (tira a contagem inflada: n=2 no
// mesmo dia, recontagem); n_sobe e vira_dwell so' com --categorias, porque a
// trilha do dia inteiro conta qualquer parada >= 120 s a ate 500 m do ponto
// (pode ser o cliente vizinho) -- evidencia mais fraca que a do cron, que
// mede logo depois da parada.
export function classificarAncora(atual, recalculada) {
  const geocodificada = FONTES_GEOCODIFICADAS.has(atual.fonte);
  if (!geocodificada && atual.fonte !== "dwell_confirmado") return { categoria: "protegida", distM: null };
  if (recalculada === null) {
    return { categoria: geocodificada ? "geocodificada_sem_parada" : "sem_evidencia", distM: null };
  }
  const distM = haversineM(atual.lat, atual.lng, recalculada.lat, recalculada.lng);
  if (distM > REVISAO_M) return { categoria: "revisao", distM };
  if (geocodificada) return { categoria: "vira_dwell", distM };
  if (recalculada.n < atual.n_observacoes) return { categoria: "n_cai", distM };
  if (recalculada.n > atual.n_observacoes) return { categoria: "n_sobe", distM };
  if (distM > IGUAL_M) return { categoria: "move_pouco", distM };
  return { categoria: "igual", distM };
}

export const CATEGORIAS_APLICAVEIS = new Set(["n_cai", "n_sobe", "move_pouco", "vira_dwell"]);
export const CATEGORIAS_PADRAO = ["n_cai"];
export function categoriasParaAplicar(valorArg) {
  const lista = valorArg ? valorArg.split(",").map((c) => c.trim()).filter(Boolean) : CATEGORIAS_PADRAO;
  for (const c of lista) if (!CATEGORIAS_APLICAVEIS.has(c)) throw new Error(`categoria nao aplicavel: ${c}`);
  return new Set(lista);
}

function arg(nome, padrao) {
  const i = process.argv.indexOf(nome);
  return i >= 0 && process.argv[i + 1] ? process.argv[i + 1] : padrao;
}

function csv(v) {
  if (v === null || v === undefined) return "";
  const s = String(v);
  return /[",\n;]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

async function main() {
  const DATABASE_URL = process.env.DATABASE_URL;
  if (!DATABASE_URL) throw new Error("DATABASE_URL ausente (use --env-file=.env.production)");
  const aplicar = process.argv.includes("--aplicar");
  const restaurar = arg("--restaurar", null);
  const limite = Number(arg("--limite", "200"));
  const categorias = categoriasParaAplicar(arg("--categorias", null));
  const cliente = arg("--cliente", null);
  const de = arg("--de", "2000-01-01");
  const ate = arg("--ate", "2999-12-31");
  const saida = arg("--saida", "saida-recalcular-ancoras");
  fs.mkdirSync(saida, { recursive: true });
  const pool = new pg.Pool({ connectionString: DATABASE_URL, max: 2 });

  if (restaurar) {
    const linhas = JSON.parse(fs.readFileSync(restaurar, "utf8"));
    const client = await pool.connect();
    try {
      await client.query("BEGIN");
      for (const l of linhas) {
        await client.query(
          `UPDATE romaneio_cliente_codigo_geocode SET lat = $4, lng = $5, fonte = $6, n_observacoes = $7, ultima_observacao = $8::date
            WHERE cliente_id = $1 AND cliente_codigo = $2 AND endereco_chave = $3`,
          [l.cliente_id, l.cliente_codigo, l.endereco_chave, l.lat, l.lng, l.fonte, l.n_observacoes, l.ultima_observacao]
        );
      }
      await client.query("COMMIT");
      console.log(`${linhas.length} ancoras restauradas de ${restaurar}.`);
    } catch (e) {
      await client.query("ROLLBACK");
      throw e;
    } finally {
      client.release();
      await pool.end();
    }
    return;
  }

  // 1) NFs com ponto e codigo de cliente (RQ, com codigo = NF, fica de fora).
  const { rows: nfs } = await pool.query(
    `SELECT p.veiculo_id, p.nf, p.romaneio_data::text AS dia, p.lat, p.lng, p.cliente_codigo, p.endereco_bruto, v.cliente_id
       FROM romaneio_pontos p JOIN veiculos v ON v.id = p.veiculo_id
      WHERE p.lat IS NOT NULL AND p.lng IS NOT NULL AND p.cliente_codigo IS NOT NULL
        AND p.romaneio_data BETWEEN $1::date AND $2::date
        AND ($3::uuid IS NULL OR v.cliente_id = $3::uuid)
      ORDER BY p.veiculo_id, p.romaneio_data`,
    [de, ate, cliente]
  );
  const elegiveis = nfs.filter((p) => deveGravarAncora(p) && normalizarEnderecoChave(p.endereco_bruto));
  console.log(`${nfs.length} NFs com ponto; ${elegiveis.length} elegiveis (fora RQ com codigo = NF).`);

  // 2) Dwell de cada NF na trilha do proprio dia (uma consulta por veiculo-dia).
  const obsPorChave = new Map();
  let trilhas = 0;
  let i = 0;
  while (i < elegiveis.length) {
    const { veiculo_id, dia } = elegiveis[i];
    let j = i;
    while (j < elegiveis.length && elegiveis[j].veiculo_id === veiculo_id && elegiveis[j].dia === dia) j++;
    const { rows: trilha } = await pool.query(SQL_TRILHA, paramsTrilha(veiculo_id, dia));
    trilhas++;
    if (trilhas % 200 === 0) console.log(`  ${trilhas} trilhas, ${j}/${elegiveis.length} NFs...`);
    for (let k = i; k < j; k++) {
      const p = elegiveis[k];
      const chave = `${p.cliente_id}|${p.cliente_codigo}|${normalizarEnderecoChave(p.endereco_bruto)}`;
      const r = trilha.length === 0
        ? { dwellMaxS: 0, posicaoReal: null }
        : calcularStreakMaximoComPosicao(trilha, p.lat, p.lng, RAIO_PADRAO_M, VELOCIDADE_MAX_PARADO_KMH, DWELL_MINIMO_SEGUNDOS);
      const lista = obsPorChave.get(chave) ?? [];
      lista.push({ dia, dwellMaxS: r.dwellMaxS, posicaoReal: r.posicaoReal });
      obsPorChave.set(chave, lista);
    }
    i = j;
  }

  // 3) Ancoras atuais x recalculadas.
  const { rows: ancoras } = await pool.query(
    `SELECT g.cliente_id, g.cliente_codigo, g.endereco_chave, g.lat, g.lng, g.fonte, g.n_observacoes,
            g.primeira_observacao::text AS primeira_observacao, g.ultima_observacao::text AS ultima_observacao
       FROM romaneio_cliente_codigo_geocode g
      WHERE ($1::uuid IS NULL OR g.cliente_id = $1::uuid)`,
    [cliente]
  );
  const contagem = {};
  const contagemFonte = {};
  const linhasCsv = [[
    "cliente_id", "cliente_codigo", "endereco_chave", "fonte_atual", "n_atual", "primeira", "ultima", "lat_atual", "lng_atual",
    "n_recalc", "primeira_recalc", "ultima_recalc", "lat_recalc", "lng_recalc", "dist_m", "categoria", "n2_mesmo_dia_atual",
  ].join(";")];
  const aplicaveis = [];
  let semNfElegivel = 0;
  for (const a of ancoras) {
    const chave = `${a.cliente_id}|${a.cliente_codigo}|${a.endereco_chave}`;
    const obs = obsPorChave.get(chave);
    if (obs === undefined) {
      // Sem NF elegivel no periodo (RQ com codigo = NF, ou fora da janela).
      semNfElegivel++;
      continue;
    }
    const rec = dobrarObservacoes(umaObservacaoPorDia(obs));
    const { categoria, distM } = classificarAncora(a, rec);
    contagem[categoria] = (contagem[categoria] ?? 0) + 1;
    const cf = `${a.fonte}->${categoria}`;
    contagemFonte[cf] = (contagemFonte[cf] ?? 0) + 1;
    const n2MesmoDia = a.fonte === "dwell_confirmado" && a.n_observacoes >= 2 && a.primeira_observacao === a.ultima_observacao;
    linhasCsv.push([
      a.cliente_id, a.cliente_codigo, a.endereco_chave, a.fonte, a.n_observacoes, a.primeira_observacao, a.ultima_observacao, a.lat, a.lng,
      rec?.n ?? "", rec?.primeira ?? "", rec?.ultima ?? "", rec?.lat ?? "", rec?.lng ?? "", distM === null ? "" : Math.round(distM), categoria, n2MesmoDia ? 1 : 0,
    ].map(csv).join(";"));
    if (categorias.has(categoria)) aplicaveis.push({ atual: a, rec, categoria, distM });
  }
  const carimbo = new Date().toISOString().replace(/[:.]/g, "-");
  const arqCsv = path.join(saida, `ancoras-recalculadas-${carimbo}.csv`);
  fs.writeFileSync(arqCsv, linhasCsv.join("\n") + "\n");

  // Distribuicao de n (atual x recalculado) so' nas ancoras dwell com evidencia.
  const resumo = {
    nfs: nfs.length, elegiveis: elegiveis.length, trilhas, ancoras: ancoras.length,
    ancoras_sem_nf_elegivel: semNfElegivel, categorias: contagem, por_fonte: contagemFonte,
    categorias_para_aplicar: [...categorias], aplicaveis: aplicaveis.length, csv: arqCsv,
  };
  fs.writeFileSync(path.join(saida, `resumo-${carimbo}.json`), JSON.stringify(resumo, null, 2));
  console.log(JSON.stringify(resumo, null, 2));

  if (!aplicar) {
    console.log("\nA seco: nada gravado. Para aplicar (PENDENTE DONO): --aplicar --limite N.");
    await pool.end();
    return;
  }

  // 4) Aplicar (so' categorias aplicaveis, ate --limite, com backup antes).
  const lote = aplicaveis.slice(0, limite);
  const backup = lote.map(({ atual }) => atual);
  const arqBackup = path.join(saida, `backup-${carimbo}.json`);
  fs.writeFileSync(arqBackup, JSON.stringify(backup, null, 2));
  const client = await pool.connect();
  let gravadas = 0;
  let mudaramNoMeio = 0;
  try {
    await client.query("BEGIN");
    for (const { atual, rec } of lote) {
      const res = await client.query(
        `UPDATE romaneio_cliente_codigo_geocode
            SET lat = $4, lng = $5, fonte = 'dwell_confirmado', n_observacoes = $6,
                ultima_observacao = GREATEST(ultima_observacao, $7::date)
          WHERE cliente_id = $1 AND cliente_codigo = $2 AND endereco_chave = $3
            AND fonte = $8 AND n_observacoes = $9 AND lat = $10 AND lng = $11`,
        [atual.cliente_id, atual.cliente_codigo, atual.endereco_chave, rec.lat, rec.lng, rec.n, rec.ultima,
          atual.fonte, atual.n_observacoes, atual.lat, atual.lng]
      );
      if (res.rowCount === 1) gravadas++; else mudaramNoMeio++;
    }
    await client.query("COMMIT");
  } catch (e) {
    await client.query("ROLLBACK");
    throw e;
  } finally {
    client.release();
  }
  console.log(`\n${gravadas} ancoras atualizadas (${mudaramNoMeio} mudaram no meio e ficaram como estavam). Backup: ${arqBackup}`);
  await pool.end();
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((err) => {
    console.error(err);
    process.exit(1);
  });
}
