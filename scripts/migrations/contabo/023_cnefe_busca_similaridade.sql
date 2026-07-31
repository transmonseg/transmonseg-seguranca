-- scripts/migrations/contabo/023_cnefe_busca_similaridade.sql
--
-- Funcao stored pra busca por similaridade (pg_trgm) em cnefe_enderecos --
-- Supabase JS nao expoe ORDER BY similarity()/operador % direto pelo
-- query builder, precisa de RPC. Usa o operador "%" (pg_trgm, limiar
-- default 0.3) que aproveita o indice GIN ja criado na migration 022, nao
-- faz sequential scan.
create or replace function cnefe_buscar_por_similaridade(termo text, limite int default 5)
returns table(lat double precision, lng double precision) as $$
  select lat, lng from cnefe_enderecos
  where nome_normalizado % termo
  order by similarity(nome_normalizado, termo) desc
  limit limite;
$$ language sql stable;
