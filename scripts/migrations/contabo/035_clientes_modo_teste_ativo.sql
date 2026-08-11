-- 035_clientes_modo_teste_ativo.sql
ALTER TABLE clientes ADD COLUMN IF NOT EXISTS modo_teste_ativo boolean NOT NULL DEFAULT false;
NOTIFY pgrst, 'reload schema';
