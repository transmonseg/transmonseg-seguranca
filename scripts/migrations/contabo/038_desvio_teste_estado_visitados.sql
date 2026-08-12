-- 038_desvio_teste_estado_visitados.sql
ALTER TABLE desvio_teste_estado ADD COLUMN IF NOT EXISTS visitados jsonb NOT NULL DEFAULT '{}'::jsonb;
NOTIFY pgrst, 'reload schema';
