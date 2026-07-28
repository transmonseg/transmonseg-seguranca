-- scripts/migrations/contabo/013_divergencia_rumo_inicio.sql
--
-- Achado CRITICO da revisao independente 28/07 (Tasks 2-4, rumo-diverge):
-- o wiring de verificarCorredor (Task 4) exigia desvioInicio nao-nulo, mas
-- esse e' o anchor da streak de AFASTANDO DE TUDO -- fica null exatamente
-- no caso que motivou a Task 4 (rodovia com curva, divergindo em linha
-- reta SEM afastar de nada). Anchor proprio, mesmo padrao de desvio_inicio,
-- pra streak de divergencia de rumo.
ALTER TABLE posicoes_atuais ADD COLUMN IF NOT EXISTS divergencia_rumo_inicio jsonb NULL DEFAULT NULL;

NOTIFY pgrst, 'reload schema';
