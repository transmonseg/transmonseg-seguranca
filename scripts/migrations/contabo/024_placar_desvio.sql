-- Placar de desvio (Fase 1, sombra) -- ver docs/superpowers/specs/2026-08-01-placar-desvio-design.md
ALTER TABLE posicoes_atuais
  ADD COLUMN IF NOT EXISTS placar_desvio numeric NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS placar_desvio_estado jsonb;

CREATE TABLE IF NOT EXISTS placar_desvio_log (
  id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  veiculo_id uuid NOT NULL REFERENCES veiculos(id),
  criado_em timestamptz NOT NULL DEFAULT now(),
  placar numeric NOT NULL,
  componentes jsonb NOT NULL,
  teria_amarelo boolean NOT NULL,
  teria_vermelho boolean NOT NULL
);
CREATE INDEX IF NOT EXISTS placar_desvio_log_veiculo_tempo_idx
  ON placar_desvio_log (veiculo_id, criado_em);
CREATE INDEX IF NOT EXISTS placar_desvio_log_criado_em_idx
  ON placar_desvio_log (criado_em);

GRANT SELECT, INSERT ON placar_desvio_log TO app_service;
GRANT USAGE ON SEQUENCE placar_desvio_log_id_seq TO app_service;
