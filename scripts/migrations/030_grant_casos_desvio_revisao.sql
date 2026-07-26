-- scripts/migrations/030_grant_casos_desvio_revisao.sql
--
-- Achado real na Task 5 (validacao end-to-end contra o Contabo, ver
-- .superpowers/sdd/historico-casos-desvio/task-5-report.md): a migration 029
-- criou casos_desvio_revisao mas nunca concedeu privilegios pro role
-- app_service (o role fixo usado pelo PostgREST/pg.Pool no Contabo desde a
-- migracao de infra) -- o GRANT ALL original (Task 7 da migracao pro
-- Contabo, 2026-07-25) foi um comando manual de unica vez, direto no VPS,
-- cobrindo só as tabelas que ja existiam NAQUELE momento. Qualquer tabela
-- nova criada por migration DEPOIS do corte pro Contabo (esta foi a
-- primeira) fica sem grant nenhum, e o insert de
-- registrarCasosDesvioRevisao() falha silenciosamente (o try/catch de
-- casos-desvio-revisao.ts so loga um aviso, por design -- nao deve bloquear
-- o operador). Resultado real observado: casos_desvio_revisao ficou vazia em
-- producao apos duas rodadas de teste real (falso_positivo via UI real),
-- mesmo com o codigo das Tasks 1-4 correto.
--
-- Corrige o buraco pontual (grant nesta tabela + sequence do identity) e,
-- pra nao repetir o problema na proxima tabela nova, adiciona
-- ALTER DEFAULT PRIVILEGES pro role que roda as migrations (postgres) --
-- daqui pra frente, toda tabela/sequence nova em public ja nasce com grant
-- pro app_service automaticamente. Idempotente (GRANT e ALTER DEFAULT
-- PRIVILEGES podem ser reexecutados sem erro).
GRANT SELECT, INSERT, UPDATE, DELETE, TRUNCATE, REFERENCES, TRIGGER
  ON casos_desvio_revisao TO app_service;
GRANT USAGE, SELECT ON SEQUENCE casos_desvio_revisao_id_seq TO app_service;

ALTER DEFAULT PRIVILEGES FOR ROLE postgres IN SCHEMA public
  GRANT SELECT, INSERT, UPDATE, DELETE, TRUNCATE, REFERENCES, TRIGGER
  ON TABLES TO app_service;
ALTER DEFAULT PRIVILEGES FOR ROLE postgres IN SCHEMA public
  GRANT USAGE, SELECT ON SEQUENCES TO app_service;

-- IMPORTANTE (segunda parte do mesmo achado): grant no Postgres nao basta --
-- o PostgREST mantem um cache de schema proprio (quais tabelas/colunas
-- existem) que so e' atualizado por reload explicito. casos_desvio_revisao
-- (criada via psql direto, migration 029) nunca apareceu nesse cache ate'
-- este comando ser rodado uma vez, manualmente, na Task 5:
--   NOTIFY pgrst, 'reload schema';
-- Isso NAO e' parte deste arquivo .sql porque e' um passo operacional (rodar
-- uma vez, manual, apos aplicar QUALQUER migration no Contabo que crie
-- tabela/coluna nova), nao uma mudanca de schema em si. Documentado aqui pra
-- a proxima migration nao esquecer: sem o NOTIFY, PostgREST responde
-- PGRST205 "Could not find the table ... in the schema cache" mesmo com os
-- grants corretos.
