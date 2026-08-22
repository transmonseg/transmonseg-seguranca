-- scripts/migrations/contabo/057_motor_romaneio_cron.sql
--
-- Agenda o motor paralelo do romaneio (POST /api/motor-romaneio, migration
-- 055 + 056) na MESMA cadencia do motor principal: 2 jobs por minuto, um na
-- hora exata e outro 30s depois. Mesma cadencia importa porque o produto
-- desta entrega e' comparar os dois pipelines no mesmo dia pros mesmos
-- carros -- cadencia diferente sujaria a comparacao.
--
-- Escopo real por ciclo e' pequeno: so' veiculos com romaneio_pontos de hoje
-- (~82 em 21/08), contra a frota inteira do motor principal.
--
-- Isolamento: falha aqui nao afeta o motor principal. Os dois jobs escrevem
-- so' em alertas_romaneio e romaneio_desvio_estado.
--
-- IMPORTANTE: o x-motor-key abaixo e' o MOTOR_SECRET real, o mesmo que ja'
-- aparece em texto pleno nos 5 jobs existentes (motor-1min, motor-tick-30s,
-- recalibrar-desvio-semanal, romaneio-geocode, romaneio-geocode-tick-30s).
-- Nao e' um valor novo sendo exposto.

select cron.schedule(
  'motor-romaneio-1min',
  '* * * * *',
  $$
  select net.http_post(
    url := 'http://localhost:3000/api/motor-romaneio',
    headers := jsonb_build_object('x-motor-key', 'f8acef6d89d1ad73c5b500e269000b7f9b4bca1422fbca2f8765a7b976369322', 'Content-Type', 'application/json')
  );
  $$
);

select cron.schedule(
  'motor-romaneio-tick-30s',
  '* * * * *',
  $$
  select pg_sleep(30);
  select net.http_post(
    url := 'http://localhost:3000/api/motor-romaneio',
    headers := jsonb_build_object('x-motor-key', 'f8acef6d89d1ad73c5b500e269000b7f9b4bca1422fbca2f8765a7b976369322', 'Content-Type', 'application/json')
  );
  $$
);
