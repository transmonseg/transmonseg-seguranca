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
import { configPoolContabo } from "@/lib/supabase/contabo-ca";
import { contaComoRotuloHumano } from "@/lib/detectores";

export const dynamic = "force-dynamic";
export const maxDuration = 30;

const MIN_AMOSTRAS = 20;

type RowAlertas = { tipo: string; status: string; contexto: unknown };
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
    ...configPoolContabo(process.env.DATABASE_URL),
    max: 2,
  });

  try {
    // Segmentacao grosseira por tipo -- continua vindo de `alertas`. Agora
    // PRECISA de `contexto` (deixou de estar sempre zerado aqui, ver filtro
    // logo abaixo). Tambem a fonte da populacao mais ampla usada como
    // denominador de `taxaGlobal`.
    // 'parada_fora_tapete' adicionado 27/07 (revisao adversarial, caso
    // TTK-4D14): tipo NOVO, criado nesta mesma sessao dando ao gatilho
    // "parado fora do tapete" uma vaga propria em vez de reusar tipo=
    // "desvio" (ver detectores.ts/TIPOS_NAO_GERENCIADOS) -- precisa entrar
    // aqui pra ter um segmento `tipo:parada_fora_tapete` de fallback e pra
    // contar na populacao de `taxaGlobal`, mesma logica ja aplicada a
    // bypass_entrega/baseline_veiculo quando ganharam tipo proprio.
    // 'parada_sem_marcacao' adicionado 28/07 (achado real, cliente Nutry
    // Max): detector NOVO, "sem historico validado" -- precisa entrar aqui
    // desde o dia 1, senao a taxa de falso positivo dele nunca e medida
    // (mesmo achado M3 da revisao independente que motivou esta linha).
    // status != 'limpo' (28/07): status novo, criado nesta mesma sessao pro
    // botao "Limpar avisos" (acoes-alertas.ts/limparVarios) -- operador so
    // tirou da tela, sem afirmar nada sobre o caso. Filtrado aqui direto no
    // WHERE, e NAO estendendo contaComoRotuloHumano (detectores.ts, abaixo):
    // aquela funcao resolve uma pergunta diferente -- dentro de linhas JA
    // fora de 'ativo', o CONTEXTO marca origem automatica (auto_resolvido/
    // auto_expirado)? 'limpo' e' o proprio STATUS, nao um marcador de
    // contexto, e por construcao nunca deveria nem entrar no conjunto de
    // entrada dessa funcao -- diferente de 'resolvido'/'falso_positivo', que
    // MISTURAM veredito humano genuino e marcador automatico sob o MESMO
    // status (por isso aqueles precisam do filtro fino de contexto). 'limpo'
    // nunca foi pensado como sinal de calibracao desde a origem, entao o
    // filtro grosseiro de status (igual ao 'ativo' logo ao lado) já resolve.
    const { rows: rowsAlertasBrutos } = await pool.query<RowAlertas>(`
      select tipo, status, contexto
      from alertas
      where tipo in ('desvio', 'bypass_entrega', 'baseline_veiculo', 'parada_fora_tapete', 'parada_sem_marcacao') and status != 'ativo' and status != 'limpo'
    `);

    // BLOCKER (revisao independente round 2, 27/07): a auto-resolucao de
    // "rua estranha" (motor/route.ts) grava status='falso_positivo' com
    // contexto.auto_resolvido=true -- igual, em status, a uma resolucao
    // humana real. Sem filtrar essas linhas aqui, elas inflam `taxaGlobal`
    // (prior Bayesiano compartilhado por TODO segmento, peso MIN_AMOSTRAS)
    // e o segmento grosseiro `tipo:desvio` (fallback ao vivo que o motor usa
    // quando o segmento fino tem <20 amostras) -- exatamente o vies que a
    // remocao de registrarCasosDesvioRevisao em motor/route.ts (busca por
    // "MEDIUM 3" la) protege do lado FINO (`casos_desvio_revisao`), mas
    // nunca protegeu deste lado grosseiro por vir de tabela diferente.
    // M1 (revisao independente round 3, 27/07): a round 2 reusava
    // contaComoEventoDeSilenciamento (detectores.ts) aqui, mas esse
    // predicado so cobre contexto.auto_resolvido -- deixava passar
    // contexto.auto_expirado (cron 'expirar-alertas-ativos-esquecidos',
    // scripts/migrations/contabo/002_retencao.sql, fecha sozinho como
    // 'resolvido' qualquer alerta 'ativo' esquecido ha 7+ dias). Como desvio
    // nunca fecha sozinho por conta propria, TODO desvio nunca tratado pelo
    // operador eventualmente vira uma linha auto_expirado e contava como
    // "verdadeiro positivo" aqui -- mesmo vies, so pela porta auto_expirado
    // em vez de auto_resolvido. Trocado por contaComoRotuloHumano
    // (detectores.ts), que cobre os dois casos -- essa e' a pergunta de
    // pureza de calibracao, diferente da pergunta de silenciamento por 2h
    // que contaComoEventoDeSilenciamento continua respondendo em
    // mapaTiposSilenciados (motor/route.ts, nao mudado por este achado). O
    // node-postgres ja desserializa a coluna jsonb pra objeto JS, entao a
    // mesma funcao pura serve aqui sem duplicar o check.
    const rowsAlertas = rowsAlertasBrutos.filter((r) => contaComoRotuloHumano(r.contexto));

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
    // Achado 01/08: "Resolver todos" (massa) alimentava esta tabela como se
    // fosse veredito caso a caso -- 4.165 alertas de massa contra 457
    // individuais no historico, ou seja a calibracao estava lendo
    // majoritariamente clique-pra-desentupir-a-tela como "confirmado real".
    // So origem individual conta. NULL = historico anterior a migration 027
    // (mantido: o backfill so marcou o que dava pra inferir com seguranca).
    const { rows: rowsCasosRevisao } = await pool.query<RowCasosRevisao>(`
      select status_final as status, contexto_detector -> 'calibracao' ->> 'segmento' as segmento
      from casos_desvio_revisao
      where origem_acao is null or origem_acao <> 'resolver_massa'
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
