// E2E do fluxo do operador: cadastra/loga, reconhece um alerta e marca outro
// como falso positivo, conferindo o efeito na tela. Cria operador QA temporario.
import puppeteer from "puppeteer-core";

const DIR = process.argv[2];
const base = process.argv[3] || "http://localhost:3000";
const email = `qa-${Date.now()}@transmonseg.com`;
const senha = "teste123";

const browser = await puppeteer.launch({
  executablePath: "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe",
  headless: "new",
  args: ["--no-sandbox", "--disable-gpu"],
});
const page = await browser.newPage();
await page.setViewport({ width: 1320, height: 1100 });
const espera = (ms) => new Promise((r) => setTimeout(r, ms));
const clicaTexto = (txt) =>
  page.evaluate((t) => {
    const b = [...document.querySelectorAll("button")].find((x) => x.textContent.trim() === t);
    if (b) { b.scrollIntoView({ block: "center" }); b.click(); return true; }
    return false;
  }, txt);
const contaBotoes = (txt) =>
  page.evaluate((t) => [...document.querySelectorAll("button")].filter((x) => x.textContent.trim() === t).length, txt);

try {
  // login (signup aberto)
  await page.goto(`${base}/login`, { waitUntil: "networkidle2", timeout: 60000 });
  await espera(500);
  await clicaTexto("Criar acesso");
  await espera(400);
  await page.type("#nome", "Operador QA");
  await page.type("#email", email);
  await page.type("#senha", senha);
  await page.click('button[type="submit"]');
  await page.waitForFunction(() => window.location.pathname === "/", { timeout: 20000 }).catch(() => {});
  await espera(2500);

  const reconhecerAntes = await contaBotoes("Reconhecer");
  const resolverAntes = await contaBotoes("Resolver");
  console.log(`central carregada: ${reconhecerAntes} botoes Reconhecer, ${resolverAntes} Resolver`);
  await page.screenshot({ path: `${DIR}/acoes-1-central.png` });

  if (reconhecerAntes === 0) {
    console.log("(sem alertas com acoes nesta janela; nada a exercer)");
  } else {
    // 1. Reconhecer o primeiro alerta
    await clicaTexto("Reconhecer");
    await page.waitForFunction(
      () => document.body.innerText.includes("Em atendimento por um operador"),
      { timeout: 15000 }
    ).catch(() => {});
    await espera(1500);
    const temAtendimento = await page.evaluate(() => document.body.innerText.includes("Em atendimento por um operador"));
    console.log(`1) apos Reconhecer -> badge 'Em atendimento' visivel: ${temAtendimento}`);
    await page.screenshot({ path: `${DIR}/acoes-2-reconhecido.png` });

    // 2. Marcar um alerta como falso positivo (deve sumir da tela)
    const resolverDepois = await contaBotoes("Resolver");
    const fpAntes = await contaBotoes("Falso positivo");
    await clicaTexto("Falso positivo");
    await espera(2500);
    const fpDepois = await contaBotoes("Falso positivo");
    console.log(`2) Falso positivo: cards com acao caiu de ${fpAntes} para ${fpDepois} (esperado -1)`);
    console.log(`   (Resolver antes do FP: ${resolverDepois})`);
    await page.screenshot({ path: `${DIR}/acoes-3-pos-falsopositivo.png` });
  }

  console.log(`\nEMAIL_QA=${email}`);
} catch (e) {
  console.error("ERRO E2E:", e.message);
} finally {
  await browser.close();
}
