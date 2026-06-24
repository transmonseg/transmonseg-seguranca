-- Cache de POIs (postos, restaurantes, farmácias etc.) do Overpass API.
-- Evita consultar o Overpass a cada ciclo do motor para o mesmo ponto.
-- Validade: 7 dias. Chave: lat+lng arredondados a 3 casas decimais (~111m de resolucao).

CREATE TABLE IF NOT EXISTS poi_cache (
  lat   NUMERIC(9,4)  NOT NULL,
  lng   NUMERIC(9,4)  NOT NULL,
  tem_poi   BOOLEAN   NOT NULL,
  atualizado_em TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (lat, lng)
);

CREATE INDEX IF NOT EXISTS idx_poi_cache_atualizado
  ON poi_cache (atualizado_em);
