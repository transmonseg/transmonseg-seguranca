// scripts/validar-sql-balde.mjs
//
// Detector de divergencia entre SQL_BALDE (o que roda de verdade em
// apurarQualidade, agregado no Postgres) e classificarBalde (a funcao pura
// que tem os 9 testes unitarios, mas ZERO chamador em producao). Achado
// real da revisao de pendencias de 22/08: as duas expressoes da mesma
// regra podem divergir silenciosamente -- um script de validacao existiu
// uma vez, rodou, achou os dois batendo, e foi apagado sem deixar
// mecanismo permanente de deteccao. Este script substitui aquele.
//
// O que faz:
//   1. Busca as linhas cruas de `alertas` (tipo/status/origem_acao/
//      operador_id) pro dia e tipo alvo, direto do banco.
//   2. Classifica CADA linha em JS com classificarBalde (a funcao testada).
//   3. Roda a MESMA agregacao via SQL_BALDE (a expressao que roda de
//      verdade em producao) sobre o mesmo recorte.
//   4. Compara balde a balde -- se alguem mudar um ramo de SQL_BALDE sem
//      espelhar em classificarBalde (ou vice-versa), os dois tabelas
//      divergem e o script falha com exit code 1.
//   5. Confere os 2 baselines conhecidos e documentados na sessao de
//      22/08 (dado real, dia 19/08 tipo desvio):
//        - individual=14, massa=29, limpo=122 (soma=165, "total" tratado)
//        - dentro dos 14 individuais: 6 corretos (status=resolvido) e
//          8 falsos (status=falso_positivo), TODOS da operadora
//          Elloisy.Salles.
//
// Uso: npx tsx --env-file=.env.local scripts/validar-sql-balde.mjs [DIA] [TIPO]
//   Sem argumentos, valida 2026-08-19 / desvio (o caso conhecido). tsx (nao
//   node puro) porque este script importa classificarBalde/SQL_BALDE
//   direto de src/lib/qualidade-tratamento.ts (TypeScript) -- mesmo padrao
//   de scripts/simular-dia-desvio-v2.mjs importando src/lib/desvio.ts.
import pg from "pg";
import { classificarBalde, SQL_BALDE } from "../src/lib/qualidade-tratamento.ts";

const conn = process.env.DATABASE_URL;
if (!conn) { console.error("DATABASE_URL ausente (rode com --env-file=.env.local)"); process.exit(1); }

const diaAlvo = process.argv[2] ?? "2026-08-19";
const tipoAlvo = process.argv[3] ?? "desvio";

// Baseline conhecido: so' se aplica ao caso default (19/08 desvio), o
// mesmo dado ja conferido manualmente nesta sessao e na sessao anterior
// que originou o painel. Rodar o script pra outro dia/tipo ainda faz a
// checagem de divergencia (item 4 acima), so' pula a comparacao com
// numeros fixos que nao se aplicam a outro recorte.
const BASELINE_CONHECIDO =
  diaAlvo === "2026-08-19" && tipoAlvo === "desvio"
    ? { individual: 14, massa: 29, limpo: 122, corretos: 6, falsos: 8, operadoraUnica: "Elloisy.Salles" }
    : null;

const client = new pg.Client({ connectionString: conn, ssl: { rejectUnauthorized: false } });
await client.connect();

let falhou = false;
function checar(descricao, esperado, real) {
  const ok = esperado === real;
  console.log(`  [${ok ? "OK" : "FALHOU"}] ${descricao}: esperado=${esperado} real=${real}`);
  if (!ok) falhou = true;
}

