import puppeteer from "puppeteer-core";
const url = process.argv[2] || "http://localhost:3000/";
const out = process.argv[3] || "m.png";
const wait = Number(process.argv[4]) || 9000;
const browser = await puppeteer.launch({
  executablePath: "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe",
  headless: "new",
  args: ["--no-sandbox", "--disable-gpu"],
});
const page = await browser.newPage();
await page.setViewport({ width: 1320, height: 1150 });
await page.goto(url, { waitUntil: "networkidle2", timeout: 60000 });
await new Promise((r) => setTimeout(r, wait)); // espera o leaflet desenhar tiles + camadas
await page.screenshot({ path: out });
await browser.close();
console.log("screenshot:", out);
