// Relatorio diario do detector de desvio -- pedido do usuario (10/09):
// todo dia as 22h (America/Sao_Paulo), quantos corretos/falsos e o que
// mudou no motor naquele dia. Manda por DM pro proprio usuario -- NUNCA
// poste automatico no grupo "DESVIO DE ROTA" (regra explicita, ver
// [[feedback_ia_responde_grupo_desvio]]: sempre confirmar texto antes de
// mandar no grupo, sem excecao). Quem decide encaminhar pro grupo e' o
// usuario.
//
// Numeros: reusa SQL_BALDE de src/lib/qualidade-tratamento.ts (mesma
// metrica validada da pagina /analise), com filtro extra de cliente_id
// (Nutry Max) que aquele modulo nao tem -- ver [[feedback_monitoramento_foco_nutry_max]].
// So conta como corretos/falsos os do balde 'individual' (revisao caso a
// caso), igual ao painel -- resolucao em massa nao entra na taxa.
//
// Mudancas do dia: git log do proprio checkout de producao, so' commits
// que tocaram o motor de desvio (src/lib/desvio.ts, src/app/api/motor/route.ts).
//
// Envio: SSH restrito pro VPS contabo-joaquim (chave dedicada
// ~/.ssh/id_ed25519_whatsapp_send, alias "whatsapp-send" no ~/.ssh/config),
// que roda um script fixo (/opt/whatsapp-bridge/send-dm.sh) via Evolution
// API local -- nunca ve a API key, so manda {number, text} por stdin.
//
// Uso: node --env-file=.env.production scripts/relatorio-diario-desvio.mjs [YYYY-MM-DD]
// Sem argumento, roda pro dia de HOJE (America/Sao_Paulo).
import pg from "pg";
import { execFile, spawn } from "node:child_process";
import { promisify } from "node:util";
import { SQL_BALDE } from "../src/lib/qualidade-tratamento.ts";
import { montarTextoRelatorioDiario } from "../src/lib/relatorio-diario-desvio.ts";

const execFileAsync = promisify(execFile);

// execFile (async) nao tem opcao `input` (so' a variante Sync tem) -- precisa
// escrever no stdin do processo filho manualmente.
function executarComStdin(comando, args, textoStdin) {
  return new Promise((resolve, reject) => {
    const filho = spawn(comando, args, { stdio: ["pipe", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    filho.stdout.on("data", (d) => { stdout += d; });
    filho.stderr.on("data", (d) => { stderr += d; });
    filho.on("error", reject);
    filho.on("close", (codigo) => {
      if (codigo === 0) resolve(stdout);
      else reject(new Error(`${comando} saiu com codigo ${codigo}: ${stderr}`));
    });
    filho.stdin.write(textoStdin);
    filho.stdin.end();
  });
}

const NUMERO_DESTINO = "5571996591404";
const CLIENTE_ID_NUTRY_MAX = "cfcb52f5-fd01-47c7-988c-d13a10f0d8fd";

const conn = process.env.DATABASE_URL;
if (!conn) { console.error("DATABASE_URL ausente"); process.exit(1); }
const client = new pg.Client({ connectionString: conn, ssl: { rejectUnauthorized: false } });
await client.connect();

const diaAlvo = process.argv[2] ?? new Date().toLocaleString("en-CA", { timeZone: "America/Sao_Paulo" }).slice(0, 10);
console.log(`Relatorio diario de desvio -- dia ${diaAlvo} (SP).`);

const { rows: janelaRows } = await client.query(
  `SELECT (($1::text || ' 00:00:00')::timestamp AT TIME ZONE 'America/Sao_Paulo') AS inicio,
          (($1::text || ' 00:00:00')::timestamp AT TIME ZONE 'America/Sao_Paulo' + interval '1 day') AS fim`,
  [diaAlvo]
);
const inicioUTC = janelaRows[0].inicio;
const fimUTC = janelaRows[0].fim;

const { rows: corretoFalsoRows } = await client.query(
  `SELECT (CASE WHEN status = 'falso_positivo' THEN 'falso' ELSE 'correto' END) AS resultado, count(*)::text AS n
     FROM alertas
    WHERE modo_teste = false
      AND cliente_id = $1
      AND tipo = 'desvio'
      AND desde >= $2 AND desde < $3
      AND ${SQL_BALDE} = 'individual'
    GROUP BY 1`,
  [CLIENTE_ID_NUTRY_MAX, inicioUTC, fimUTC]
);
const mapaCorretoFalso = Object.fromEntries(corretoFalsoRows.map((r) => [r.resultado, Number(r.n)]));

const { rows: brutosRows } = await client.query(
  `SELECT count(*)::text AS n
     FROM desvio_disparo_log d
     JOIN veiculos v ON v.id = d.veiculo_id
    WHERE v.cliente_id = $1
      AND d.tipo_disparo = 'afastando_geral'
      AND d.criado_em >= $2 AND d.criado_em < $3`,
  [CLIENTE_ID_NUTRY_MAX, inicioUTC, fimUTC]
);
const totalDisparosBrutos = Number(brutosRows[0]?.n ?? 0);

await client.end();

let commits = [];
try {
  const { stdout } = await execFileAsync("git", [
    "log",
    // Offset -03:00 explicito (Brasil nao tem horario de verao desde 2019) --
    // NUNCA usar --date=local/sem offset: o fuso do SISTEMA neste VPS e'
    // Europa (CEST/CET), nao America/Sao_Paulo, o que fazia um commit de
    // 09/09 21:29 (SP) aparecer como 10/09 no relatorio (achado real 10/09).
    `--since=${diaAlvo} 00:00:00 -0300`,
    `--until=${diaAlvo} 23:59:59 -0300`,
    "--pretty=format:%h|%s",
    "--",
    "src/lib/desvio.ts",
    "src/app/api/motor/route.ts",
  ], { cwd: new URL("..", import.meta.url).pathname });
  commits = stdout
    .split("\n")
    .filter(Boolean)
    .map((linha) => {
      const [hash, ...resto] = linha.split("|");
      return { hash, mensagem: resto.join("|") };
    });
} catch (e) {
  console.log(`Aviso: falha ao ler git log (${e.message}) -- relatorio segue sem a secao de commits.`);
}

const texto = montarTextoRelatorioDiario({
  dia: diaAlvo,
  corretos: mapaCorretoFalso.correto ?? 0,
  falsos: mapaCorretoFalso.falso ?? 0,
  totalDisparosBrutos,
  commits,
});

console.log("--- Texto do relatorio ---");
console.log(texto);

try {
  const stdout = await executarComStdin("ssh", ["whatsapp-send"], JSON.stringify({ number: NUMERO_DESTINO, text: texto }));
  console.log("Enviado. Resposta da Evolution API:", stdout.slice(0, 300));
} catch (e) {
  console.error(`ERRO ao enviar DM: ${e.message}`);
  process.exit(1);
}
