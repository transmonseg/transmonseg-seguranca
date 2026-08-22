// Classificacao de COMO um alerta foi tratado -- a distincao que motivou a
// mudanca de 20/08 (desvio saiu do botao "Resolver todos"): achado real de
// 19/08, 29 dos 35 "corretos" de desvio vieram de 6 cliques em lote e so'
// 6 de revisao individual. Sem separar os dois, "taxa de acerto" nao
// significa nada pra calibracao.
import pg from "pg";
// Import relativo (nao "@/...") de proposito: este modulo e' carregado
// diretamente pelo vitest via qualidade-tratamento.test.ts, e o projeto
// nao tem alias "@" configurado no vitest (nenhum outro arquivo em
// src/lib coberto por teste usa esse alias) -- "@/..." aqui faria o
// modulo inteiro falhar ao importar sob vitest, quebrando ate os testes
// puros de classificarBalde/mediana/percentil90.
import { configPoolContabo } from "./supabase/contabo-ca";

export type Balde = "individual" | "massa" | "limpo" | "auto" | "aberto";

const ORIGENS_INDIVIDUAIS = new Set(["resolver_individual", "falso_individual"]);
const ORIGENS_MASSA = new Set(["resolver_massa"]);

export function classificarBalde(a: {
  origem_acao: string | null;
  status: string;
  operador_id: string | null;
}): Balde {
  // Ordem importa. "limpo" primeiro: e' um status proprio (28/07, botao
  // "Limpar avisos") que tira da tela SEM afirmar revisao caso a caso --
  // nunca deve cair em "individual"/"massa" mesmo tendo origem_acao.
  if (a.status === "limpo") return "limpo";
  if (a.status === "ativo" || a.status === "reconhecido") return "aberto";
  if (a.origem_acao && ORIGENS_INDIVIDUAIS.has(a.origem_acao)) return "individual";
  if (a.origem_acao && ORIGENS_MASSA.has(a.origem_acao)) return "massa";
  // Sem origem_acao reconhecida: quem decide e' a presenca de operador.
  // operador_id preenchido = acao humana de antes da coluna origem_acao
  // existir (dado historico); vazio = o motor fechou sozinho.
  return a.operador_id ? "individual" : "auto";
}

export function mediana(nums: number[]): number | null {
  if (nums.length === 0) return null;
  const ord = [...nums].sort((x, y) => x - y);
  const meio = Math.floor(ord.length / 2);
  return ord.length % 2 === 1 ? ord[meio] : (ord[meio - 1] + ord[meio]) / 2;
}

export function percentil90(nums: number[]): number | null {
  if (nums.length === 0) return null;
  const ord = [...nums].sort((x, y) => x - y);
  // Nearest-rank: menor valor tal que >=90% das amostras sao <= ele.
  const idx = Math.min(ord.length - 1, Math.ceil(0.9 * ord.length) - 1);
  return ord[Math.max(0, idx)];
}

export type ResumoQualidade = {
  baldes: Record<string, number>;
  // Correto vs falso ENTRE OS DE REVISAO INDIVIDUAL -- a metrica que o
  // cliente mais cita ("taxa de acerto", spec Secao 1). Dentro do balde
  // 'individual' so' existem 2 status possiveis por construcao do proprio
  // SQL_BALDE (a CASE ja desvia 'limpo'/'ativo'/'reconhecido' antes de
  // chegar em 'individual'): 'falso_positivo' -> falso, 'resolvido' ->
  // correto. Validado contra dado real de 19/08 tipo desvio: 6
  // corretos + 8 falsos = 14 individuais, todos da mesma operadora
  // (Elloisy.Salles) -- ver scripts/validar-sql-balde.mjs.
  individualCorretoFalso: { corretos: number; falsos: number };
  falsosPorMotivo: { motivo: string | null; n: number }[];
  porOperador: { operador: string; balde: string; n: number }[];
  latencia: { amostras: number; medianaMin: number | null; p90Min: number | null };
  serieDiaria: { dia: string; balde: string; n: number }[];
};

