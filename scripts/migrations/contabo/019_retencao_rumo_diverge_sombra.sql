-- scripts/migrations/contabo/019_retencao_rumo_diverge_sombra.sql
--
-- Achado da revisao independente da Task 7 (30/07): a migracao 018 criou
-- rumo_diverge_sombra (log de serie temporal, 1 linha por ciclo enquanto
-- o episodio de divergencia estiver ativo) sem job de retencao -- unica
-- tabela de log deste sistema sem um. Toda outra tabela do mesmo genero
-- (cerca_sombra, casos_desvio_revisao, observacoes_ia_desvio) tem retencao
-- de 30 dias via pg_cron (ver 002_retencao.sql e 004_observacoes_ia_desvio.sql,
-- mesmo padrao usado aqui) -- 002_retencao.sql ja corrigiu retroativamente
-- 3 buracos de retencao achados em auditoria; nao repetir o erro numa
-- tabela nova.
select cron.schedule(
  'limpar-rumo-diverge-sombra',
  '0 4 * * *',
  $$delete from rumo_diverge_sombra where criado_em < now() - interval '30 days'$$
);
