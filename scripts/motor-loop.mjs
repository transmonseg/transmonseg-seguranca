// Loop local de autonomia: dispara o motor a cada 60s (enquanto o dev server roda).
// Em produção, quem faz isso é um cron externo (cron-job.org) chamando a URL pública.
// Uso: node --env-file=.env.local scripts/motor-loop.mjs
const URL = process.env.MOTOR_URL || "http://localhost:3000/api/motor";
const KEY = process.env.MOTOR_SECRET;
if (!KEY) { console.error("MOTOR_SECRET ausente no .env.local"); process.exit(1); }

async function tick() {
  try {
    const r = await fetch(URL, { method: "POST", headers: { "x-motor-key": KEY } });
    const j = await r.json();
    console.log(new Date().toLocaleTimeString("pt-BR"), JSON.stringify(j));
  } catch (e) {
    console.log(new Date().toLocaleTimeString("pt-BR"), "erro:", String(e));
  }
}

await tick();
setInterval(tick, 60000);
console.log("motor-loop ativo: disparando a cada 60s");
