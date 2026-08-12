-- 038_desvio_teste_estado_visitados.sql
-- Achado real (revisao caso a caso, 11/08): cliente visitado mas ainda
-- nao confirmado como entregue continuava pesando na media do delta
-- conforme o carro seguia viagem. Guarda quais destinos ja foram
-- "visitados" (dwell perto, ver src/lib/detectores-teste.ts) pra pararem
-- de contar, mesmo sem confirmacao oficial.
ALTER TABLE desvio_teste_estado ADD COLUMN visitados jsonb NOT NULL DEFAULT '{}'::jsonb;
