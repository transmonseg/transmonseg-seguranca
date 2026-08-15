// Mede quanto o corredor real teria corroborado nos disparos de desvio
// reais dos ultimos 14 dias, SEM mudar nenhum comportamento de disparo --
// so' roda a funcao pura contra dado ja gravado. Ver
// docs/superpowers/specs/2026-08-14-desvio-corredor-corroboracao-design.md,
// secao "Testes e validacao".
//
// Importa ../src/lib/corredor-confirmacao.ts direto (.ts, sem build) --
// so roda via `npx tsx`, NUNCA `node` puro (node nao entende import de
// .ts sem loader). Comando exato:
//   npx tsx scripts/validar-corredor-corroboracao.mjs
//
// Achado da revisao final (14/08, item 1 Important): a taxa bruta de
// confirmaFora=true nos disparos reais (medida abaixo, secao "MEDICAO 1")
// pode ser artefato do MESMO problema que matou o corredor como regra
// primaria em 11/08 (ancora velha depois de paradas reais -> sempre
// "fora"), nao porque o sinal discrimina desvio real de falso positivo.
// Essa medicao sozinha NAO decide nada -- por isso este script ganhou 2
// grupos de controle:
//
//   MEDICAO 2 (grupo a): dos disparos reais ja classificados por um
//   operador (join com `alertas` por INTERVALO -- o alerta que estava
//   ABERTO, desde <= criado_em <= coalesce(resolvido_em, now()), mesmo
//   veiculo_id, tipo='desvio' -- mais confiavel que "alerta mais proximo
//   no tempo", que da match errado quando o alerta ficou aberto por horas
//   e o proximo so foi criado bem depois, ver investigacao real de 14/08),
//   compara a taxa de confirmaFora=true entre os que viraram
//   'falso_positivo' e os que viraram 'resolvido'. Taxa parecida nos dois
//   grupos = o sinal nao discrimina; taxa bem maior em 'resolvido' = o
//   sinal carrega informacao real.
//
//   MEDICAO 3 (grupo b): amostra de ciclos "normais" (sem streak formado,
//   sem disparo real por perto) rodando a MESMA logica de corredor com
//   ancora FIXA de 2min atras (nao ha streak pra ancorar em ciclos que
//   nunca dispararam). Se a taxa de "fora" aqui for parecida com a dos
//   disparos reais (MEDICAO 1), o sinal e quase sempre "fora"
//   independente do contexto -- nao carrega informacao.
//
// Sem conclusao prescritiva aqui -- so reporta os 3 numeros. A decisao de
// manter/ajustar o bonus fica pra depois, com esses dados em maos.
import pg from "pg";
import { verificarCorredorFora } from "../src/lib/corredor-confirmacao.ts";

const c = new pg.Client({ connectionString: process.env.DATABASE_URL, ssl: { rejectUnauthorized: false } });
await c.connect();

// Mesmo teto aplicado em route.ts (Achado real da revisao final 14/08,
// item 2 Important): sem teto, streaks longos geram ancora de horas atras,
// quase sempre "fora" por definicao, nao por sinal real. 20 ciclos = 10min.
const TETO_CICLOS_STREAK = 20;
const CICLO_SEGUNDOS = 30;

async function buscarAncora(veiculoId, refTimestamp, segundosAtras) {
  const { rows } = await c.query(
    `SELECT lat, lng FROM posicoes_historico
      WHERE veiculo_id = $1 AND criado_em <= $2::timestamptz - ($3 || ' seconds')::interval
      ORDER BY criado_em DESC LIMIT 1`,
    [veiculoId, refTimestamp, String(segundosAtras)]
  );
  return rows[0] ?? null;
}

async function buscarPosicao(veiculoId, refTimestamp) {
  const { rows } = await c.query(
    `SELECT lat, lng, velocidade FROM posicoes_historico
      WHERE veiculo_id = $1 AND criado_em <= $2::timestamptz
      ORDER BY criado_em DESC LIMIT 1`,
    [veiculoId, refTimestamp]
  );
  return rows[0] ?? null;
}

// ============================================================
// MEDICAO 1: taxa bruta de corroboracao nos disparos reais (afastando_geral,
// 14 dias) -- numero original ja usado antes do deploy, agora com o teto de
// streak aplicado (mesma logica de producao pos-correcao).
// ============================================================
const { rows: disparos } = await c.query(`
  select ddl.id, ddl.veiculo_id, ddl.destinos, ddl.streak_afastando, ddl.criado_em, v.placa
  from desvio_disparo_log ddl
  join veiculos v on v.id = ddl.veiculo_id
  where ddl.tipo_disparo = 'afastando_geral'
    and ddl.criado_em >= now() - interval '14 days'
  order by ddl.criado_em desc
`);
console.log(`\n=== MEDICAO 1: disparos reais de afastando_geral, 14 dias ===`);
console.log(`Total: ${disparos.length}`);

