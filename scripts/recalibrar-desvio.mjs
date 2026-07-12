// Recalcula calibracao_desvio a partir dos alertas ja rotulados pelos
// operadores. Rodar manualmente por enquanto (nao automatizado neste
// ciclo); candidato a virar cron semanal depois de validar as primeiras
// rodadas.
// Nota 12/07: a coluna score_ajustado (migration 019) fica SEM USO -- o
// motor aplica o fator ao vivo direto de taxa_falso_positivo
// (aplicarFatorCalibrado em src/lib/calibracao-desvio.ts), nao precisa de
// um "score base de referencia" pre-calculado (ambiguo: alertas do mesmo
// tipo tem scores base muito diferentes).
import pg from "pg";

const MIN_AMOSTRAS = 20;
const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL });

// Copia intencional de src/lib/calibracao-desvio.ts: script .mjs standalone
// (mesmo padrao dos outros scripts deste diretorio) nao importa .ts sem
// build. Se mudar a formula aqui, mudar la tambem (e vice-versa) -- testes
// unitarios reais ficam em calibracao-desvio.test.ts.
function taxaFalsoPositivoCalibrada(nAmostras, nFalsoPositivo, taxaGlobal, minAmostras) {
  const alphaPrior = taxaGlobal * minAmostras;
  const betaPrior = (1 - taxaGlobal) * minAmostras;
  return (alphaPrior + nFalsoPositivo) / (alphaPrior + betaPrior + nAmostras);
}

const { rows } = await pool.query(`
  select tipo, status, contexto -> 'corredor' ->> 'veredito' as corredor_veredito
  from alertas
  where tipo in ('desvio', 'bypass_entrega', 'baseline_veiculo') and status != 'ativo'
`);

const totalFalsoPositivo = rows.filter((r) => r.status === "falso_positivo").length;
const taxaGlobal = rows.length > 0 ? totalFalsoPositivo / rows.length : 0.3;

function segmentar(chave) {
  const grupos = new Map();
  for (const r of rows) {
    const k = chave(r);
    if (k == null) continue;
    const g = grupos.get(k) ?? { total: 0, falsoPositivo: 0 };
    g.total++;
    if (r.status === "falso_positivo") g.falsoPositivo++;
    grupos.set(k, g);
  }
  return grupos;
}

const segmentos = new Map([
  ...[...segmentar((r) => `tipo:${r.tipo}`)].map(([k, v]) => [k, v]),
  ...[...segmentar((r) => (r.corredor_veredito ? `corredor_veredito:${r.corredor_veredito}` : null))].map(([k, v]) => [k, v]),
]);

for (const [segmento, g] of segmentos) {
  const taxa = taxaFalsoPositivoCalibrada(g.total, g.falsoPositivo, taxaGlobal, MIN_AMOSTRAS);
  await pool.query(
    `insert into calibracao_desvio (segmento, n_amostras, n_falso_positivo, taxa_falso_positivo, atualizado_em)
     values ($1, $2, $3, $4, now())
     on conflict (segmento) do update set n_amostras = $2, n_falso_positivo = $3, taxa_falso_positivo = $4, atualizado_em = now()`,
    [segmento, g.total, g.falsoPositivo, taxa]
  );
  console.log(`${segmento}: ${g.total} amostras, taxa calibrada ${(taxa * 100).toFixed(1)}%`);
}

await pool.end();
