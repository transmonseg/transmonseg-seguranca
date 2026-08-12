-- 042_celula_frequencia_cliente.sql
-- Frequencia historica de visitas por celula (~100m, mesma grade de
-- src/lib/celulas.ts), por CLIENTE (frota inteira, nao por veiculo -- pra
-- rota nova atribuida hoje a 1 caminhao nao disparar falso positivo so
-- porque ESSE veiculo nunca foi ali). Ver Sinal B na spec.
CREATE TABLE celula_frequencia_cliente (
  cliente_id uuid NOT NULL REFERENCES clientes(id) ON DELETE CASCADE,
  celula text NOT NULL,
  n_visitas int NOT NULL DEFAULT 0,
  primeira_vez date NOT NULL DEFAULT current_date,
  ultima_vez date NOT NULL DEFAULT current_date,
  PRIMARY KEY (cliente_id, celula)
);
CREATE INDEX idx_celula_frequencia_cliente_ultima_vez ON celula_frequencia_cliente (ultima_vez);
