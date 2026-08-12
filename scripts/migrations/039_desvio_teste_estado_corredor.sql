-- 039_desvio_teste_estado_corredor.sql
-- Motor do modo teste trocou de arquitetura (docs/analise-desvio-raiz-2026-08-11.md):
-- de "score com decaimento sobre distancia media" pra "dentro/fora do
-- corredor de rota real" (src/lib/corredor-verificacao.ts::verificarCorredor),
-- reaproveitando a mesma checagem ja validada em producao. O estado
-- persistido muda de acordo: nao guarda mais score nem distancias por
-- destino, so o ultimo ponto confirmado dentro de algum corredor e o
-- streak de leituras seguidas fora.
ALTER TABLE desvio_teste_estado DROP COLUMN score;
ALTER TABLE desvio_teste_estado DROP COLUMN distancias_anteriores;
ALTER TABLE desvio_teste_estado DROP COLUMN visitados;
ALTER TABLE desvio_teste_estado ADD COLUMN ultima_posicao_dentro_lat double precision;
ALTER TABLE desvio_teste_estado ADD COLUMN ultima_posicao_dentro_lng double precision;
ALTER TABLE desvio_teste_estado ADD COLUMN fora_streak integer NOT NULL DEFAULT 0;