let confirmados = 0;
let semAncora = 0;
let semDestinos = 0;
let indisponivel = 0;
// id -> confirmaFora, usado pela MEDICAO 2 abaixo (evita rodar OSRM 2x)
const resultadoPorDisparo = new Map();

for (const d of disparos) {
  const destinos = d.destinos.map((x) => ({ lat: x.lat, lng: x.lng }));
  if (destinos.length === 0) { semDestinos++; continue; }

  const segundosStreak = Math.min(d.streak_afastando, TETO_CICLOS_STREAK) * CICLO_SEGUNDOS;
  const ancora = await buscarAncora(d.veiculo_id, d.criado_em, segundosStreak);
  if (!ancora) { semAncora++; continue; }

  const atual = await buscarPosicao(d.veiculo_id, d.criado_em);
  if (!atual) { semAncora++; continue; }

  const { confirmaFora } = await verificarCorredorFora(
    { lat: ancora.lat, lng: ancora.lng },
    { lat: atual.lat, lng: atual.lng, velocidade: atual.velocidade ?? 0 },
    destinos
  );
  resultadoPorDisparo.set(d.id, confirmaFora);
  if (confirmaFora) confirmados++;
  else indisponivel++;
}

const testados1 = confirmados + indisponivel;
console.log(`Corroborados (confirmaFora=true): ${confirmados}`);
console.log(`Nao corroborados (OSRM indisponivel/dentro de rota): ${indisponivel}`);
console.log(`Sem ancora suficiente: ${semAncora}`);
console.log(`Sem destinos gravados: ${semDestinos}`);
console.log(`Taxa de confirmaFora=true (sobre testados): ${testados1 > 0 ? ((confirmados / testados1) * 100).toFixed(1) : "N/A"}% (${confirmados}/${testados1})`);

// ============================================================
// MEDICAO 2 (grupo a): falso_positivo vs resolvido, entre os disparos ja
// medidos acima. Join por INTERVALO com `alertas` -- o alerta tipo='desvio'
// que estava ABERTO (desde <= ddl.criado_em <= coalesce(resolvido_em,
// now())) pro mesmo veiculo_id. Investigado em 14/08: nao ha FK direta
// entre desvio_disparo_log e alertas, e o "alerta mais proximo no tempo"
// (nearest neighbor simples) da match ERRADO quando o alerta fica aberto
// por horas (visto em producao: delta de ate -71764s / ~20h com esse
// metodo) -- containment por intervalo e o join correto porque reflete o
// que realmente aconteceu: o disparo ocorreu ENQUANTO aquele alerta
// especifico estava aberto.
// ============================================================
const { rows: classificados } = await c.query(`
  select ddl.id as ddl_id, a.status
  from desvio_disparo_log ddl
  join lateral (
    select status
    from alertas
    where alertas.veiculo_id = ddl.veiculo_id
      and alertas.tipo = 'desvio'
      and alertas.desde <= ddl.criado_em
      and coalesce(alertas.resolvido_em, now()) >= ddl.criado_em
    order by alertas.desde desc
    limit 1
  ) a on true
  where ddl.tipo_disparo = 'afastando_geral'
    and ddl.criado_em >= now() - interval '14 days'
    and a.status in ('falso_positivo', 'resolvido')
`);

let fpConfirmados = 0, fpTotal = 0, resolvidoConfirmados = 0, resolvidoTotal = 0;
for (const row of classificados) {
  if (!resultadoPorDisparo.has(row.ddl_id)) continue; // sem ancora/destinos, nao testado na medicao 1
  const confirmaFora = resultadoPorDisparo.get(row.ddl_id);
  if (row.status === "falso_positivo") {
    fpTotal++;
    if (confirmaFora) fpConfirmados++;
  } else if (row.status === "resolvido") {
    resolvidoTotal++;
    if (confirmaFora) resolvidoConfirmados++;
  }
}

console.log(`\n=== MEDICAO 2 (grupo a): falso_positivo vs resolvido ===`);
console.log(`Disparos com alerta classificado (falso_positivo ou resolvido) e testados: ${fpTotal + resolvidoTotal}`);
console.log(`  falso_positivo: ${fpConfirmados}/${fpTotal} confirmaFora=true (${fpTotal > 0 ? ((fpConfirmados / fpTotal) * 100).toFixed(1) : "N/A"}%)`);
console.log(`  resolvido:      ${resolvidoConfirmados}/${resolvidoTotal} confirmaFora=true (${resolvidoTotal > 0 ? ((resolvidoConfirmados / resolvidoTotal) * 100).toFixed(1) : "N/A"}%)`);

