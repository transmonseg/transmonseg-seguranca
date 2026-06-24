// Print generico de uma rota logada. Uso: node scripts/dev/print.mjs <rota> <arquivo> [base]
import puppeteer from "puppeteer-core";
const rota = process.argv[2] || "/";
const arquivo = process.argv[3] || "print.png";
const base = process.argv[4] || "http://localhost:3010";
const email = `qa-${Date.now()}@transmonseg.com`;
const browser = await puppeteer.launch({
  executablePath: "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe",
  headless: "new", args: ["--no-sandbox","--disable-gpu"],
});
const page = await browser.newPage();
await page.setViewport({ width: 1600, height: 1000 });
const espera = (ms)=>new Promise(r=>setTimeout(r,ms));
try {
  await page.goto(`${base}/`, { waitUntil:"networkidle2", timeout:60000 });
  await espera(700);
  await page.evaluate(()=>{const b=[...document.querySelectorAll("button")].find(x=>x.textContent.trim()==="Criar acesso"); if(b)b.click();});
  await espera(400);
  await page.type("#nome","Operador QA"); await page.type("#email",email); await page.type("#senha","teste123");
  await page.click('button[type="submit"]');
  await page.waitForFunction(()=>location.pathname==="/",{timeout:25000}).catch(()=>{});
  await espera(1500);
  const alvo = `${base}${rota}`;
  console.log("NAVEGANDO PARA:", JSON.stringify(alvo));
  await page.goto(alvo, { waitUntil:"domcontentloaded", timeout:60000 });
  await espera(6000);
  await page.screenshot({ path: arquivo });
  console.log("OK", arquivo, "EMAIL_QA="+email);
} catch(e){ console.error("ERRO:", e.message); }
finally { await browser.close(); }