// Mesma classificacao de classificarBalde (acima), expressa em SQL pra
// rodar no banco. Os dois precisam concordar -- o script de validacao com
// dado real (Step 8 do plano) e' o que garante isso na pratica.
//
// QUEBRA DE SERIE A PARTIR DO DEPLOY DO COOLDOWN (achado Important da
// revisao final de integracao): no mesmo branch que criou este painel, o
// motor passou a aplicar um cooldown de re-disparo pra
// parada_anomala/parada_longa (ver deveSuprimirRedisparoParada em
// detectores.ts + o filtro em src/app/api/motor/route.ts, achado real
// TUG-9D18; implementado no commit de 22/08/2026, mas so' entra em vigor
// quando for de fato deployado em producao -- deploy ainda pendente de
// autorizacao humana no momento deste comentario, NAO usar 22/08/2026 como
// a data real da quebra). A partir do deploy do cooldown, alertas de parada
// duplicados pro mesmo episodio simplesmente deixam de nascer. Efeito
// nestes baldes e na latencia, SO' pra esses dois tipos:
//   - 'individual' cai -- nao porque a operacao revisou menos, mas porque
//     chegou menos alerta duplicado pra revisar.
//   - medianaMin/p90Min SOBEM -- a populacao de tratamentos baratos de
//     1-3min (a segunda, terceira... N-esima duplicata do mesmo episodio,
//     que o operador fechava rapido por ja conhecer o caso) some da
//     amostra. Nos dados reais do TUG-9D18 havia varios desses
//     (10:15:30->10:17:21, 10:18:01->10:20:33, 10:21:01->10:22:06). Um
//     leitor comparando dias antes/depois do deploy do cooldown pode ler
//     isso como "a operacao ficou mais lenta", quando na verdade e' o
//     cooldown fazendo o trabalho antes. Nao e' bug -- e' quebra de
//     comparabilidade historica que precisa de nota na UI (ver /analise,
//     que usa linguagem relativa -- "a partir do deploy do cooldown" --
//     de proposito, pra nao cravar uma data que pode nao ser a real).
export const SQL_BALDE = `
  CASE
    WHEN status = 'limpo' THEN 'limpo'
    WHEN status IN ('ativo','reconhecido') THEN 'aberto'
    WHEN origem_acao IN ('resolver_individual','falso_individual') THEN 'individual'
    WHEN origem_acao = 'resolver_massa' THEN 'massa'
    WHEN operador_id IS NOT NULL THEN 'individual'
    ELSE 'auto'
  END`;

