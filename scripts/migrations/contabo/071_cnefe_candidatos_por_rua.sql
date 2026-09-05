-- 071_cnefe_candidatos_por_rua.sql
--
-- Achado real 05/09 (romaneio Rio Quality -- so' NOME DA RUA por parada, sem
-- numero/bairro/cidade): a cascata atual escolhe UM ponto por rua e joga o
-- resto fora. Pra geocodificar por coerencia de grupo (ver
-- src/lib/romaneio-geocode-coerencia.ts) precisamos de TODOS os aglomerados
-- onde aquele nome de rua existe no RJ -- um por (municipio, celula de ~1km)
-- -- pra escolher o mais perto das ruas unicas do mesmo caminhao.
--
-- Duas funcoes, mesmo formato de saida:
--   cnefe_candidatos_por_rua(nomes text[])          match EXATO do nome
--                                                    normalizado, em lote
--   cnefe_candidatos_por_similaridade(nome text)    pg_trgm (>= 0.6), so' pros
--                                                    nomes que o exato nao achou;
--                                                    devolve tambem qual nome do
--                                                    CNEFE casou e a similaridade
--
-- Celula = round(lat,2) x round(lng,2) ~ 1,1km x 1,0km nesta latitude. Rua
-- longa (Av. das Americas, ~20km) vira varios aglomerados -- e' proposital:
-- a camada de coerencia escolhe o TRECHO mais perto das ancoras, corrigindo o
-- erro de ~1,7km medido com "um ponto por rua".
--
-- Roda como superuser (`sudo -u postgres psql -d transmonseg -f <arquivo>`),
-- mesmo motivo das migrations 034/044/045/070.

create or replace function cnefe_candidatos_por_rua(nomes text[])
returns table(
  nome text,
  municipio_codigo text,
  lat double precision,
  lng double precision,
  qtd bigint
) as $$
  select c.nome_normalizado,
         c.municipio_codigo,
         avg(c.lat),
         avg(c.lng),
         count(*)
    from cnefe_enderecos c
   where c.nome_normalizado = any(nomes)
   group by c.nome_normalizado, c.municipio_codigo, round(c.lat::numeric, 2), round(c.lng::numeric, 2);
$$ language sql stable;

create or replace function cnefe_candidatos_por_similaridade(nome text, limite_clusters int default 40)
returns table(
  nome_cnefe text,
  similaridade real,
  municipio_codigo text,
  lat double precision,
  lng double precision,
  qtd bigint
) as $$
  select c.nome_normalizado,
         similarity(c.nome_normalizado, nome),
         c.municipio_codigo,
         avg(c.lat),
         avg(c.lng),
         count(*)
    from cnefe_enderecos c
   where c.nome_normalizado % nome
     and similarity(c.nome_normalizado, nome) >= 0.6
   group by c.nome_normalizado, c.municipio_codigo, round(c.lat::numeric, 2), round(c.lng::numeric, 2)
   order by similarity(c.nome_normalizado, nome) desc, count(*) desc
   limit limite_clusters;
$$ language sql stable;

NOTIFY pgrst, 'reload schema';
