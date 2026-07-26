// Recalibração semanal de calibracao_desvio — POST /api/recalibrar-desvio
// Rota protegida por x-motor-key (MOTOR_SECRET), mesmo padrao de /api/motor.
// Mesma logica de scripts/recalibrar-desvio.mjs, convertida pra rodar via
// cron (pg_cron + pg_net) em vez de execucao manual -- ver comentario
// original no script: "candidato a virar cron semanal depois de validar as
// primeiras rodadas."
// Nota 12/07 (preservada do script): a coluna score_ajustado (migration 019)
// fica SEM USO -- o motor aplica o fator ao vivo direto de
// taxa_falso_positivo (aplicarFatorCalibrado em src/lib/calibracao-desvio.ts).

import pg from "pg";
import { sslContabo } from "@/lib/supabase/contabo-ca";

export const dynamic = "force-dynamic";
export const maxDuration = 30;

const MIN_AMOSTRAS = 20;

type Row = { tipo: string; status: string; corredor_veredito: string | null };

// Copia intencional de src/lib/calibracao-desvio.ts, mesmo padrao do script
// standalone: rota nao importa .ts de lib sem passar pelo bundler do Next,
// mas aqui SIM da pra importar direto (mesmo processo Next) -- mantido
// como copia local só pra ficar identico ao script durante a transicao;
// os testes reais da formula ficam em calibracao-desvio.test.ts.
function taxaFalsoPositivoCalibrada(
  nAmostras: number,
  nFalsoPositivo: number,
  taxaGlobal: number,
  minAmostras: number
): number {
  const alphaPrior = taxaGlobal * minAmostras;
  const betaPrior = (1 - taxaGlobal) * minAmostras;
  return (alphaPrior + nFalsoPositivo) / (alphaPrior + betaPrior + nAmostras);
}

function segmentar(rows: Row[], chave: (r: Row) => string | null): Map<string, { total: number; falsoPositivo: number }> {
  const grupos = new Map<string, { total: number; falsoPositivo: number }>();
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

export async function POST(request: Request) {
  const chave = request.headers.get("x-motor-key");
  if (!chave || chave !== process.env.MOTOR_SECRET) {
    return Response.json({ erro: "Nao autorizado" }, { status: 401 });
  }

  const pool = new pg.Pool({
    connectionString: process.env.DATABASE_URL,
    ssl: sslContabo(process.env.DATABASE_URL),
    max: 2,
  });

  try {
    const { rows } = await pool.query<Row>(`
      select tipo, status, contexto -> 'corredor' ->> 'veredito' as corredor_veredito
      from alertas
      where tipo in ('desvio', 'bypass_entrega', 'baseline_veiculo') and status != 'ativo'
    `);

    const totalFalsoPositivo = rows.filter((r) => r.status === "falso_positivo").length;
    const taxaGlobal = rows.length > 0 ? totalFalsoPositivo / rows.length : 0.3;

    const segmentos = new Map([
      ...segmentar(rows, (r) => `tipo:${r.tipo}`),
      ...segmentar(rows, (r) => (r.corredor_veredito ? `corredor_veredito:${r.corredor_veredito}` : null)),
    ]);

    const resultado: { segmento: string; amostras: number; taxa: number }[] = [];
    for (const [segmento, g] of segmentos) {
      const taxa = taxaFalsoPositivoCalibrada(g.total, g.falsoPositivo, taxaGlobal, MIN_AMOSTRAS);
      await pool.query(
        `insert into calibracao_desvio (segmento, n_amostras, n_falso_positivo, taxa_falso_positivo, atualizado_em)
         values ($1, $2, $3, $4, now())
         on conflict (segmento) do update set n_amostras = $2, n_falso_positivo = $3, taxa_falso_positivo = $4, atualizado_em = now()`,
        [segmento, g.total, g.falsoPositivo, taxa]
      );
      resultado.push({ segmento, amostras: g.total, taxa: Math.round(taxa * 1000) / 10 });
    }

    return Response.json({ segmentos: resultado.length, taxaGlobal: Math.round(taxaGlobal * 1000) / 10, detalhe: resultado });
  } finally {
    await pool.end();
  }
}
