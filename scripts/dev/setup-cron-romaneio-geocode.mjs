// scripts/dev/setup-cron-romaneio-geocode.mjs
// Cria/atualiza o job de pg_cron que processa a fila de geocodificacao
// pendente do romaneio (ver docs/superpowers/specs/2026-07-22-romaneio-geocode-assincrono-design.md).
// 1x/minuto, UM net.http_post so (sem o truque de pg_sleep que o motor
// usa pra 30s -- essa feature nao precisa de tanta frequencia). Rerodar
// so se precisar trocar o dominio/schedule.
import pg from "pg";
const c = new pg.Client({ connectionString: process.env.DATABASE_URL, ssl: { rejectUnauthorized: false } });
await c.connect();

try {
  await c.query(`select cron.schedule('romaneio-geocode', '* * * * *', $job$
    select net.http_post(
      url := 'https://transmonseg-seguranca-stopgap.vercel.app/api/romaneio/processar-geocode',
      headers := jsonb_build_object(
        'x-motor-key', '17b41358e1c898f916867c483389ded6d5bb0bfd6dde3715',
        'Content-Type', 'application/json'
      )
    );
  $job$)`);
  console.log("cron criado/atualizado: romaneio-geocode, 1x/minuto");

  const { rows } = await c.query("select jobname, schedule, active, command from cron.job where jobname='romaneio-geocode'");
  console.log("job:", JSON.stringify(rows[0], null, 2));
} catch (e) {
  console.log("ERRO:", e.message);
  process.exitCode = 1;
} finally {
  await c.end();
}