// Agregacao feita no Postgres de proposito: a pagina /analise puxa linhas
// com .limit(2000) e ~12k alertas/14d ja estouram isso -- contar em JS
// sobre um recorte truncado daria numero errado sem avisar. Compartilhada
// entre a rota /api/qualidade e a pagina /analise (Server Component) pra
// nao duplicar o SQL.
//
// Parametro `nivel` (22/08, achado Important da revisao final): a pagina
// /analise tem chips clicaveis de nivel ("critico"/"atencao") que reescrevem
// todas as outras secoes da tela -- sem propagar aqui, clicar no chip mudava
// tudo MENOS esta secao, sem sinalizar a inconsistencia. `status` (a outra
// dimensao de filtro da pagina) deliberadamente NAO entra aqui: os baldes
// desta secao JA particionam por status por construcao (aberto/limpo/etc
// sao, eles mesmos, status), entao aplicar um filtro de status por cima
// zeraria baldes inteiros sem sentido -- ver nota na UI (/analise).
export async function apurarQualidade(
  dias: number,
  tipo: string | null,
  nivel: string | null = null
): Promise<ResumoQualidade> {
  const client = new pg.Client({ ...configPoolContabo(process.env.DATABASE_URL) });
  await client.connect();
  try {
    const params = [dias, tipo, nivel];
    const filtroBase = `
      FROM alertas
      WHERE modo_teste = false
        AND desde >= now() - ($1::int * interval '1 day')
        AND ($2::text IS NULL OR tipo = $2::text)
        AND ($3::text IS NULL OR nivel = $3::text)`;
    const [baldes, corretoFalso, falsos, porOperador, latencia, serie] = await Promise.all([
      client.query<{ balde: string; n: string }>(
        `SELECT ${SQL_BALDE} AS balde, count(*)::text AS n ${filtroBase} GROUP BY 1`, params),
      // Correto vs falso dentro de 'individual' (ver comentario do tipo
      // ResumoQualidade acima). status='falso_positivo' -> falso, resto
      // (so' 'resolvido' chega aqui) -> correto -- mesmo criterio que
      // scripts/validar-sql-balde.mjs confere contra o dado real.
      client.query<{ resultado: string; n: string }>(
        `SELECT (CASE WHEN status = 'falso_positivo' THEN 'falso' ELSE 'correto' END) AS resultado,
                count(*)::text AS n
         ${filtroBase} AND ${SQL_BALDE} = 'individual' GROUP BY 1`, params),
      client.query<{ motivo: string | null; n: string }>(
        `SELECT motivo_falso_positivo AS motivo, count(*)::text AS n ${filtroBase} AND ${SQL_BALDE} = 'individual' GROUP BY 1`, params),
      client.query<{ operador: string; balde: string; n: string }>(
        // Sem prefixo "a." em SQL_BALDE de proposito: `operadores` (o) nao
        // tem coluna com nome colidente (status/origem_acao/operador_id --
        // ver scripts/migrations/contabo/001_schema_base.sql), entao nao ha
        // ambiguidade no JOIN. Reusar ${SQL_BALDE} bare (em vez de uma copia
        // manual com prefixo) evita uma TERCEIRA expressao da mesma regra
        // que pudesse divergir silenciosamente da que o Step 8 valida.
        `SELECT coalesce(o.nome, 'sem operador') AS operador,
                ${SQL_BALDE} AS balde,
                count(*)::text AS n
         FROM alertas a LEFT JOIN operadores o ON o.id = a.operador_id
         WHERE a.modo_teste = false
           AND a.desde >= now() - ($1::int * interval '1 day')
           AND ($2::text IS NULL OR a.tipo = $2::text)
           AND ($3::text IS NULL OR a.nivel = $3::text)
         GROUP BY 1, 2`, params),
      client.query<{ minutos: string }>(
        `SELECT (extract(epoch from (resolvido_em - desde)) / 60)::text AS minutos
         ${filtroBase} AND ${SQL_BALDE} = 'individual' AND resolvido_em IS NOT NULL`, params),
      client.query<{ dia: string; balde: string; n: string }>(
        `SELECT to_char(date_trunc('day', desde AT TIME ZONE 'America/Sao_Paulo'), 'YYYY-MM-DD') AS dia,
                ${SQL_BALDE} AS balde, count(*)::text AS n ${filtroBase} GROUP BY 1, 2 ORDER BY 1`, params),
    ]);
    const minutos = latencia.rows.map((r) => Number(r.minutos)).filter((n) => Number.isFinite(n) && n >= 0);
    const mapaCorretoFalso = Object.fromEntries(corretoFalso.rows.map((r) => [r.resultado, Number(r.n)]));
    return {
      baldes: Object.fromEntries(baldes.rows.map((r) => [r.balde, Number(r.n)])),
      individualCorretoFalso: {
        corretos: mapaCorretoFalso.correto ?? 0,
        falsos: mapaCorretoFalso.falso ?? 0,
      },
      falsosPorMotivo: falsos.rows.map((r) => ({ motivo: r.motivo, n: Number(r.n) })),
      porOperador: porOperador.rows.map((r) => ({ operador: r.operador, balde: r.balde, n: Number(r.n) })),
      latencia: { amostras: minutos.length, medianaMin: mediana(minutos), p90Min: percentil90(minutos) },
      serieDiaria: serie.rows.map((r) => ({ dia: r.dia, balde: r.balde, n: Number(r.n) })),
    };
  } finally {
    await client.end();
  }
}
