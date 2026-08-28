-- 064_desvio_disparo_log_retorno_base.sql
--
-- Task "falso positivo de desvio quando veiculo retorna pra base" (28/08 --
-- ver .superpowers/sdd/2026-08-27-romaneio-fonte-unica-plano-geral/
-- task-desvio-retorno-base-report.md): o motor passa a gravar tambem os
-- DISPAROS de desvio que foram segurados pelo gate de retorno sustentado a
-- base (ehRetornoSustentadoABase em lib/desvio.ts).
--
-- Igual a 063: o CHECK de tipo_disparo e' restritivo, entao SEM esta
-- migration todo INSERT desse tipo falha. O motor foi escrito pra sobreviver
-- a isso (flag `logRetornoBase` separada da `logSupressaoDesvio`, desliga so'
-- este log na primeira falha e reporta uma vez) -- a SUPRESSAO em si nao
-- depende da migration, so' a auditoria dela.
--
-- Volume estimado pelo dado real dos ultimos 5 dias: ~66 linhas/dia
-- (331 supressoes em 5 dias).
--
-- ATENCAO: NAO aplicada pela task (constraint da task: nenhuma migration
-- aplicada). Aplicar junto com o deploy deste codigo.
ALTER TABLE desvio_disparo_log DROP CONSTRAINT IF EXISTS desvio_disparo_log_tipo_disparo_check;
ALTER TABLE desvio_disparo_log ADD CONSTRAINT desvio_disparo_log_tipo_disparo_check
  CHECK (tipo_disparo = ANY (ARRAY[
    'afastando_geral'::text,
    'rua_rara_frota'::text,
    'suprimido_salto_reconciliacao'::text,
    'suprimido_retorno_base'::text
  ]));
NOTIFY pgrst, 'reload schema';
