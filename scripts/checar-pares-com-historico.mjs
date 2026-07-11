// Lista os pares origem-destino que ja acumularam 3+ dias distintos em
// corredor_celulas -- candidatos a religar historico proprio (Fase adiada
// no design, so quando o dado sustentar). Rodar periodicamente pra
// acompanhar o crescimento, sem acao automatica ainda.
import pg from "pg";

const MIN_DIAS = 3;
const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL });

const { rows } = await pool.query(`
  select cliente_id, origem_celula, destino_celula, count(distinct ultimo_visto) as dias_distintos
  from corredor_celulas
  where origem_celula is not null and destino_celula is not null
  group by cliente_id, origem_celula, destino_celula
  having count(distinct ultimo_visto) >= $1
  order by dias_distintos desc
`, [MIN_DIAS]);

console.log(`${rows.length} pares com ${MIN_DIAS}+ dias distintos de historico:`);
console.log(JSON.stringify(rows, null, 1));

await pool.end();
