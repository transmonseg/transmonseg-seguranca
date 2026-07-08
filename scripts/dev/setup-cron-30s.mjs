// Reagenda o motor pra rodar a cada 30s (em vez de 1min). pg_cron tem
// granularidade minima de 1 minuto, entao o truque padrao e o MESMO job de
// "* * * * *" disparar a chamada DUAS vezes, com um pg_sleep(30) no meio.
// Isso DOBRA o numero de invocacoes/mes (43.200 -> 86.400) -- so faz sentido
// depois de cortar o consumo de CPU ativa por invocacao (ver batch de
// posicoes_atuais no motor, commit que resolveu o estouro de cota da Vercel).
import pg from "pg";
const c = new pg.Client({ connectionString: process.env.DATABASE_URL, ssl: { rejectUnauthorized: false } });
await c.connect();

try {
  // Mesmo jobname ('motor-1min') -- cron.schedule com nome existente
  // substitui o comando/schedule do job, nao cria um segundo job.
  await c.query(`select cron.schedule('motor-1min', '* * * * *', $job$
    select net.http_post(
      url := 'https://transmonseg-seguranca.vercel.app/api/motor',
      headers := jsonb_build_object(
        'x-motor-key', '17b41358e1c898f916867c483389ded6d5bb0bfd6dde3715',
        'Content-Type', 'application/json'
      )
    );
    select pg_sleep(30);
    select net.http_post(
      url := 'https://transmonseg-seguranca.vercel.app/api/motor',
      headers := jsonb_build_object(
        'x-motor-key', '17b41358e1c898f916867c483389ded6d5bb0bfd6dde3715',
        'Content-Type', 'application/json'
      )
    );
  $job$)`);
  console.log("cron reagendado: motor a cada 30 segundos (2x por minuto)");

  const { rows } = await c.query("select jobname, schedule, active, command from cron.job where jobname='motor-1min'");
  console.log("job:", JSON.stringify(rows[0], null, 2));
} catch (e) {
  console.log("ERRO:", e.message);
  process.exitCode = 1;
} finally {
  await c.end();
}
