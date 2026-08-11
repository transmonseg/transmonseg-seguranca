-- 037_desvio_teste_estado.sql
CREATE TABLE IF NOT EXISTS desvio_teste_estado (
  veiculo_id uuid PRIMARY KEY,
  score numeric NOT NULL DEFAULT 0,
  distancias_anteriores jsonb NOT NULL DEFAULT '{}'::jsonb,
  atualizado_em timestamptz NOT NULL DEFAULT now()
);
NOTIFY pgrst, 'reload schema';
