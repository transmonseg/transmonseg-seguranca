// Mede quanto a classe viaria teria corroborado nos disparos reais de
// desvio dos ultimos 14 dias, COM grupos de controle -- a licao de 14/08
// (corredor: 89% de corroboracao geral escondia uma discriminacao
// invertida, falso_positivo corroborando MAIS que resolvido) exige medir
// contra controle, nao so o numero bruto. Ver
// docs/superpowers/specs/2026-08-15-classe-viaria-corroboracao-design.md.
//
// Importa .ts direto (sem build) -- so roda via `npx tsx`, NUNCA `node`
// puro. Comando exato:
//   npx tsx scripts/validar-classe-viaria-corroboracao.mjs
//
// Grupos (mesmo par ja usado pro corredor em
// scripts/validar-corredor-corroboracao.mjs, secao "Testes e validacao" do
// spec exige explicitamente os MESMOS 2):
//
//   grupo (a): dos disparos reais de afastando_geral ja classificados por
//   um operador (join com `alertas` por INTERVALO, mesmo padrao do script
//   do corredor), compara a taxa de corroboracao entre falso_positivo e
//   resolvido. Taxa parecida nos dois grupos = o sinal nao discrimina; taxa
//   bem maior em resolvido = o sinal carrega informacao real.
//
//   grupo (b): amostra de ~200 ciclos SEM streak formado (nenhuma linha em
//   desvio_disparo_log de qualquer tipo pro mesmo veiculo dentro de +-3min)
//   -- taxa-base de comparacao. Se a taxa de queda aqui for parecida com a
//   dos disparos reais, o sinal e quase sempre "queda" independente do
//   contexto, nao carrega informacao.
//
// Achados da revisao final da leva de correcao (15/08), corrigidos aqui:
//
//   1. O script so media quedaDetectada (avaliarQuedaClasseViaria), sem
//   nunca chamar avaliarSaiuParadaConfirmadaRecentemente -- a producao
//   SUPRIME a corroboracao quando o veiculo saiu de uma parada de entrega
//   confirmada ha pouco (JANELA_SAIDA_PARADA_MIN=5min, ver
//   classe-viaria-confirmacao.ts), o script nao modelava esse gate e
//   portanto SUPERESTIMAVA levemente a taxa real. Corrigido: cada medicao
//   agora tambem reconstroi saiu_parada_confirmada_em (aproximacao via
//   posicoes_historico + snapshot de pendentes, mesma limitacao ja
//   documentada pra ultimaViaPrincipalAntes abaixo -- nao ha historico de
//   desvio_estado anterior ao deploy desta feature) e aplica o gate antes
//   de contar como "corroboraria". "queda_bruta" (sem o gate) continua
//   reportado ao lado pra visibilidade, mas o numero que importa pra
//   comparar com producao e "corroboraria".
//
//   2. celulaDe estava importado e nunca usado -- removido (nao precisa
//   pra nenhum dos 2 grupos: group (a) usa a posicao real do disparo,
//   group (b) usa lat/lng direto de posicoes_historico).
//
//   3. ddl.destinos era selecionado no SQL e nunca usado -- removido da
//   query.
import pg from "pg";
import { melhorClasse, avaliarQuedaClasseViaria, avaliarSaiuParadaConfirmadaRecentemente } from "../src/lib/classe-viaria-confirmacao.ts";
import { haversineM } from "../src/lib/unitrac.ts";

const c = new pg.Client({ connectionString: process.env.DATABASE_URL, ssl: { rejectUnauthorized: false } });
await c.connect();

function vizinhanca3x3(lat, lng) {
  const la = Math.round(lat * 1000);
  const lo = Math.round(lng * 1000);
  const out = [];
  for (let di = -1; di <= 1; di++) for (let dj = -1; dj <= 1; dj++) out.push(`${la + di}:${lo + dj}`);
  return out;
}

async function classificarPosicao(lat, lng) {
  const { rows } = await c.query(`SELECT classe FROM vias_celulas WHERE celula = ANY($1::text[])`, [vizinhanca3x3(lat, lng)]);
  let classe = null;
  for (const r of rows) classe = melhorClasse(classe, r.classe);
  return classe;
}

// Reconstroi ultima_via_principal_em varrendo os ultimos 15min de
// posicoes_historico do veiculo ANTES do momento do disparo -- aproximacao
// pro estado que desvio_estado teria acumulado, ja que essa coluna so
// existe a partir do deploy desta feature (nao tem historico anterior).
async function ultimaViaPrincipalAntes(veiculoId, momento) {
  const { rows } = await c.query(
    `SELECT lat, lng, criado_em FROM posicoes_historico
      WHERE veiculo_id = $1 AND criado_em >= $2::timestamptz - interval '15 minutes' AND criado_em < $2::timestamptz
      ORDER BY criado_em DESC`,
    [veiculoId, momento]
  );
  for (const r of rows) {
    const classe = await classificarPosicao(r.lat, r.lng);
    if (classe === "principal") return r.criado_em;
  }
  return null;
}

