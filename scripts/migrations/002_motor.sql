-- ============================================================
-- Transmonseg Central — Migration 002: motor de detecção
-- Adiciona coluna parado_desde em posicoes_atuais e função
-- fn_favela_em para cruzamento geográfico de ponto com favelas.
-- ============================================================

alter table posicoes_atuais add column if not exists parado_desde timestamptz;

create or replace function fn_favela_em(p_lat double precision, p_lng double precision)
  returns text language sql stable as $$
  select nome from geofences where tipo='favela'
    and ST_Intersects(geom, ST_SetSRID(ST_MakePoint(p_lng, p_lat),4326)::geography) limit 1
$$;
