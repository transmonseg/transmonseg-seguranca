-- 022_geofences_area_risco_cliente.sql
-- Novo tipo de geofence pra areas de risco especificas de um cliente (ex.:
-- "Caixotaria do Ceasa", cadastrada pelo Benassi no proprio Unitrac) --
-- diferente de 'risco' (corredor rodoviario, MultiLineString, global) e de
-- 'favela' (poligono, global) -- essa e poligono E escopada por cliente_id.
ALTER TABLE geofences DROP CONSTRAINT geofences_tipo_check;
ALTER TABLE geofences ADD CONSTRAINT geofences_tipo_check
  CHECK (tipo = ANY (ARRAY['favela'::text, 'risco'::text, 'ponto_seguro'::text, 'cisp'::text, 'area_risco_cliente'::text]));
