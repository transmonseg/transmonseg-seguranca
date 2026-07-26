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

type RowAlertas = { tipo: string; status: string };
type RowCasosRevisao = { status: string; segmento: string | null };

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

// Generico desde 26/07: precisa rodar sobre 2 formatos de linha diferentes
// (`alertas`: {tipo, status}; `casos_desvio_revisao`: {status, segmento}) --
// ver achado no comentario da query principal, abaixo.
function segmentar<T extends { status: string }>(
  rows: T[],
  chave: (r: T) => string | null
): Map<string, { total: number; falsoPositivo: number }> {
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
    // Segmentacao grosseira por tipo -- continua vindo de `alertas`, nao
    // precisa de `contexto` (que ja esta zerado pelo STRIP_PESADO em
    // acoes-alertas.ts nesse ponto pra qualquer alerta ja fechado). Tambem a
    // fonte da populacao mais ampla usada como denominador de `taxaGlobal`.
    const { rows: rowsAlertas } = await pool.query<RowAlertas>(`
      select tipo, status
      from alertas
      where tipo in ('desvio', 'bypass_entrega', 'baseline_veiculo') and status != 'ativo'
    `);

    // Achado real 26/07: a segmentacao FINA (antes `corredor_veredito:X`, lida
    // de `alertas.contexto`) travava com dado congelado -- `contexto` ja esta
    // `{}` no momento em que este job roda (STRIP_PESADO acontece no
    // resolver/marcar-falso-positivo, muito antes do cron semanal). O
    // segmento correto (`corredor_veredito:X` ou `origem:saida_parada`, ja
    // calculado uma vez por `segmentoCalibracaoPreferido` no momento em que o
    // alerta foi criado) sobrevive intacto em `casos_desvio_revisao`
    // (snapshot tirado ANTES do STRIP_PESADO, ver src/lib/casos-desvio-revisao.ts).
    // So tem status_final in ('resolvido','falso_positivo') por construcao --
    // nunca 'ativo', nao precisa filtrar de novo.
    const { rows: rowsCasosRevisao } = await pool.query<RowCasosRevisao>(`
      select status_final as status, contexto_detector -> 'calibracao' ->> 'segmento' as segmento
      from casos_desvio_revisao
    `);

    const totalFalsoPositivo = rowsAlertas.filter((r) => r.status === "falso_positivo").length;
    const taxaGlobal = rowsAlertas.length > 0 ? totalFalsoPositivo / rowsAlertas.length : 0.3;

    const segmentos = new Map([
      ...segmentar(rowsAlertas, (r) => `tipo:${r.tipo}`),
      ...segmentar(rowsCasosRevisao, (r) => r.segmento),
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
