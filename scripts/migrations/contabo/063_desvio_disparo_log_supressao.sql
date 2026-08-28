-- 063_desvio_disparo_log_supressao.sql
--
-- Task "salto de reconciliacao de atraso" (28/08 -- ver
-- .superpowers/sdd/2026-08-27-romaneio-fonte-unica-plano-geral/task-desvio-catchup-atraso-report.md):
-- o motor passa a gravar, alem dos DISPAROS de desvio, os ciclos que SERIAM
-- avaliados e foram suspensos pelo gate de salto de reconciliacao de
-- telemetria atrasada (ehSaltoDeReconciliacaoDeAtraso em lib/desvio.ts) --
-- pra dar visibilidade de quantas supressoes acontecem por dia sem precisar
-- reconstruir do dado bruto depois.
--
-- O CHECK atual so' aceita os 2 tipos de disparo ('afastando_geral',
-- 'rua_rara_frota'), entao SEM esta migration todo INSERT de supressao
-- falha (cai no catch do motor e vira ruido no array `erros`). Volume
-- estimado pelo dado real dos ultimos dias: ~200-500 linhas/dia.
--
-- Achado real 28/08 (revisao independente): a primeira versao desta task
-- afirmou que nao precisava de migration -- estava errado, o CHECK existe e
-- e' restritivo.
ALTER TABLE desvio_disparo_log DROP CONSTRAINT IF EXISTS desvio_disparo_log_tipo_disparo_check;
ALTER TABLE desvio_disparo_log ADD CONSTRAINT desvio_disparo_log_tipo_disparo_check
  CHECK (tipo_disparo = ANY (ARRAY[
    'afastando_geral'::text,
    'rua_rara_frota'::text,
    'suprimido_salto_reconciliacao'::text
  ]));
NOTIFY pgrst, 'reload schema';
