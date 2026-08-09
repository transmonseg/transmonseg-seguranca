-- Log de snapshot de pendentes por ciclo -- ver
-- docs/superpowers/specs/2026-08-09-snapshot-pendentes-log-design.md.
-- Puramente auditoria/investigacao (mesmo padrao de placar_desvio_log) --
-- NUNCA lido por nenhum detector.
CREATE TABLE IF NOT EXISTS pendentes_snapshot_log (
  id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  veiculo_id uuid NOT NULL REFERENCES veiculos(id),
  criado_em timestamptz NOT NULL DEFAULT now(),
  tem_pendentes boolean NOT NULL,
  alvos_api_ok boolean NOT NULL,
  pendentes jsonb NOT NULL
);
CREATE INDEX IF NOT EXISTS pendentes_snapshot_log_veiculo_tempo_idx
  ON pendentes_snapshot_log (veiculo_id, criado_em);
CREATE INDEX IF NOT EXISTS pendentes_snapshot_log_criado_em_idx
  ON pendentes_snapshot_log (criado_em);

GRANT SELECT, INSERT ON pendentes_snapshot_log TO app_service;
GRANT USAGE ON SEQUENCE pendentes_snapshot_log_id_seq TO app_service;
