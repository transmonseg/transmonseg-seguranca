// Testa a Fase 2.5 (filtros) na central: confirma que a FiltrosBar existe,
// que clicar um chip muda a URL e filtra lista + mapa, e que "So com problema"
// oculta as secoes que nao sao problema. Prints + diagnostico.
// Uso: node scripts/dev/e2e-filtros.mjs <dir-saida> [base-url]
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

// mede o estado da tela: marcadores no mapa, cards de alerta, secoes visiveis
const medir = () => page.evaluate(() => {
  const txt = (s) => [...document.querySelectorAll("*")].some((e) => e.children.length === 0 && e.textContent.trim() === s);
  return {
    url: location.search,
    marcadores: document.querySelectorAll(".leaflet-marker-icon").length,
    secaoOperacao: /EM OPERA|Em opera/i.test(document.body.innerText),
    secaoConcluidos: /CONCLU|Conclu/i.test(document.body.innerText),
    chips: [...document.querySelectorAll('[role="group"] button')].map((b) => b.textContent.trim()),
  };
});

try {
  await page.goto(`${base}/`, { waitUntil: "networkidle2", timeout: 60000 });
  await espera(700);
  // criar acesso QA
  await page.evaluate(() => { const b=[...document.querySelectorAll("button")].find(x=>x.textContent.trim()==="Criar acesso"); if(b)b.click(); });
  await espera(400);
  await page.type("#nome", "Operador QA");
  await page.type("#email", email);
  await page.type("#senha", "teste123");
  await page.click('button[type="submit"]');
  await page.waitForFunction(() => location.pathname === "/", { timeout: 25000 }).catch(() => {});
  await espera(4500); // carrega mapa + alertas

  const antes = await medir();
  console.log("ANTES:", JSON.stringify(antes));
  await page.screenshot({ path: `${DIR}/filtros-inicial.png` });

  // clicar chip "Desvio"
  await page.evaluate(() => { const b=[...document.querySelectorAll('[role="group"] button')].find(x=>x.textContent.trim()==="Desvio"); if(b)b.click(); });
  await espera(3000);
  const desvio = await medir();
  console.log("APOS_DESVIO:", JSON.stringify(desvio));
  await page.screenshot({ path: `${DIR}/filtros-desvio.png` });

  // limpar e clicar "So com problema"
  await page.evaluate(() => { const b=[...document.querySelectorAll('[role="group"] button')].find(x=>x.textContent.trim()==="Limpar"); if(b)b.click(); });
  await espera(1500);
  await page.evaluate(() => { const b=[...document.querySelectorAll('[role="group"] button')].find(x=>/So com problema/i.test(x.textContent.trim())); if(b)b.click(); });
  await espera(3000);
  const problema = await medir();
  console.log("APOS_SO_PROBLEMA:", JSON.stringify(problema));
  await page.screenshot({ path: `${DIR}/filtros-soproblema.png` });

  console.log("ERROS_CONSOLE:", erros.length);
  erros.slice(0, 15).forEach((e) => console.log("  -", e.slice(0, 200)));
  console.log(`EMAIL_QA=${email}`);
} catch (e) {
  console.error("ERRO E2E:", e.message);
  await page.screenshot({ path: `${DIR}/filtros-erro.png` }).catch(() => {});
} finally {
  await browser.close();
}
