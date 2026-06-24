-- Cache de rotas OSRM por veiculo.
-- Armazena o corredor (serie de pontos lat/lng) calculado base→alvos.
-- Invalidado quando o conjunto de alvos pendentes muda (hash).
-- Validade: 4 horas ou mudanca de hash.

CREATE TABLE IF NOT EXISTS rotas_cache (
  veiculo_id  UUID    PRIMARY KEY REFERENCES veiculos(id) ON DELETE CASCADE,
  alvos_hash  TEXT    NOT NULL,
  pontos_rota JSONB   NOT NULL,  -- [[lat, lng], ...]
  criado_em   TIMESTAMPTZ NOT NULL DEFAULT now()
);
