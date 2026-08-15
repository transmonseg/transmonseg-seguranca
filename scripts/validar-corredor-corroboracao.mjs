// Mede quanto o corredor real teria corroborado nos disparos de desvio
// reais dos ultimos 14 dias, SEM mudar nenhum comportamento de disparo --
// so' roda a funcao pura contra dado ja gravado. Ver
// docs/superpowers/specs/2026-08-14-desvio-corredor-corroboracao-design.md,
// secao "Testes e validacao".
import pg from "pg";
import { verificarCorredorFora } from "../src/lib/corredor-confirmacao.ts";

const c = new pg.Client({ connectionString: process.env.DATABASE_URL, ssl: { rejectUnauthorized: false } });
await c.connect();

const { rows: disparos } = await c.query(`
  select ddl.id, ddl.veiculo_id, ddl.destinos, ddl.streak_afastando, ddl.criado_em, v.placa
  from desvio_disparo_log ddl
  join veiculos v on v.id = ddl.veiculo_id
  where ddl.tipo_disparo = 'afastando_geral'
    and ddl.criado_em >= now() - interval '14 days'
  order by ddl.criado_em desc
`);
console.log(`Disparos reais de afastando_geral, 14 dias: ${disparos.length}`);

let confirmados = 0;
let semAncora = 0;
let semDestinos = 0;
let indisponivel = 0;

for (const d of disparos) {
  const destinos = d.destinos.map((x) => ({ lat: x.lat, lng: x.lng }));
  if (destinos.length === 0) { semDestinos++; continue; }

  const segundosStreak = d.streak_afastando * 30;
  const { rows: ancoraRows } = await c.query(
    `SELECT lat, lng FROM posicoes_historico
      WHERE veiculo_id = $1 AND criado_em <= $2::timestamptz - ($3 || ' seconds')::interval
      ORDER BY criado_em DESC LIMIT 1`,
    [d.veiculo_id, d.criado_em, String(segundosStreak)]
  );
  const ancora = ancoraRows[0];
  if (!ancora) { semAncora++; continue; }

  // posicao atual = posicao no momento do disparo (o proprio criado_em)
  const { rows: atualRows } = await c.query(
    `SELECT lat, lng, velocidade FROM posicoes_historico
      WHERE veiculo_id = $1 AND criado_em <= $2::timestamptz
      ORDER BY criado_em DESC LIMIT 1`,
    [d.veiculo_id, d.criado_em]
  );
  const atual = atualRows[0];
  if (!atual) { semAncora++; continue; }

  const { confirmaFora } = await verificarCorredorFora(
    { lat: ancora.lat, lng: ancora.lng },
    { lat: atual.lat, lng: atual.lng, velocidade: atual.velocidade ?? 0 },
    destinos
  );
  if (confirmaFora) confirmados++;
  else indisponivel++;
}

console.log(`Corroborados (confirmaFora=true): ${confirmados}`);
console.log(`Nao corroborados (OSRM indisponivel/dentro de rota): ${indisponivel}`);
console.log(`Sem ancora suficiente: ${semAncora}`);
console.log(`Sem destinos gravados: ${semDestinos}`);

await c.end();
