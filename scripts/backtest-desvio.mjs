// Analise retroativa de precisao dos alertas de desvio, usando os rotulos
// que os operadores JA geraram (status='falso_positivo' vs
// status in ('resolvido','reconhecido','ativo') como proxy de "achou real
// o suficiente pra nao descartar na hora"). Nao existe historico bruto de
// posicoes no banco pra replay de trajetoria completa (restricao
// confirmada 11/07/2026) -- isso mede precisao sobre o que JA disparou, nao
// pega falso negativo (desvio real que nunca chegou a disparar).
import pg from "pg";

const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL });

const { rows } = await pool.query(`
  select
    v.placa,
    a.tipo,
    a.score,
    a.status,
    a.contexto -> 'corredor' ->> 'veredito' as corredor_veredito,
    extract(hour from a.created_at at time zone 'America/Sao_Paulo') as hora_sp
  from alertas a
  join veiculos v on v.id = a.veiculo_id
  where a.tipo in ('desvio', 'bypass_entrega', 'baseline_veiculo')
    and a.status != 'ativo'
  order by a.created_at asc
`);

function segmentar(linhas, chave) {
  const grupos = new Map();
  for (const r of linhas) {
    const k = chave(r);
    if (k == null) continue;
    const g = grupos.get(k) ?? { total: 0, falsoPositivo: 0 };
    g.total++;
    if (r.status === "falso_positivo") g.falsoPositivo++;
    grupos.set(k, g);
  }
  return grupos;
}

console.log("=== Por tipo ===");
for (const [k, g] of segmentar(rows, (r) => r.tipo)) {
  const precisao = g.total > 0 ? (100 * (g.total - g.falsoPositivo) / g.total).toFixed(1) : "n/a";
  console.log(`${k}: ${g.total} alertas, ${g.falsoPositivo} falso positivo, precisao ${precisao}% ${g.total < 20 ? "(AMOSTRA INSUFICIENTE, minimo 20)" : ""}`);
}

console.log("\n=== Por veredito do corredor (so tipo=desvio) ===");
for (const [k, g] of segmentar(rows.filter((r) => r.tipo === "desvio"), (r) => r.corredor_veredito ?? "sem_contexto")) {
  const precisao = g.total > 0 ? (100 * (g.total - g.falsoPositivo) / g.total).toFixed(1) : "n/a";
  console.log(`${k}: ${g.total} alertas, precisao ${precisao}% ${g.total < 20 ? "(AMOSTRA INSUFICIENTE)" : ""}`);
}

console.log("\n=== Por faixa horaria ===");
for (const [k, g] of segmentar(rows, (r) => `${Math.floor(r.hora_sp / 6) * 6}h-${Math.floor(r.hora_sp / 6) * 6 + 6}h`)) {
  const precisao = g.total > 0 ? (100 * (g.total - g.falsoPositivo) / g.total).toFixed(1) : "n/a";
  console.log(`${k}: ${g.total} alertas, precisao ${precisao}% ${g.total < 20 ? "(AMOSTRA INSUFICIENTE)" : ""}`);
}

await pool.end();
