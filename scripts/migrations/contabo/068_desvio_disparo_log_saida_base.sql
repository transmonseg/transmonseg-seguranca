-- 068_desvio_disparo_log_saida_base.sql
--
-- Task "falso positivo de desvio ao SAIR da base em rota longa" (31/08 --
-- ver .superpowers/sdd/2026-08-27-romaneio-fonte-unica-plano-geral/
-- task-desvio-saida-base-report.md): o motor passa a gravar tambem os
-- DISPAROS de desvio segurados pelo gate de saida da base sem destino
-- avaliavel (ehSaidaDeBaseSemDestinoAvaliavel em lib/desvio.ts).
--
-- Igual a 063/064: o CHECK de tipo_disparo e' restritivo, entao SEM esta
-- migration todo INSERT desse tipo falha. O motor foi escrito pra sobreviver
-- a isso (flag `logSaidaBase` propria, desliga so' este log na primeira falha
-- e reporta uma vez) -- a SUPRESSAO em si nao depende da migration, so' a
-- auditoria dela.
--
-- Volume estimado pelo dado real dos ultimos 18 dias: ~110 supressoes de
-- ALERTA em 18 dias (~6/dia), mas o log e' por CICLO suprimido, nao por
-- alerta -- ordem de grandeza esperada de algumas centenas de linhas/dia,
-- comparavel a 064.
--
-- ATENCAO: NAO aplicada pela task (constraint da task: nenhuma migration
-- aplicada em producao). Aplicar junto com o deploy deste codigo.
ALTER TABLE desvio_disparo_log DROP CONSTRAINT IF EXISTS desvio_disparo_log_tipo_disparo_check;
ALTER TABLE desvio_disparo_log ADD CONSTRAINT desvio_disparo_log_tipo_disparo_check
  CHECK (tipo_disparo = ANY (ARRAY[
    'afastando_geral'::text,
    'rua_rara_frota'::text,
    'suprimido_salto_reconciliacao'::text,
    'suprimido_retorno_base'::text,
    'suprimido_saida_base'::text
  ]));
NOTIFY pgrst, 'reload schema';
