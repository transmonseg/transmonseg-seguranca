-- 095_distancia_ao_municipio.sql
--
-- GEO3-07 (auditoria 03/11, geocode.md). PENDENTE DONO: nao aplicada.
--
-- A guarda territorial (src/lib/territorio.ts) aprovava ponto fora de QUALQUER
-- poligono da malha (MG, PE, 0,0): municipio_da_coordenada devolvia vazio e
-- isso era tratado como "sem dado". Agora, com o municipio esperado conhecido,
-- o ponto fora da malha a mais de 2 km do poligono esperado reprova (folga de
-- praia/ilha). Esta funcao mede essa distancia.
--
-- O codigo funciona ANTES e DEPOIS: sem a funcao, a RPC erra, o adaptador
-- (src/app/api/romaneio/geocode/territorio-deps.ts) devolve null e a guarda usa
-- o retangulo do estado do RJ (pega outro estado e 0,0; nao pega vizinho de
-- MG/ES dentro do retangulo).
--
-- Tabela pequena (92 linhas, PK municipio_codigo): consulta por igualdade,
-- sem indice novo. So' leitura, STABLE.
--
-- COMO APLICAR (dono; janela 21:30-23:45 BRT):
--   scp scripts/migrations/contabo/095_distancia_ao_municipio.sql transmonseg-vps:/tmp/
--   ssh transmonseg-vps 'sudo -u postgres psql -d transmonseg -v ON_ERROR_STOP=1 -f /tmp/095_distancia_ao_municipio.sql'
--   e recarregar o cache do PostgREST: NOTIFY pgrst, 'reload schema';
--
-- VERIFICACAO:
--   select round(distancia_ao_municipio(-18.6785, -48.1692, '3302502'));  -- ~ 684 km (MG x Mage)
--   select distancia_ao_municipio(-22.6043, -43.1081, '3302502');         -- 0 (dentro de Mage)
--   select round(distancia_ao_municipio(-23.1606, -44.2306, '3300100'));  -- < 2000 (Ilha Grande)
--   select distancia_ao_municipio(-22.9, -43.2, '9999999');               -- null (municipio inexistente)
--
-- ROLLBACK:
--   drop function if exists distancia_ao_municipio(float8, float8, text);

CREATE OR REPLACE FUNCTION distancia_ao_municipio(p_lat float8, p_lng float8, p_municipio text)
RETURNS float8 LANGUAGE sql STABLE AS $$
  SELECT ST_Distance(m.geom::geography, ST_SetSRID(ST_MakePoint(p_lng, p_lat), 4326)::geography)
  FROM malha_municipios_rj m
  WHERE m.municipio_codigo = p_municipio;
$$;
