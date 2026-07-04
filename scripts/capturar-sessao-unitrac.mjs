// Captura a sessao do portal humano da Unitrac (www2.portalunitrac.com/unitrac)
// pra habilitar sirene/bloqueio de verdade no app. O login tem reCAPTCHA v2 —
// so um humano consegue resolver, por isso esse script abre um Chrome de
// verdade e espera voce logar manualmente.
//
// Uso: node --env-file=.env.local scripts/capturar-sessao-unitrac.mjs
//
// Depois de logar (e opcionalmente clicar em algum comando pra manter a
// sessao "quente"), a sessao fica guardada no banco (tabela unitrac_sessao)
// e o app passa a reusar ela em todo comando, sem precisar logar de novo ate
// ela expirar por inatividade (o motor faz keep-alive automatico a cada ciclo).

import puppeteer from "puppeteer-core";
import pg from "pg";

const CHROME_PATHS = [
  "C:/Program Files/Google/Chrome/Application/chrome.exe",
  "/usr/bin/google-chrome",
  "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
];

async function acharChrome() {
  const { existsSync } = await import("fs");
  for (const p of CHROME_PATHS) if (existsSync(p)) return p;
  throw new Error("Chrome nao encontrado — ajuste CHROME_PATHS no script.");
}

async function main() {
  if (!process.env.DATABASE_URL) {
    console.error("DATABASE_URL nao definida. Rode com: node --env-file=.env.local scripts/capturar-sessao-unitrac.mjs");
    process.exit(1);
  }

  const executablePath = await acharChrome();
  const browser = await puppeteer.launch({
    executablePath,
    headless: false,
    args: ["--start-maximized"],
    defaultViewport: null,
  });
  const page = await browser.newPage();
  await page.goto("https://www2.portalunitrac.com/unitrac/", { waitUntil: "domcontentloaded", timeout: 60000 });

  console.log("\n========================================================");
  console.log("Chrome aberto. Faca o login (resolva o captcha).");
  console.log("Esse script fica esperando ate 5 minutos, checando a cada 5s");
  console.log("se o login foi concluido (saiu da tela de login).");
  console.log("========================================================\n");

  let logado = false;
  for (let i = 0; i < 60; i++) {
    await new Promise((r) => setTimeout(r, 5000));
    const cookies = await page.cookies();
    const sess = cookies.find((c) => c.name === "PHPSESSID");
    if (!sess) continue;
    // Confere se a sessao autentica de verdade (nao so tem cookie de visitante)
    const res = await fetch("https://www2.portalunitrac.com/unitrac/unitrac_menu_principal2/unitrac_menu_principal2.php", {
      headers: { cookie: `PHPSESSID=${sess.value}` },
    });
    const corpo = await res.text();
    if (res.status === 200 && !/name=["']password["']/i.test(corpo)) {
      logado = true;
      console.log("Login confirmado! PHPSESSID:", sess.value);
      const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL, ssl: { rejectUnauthorized: false } });
      try {
        await pool.query(
          `insert into unitrac_sessao (id, cookie, criado_em, atualizado_em, ok)
           values (1, $1, now(), now(), true)
           on conflict (id) do update set
             cookie = excluded.cookie, criado_em = now(), atualizado_em = now(), ok = true`,
          [sess.value]
        );
        console.log("Sessao guardada no banco (tabela unitrac_sessao). Pode fechar o Chrome.");
      } finally {
        await pool.end();
      }
      break;
    }
    console.log(`[${i + 1}/60] ainda nao logou, esperando...`);
  }

  if (!logado) {
    console.log("\nTempo esgotado sem login confirmado. Rode o script de novo quando puder.");
  }

  await new Promise((r) => setTimeout(r, 3000));
  await browser.close();
  process.exit(logado ? 0 : 1);
}

main();
