// Loga (signup QA) e captura o mapa com a camada de tiroteios. Limpa o QA no fim.
import puppeteer from "puppeteer-core";

const DIR = process.argv[2];
const base = process.argv[3] || "http://localhost:3000";
const email = `qa-${Date.now()}@transmonseg.com`;

const browser = await puppeteer.launch({
  executablePath: "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe",
  headless: "new",
  args: ["--no-sandbox", "--disable-gpu"],
});
const page = await browser.newPage();
await page.setViewport({ width: 1320, height: 1050 });
const espera = (ms) => new Promise((r) => setTimeout(r, ms));
const clicaTexto = (txt) =>
  page.evaluate((t) => {
    const b = [...document.querySelectorAll("button")].find((x) => x.textContent.trim() === t);
    if (b) b.click();
    return !!b;
  }, txt);

try {
  await page.goto(`${base}/login`, { waitUntil: "networkidle2", timeout: 60000 });
  await espera(500);
  await clicaTexto("Criar acesso");
  await espera(400);
  await page.type("#nome", "Operador QA");
  await page.type("#email", email);
  await page.type("#senha", "teste123");
  await page.click('button[type="submit"]');
  await page.waitForFunction(() => window.location.pathname === "/", { timeout: 20000 }).catch(() => {});
  await espera(1500);

  // contar tiroteios via a API (autenticado, mesmos cookies)
  const cont = await page.evaluate(async () => {
    try { const r = await fetch("/api/tiroteios"); const j = await r.json(); return Array.isArray(j?.tiroteios) ? j.tiroteios.length : -1; } catch { return -2; }
  });
  console.log(`/api/tiroteios retornou ${cont} tiroteios`);

  // mapa Nutry
  await page.goto(`${base}/?vista=mapa&cliente=4096`, { waitUntil: "networkidle2", timeout: 60000 });
  await espera(9000); // leaflet + camadas + tiroteios
  await page.screenshot({ path: `${DIR}/mapa-tiroteios-nutry.png` });
  console.log("print estado salvo");

  // foco na regiao metropolitana do Rio (onde se concentram os tiroteios)
  await page.goto(`${base}/?vista=mapa&cliente=4096&foco=rio`, { waitUntil: "networkidle2", timeout: 60000 });
  await espera(9000);
  await page.screenshot({ path: `${DIR}/mapa-tiroteios-rio.png` });
  console.log("print foco Rio salvo");

  // zoom in (botao +) 3x para ver tiroteios destacados de perto
  for (let k = 0; k < 3; k++) {
    await page.click(".leaflet-control-zoom-in").catch(() => {});
    await espera(900);
  }
  await espera(3000);
  await page.screenshot({ path: `${DIR}/mapa-tiroteios-zoom.png` });
  console.log("print zoom salvo");

  console.log(`EMAIL_QA=${email}`);
} catch (e) {
  console.error("ERRO:", e.message);
} finally {
  await browser.close();
}
