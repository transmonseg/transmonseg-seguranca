-- scripts/migrations/contabo/005_romaneio_geocode_claim.sql
--
-- Pedido do usuario (27/07): acelerar a geocodificacao do romaneio,
-- rodando o job 2x mais rapido (a cada 30s, mesmo padrao ja usado pro
-- motor -- motor-1min + motor-tick-30s). Pre-requisito: sem protecao
-- contra corrida, os 2 disparos (30s de diferenca) poderiam pegar os
-- MESMOS enderecos "pendente" ao mesmo tempo (SELECT sem lock nenhum
-- hoje) e processar tudo 2x -- desperdicio de chamada de API externa,
-- nao quebra dado mas e' ineficiente.
--
-- Fix: coluna nova pra "reivindicar" um lote antes de processar (mesmo
-- espirito do motor_lease, mas por LINHA, nao lock global -- aqui varias
-- linhas sendo processadas em paralelo por invocacoes diferentes e' ate
-- desejavel, so nao pode ser a MESMA linha 2x). Reivindicacoes com mais
-- de 5min (processo que travou/crashou no meio) sao consideradas
-- abandonadas e voltam a ficar disponiveis.
ALTER TABLE romaneio_pontos ADD COLUMN IF NOT EXISTS geocode_reivindicado_em timestamptz;
CREATE INDEX IF NOT EXISTS romaneio_pontos_geocode_status_idx ON romaneio_pontos (geocode_status, geocode_reivindicado_em);
