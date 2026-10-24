-- 091_cnefe_bairros_centroide.sql
--
-- F4-01 (GEO-26) do plano mestre da Central (23/10). PENDENTE DONO: nao aplicada.
--
-- Problema (auditoria 23/10, geocode.md GEO-26):
--   - o centroide de bairro da ponte do KPI (/api/romaneio/geocode, passo
--     cnefe_bairro) fazia `.eq(municipio_codigo).ilike('localidade','%X%')`
--     direto em cnefe_enderecos (8,8 M linhas), sem indice, sem limite e sem
--     prazo: Parallel Seq Scan de 50,4 s e 167.131 linhas para CAMPO GRANDE;
--     os 127 cnefe_bairro gravados de 21 a 23/10 custaram ~1h45 de seq scan;
--   - '%X%' mistura localidades: "MARE" juntava 15 (74.629 pontos, Marechal
--     Hermes incluso) e o centroide ficava a 8,1 km do da Mare.
--
-- Correcao:
--   1. tabela derivada cnefe_bairros_centroide: 1 linha por
--      (municipio_codigo, localidade_norm) com a MEDIA dos pontos do Censo (o
--      mesmo calculo que a rota fazia no Node, so' que por localidade), o
--      numero de pontos e a extensao (caixa min/max). localidade_norm com a
--      mesma expressao de cnefe_bairros (082), para as duas casarem. NAO e' a
--      tabela cnefe_bairros (essa e' da guarda territorial, com hull, e e'
--      DROP+CREATE pela 082 a cada reingestao).
--      A rota consulta por igualdade (PK) e, sem igualdade, as localidades do
--      municipio que contem o bairro (src/lib/cnefe-bairro-centroide.ts).
--   2. indice composto (municipio_codigo, localidade_norm) em cnefe_bairros
--      (distancia_ao_bairro filtra pelos dois; a 082 tambem passa a cria-lo).
--   3. CREATE INDEX CONCURRENTLY em cnefe_enderecos(cep) e
--      (municipio_codigo, localidade) -- pedidos no GEO-26 para as buscas por
--      CEP/localidade (cada um ~0,2-0,3 GB; disco livre 112 GB em 24/10).
--
-- O codigo funciona ANTES e DEPOIS: sem a tabela (PGRST205) a rota usa a
-- consulta antiga, agora com prazo de 60 s; com a tabela, < 50 ms.
-- Aplicar ANTES de ligar db-max-rows no PostgREST (F1-15): a consulta antiga
-- devolve ate' 167 mil linhas e seria cortada sem aviso.
--
-- Dado DERIVADO de cnefe_enderecos: re-rodar este arquivo inteiro depois de
-- reingerir o CNEFE (scripts/ingerir-cnefe.mjs avisa), como a 082. A troca da
-- tabela e' atomica (cria _novo, troca o nome numa transacao): a rota nunca ve
-- a tabela vazia. Os CREATE INDEX CONCURRENTLY sao "if not exists".
--
-- COMO APLICAR (dono; janela 21:30-23:45 BRT): CONCURRENTLY nao roda dentro de
-- transacao -- NAO usar scripts/aplicar-migration.mjs (arquivo inteiro numa
-- query so'). Como superuser, statement a statement:
--   scp scripts/migrations/contabo/091_cnefe_bairros_centroide.sql transmonseg-vps:/tmp/
--   ssh transmonseg-vps 'sudo -u postgres psql -d transmonseg -v ON_ERROR_STOP=1 -f /tmp/091_cnefe_bairros_centroide.sql'
-- Tempo esperado: a agregacao leva ~10-40 s (1 leitura de cnefe_enderecos;
-- medido 8 s quente em 24/10); cada indice CONCURRENTLY ~1-3 min.
-- Se um CONCURRENTLY falhar no meio, sobra indice INVALID: dropar com
-- `drop index concurrently if exists <nome>;` e rodar de novo.
--
-- VERIFICACAO:
--   select count(*) from cnefe_bairros_centroide;            -- esperado 7.678 (= cnefe_bairros)
--   select localidade_norm, n_pontos, round(lat::numeric,5), round(lng::numeric,5)
--     from cnefe_bairros_centroide where municipio_codigo='3304557' and localidade_norm='MARE';
--     -- esperado 39142 pontos, -22.86419 -43.24036
--   explain analyze select * from cnefe_bairros_centroide
--     where municipio_codigo='3304557' and localidade_norm='CAMPO GRANDE';  -- Index Scan, < 50 ms
--   GET do PostgREST (como a rota): /rest/v1/cnefe_bairros_centroide?municipio_codigo=eq.3304557&localidade_norm=eq.MARE
--   pm2 logs do monitoramento: sem "[cnefe-bairro] consulta antiga" depois do reload.
--
-- ROLLBACK:
--   drop table if exists cnefe_bairros_centroide;   -- a rota volta sozinha a consulta antiga
--   drop index concurrently if exists idx_cnefe_cep;
--   drop index concurrently if exists idx_cnefe_municipio_localidade;
--   drop index if exists cnefe_bairros_municipio_nome_idx;
--   NOTIFY pgrst, 'reload schema';

begin;

drop table if exists cnefe_bairros_centroide_novo;

create table cnefe_bairros_centroide_novo as
select municipio_codigo,
       upper(translate(localidade,'ÁÀÂÃÉÊÍÓÔÕÚÇáàâãéêíóôõúç','AAAAEEIOOOUCAAAAEEIOOOUC')) as localidade_norm,
       count(*)::int as n_pontos,
       avg(lat) as lat,
       avg(lng) as lng,
       min(lat) as lat_min,
       max(lat) as lat_max,
       min(lng) as lng_min,
       max(lng) as lng_max
from cnefe_enderecos
where localidade is not null and localidade <> '' and municipio_codigo is not null
group by 1, 2;

alter table cnefe_bairros_centroide_novo
  add constraint cnefe_bairros_centroide_novo_pkey primary key (municipio_codigo, localidade_norm);

drop table if exists cnefe_bairros_centroide;
alter table cnefe_bairros_centroide_novo rename to cnefe_bairros_centroide;
alter index cnefe_bairros_centroide_novo_pkey rename to cnefe_bairros_centroide_pkey;

comment on table cnefe_bairros_centroide is
  'F4-01 (GEO-26): media dos pontos do CNEFE por (municipio_codigo, localidade_norm), para o centroide de bairro da ponte do KPI. Derivada de cnefe_enderecos: re-rodar a migration 091 depois de reingerir o CNEFE.';

grant select on cnefe_bairros_centroide to app_service;

create index if not exists cnefe_bairros_municipio_nome_idx on cnefe_bairros (municipio_codigo, localidade_norm);

commit;

analyze cnefe_bairros_centroide;

set maintenance_work_mem = '1GB';

create index concurrently if not exists idx_cnefe_cep
  on cnefe_enderecos (cep);

create index concurrently if not exists idx_cnefe_municipio_localidade
  on cnefe_enderecos (municipio_codigo, localidade);

NOTIFY pgrst, 'reload schema';
