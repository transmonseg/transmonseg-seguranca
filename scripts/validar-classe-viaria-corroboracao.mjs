// Mede quanto a classe viaria teria corroborado nos disparos reais de
// desvio dos ultimos 14 dias, COM grupos de controle -- a licao de 14/08
// (corredor: 89% de corroboracao geral escondia uma discriminacao
// invertida, falso_positivo corroborando MAIS que resolvido) exige medir
// contra controle, nao so o numero bruto. Ver
// docs/superpowers/specs/2026-08-15-classe-viaria-corroboracao-design.md.
import pg from "pg";
import { melhorClasse, avaliarQuedaClasseViaria, avaliarSaiuParadaConfirmadaRecentemente } from "../src/lib/classe-viaria-confirmacao.ts";

const c = new pg.Client({ connectionString: process.env.DATABASE_URL, ssl: { rejectUnauthorized: false } });
await c.connect();

function celulaDe(lat, lng) {
  return `${Math.round(lat * 1000)}:${Math.round(lng * 1000)}`;
}
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

async function medirGrupo(nome, whereClause, params) {
  const { rows: disparos } = await c.query(
    `select ddl.veiculo_id, ddl.criado_em, ddl.destinos
       from desvio_disparo_log ddl
       join alertas a on a.veiculo_id = ddl.veiculo_id
         and a.desde <= ddl.criado_em and coalesce(a.resolvido_em, now()) >= ddl.criado_em
      where ddl.tipo_disparo = 'afastando_geral' and ${whereClause}`,
    params
  );
  let quedaSim = 0, semHistorico = 0, total = disparos.length;
  for (const d of disparos) {
    const posAtual = await c.query(
      `SELECT lat, lng FROM posicoes_historico WHERE veiculo_id = $1 AND criado_em <= $2::timestamptz ORDER BY criado_em DESC LIMIT 1`,
      [d.veiculo_id, d.criado_em]
    );
    if (posAtual.rows.length === 0) { semHistorico++; continue; }
    const classeAtual = await classificarPosicao(posAtual.rows[0].lat, posAtual.rows[0].lng);
    const ultimaPrincipal = await ultimaViaPrincipalAntes(d.veiculo_id, d.criado_em);
    const { quedaDetectada } = avaliarQuedaClasseViaria(classeAtual, ultimaPrincipal === null ? null : new Date(ultimaPrincipal), d.criado_em);
    if (quedaDetectada) quedaSim++;
  }
  console.log(`${nome}: total=${total} queda_detectada=${quedaSim} sem_historico=${semHistorico} taxa=${total > 0 ? ((quedaSim / total) * 100).toFixed(1) : "n/a"}%`);
}

await medirGrupo(
  "TODOS os disparos reais (14 dias)",
  `ddl.criado_em >= now() - interval '14 days'`,
  []
);
await medirGrupo(
  "grupo FALSO_POSITIVO",
  `ddl.criado_em >= now() - interval '14 days' and a.status = 'falso_positivo'`,
  []
);
await medirGrupo(
  "grupo RESOLVIDO",
  `ddl.criado_em >= now() - interval '14 days' and a.status = 'resolvido'`,
  []
);

await c.end();
