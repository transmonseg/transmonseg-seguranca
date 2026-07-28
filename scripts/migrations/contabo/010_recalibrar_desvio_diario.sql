-- scripts/migrations/contabo/010_recalibrar_desvio_diario.sql
--
-- Achado real 28/07: recalibrar-desvio rodava so semanalmente (seg 3h) --
-- uma mudanca de comportamento no meio da semana (rua estreita saltando de
-- 1.6% pra 77% de falso positivo em um unico dia) so seria refletida na
-- calibracao ate 6 dias depois. Diario reage no dia seguinte.
SELECT cron.alter_job(
  job_id := (SELECT jobid FROM cron.job WHERE jobname = 'recalibrar-desvio-semanal'),
  schedule := '0 3 * * *'
);
