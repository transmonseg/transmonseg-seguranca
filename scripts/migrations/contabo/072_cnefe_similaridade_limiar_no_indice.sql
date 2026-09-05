-- 072_cnefe_similaridade_limiar_no_indice.sql
--
-- Achado real 05/09 (smoke test da rota geocode-coerencia com o romaneio Rio
-- Quality, 177 nomes sem match exato): cada chamada de
-- cnefe_candidatos_por_similaridade levava ~12s via PostgREST -- a mesma
-- consulta rodada no psql com `set pg_trgm.similarity_threshold = 0.6`
-- levava fracoes de segundo. Motivo: o operador `%` usa o indice GIN trigram
-- com o LIMIAR DA SESSAO (padrao 0.3), entao o indice devolve dezenas de
-- milhares de linhas "parecidas" e o `similarity(...) >= 0.6` do WHERE filtra
-- tudo depois, linha a linha, em 8,8M de enderecos.
--
-- Fix: fixar o limiar NA DEFINICAO da funcao (clausula SET do CREATE
-- FUNCTION -- vale so' durante a execucao dela, nao mexe na sessao de quem
-- chama). Com 0.6 no indice, o `%` ja' devolve so' o que interessa. Mesma
-- assinatura/saida da migration 071; `create or replace` com a MESMA lista de
-- parametros substitui de verdade (licao da migration 070: quantidade
-- diferente de parametros criaria um overload paralelo).
--
-- Roda como superuser (`sudo -u postgres psql -d transmonseg -f <arquivo>`).

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
   group by c.nome_normalizado, c.municipio_codigo, round(c.lat::numeric, 2), round(c.lng::numeric, 2)
   order by similarity(c.nome_normalizado, nome) desc, count(*) desc
   limit limite_clusters;
$$ language sql stable
   set pg_trgm.similarity_threshold = 0.6;

NOTIFY pgrst, 'reload schema';
