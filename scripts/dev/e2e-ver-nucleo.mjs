// Sobe um operador QA temporario, loga e tira prints das telas novas:
// central (layout 2 colunas + ordem dos sinais) e /monitoramento (mapa estilo Unitrac).
// Coleta erros de console pra pegar bug visual. Imprime EMAIL_QA pra limpeza posterior.
// Roda: node scripts/dev/e2e-ver-nucleo.mjs <dirSaida> <baseUrl>
import puppeteer from "puppeteer-core";

const DIR = process.argv[2] || ".";
const base = process.argv[3] || "http://localhost:3010";
const email = `qa-${Date.now()}@transmonseg.com`;
const senha = "teste123";
const nome = "Operador QA";

const browser = await puppeteer.launch({
  executablePath: "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe",
  headless: "new",
  args: ["--no-sandbox", "--disable-gpu"],
});
const page = await browser.newPage();
await page.setViewport({ width: 1600, height: 1000 });
const espera = (ms) => new Promise((r) => setTimeout(r, ms));
const erros = [];
page.on("console", (m) => { if (m.type() === "error") erros.push(m.text()); });
page.on("pageerror", (e) => erros.push("PAGEERROR: " + e.message));

try {
  // login via signup aberto
  await page.goto(`${base}/`, { waitUntil: "networkidle2", timeout: 60000 });
  await espera(800);
  await page.evaluate(() => {
    const b = [...document.querySelectorAll("button")].find((x) => x.textContent.trim() === "Criar acesso");
    if (b) b.click();
  });
  await espera(400);
  await page.type("#nome", nome);
  await page.type("#email", email);
  await page.type("#senha", senha);
  await page.click('button[type="submit"]');
  await page.waitForFunction(() => window.location.pathname === "/", { timeout: 25000 }).catch(() => {});
  await espera(3500); // leaflet + dados
  console.log("path apos login:", await page.evaluate(() => location.pathname));
  await page.screenshot({ path: `${DIR}/nucleo-central.png` });

  // monitoramento
  await page.goto(`${base}/monitoramento`, { waitUntil: "networkidle2", timeout: 60000 });
  await espera(5000);
  await page.screenshot({ path: `${DIR}/nucleo-monitoramento.png` });

  console.log("ERROS_CONSOLE:", erros.length);
  erros.slice(0, 20).forEach((e) => console.log("  -", e.slice(0, 200)));
  console.log(`EMAIL_QA=${email}`);
} catch (e) {
  console.error("ERRO E2E:", e.message);
  await page.screenshot({ path: `${DIR}/nucleo-erro.png` }).catch(() => {});
} finally {
  await browser.close();
}
