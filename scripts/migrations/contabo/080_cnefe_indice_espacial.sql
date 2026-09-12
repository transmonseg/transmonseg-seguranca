-- Achado real 12/09: a checagem de bairro (ver src/lib/territorio.ts) precisa
-- do vizinho CNEFE mais proximo de uma coordenada. cnefe_enderecos tem 8,8M
-- linhas e ate hoje so' a PRIMARY KEY -- uma consulta de vizinho mais proximo
-- com bounding box leva 1,36s. Com 15 enderecos por lote isso sozinho passaria
-- de 20s, dentro de uma rota que ja tem prazo apertado (PRAZO_MAXIMO_MS=280s
-- em api/romaneio/geocode/route.ts, disputado com o throttle do Nominatim).
--
-- Indice em expressao (geography sobre lng/lat) em vez de coluna nova: nao
-- reescreve as 8,8M linhas e nao muda o schema que o resto do codigo le.
-- CONCURRENTLY porque a tabela e' de producao e um CREATE INDEX comum a
-- travaria para escrita durante a construcao.
CREATE INDEX CONCURRENTLY IF NOT EXISTS cnefe_enderecos_geog_idx
  ON cnefe_enderecos
  USING GIST ((ST_SetSRID(ST_MakePoint(lng, lat), 4326)::geography));
