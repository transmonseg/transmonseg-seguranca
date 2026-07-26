-- scripts/migrations/031_casos_desvio_revisao_retencao_14_dias.sql
--
-- Achado real 26/07: casos_desvio_revisao tinha retencao de 2 dias
-- (migration 029), mas a calibracao semanal (recalibrar-desvio-semanal,
-- toda segunda 3h) precisa desse dado pra segmentar corretamente (ver
-- fix no mesmo commit em src/app/api/recalibrar-desvio/route.ts) -- 2 dias
-- e' curto demais pra sobreviver ate' o job semanal rodar. Aumentado pra
-- 14 dias (ainda curto, cobre uma semana cheia + margem, decisao do
-- usuario -- nao e' retencao "pra sempre").
select cron.alter_job(
  (select jobid from cron.job where jobname = 'limpar-casos-desvio-revisao'),
  command := $$delete from casos_desvio_revisao where criado_em < now() - interval '14 days'$$
);
