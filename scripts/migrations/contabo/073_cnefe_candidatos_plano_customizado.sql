-- 073_cnefe_candidatos_plano_customizado.sql
--
-- Achado real 05/09 (meta.msExato da rota geocode-coerencia: 37s de 44s pra
-- 383 nomes): cnefe_candidatos_por_rua(nomes text[]) com `= any(nomes)`
-- roda em ~4,5s nas 5 primeiras execucoes de uma sessao e ~37s a partir da
-- sexta -- e' o PLANO GENERICO do prepared statement (o PostgREST reusa a
-- conexao/plano): sem saber o tamanho do array, o planner estima mal e troca
-- o index scan por varredura. Reproduzido no psql com PREPARE/EXECUTE:
-- execucoes 1-5 = 4,5s, 6-7 = 35-37s.
--
-- Dois ajustes, mesma assinatura/saida da migration 071:
--   1. `join unnest(nomes)` em vez de `= any(nomes)` -- o planner estima o
--      unnest em poucas linhas e faz nested loop com o indice
--      (idx_cnefe_nome_numero): 4,4s no plano generico, ~2s no customizado.
--   2. `SET plan_cache_mode = force_custom_plan` na definicao da funcao --
--      planeja com os valores reais em toda execucao (planejar custa ms;
--      executar o plano errado custa dezenas de segundos).
--
-- Roda como superuser (`sudo -u postgres psql -d transmonseg -f <arquivo>`).

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
    from unnest(nomes) as n(nome)
    join cnefe_enderecos c on c.nome_normalizado = n.nome
   group by c.nome_normalizado, c.municipio_codigo, round(c.lat::numeric, 2), round(c.lng::numeric, 2);
$$ language sql stable
   set plan_cache_mode = force_custom_plan;

NOTIFY pgrst, 'reload schema';
