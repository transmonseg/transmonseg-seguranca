// Agenda o motor para rodar a cada 1 min via pg_cron + pg_net (no proprio Supabase).
import pg from "pg";
const c = new pg.Client({ connectionString: process.env.DATABASE_URL, ssl: { rejectUnauthorized: false } });
await c.connect();

try {
  await c.query("create extension if not exists pg_cron");
  console.log("pg_cron ok");
  await c.query("create extension if not exists pg_net");
  console.log("pg_net ok");

  try {
    await c.query("select cron.unschedule('motor-1min')");
    console.log("job antigo removido");
  } catch {
    console.log("(sem job antigo)");
  }

  await c.query(`select cron.schedule('motor-1min', '* * * * *', $job$
    select net.http_post(
      url := 'https://transmonseg-seguranca.vercel.app/api/motor',
      headers := jsonb_build_object(
        'x-motor-key', '17b41358e1c898f916867c483389ded6d5bb0bfd6dde3715',
        'Content-Type', 'application/json'
      )
    );
  $job$)`);
  console.log("cron agendado: motor a cada 1 minuto");

  const { rows } = await c.query("select jobname, schedule, active from cron.job where jobname='motor-1min'");
  console.log("job:", JSON.stringify(rows[0]));
} catch (e) {
  console.log("ERRO:", e.message);
  process.exitCode = 1;
} finally {
  await c.end();
}
