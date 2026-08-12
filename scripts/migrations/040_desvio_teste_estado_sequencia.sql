-- 040_desvio_teste_estado_sequencia.sql
-- Segundo ajuste do dia no motor do modo teste (docs/analise-desvio-raiz-2026-08-11.md,
-- secao "auditoria de tecnologias"): o corredor como regra primaria testava
-- todos os destinos de uma vez a partir de um ponto de origem congelado,
-- disparando em rotas de entrega legitimas de multiplas paradas. Agora usa
-- OSRM /trip pra ordenar os pendentes e testa perna-a-perna, reancorando a
-- origem quando o veiculo chega de verdade numa parada da sequencia (nao
-- mais "ultima posicao dentro de qualquer corredor generico").
ALTER TABLE desvio_teste_estado RENAME COLUMN ultima_posicao_dentro_lat TO ultima_parada_real_lat;
ALTER TABLE desvio_teste_estado RENAME COLUMN ultima_posicao_dentro_lng TO ultima_parada_real_lng;
ALTER TABLE desvio_teste_estado ADD COLUMN sequencia_ids jsonb;
ALTER TABLE desvio_teste_estado ADD COLUMN sequencia_atualizada_em timestamptz;
