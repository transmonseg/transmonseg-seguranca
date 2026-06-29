// Diagnóstico do motor: pg_cron, último alerta, últimas posições
import pg from "pg";

const c = new pg.Client({
  connectionString: process.env.DATABASE_URL,
  ssl: { rejectUnauthorized: false },
});
await c.connect();

// 1. Último alerta criado
const { rows: [ultiAlerta] } = await c.query(
  `SELECT tipo, nivel, desde, created_at FROM alertas ORDER BY created_at DESC LIMIT 1`
);
console.log("=== ÚLTIMO ALERTA ===");
console.log(ultiAlerta ?? "(nenhum)");

// 2. Últimas atualizações de posição
const { rows: [ultiPos] } = await c.query(
  `SELECT max(updated_at) as ultima FROM posicoes_atuais`
);
console.log("\n=== ÚLTIMA ATUALIZAÇÃO DE POSIÇÃO ===");
console.log(ultiPos?.ultima ?? "(nenhuma)");

// 3. Contagem de posições
const { rows: [cntPos] } = await c.query(`SELECT count(*) n FROM posicoes_atuais`);
console.log(`\n=== POSIÇÕES ATUAIS: ${cntPos.n} veículos ===`);

// 4. Status do pg_cron job
try {
  const { rows: cronRows } = await c.query(
    `SELECT jobname, schedule, active FROM cron.job WHERE jobname='motor-1min'`
  );
  console.log("\n=== JOB pg_cron ===");
  if (cronRows.length === 0) {
    console.log("ALERTA: job 'motor-1min' NÃO EXISTE no pg_cron!");
  } else {
    console.log(cronRows[0]);
  }
} catch (e) {
  console.log("\npg_cron indisponível:", e.message);
}

// 5. Últimas execuções do job
try {
  const { rows: runRows } = await c.query(
    `SELECT status, start_time, end_time
     FROM cron.job_run_details
     WHERE jobname='motor-1min'
     ORDER BY start_time DESC LIMIT 10`
  );
  console.log("\n=== ÚLTIMAS 10 EXECUÇÕES ===");
  if (runRows.length === 0) {
    console.log("(nenhuma execução registrada)");
  } else {
    for (const r of runRows) {
      const dur = r.end_time ? `${((new Date(r.end_time) - new Date(r.start_time)) / 1000).toFixed(1)}s` : "em andamento";
      console.log(`  [${r.status.padEnd(8)}] ${r.start_time?.toISOString?.() ?? r.start_time}  (${dur})`);
    }
  }
} catch (e) {
  console.log("\njob_run_details indisponível:", e.message);
}

// 6. Alertas recentes (últimas 4 horas)
const { rows: recentes } = await c.query(
  `SELECT tipo, nivel, count(*)::int n, max(created_at) ultimo
   FROM alertas
   WHERE created_at > now() - interval '4 hours'
   GROUP BY tipo, nivel ORDER BY ultimo DESC`
);
console.log("\n=== ALERTAS NAS ÚLTIMAS 4 HORAS ===");
if (recentes.length === 0) {
  console.log("NENHUM — motor provavelmente parou!");
} else {
  for (const r of recentes) {
    console.log(`  ${r.nivel.padEnd(8)} ${r.tipo.padEnd(16)} x${r.n}  último: ${r.ultimo}`);
  }
}

await c.end();