// Snapshot de pendentes mais proximo do momento (mesmo padrao usado pelo
// MEDICAO 3 do script do corredor) -- so serve de insumo pra reconstruir o
// gate de saida-de-parada-confirmada abaixo; sem snapshot por perto, o gate
// fica indeterminavel e e tratado como "nao suprime" (ver
// saiuParadaConfirmadaAntes).
async function buscarSnapshotPendentes(veiculoId, momento) {
  const { rows } = await c.query(
    `select pendentes from pendentes_snapshot_log
      where veiculo_id = $1 and tem_pendentes = true
        and criado_em between $2::timestamptz - interval '10 minutes' and $2::timestamptz + interval '10 minutes'
      order by abs(extract(epoch from (criado_em - $2::timestamptz)))
      limit 1`,
    [veiculoId, momento]
  );
  return rows[0]?.pendentes ?? [];
}

// Mesmos limiares de src/lib/detectores.ts (BYPASS_ENTREGA_DWELL_MINIMO_SEGUNDOS)
// e do bloco no_raio_alvo_codigo em route.ts (LIMIAR_VELOCIDADE_DWELL_KMH) --
// duplicados aqui (script standalone, sem import de route.ts) so pra
// reconstruir a aproximacao de saiu_parada_confirmada_em.
const LIMIAR_VELOCIDADE_DWELL_KMH = 5;
const BYPASS_ENTREGA_DWELL_MINIMO_SEGUNDOS = 120;

// Reconstroi (aproximado) o momento em que o veiculo saiu de um raio de
// pendente onde tinha dwell confirmado (>=120s a <=5km/h), varrendo os
// ultimos 7min de posicoes_historico antes do momento -- mesma logica do
// bloco no_raio_alvo_codigo/saiu_parada_confirmada_em em route.ts, so que
// replay sobre historico em vez de estado incremental por ciclo. Sem
// pendentes (snapshot nao encontrado), retorna null (gate nao suprime --
// nao ha como saber, tratado como "nao suprimiria" pra nao subestimar a
// corroboracao por falta de dado).
async function saiuParadaConfirmadaAntes(veiculoId, momento, pendentes) {
  if (!pendentes || pendentes.length === 0) return null;
  const { rows: pos } = await c.query(
    `select lat, lng, velocidade, criado_em from posicoes_historico
      where veiculo_id = $1 and criado_em < $2::timestamptz
        and criado_em >= $2::timestamptz - interval '7 minutes'
      order by criado_em asc`,
    [veiculoId, momento]
  );
  if (pos.length === 0) return null;

  let codigoRastreado = null;
  let dwellSegundos = 0;
  let saidaConfirmadaEm = null;
  for (const p of pos) {
    const alvo = pendentes.find((pt) => haversineM(p.lat, p.lng, pt.lat, pt.lng) <= (pt.raio ?? 0));
    const codigoAgora = alvo ? (alvo.codigo ?? `${alvo.lat},${alvo.lng}`) : null;
    if (codigoAgora !== null) {
      const incrementa = (p.velocidade ?? 0) <= LIMIAR_VELOCIDADE_DWELL_KMH ? 30 : 0;
      dwellSegundos = codigoAgora === codigoRastreado ? dwellSegundos + incrementa : incrementa;
      codigoRastreado = codigoAgora;
    } else {
      if (codigoRastreado !== null && dwellSegundos >= BYPASS_ENTREGA_DWELL_MINIMO_SEGUNDOS) {
        saidaConfirmadaEm = p.criado_em;
      }
      codigoRastreado = null;
      dwellSegundos = 0;
    }
  }
  return saidaConfirmadaEm;
}

// Aplica avaliarQuedaClasseViaria + avaliarSaiuParadaConfirmadaRecentemente
// (o gate de supressao real da producao) pra uma posicao/momento -- usado
// pelos 2 grupos abaixo.
async function avaliarComGate(veiculoId, lat, lng, momento) {
  const classeAtual = await classificarPosicao(lat, lng);
  const ultimaPrincipal = await ultimaViaPrincipalAntes(veiculoId, momento);
  const { quedaDetectada } = avaliarQuedaClasseViaria(
    classeAtual,
    ultimaPrincipal === null ? null : new Date(ultimaPrincipal),
    momento
  );
  if (!quedaDetectada) return { quedaDetectada: false, saiuParadaRecente: false, corroboraria: false };

  const pendentes = await buscarSnapshotPendentes(veiculoId, momento);
  const saidaConfirmada = await saiuParadaConfirmadaAntes(veiculoId, momento, pendentes);
  const saiuParadaRecente = avaliarSaiuParadaConfirmadaRecentemente(
    saidaConfirmada === null ? null : new Date(saidaConfirmada),
    momento
  );
  return { quedaDetectada: true, saiuParadaRecente, corroboraria: !saiuParadaRecente };
}

