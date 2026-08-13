-- 045_cnefe_similaridade_municipio.sql
--
-- Filtro de municipio no ultimo nivel de busca do CNEFE (similaridade
-- pg_trgm) -- ver
-- docs/superpowers/specs/2026-08-12-precisao-geocodificacao-romaneio-design.md.
-- Os outros 2 niveis (rua+numero exato, so-rua) ja filtram por
-- municipio_codigo direto via query builder Supabase-js (nao precisam de
-- migration, so a consulta em processar-geocode/route.ts) -- esta funcao
-- stored e' a unica excecao porque o Supabase-js nao expoe ORDER BY
-- similarity() direto, precisa de RPC.
--
-- IMPORTANTE: roda como superuser (ex: `sudo -u postgres psql -d
-- transmonseg -f <arquivo>`), mesmo motivo das migrations 034/044.

create or replace function cnefe_buscar_por_similaridade(
  termo text,
  limite int default 5,
  filtro_municipio_codigo text default null
)
returns table(lat double precision, lng double precision) as $$
  select lat, lng from cnefe_enderecos
  where nome_normalizado % termo
    and (filtro_municipio_codigo is null or municipio_codigo = filtro_municipio_codigo)
  order by similarity(nome_normalizado, termo) desc
  limit limite;
$$ language sql stable;

NOTIFY pgrst, 'reload schema';
