-- scripts/migrations/contabo/013_divergencia_rumo_inicio.sql
--
-- Achado CRITICO da revisao independente 28/07 (Tasks 2-4, rumo-diverge):
-- o wiring de verificarCorredor (Task 4) exigia desvioInicio nao-nulo, mas
-- esse e' o anchor da streak de AFASTANDO DE TUDO -- fica null exatamente
-- no caso que motivou a Task 4 (rodovia com curva, divergindo em linha
-- reta SEM afastar de nada). Anchor proprio, mesmo padrao de desvio_inicio,
-- pra streak de divergencia de rumo.
ALTER TABLE posicoes_atuais ADD COLUMN IF NOT EXISTS divergencia_rumo_inicio jsonb NULL DEFAULT NULL;

-- Achado MENOR da revisao independente (round 2): veiculos que ja estao
-- com divergencia_rumo_streak>=1 no momento deste deploy nunca passaram
-- pela transicao 0->1 que seta o anchor -- ficariam com streak>=1 e
-- divergencia_rumo_inicio=null (auto-corrige em minutos/horas assim que a
-- streak zerar, mas resetar direto evita o intervalo de contexto vazio +
-- corredor fechado). Mesmo espirito do reset de baseline_veiculo travado
-- (migration 009), numa tabela e coluna diferentes.
UPDATE posicoes_atuais SET divergencia_rumo_streak = 0
WHERE divergencia_rumo_streak > 0 AND divergencia_rumo_inicio IS NULL;

NOTIFY pgrst, 'reload schema';
