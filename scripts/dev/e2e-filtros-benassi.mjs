// Prova POSITIVA dos filtros no cliente Benassi (4586), que tem alertas ativos:
// 11 veiculos vermelhos, 8 favela, 5 jammer. Confirma que cada filtro acende
// so o subconjunto certo no mapa. Prints + diagnostico.
// Uso: node scripts/dev/e2e-filtros-benassi.mjs <dir-saida> [base-url]
import puppeteer from "puppeteer-core";

const DIR = process.argv[2] || ".";
const base = process.argv[3] || "http://localhost:3010";
const email = `qa-${Date.now()}@transmonseg.com`;

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

const marcadores = () => page.evaluate(() => document.querySelectorAll(".leaflet-marker-icon").length);
const clicarChip = (txt) => page.evaluate((t) => {
  const b = [...document.querySelectorAll('[role="group"] button')].find((x) => x.textContent.trim() === t);
  if (b) b.click(); return !!b;
}, txt);

try {
  await page.goto(`${base}/`, { waitUntil: "networkidle2", timeout: 60000 });
  await espera(700);
  await page.evaluate(() => { const b=[...document.querySelectorAll("button")].find(x=>x.textContent.trim()==="Criar acesso"); if(b)b.click(); });
  await espera(400);
  await page.type("#nome", "Operador QA");
  await page.type("#email", email);
  await page.type("#senha", "teste123");
  await page.click('button[type="submit"]');
  await page.waitForFunction(() => location.pathname === "/", { timeout: 25000 }).catch(() => {});
  await espera(1500);

  // ir pro Benassi
  await page.goto(`${base}/?cliente=4586`, { waitUntil: "networkidle2", timeout: 60000 });
  await espera(5000);
  const total = await marcadores();
  console.log("BENASSI total marcadores:", total);
  await page.screenshot({ path: `${DIR}/benassi-todos.png` });

  // Favela
  await clicarChip("Favela");
  await espera(3000);
  console.log("APOS_FAVELA url:", await page.evaluate(()=>location.search), "marcadores:", await marcadores());
  await page.screenshot({ path: `${DIR}/benassi-favela.png` });
  await clicarChip("Limpar"); await espera(1500);

  // Jammer/Sinal
  await clicarChip("Jammer/Sinal");
  await espera(3000);
  console.log("APOS_JAMMER url:", await page.evaluate(()=>location.search), "marcadores:", await marcadores());
  await page.screenshot({ path: `${DIR}/benassi-jammer.png` });
  await clicarChip("Limpar"); await espera(1500);

  // So com problema
  await page.evaluate(() => { const b=[...document.querySelectorAll('[role="group"] button')].find(x=>/So com problema/i.test(x.textContent.trim())); if(b)b.click(); });
  await espera(3000);
  console.log("APOS_SO_PROBLEMA url:", await page.evaluate(()=>location.search), "marcadores:", await marcadores());
  await page.screenshot({ path: `${DIR}/benassi-soproblema.png` });

  console.log("ERROS_CONSOLE:", erros.length);
  erros.slice(0, 10).forEach((e) => console.log("  -", e.slice(0, 200)));
  console.log(`EMAIL_QA=${email}`);
} catch (e) {
  console.error("ERRO E2E:", e.message);
  await page.screenshot({ path: `${DIR}/benassi-erro.png` }).catch(() => {});
} finally {
  await browser.close();
}
