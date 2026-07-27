-- scripts/migrations/contabo/006_romaneio_geocode_tick_30s.sql
--
-- Pedido do usuario (27/07): acelerar a geocodificacao do romaneio.
-- Pre-requisitos ja aplicados: migration 005 (coluna de reivindicacao,
-- protecao contra corrida) + fix no codigo (UPDATE atomico, testado ao
-- vivo com 2 chamadas concorrentes reais -- uma reivindicou tudo, a
-- outra ficou com 0, sem processar nada 2x) + lote aumentado de 40 pra
-- 60 por invocacao.
--
-- Mesmo padrao ja usado pro motor (motor-1min + motor-tick-30s): 2 jobs
-- disparando no mesmo minuto, um na hora exata e outro 30s depois,
-- dobrando a frequencia real sem precisar de sintaxe de cron abaixo do
-- minuto (que o pg_cron nao suporta nativamente).
--
-- IMPORTANTE: o valor de x-motor-key abaixo e' o MOTOR_SECRET real,
-- rotacionado nesta mesma sessao -- ja aparece em texto pleno nos outros
-- 4 jobs existentes (motor-1min, motor-tick-30s, recalibrar-desvio-semanal,
-- romaneio-geocode), mesma exposicao inerente ao padrao ja usado, nao e'
-- um valor novo sendo exposto.
select cron.schedule(
  'romaneio-geocode-tick-30s',
  '* * * * *',
  $$
  select pg_sleep(30);
  select net.http_post(
    url := 'http://localhost:3000/api/romaneio/processar-geocode',
    headers := jsonb_build_object('x-motor-key', 'f8acef6d89d1ad73c5b500e269000b7f9b4bca1422fbca2f8765a7b976369322', 'Content-Type', 'application/json')
  );
  $$
);