async function medirGrupo(nome, whereClause, params) {
  const { rows: disparos } = await c.query(
    `select ddl.veiculo_id, ddl.criado_em
       from desvio_disparo_log ddl
       join alertas a on a.veiculo_id = ddl.veiculo_id
         and a.desde <= ddl.criado_em and coalesce(a.resolvido_em, now()) >= ddl.criado_em
      where ddl.tipo_disparo = 'afastando_geral' and ${whereClause}`,
    params
  );
  let quedaBruta = 0, corroboraria = 0, suprimidoPorSaidaParada = 0, semHistorico = 0;
  const total = disparos.length;
  for (const d of disparos) {
    const posAtual = await c.query(
      `SELECT lat, lng FROM posicoes_historico WHERE veiculo_id = $1 AND criado_em <= $2::timestamptz ORDER BY criado_em DESC LIMIT 1`,
      [d.veiculo_id, d.criado_em]
    );
    if (posAtual.rows.length === 0) { semHistorico++; continue; }
    const { quedaDetectada, saiuParadaRecente, corroboraria: corroborou } = await avaliarComGate(
      d.veiculo_id, posAtual.rows[0].lat, posAtual.rows[0].lng, d.criado_em
    );
    if (!quedaDetectada) continue;
    quedaBruta++;
    if (saiuParadaRecente) suprimidoPorSaidaParada++;
    if (corroborou) corroboraria++;
  }
  const taxaCorroboraria = total > 0 ? ((corroboraria / total) * 100).toFixed(1) : "n/a";
  console.log(
    `${nome}: total=${total} queda_bruta=${quedaBruta} suprimido_saida_parada=${suprimidoPorSaidaParada} ` +
    `corroboraria=${corroboraria} sem_historico=${semHistorico} taxa_corroboraria=${taxaCorroboraria}%`
  );
  return { total, corroboraria, taxaCorroboraria };
}

// grupo (b): amostra de ciclos SEM streak formado -- nenhuma linha em
// desvio_disparo_log (qualquer tipo) pro mesmo veiculo dentro de +-3min.
const TAMANHO_AMOSTRA_CONTROLE = 200;
async function medirGrupoControleSemStreak() {
  const { rows: amostra } = await c.query(
    `select ph.veiculo_id, ph.lat, ph.lng, ph.criado_em
       from posicoes_historico ph
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
  let quedaBruta = 0, corroboraria = 0, suprimidoPorSaidaParada = 0;
  const total = amostra.length;
  for (const s of amostra) {
    const { quedaDetectada, saiuParadaRecente, corroboraria: corroborou } = await avaliarComGate(
      s.veiculo_id, s.lat, s.lng, s.criado_em
    );
    if (!quedaDetectada) continue;
    quedaBruta++;
    if (saiuParadaRecente) suprimidoPorSaidaParada++;
    if (corroborou) corroboraria++;
  }
  const taxaCorroboraria = total > 0 ? ((corroboraria / total) * 100).toFixed(1) : "n/a";
  console.log(
    `grupo CONTROLE (sem streak formado): amostra=${total} queda_bruta=${quedaBruta} ` +
    `suprimido_saida_parada=${suprimidoPorSaidaParada} corroboraria=${corroboraria} taxa_corroboraria=${taxaCorroboraria}%`
  );
  return { total, corroboraria, taxaCorroboraria };
}

const resTodos = await medirGrupo(
  "TODOS os disparos reais (14 dias)",
  `ddl.criado_em >= now() - interval '14 days'`,
  []
);
const resFalsoPositivo = await medirGrupo(
  "grupo FALSO_POSITIVO",
  `ddl.criado_em >= now() - interval '14 days' and a.status = 'falso_positivo'`,
  []
);
const resResolvido = await medirGrupo(
  "grupo RESOLVIDO",
  `ddl.criado_em >= now() - interval '14 days' and a.status = 'resolvido'`,
  []
);
const resControle = await medirGrupoControleSemStreak();

console.log(`\n=== RESUMO (sem conclusao prescritiva -- decisao de manter/ajustar o bonus e do usuario) ===`);
console.log(`TODOS os disparos:        total=${resTodos.total} corroboraria=${resTodos.corroboraria} (${resTodos.taxaCorroboraria}%)`);
console.log(`grupo FALSO_POSITIVO:      total=${resFalsoPositivo.total} corroboraria=${resFalsoPositivo.corroboraria} (${resFalsoPositivo.taxaCorroboraria}%)`);
console.log(`grupo RESOLVIDO:           total=${resResolvido.total} corroboraria=${resResolvido.corroboraria} (${resResolvido.taxaCorroboraria}%)`);
console.log(`grupo CONTROLE (sem streak): amostra=${resControle.total} corroboraria=${resControle.corroboraria} (${resControle.taxaCorroboraria}%)`);

await c.end();