// ============================================================
// MEDICAO 3 (grupo b): amostra de ciclos SEM streak formado (nenhum
// desvio_disparo_log de qualquer tipo pro mesmo veiculo dentro de +-3min),
// ancora FIXA 2min atras (sem streak pra ancorar), destinos = snapshot de
// pendentes mais proximo no tempo (pendentes_snapshot_log, throttled a
// cada 5min por veiculo -- aproximacao razoavel do conjunto de destinos
// real do ciclo, mesma limitacao ja documentada na migration 045: nao
// reproduz o ciclo EXATO, mas serve pra medir o comportamento do corredor
// em contexto "sem desvio", que e o que importa aqui).
// ============================================================
// Join direto (nao sample-then-discard): junta cada posicao candidata ja
// com o snapshot de pendentes mais proximo no tempo (+-10min, cobre o
// throttle de 5min do snapshot com folga) via LATERAL -- amostrar posicoes
// "cruas" e so depois buscar snapshot descartava ~90% dos candidatos (so
// 19/200 tinham snapshot por perto), medido na 1a rodada deste script em
// 14/08.
const TAMANHO_AMOSTRA_CONTROLE = 200;
const { rows: amostraControle } = await c.query(
  `select ph.veiculo_id, ph.lat, ph.lng, ph.velocidade, ph.criado_em, snap.pendentes
     from posicoes_historico ph
     join lateral (
       select pendentes
       from pendentes_snapshot_log
       where pendentes_snapshot_log.veiculo_id = ph.veiculo_id
         and tem_pendentes = true
         and criado_em between ph.criado_em - interval '10 minutes' and ph.criado_em + interval '10 minutes'
       order by abs(extract(epoch from (criado_em - ph.criado_em)))
       limit 1
     ) snap on true
     where ph.criado_em >= now() - interval '14 days'
       and ph.velocidade is not null
       and not exists (
         select 1 from desvio_disparo_log ddl
         where ddl.veiculo_id = ph.veiculo_id
           and ddl.criado_em between ph.criado_em - interval '3 minutes' and ph.criado_em + interval '3 minutes'
       )
     order by random()
     limit $1`,
  [TAMANHO_AMOSTRA_CONTROLE]
);

let controleConfirmados = 0;
let controleSemAncora = 0;
let controleSemDestinos = 0;
let controleIndisponivel = 0;

for (const s of amostraControle) {
  const pendentes = s.pendentes;
  if (!pendentes || pendentes.length === 0) { controleSemDestinos++; continue; }
  // Dedup por codigo -- pendentes repete o mesmo destino varias vezes
  // quando ha multiplos pedidos no mesmo endereco; nao muda o resultado de
  // verificarCorredorFora (mesma rota testada), so evita chamada OSRM
  // redundante.
  const vistos = new Set();
  const destinos = [];
  for (const p of pendentes) {
    const chave = p.codigo ?? `${p.lat},${p.lng}`;
    if (vistos.has(chave)) continue;
    vistos.add(chave);
    destinos.push({ lat: p.lat, lng: p.lng });
  }

  const ancora = await buscarAncora(s.veiculo_id, s.criado_em, 120); // 2min fixo, sem streak
  if (!ancora) { controleSemAncora++; continue; }

  const { confirmaFora } = await verificarCorredorFora(
    { lat: ancora.lat, lng: ancora.lng },
    { lat: s.lat, lng: s.lng, velocidade: s.velocidade ?? 0 },
    destinos
  );
  if (confirmaFora) controleConfirmados++;
  else controleIndisponivel++;
}

const testadosControle = controleConfirmados + controleIndisponivel;
console.log(`\n=== MEDICAO 3 (grupo b): ciclos sem streak formado (controle) ===`);
console.log(`Amostra candidata: ${amostraControle.length}`);
console.log(`Corroborados (confirmaFora=true): ${controleConfirmados}`);
console.log(`Nao corroborados: ${controleIndisponivel}`);
console.log(`Sem ancora suficiente: ${controleSemAncora}`);
console.log(`Sem snapshot de pendentes proximo: ${controleSemDestinos}`);
console.log(`Taxa de confirmaFora=true (sobre testados): ${testadosControle > 0 ? ((controleConfirmados / testadosControle) * 100).toFixed(1) : "N/A"}% (${controleConfirmados}/${testadosControle})`);

console.log(`\n=== RESUMO (sem conclusao prescritiva -- ver comentario no topo do script) ===`);
console.log(`MEDICAO 1 (disparos reais):        ${testados1 > 0 ? ((confirmados / testados1) * 100).toFixed(1) : "N/A"}%`);
console.log(`MEDICAO 2a (falso_positivo):        ${fpTotal > 0 ? ((fpConfirmados / fpTotal) * 100).toFixed(1) : "N/A"}%`);
console.log(`MEDICAO 2b (resolvido):             ${resolvidoTotal > 0 ? ((resolvidoConfirmados / resolvidoTotal) * 100).toFixed(1) : "N/A"}%`);
console.log(`MEDICAO 3 (controle, sem streak):   ${testadosControle > 0 ? ((controleConfirmados / testadosControle) * 100).toFixed(1) : "N/A"}%`);

await c.end();
