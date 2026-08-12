-- 041_desvio_estado.sql
CREATE TABLE IF NOT EXISTS desvio_estado (
  veiculo_id uuid PRIMARY KEY REFERENCES veiculos(id) ON DELETE CASCADE,
  afastando_streak int NOT NULL DEFAULT 0,
  rua_rara_streak int NOT NULL DEFAULT 0,
  atualizado_em timestamptz NOT NULL DEFAULT now()
);
GRANT SELECT, INSERT, UPDATE ON desvio_estado TO app_service;
NOTIFY pgrst, 'reload schema';