try {
  console.log(`Validando SQL_BALDE vs classificarBalde -- dia ${diaAlvo}, tipo ${tipoAlvo}.\n`);

  // Linhas cruas -- mesma fonte que apurarQualidade usa, sem filtro de
  // janela relativa (usa dia calendario fixo em vez de "ultimos N dias" de
  // apurarQualidade, pra reproduzir com precisao um dia ja fechado).
  const { rows: linhas } = await client.query(
    `SELECT a.id, a.status, a.origem_acao, a.operador_id, coalesce(o.nome, 'sem operador') AS operador
       FROM alertas a LEFT JOIN operadores o ON o.id = a.operador_id
      WHERE a.modo_teste = false
        AND a.tipo = $1
        AND (a.desde AT TIME ZONE 'America/Sao_Paulo')::date = $2::date`,
    [tipoAlvo, diaAlvo]
  );
  console.log(`${linhas.length} alertas encontrados no recorte.\n`);

  // Passo 2+3: classifica em JS (classificarBalde) e agrega em paralelo
  // via SQL_BALDE sobre o MESMO recorte -- as duas tem que bater linha a
  // linha, nao so' na soma final.
  const contagemJS = {};
  const baldePorId = new Map();
  for (const l of linhas) {
    const balde = classificarBalde({
      origem_acao: l.origem_acao,
      status: l.status,
      operador_id: l.operador_id,
    });
    contagemJS[balde] = (contagemJS[balde] ?? 0) + 1;
    baldePorId.set(l.id, balde);
  }

  const { rows: sqlRows } = await client.query(
    `SELECT a.id, ${SQL_BALDE} AS balde
       FROM alertas a
      WHERE a.modo_teste = false
        AND a.tipo = $1
        AND (a.desde AT TIME ZONE 'America/Sao_Paulo')::date = $2::date`,
    [tipoAlvo, diaAlvo]
  );
  const contagemSQL = {};
  let divergenciasLinhaALinha = 0;
  for (const r of sqlRows) {
    contagemSQL[r.balde] = (contagemSQL[r.balde] ?? 0) + 1;
    const jsBalde = baldePorId.get(r.id);
    if (jsBalde !== r.balde) {
      divergenciasLinhaALinha++;
      console.log(`  [DIVERGE] alerta ${r.id}: SQL_BALDE='${r.balde}' classificarBalde='${jsBalde}'`);
    }
  }

  console.log("Passo 1 -- SQL_BALDE vs classificarBalde, linha a linha:");
  checar("linhas divergentes entre as duas expressoes", 0, divergenciasLinhaALinha);
  console.log();

  console.log("Passo 2 -- contagem por balde, SQL_BALDE (o que roda em producao) vs classificarBalde (JS):");
  const todosBaldes = new Set([...Object.keys(contagemSQL), ...Object.keys(contagemJS)]);
  for (const b of [...todosBaldes].sort()) {
    checar(`balde '${b}'`, contagemSQL[b] ?? 0, contagemJS[b] ?? 0);
  }
  console.log();

  if (BASELINE_CONHECIDO) {
    console.log("Passo 3 -- baseline conhecido (dado real ja conferido manualmente):");
    checar("individual", BASELINE_CONHECIDO.individual, contagemSQL.individual ?? 0);
    checar("massa", BASELINE_CONHECIDO.massa, contagemSQL.massa ?? 0);
    checar("limpo", BASELINE_CONHECIDO.limpo, contagemSQL.limpo ?? 0);
    checar(
      "total tratado (individual+massa+limpo)",
      BASELINE_CONHECIDO.individual + BASELINE_CONHECIDO.massa + BASELINE_CONHECIDO.limpo,
      (contagemSQL.individual ?? 0) + (contagemSQL.massa ?? 0) + (contagemSQL.limpo ?? 0)
    );
    console.log();

    console.log("Passo 4 -- correto vs falso dentro de 'individual' (o criterio de P1a: status='falso_positivo' -> falso, resto -> correto):");
    const individuais = linhas.filter((l) => baldePorId.get(l.id) === "individual");
    const corretos = individuais.filter((l) => l.status !== "falso_positivo");
    const falsos = individuais.filter((l) => l.status === "falso_positivo");
    checar("corretos", BASELINE_CONHECIDO.corretos, corretos.length);
    checar("falsos", BASELINE_CONHECIDO.falsos, falsos.length);
    const operadoras = new Set(falsos.map((l) => l.operador));
    const operadoraOk = operadoras.size === 1 && operadoras.has(BASELINE_CONHECIDO.operadoraUnica);
    console.log(`  [${operadoraOk ? "OK" : "FALHOU"}] todos os falsos sao da operadora '${BASELINE_CONHECIDO.operadoraUnica}': ${[...operadoras].join(", ") || "(nenhum)"}`);
    if (!operadoraOk) falhou = true;
    console.log();
  } else {
    console.log("(sem baseline fixo pra este dia/tipo -- so' a checagem de divergencia acima se aplica.)\n");
  }

  console.log(falhou ? "RESULTADO: DIVERGENCIA ENCONTRADA." : "RESULTADO: SQL_BALDE e classificarBalde concordam, baseline conhecido bate.");
} finally {
  await client.end();
}

if (falhou) process.exitCode = 1;
