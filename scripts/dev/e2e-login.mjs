// Teste E2E do fluxo de auth: redirect, cadastro (signup aberto), central
// logada e logout. Tira prints em cada etapa. Cria um operador QA temporario.
import puppeteer from "puppeteer-core";

const DIR = process.argv[2]; // pasta de saida dos prints
const base = process.argv[3] || "http://localhost:3000"; // alvo (local ou producao)
const email = `qa-${Date.now()}@transmonseg.com`;
const senha = "teste123";
const nome = "Operador QA";

const browser = await puppeteer.launch({
  executablePath: "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe",
  headless: "new",
  args: ["--no-sandbox", "--disable-gpu"],
});
const page = await browser.newPage();
await page.setViewport({ width: 1320, height: 900 });
const espera = (ms) => new Promise((r) => setTimeout(r, ms));
const path = () => page.evaluate(() => window.location.pathname);
const clicaTexto = (txt) =>
  page.evaluate((t) => {
    const b = [...document.querySelectorAll("button")].find((x) => x.textContent.trim() === t);
    if (b) b.click();
    return !!b;
  }, txt);

try {
  // 1. Acesso sem login → deve redirecionar pra /login
  await page.goto(`${base}/`, { waitUntil: "networkidle2", timeout: 60000 });
  await espera(800);
  console.log(`1) raiz sem login -> path=${await path()} (esperado /login)`);
  await page.screenshot({ path: `${DIR}/auth-1-login.png` });

  // 2. Alternar pra cadastro e preencher
  const achouToggle = await clicaTexto("Criar acesso");
  console.log(`2) toggle 'Criar acesso' clicado: ${achouToggle}`);
  await espera(400);
  await page.type("#nome", nome);
  await page.type("#email", email);
  await page.type("#senha", senha);
  await page.screenshot({ path: `${DIR}/auth-2-cadastro.png` });

  // 3. Submeter cadastro → deve logar e cair na central (/)
  await page.click('button[type="submit"]');
  await page.waitForFunction(() => window.location.pathname === "/", { timeout: 20000 }).catch(() => {});
  await espera(2500);
  console.log(`3) apos cadastro -> path=${await path()} (esperado /)`);
  await page.screenshot({ path: `${DIR}/auth-3-central.png` });

  // 4. Logout → volta pro /login
  const achouSair = await clicaTexto("Sair");
  console.log(`4) botao 'Sair' clicado: ${achouSair}`);
  await page.waitForFunction(() => window.location.pathname === "/login", { timeout: 20000 }).catch(() => {});
  await espera(800);
  console.log(`   apos logout -> path=${await path()} (esperado /login)`);

  // 5. Login com o mesmo usuario (testa o caminho de entrar)
  await page.type("#email", email);
  await page.type("#senha", senha);
  await page.click('button[type="submit"]');
  await page.waitForFunction(() => window.location.pathname === "/", { timeout: 20000 }).catch(() => {});
  await espera(1500);
  console.log(`5) login novamente -> path=${await path()} (esperado /)`);

  console.log(`\nEMAIL_QA=${email}`);
} catch (e) {
  console.error("ERRO E2E:", e.message);
} finally {
  await browser.close();
}
