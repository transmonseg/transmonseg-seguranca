-- 025_corredor_celulas_veiculo.sql
-- Familiaridade historica POR VEICULO (nao por frota) com uma celula
-- ~100m -- ver docs/superpowers/specs/2026-07-21-familiaridade-veiculo-desvio-design.md.
-- Mesmo shape de corredor_celulas (010_desvio_sem_rota.sql), so trocando
-- cliente_id por veiculo_id. Tabela interna do motor, sem RLS (nunca
-- exposta a rota publica/client).
CREATE TABLE corredor_celulas_veiculo (
  veiculo_id uuid NOT NULL REFERENCES veiculos(id) ON DELETE CASCADE,
  celula text NOT NULL,
  ultimo_visto date NOT NULL DEFAULT current_date,
  PRIMARY KEY (veiculo_id, celula)
);
CREATE INDEX idx_corredor_celulas_veiculo_ultimo_visto ON corredor_celulas_veiculo (ultimo_visto);
