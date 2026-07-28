-- scripts/migrations/contabo/008_baseline_veiculo_excluida_desde.sql
--
-- Achado real 28/07: baseline_veiculo trava com variancia ~0 porque a
-- protecao anti-autopoluicao (12/07, TTH-6G37) exclui leituras "anomalas"
-- do calculo sem teto de tempo -- uma vez travado, toda leitura normal
-- futura parece anomala e e excluida, entao nada nunca mais entra.
-- excluida_desde marca o INICIO da exclusao continua (null = nao esta
-- sendo excluido agora); route.ts usa isso pra forcar readmissao depois
-- de BASELINE_EXCLUSAO_MAX_MS (ver baseline-veiculo.ts).
ALTER TABLE baseline_veiculo ADD COLUMN IF NOT EXISTS excluida_desde timestamptz NULL DEFAULT NULL;

NOTIFY pgrst, 'reload schema';
