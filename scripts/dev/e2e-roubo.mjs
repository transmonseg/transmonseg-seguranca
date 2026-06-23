// Loga, confere /api/roubo-carga e ativa a camada de roubo de carga no mapa.
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
    if (b) b.click(); return !!b;
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

  // print do topo da lista (toggle + botao de apito)
  await espera(800);
  await page.screenshot({ path: `${DIR}/lista-topo.png` });
  console.log("print topo salvo");

  // print do painel de roubo de carga na vista lista
  await page.evaluate(() => {
    const el = [...document.querySelectorAll("h2")].find((h) => /roubo de carga/i.test(h.textContent));
    if (el) el.scrollIntoView({ block: "center" });
  });
  await espera(1200);
  await page.screenshot({ path: `${DIR}/painel-roubo.png` });
  console.log("print painel salvo");

  // confere a API
  const resumo = await page.evaluate(async () => {
    const r = await fetch("/api/roubo-carga"); const j = await r.json();
    return { total: j?.total, periodo: j?.periodo, top: (j?.ranking ?? []).slice(0, 5).map((m) => `${m.nome}:${m.total}`), feats: j?.geojson?.features?.length };
  });
  console.log("API roubo-carga:", JSON.stringify(resumo));

  // mapa foco Rio
  await page.goto(`${base}/?vista=mapa&cliente=4096&foco=rio`, { waitUntil: "networkidle2", timeout: 60000 });
  await espera(8000);

  // expandir o controle de camadas e marcar "Roubo de carga"
  await page.evaluate(() => {
    const tgl = document.querySelector(".leaflet-control-layers");
    if (tgl) tgl.classList.add("leaflet-control-layers-expanded");
  });
  await espera(800);
  const marcou = await page.evaluate(() => {
    const labels = [...document.querySelectorAll(".leaflet-control-layers-overlays label")];
    const alvo = labels.find((l) => /roubo de carga/i.test(l.textContent));
    const cb = alvo?.querySelector('input[type="checkbox"]');
    if (cb && !cb.checked) { cb.click(); return true; }
    return false;
  });
  console.log("camada roubo de carga marcada:", marcou);
  await espera(3500);
  await page.screenshot({ path: `${DIR}/mapa-roubo-carga.png` });
  console.log("print salvo");

  // desmarca favelas e tiroteios pra ver o coroplético de roubo ISOLADO
  await page.evaluate(() => {
    const labels = [...document.querySelectorAll(".leaflet-control-layers-overlays label")];
    for (const l of labels) {
      if (/favela|tiroteio/i.test(l.textContent)) {
        const cb = l.querySelector('input[type="checkbox"]');
        if (cb && cb.checked) cb.click();
      }
    }
  });
  await espera(2500);
  await page.screenshot({ path: `${DIR}/mapa-roubo-isolado.png` });
  console.log("print isolado salvo");
  console.log(`EMAIL_QA=${email}`);
} catch (e) {
  console.error("ERRO:", e.message);
} finally {
  await browser.close();
}
