// Relatorio diario do detector de desvio -- pedido do usuario (10/09):
// todo dia as 22h (America/Sao_Paulo), quantos corretos/falsos e o que
// mudou no motor naquele dia. Manda por DM pro proprio usuario -- NUNCA
// poste automatico no grupo "DESVIO DE ROTA" (regra explicita, ver
// [[feedback_ia_responde_grupo_desvio]]: sempre confirmar texto antes de
// mandar no grupo, sem excecao). Quem decide encaminhar pro grupo e' o
// usuario.
//
// Numeros (03/11, DSV-02): Central Romaneio, um bloco por cliente com
// romaneio (Nutry Max e Rio Quality) -- ver src/lib/relatorio-diario-desvio.ts.
//
// Mudancas do dia: git log do proprio checkout de producao, so' commits
// que tocaram o motor de desvio (src/lib/desvio.ts, src/app/api/motor/route.ts).
//
// Envio: SSH restrito pro servidor do WhatsApp (desde 03/10/2026 o do Norte,
// 185.193.66.240 -- o contabo-joaquim venceu; chave dedicada
// ~/.ssh/id_ed25519_whatsapp_send, alias "whatsapp-send" no ~/.ssh/config),
// que roda um script fixo (/opt/whatsapp-bridge/send-dm.sh, command= forcado
// no authorized_keys) via Evolution API local -- nunca ve a API key, so manda
// {number, text} por stdin. O send-dm.sh so aceita NUMERO_DESTINO e sai !=0
// quando a Evolution nao devolve 2xx, entao "Enviado" no log e' entrega aceita.
//
// Uso: node --env-file=.env.production scripts/relatorio-diario-desvio.mjs [YYYY-MM-DD]
// Sem argumento, roda pro dia de HOJE (America/Sao_Paulo).
import pg from "pg";
import { execFile, spawn } from "node:child_process";
import { promisify } from "node:util";
import {
  montarTextoRelatorioDiario,
  agruparRelatorioPorCliente,
  SQL_RELATORIO_ALERTAS_ROMANEIO,
  SQL_RELATORIO_DISPAROS_ROMANEIO,
} from "../src/lib/relatorio-diario-desvio.ts";
import { CLIENTES_COM_ROMANEIO_AUSENTE } from "../src/lib/config-clientes.ts";

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

// DSV-02 (auditoria 03/11): conta a Central Romaneio (a tela que o operador
// usa), por cliente com romaneio -- antes era `alertas`/desvio_disparo_log da
// Central Unitrac, so' Nutry. Consultas e agrupamento em
// src/lib/relatorio-diario-desvio.ts (testados).
const { rows: clientesRows } = await client.query(
  `SELECT id, nome FROM clientes WHERE cod_user_unitrac = ANY($1::text[]) ORDER BY nome`,
  [[...CLIENTES_COM_ROMANEIO_AUSENTE]]
);
const { rows: alertasRows } = await client.query(SQL_RELATORIO_ALERTAS_ROMANEIO, [inicioUTC, fimUTC]);
let disparosRows = [];
try {
  ({ rows: disparosRows } = await client.query(SQL_RELATORIO_DISPAROS_ROMANEIO, [inicioUTC, fimUTC]));
} catch (e) {
  // Tabela da migration 092 ainda nao criada: relatorio sai sem disparos.
  console.log(`Aviso: sem alertas_romaneio_disparos (${e.message}) -- relatorio sai sem disparos/episodios.`);
}
const porCliente = agruparRelatorioPorCliente(clientesRows, alertasRows, disparosRows);

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
    "src/app/api/motor-romaneio/route.ts",
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

const texto = montarTextoRelatorioDiario(porCliente, { dia: diaAlvo, commits });

console.log("--- Texto do relatorio ---");
console.log(texto);

try {
  const stdout = await executarComStdin("ssh", ["whatsapp-send"], JSON.stringify({ number: NUMERO_DESTINO, text: texto }));
  console.log("Enviado. Resposta da Evolution API:", stdout.slice(0, 300));
} catch (e) {
  console.error(`ERRO ao enviar DM: ${e.message}`);
  process.exit(1);
}
