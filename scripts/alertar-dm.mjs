// Alerta por WhatsApp (DM so' pro dono, mesmo canal do relatorio diario):
//   node scripts/alertar-dm.mjs <chave> "<texto>"
// No maximo 1 alerta por <chave> a cada 6 h (arquivo em /tmp), pra um problema
// persistente nao virar spam. Nunca derruba o cron: falha de envio so' loga.
import { spawn } from "node:child_process";
import { existsSync, statSync, writeFileSync } from "node:fs";

const NUMERO_DESTINO = "5571996591404";
const JANELA_MS = 6 * 60 * 60 * 1000;
const [chave, ...resto] = process.argv.slice(2);
const texto = resto.join(" ").trim();
if (!chave || !texto) { console.error("uso: alertar-dm.mjs <chave> <texto>"); process.exit(0); }

const marca = `/tmp/alerta-dm-${chave.replace(/[^a-z0-9_-]/gi, "_")}.ts`;
if (existsSync(marca) && Date.now() - statSync(marca).mtimeMs < JANELA_MS) {
  console.log(`alerta ${chave}: ja' enviado nas ultimas 6 h, nao repete`);
  process.exit(0);
}
const filho = spawn("ssh", ["whatsapp-send"], { stdio: ["pipe", "pipe", "pipe"] });
let saida = "";
filho.stdout.on("data", (d) => (saida += d));
filho.stderr.on("data", (d) => (saida += d));
filho.on("close", (codigo) => {
  if (codigo === 0) { writeFileSync(marca, String(Date.now())); console.log(`alerta ${chave} enviado`); }
  else console.error(`alerta ${chave}: envio falhou (${codigo}) ${saida.slice(0, 200)}`);
  process.exit(0);
});
filho.stdin.end(JSON.stringify({ number: NUMERO_DESTINO, text: `⚠️ ${texto}` }));
