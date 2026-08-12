-- 042_celula_frequencia_cliente.sql
CREATE TABLE IF NOT EXISTS celula_frequencia_cliente (
  cliente_id uuid NOT NULL REFERENCES clientes(id) ON DELETE CASCADE,
  celula text NOT NULL,
  n_visitas int NOT NULL DEFAULT 0,
  primeira_vez date NOT NULL DEFAULT current_date,
  ultima_vez date NOT NULL DEFAULT current_date,
  PRIMARY KEY (cliente_id, celula)
);
CREATE INDEX IF NOT EXISTS idx_celula_frequencia_cliente_ultima_vez ON celula_frequencia_cliente (ultima_vez);
GRANT SELECT, INSERT, UPDATE ON celula_frequencia_cliente TO app_service;
NOTIFY pgrst, 'reload schema';
