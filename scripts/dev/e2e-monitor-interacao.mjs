// Testa a interacao do /monitoramento: seleciona uma placa e confirma que
// rastro/paradas/telemetria sao buscados e desenhados. Print + diagnostico.
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
const apis = [];
page.on("console", (m) => { if (m.type() === "error") erros.push(m.text()); });
page.on("pageerror", (e) => erros.push("PAGEERROR: " + e.message));
page.on("response", async (r) => {
  const u = r.url();
  if (u.includes("/api/rastro") || u.includes("/api/stops") || u.includes("/api/veiculo")) {
    let info = `${r.status()}`;
    try { const j = await r.json(); info += ` pontos=${j.pontos?.length ?? "-"} paradas=${j.paradas?.length ?? "-"} pos=${j.posicao ? "ok" : "-"}`; } catch {}
    apis.push(`${u.split("/api/")[1].split("?")[0]} -> ${info}`);
  }
});

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

  await page.goto(`${base}/monitoramento`, { waitUntil: "networkidle2", timeout: 60000 });
  await espera(3500);

  // abrir dropdown e selecionar a primeira placa
  await page.click('input[placeholder="Buscar placa..."]');
  await page.type('input[placeholder="Buscar placa..."]', "T");
  await espera(900);
  const qtdPlacas = await page.evaluate(() => {
    const btns = [...document.querySelectorAll("button")].filter((b) => /^[A-Z]{3}-?\w/.test(b.textContent.trim()));
    if (btns[0]) btns[0].dispatchEvent(new MouseEvent("mousedown", { bubbles: true }));
    return { total: btns.length, primeira: btns[0]?.textContent.trim() };
  });
  console.log("PLACAS_DROPDOWN:", JSON.stringify(qtdPlacas));
  await espera(6000); // fetch rastro/stops/veiculo + desenho leaflet

  const desenho = await page.evaluate(() => ({
    paths: document.querySelectorAll(".leaflet-overlay-pane path").length,
    markers: document.querySelectorAll(".leaflet-marker-icon").length,
    canvas: document.querySelectorAll(".leaflet-overlay-pane canvas").length,
  }));
  console.log("DESENHO_LEAFLET:", JSON.stringify(desenho));
  await page.screenshot({ path: `${DIR}/monitor-rastro.png` });

  console.log("APIS:", apis.length ? apis.join(" | ") : "NENHUMA");
  console.log("ERROS_CONSOLE:", erros.length);
  erros.slice(0, 15).forEach((e) => console.log("  -", e.slice(0, 200)));
  console.log(`EMAIL_QA=${email}`);
} catch (e) {
  console.error("ERRO E2E:", e.message);
  await page.screenshot({ path: `${DIR}/monitor-erro.png` }).catch(() => {});
} finally {
  await browser.close();
}
