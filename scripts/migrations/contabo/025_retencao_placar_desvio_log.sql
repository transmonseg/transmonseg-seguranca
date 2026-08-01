-- scripts/migrations/contabo/025_retencao_placar_desvio_log.sql
--
-- Achado da revisao final pos-implementacao do placar de desvio (01/08): a
-- migracao 024 criou placar_desvio_log (log de serie temporal, 1 linha por
-- ciclo em que o placar > 0 ou tem componente) sem job de retencao -- mesmo
-- erro ja cometido e corrigido antes na rumo_diverge_sombra (ver
-- 019_retencao_rumo_diverge_sombra.sql). Toda outra tabela do mesmo genero
-- (cerca_sombra, casos_desvio_revisao, observacoes_ia_desvio,
-- rumo_diverge_sombra) tem retencao de 30 dias via pg_cron (mesmo padrao
-- usado aqui); nao repetir o buraco numa tabela nova.
select cron.schedule(
  'limpar-placar-desvio-log',
  '0 4 * * *',
  $$delete from placar_desvio_log where criado_em < now() - interval '30 days'$$
);
