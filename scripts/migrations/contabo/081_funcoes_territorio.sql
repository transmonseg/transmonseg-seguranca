-- Consultas territoriais expostas como RPC pro cliente Supabase da rota-ponte
-- (src/app/api/romaneio/geocode/route.ts). Ver
-- docs/superpowers/specs/2026-09-12-confiabilidade-kpi-nutrimax-design.md.
CREATE OR REPLACE FUNCTION municipio_da_coordenada(p_lat float8, p_lng float8)
RETURNS TABLE (municipio_codigo text)
LANGUAGE sql STABLE AS $$
  SELECT m.municipio_codigo
  FROM malha_municipios_rj m
  WHERE ST_Contains(m.geom, ST_SetSRID(ST_MakePoint(p_lng, p_lat), 4326))
  LIMIT 1;
$$;

-- ORDER BY <-> com a expressao EXATAMENTE igual a do indice
-- cnefe_enderecos_geog_idx (migration 080), senao o planejador cai em Seq Scan
-- sobre 8,8M linhas.
CREATE OR REPLACE FUNCTION bairro_da_coordenada(p_lat float8, p_lng float8)
RETURNS TABLE (localidade text, distancia_m float8)
LANGUAGE sql STABLE AS $$
  SELECT c.localidade,
         ST_Distance(
           ST_SetSRID(ST_MakePoint(c.lng, c.lat), 4326)::geography,
           ST_SetSRID(ST_MakePoint(p_lng, p_lat), 4326)::geography
         )
  FROM cnefe_enderecos c
  WHERE c.localidade IS NOT NULL
  ORDER BY ST_SetSRID(ST_MakePoint(c.lng, c.lat), 4326)::geography
        <-> ST_SetSRID(ST_MakePoint(p_lng, p_lat), 4326)::geography
  LIMIT 1;
$$;
