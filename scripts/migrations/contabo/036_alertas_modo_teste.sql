-- 036_alertas_modo_teste.sql
ALTER TABLE alertas ADD COLUMN IF NOT EXISTS modo_teste boolean NOT NULL DEFAULT false;
NOTIFY pgrst, 'reload schema';
