-- 050_desvio_estado_classe_viaria.sql
--
-- Ver docs/superpowers/specs/2026-08-15-classe-viaria-corroboracao-design.md.
-- Duas colunas de estado que DECAEM sozinhas (sem job de limpeza, mesmo
-- espirito de ultima_via_principal_em/JANELA_QUEDA_CLASSE_MIN do sistema
-- antigo, removido em 12/08): so' sao atualizadas quando o evento
-- acontece, nunca resetadas explicitamente -- quem le aplica a janela de
-- tempo (10min pra via principal, 5min pra saida de parada confirmada) na
-- hora da leitura. NULL = nunca aconteceu (ou aconteceu ha' tempo demais
-- pra qualquer janela razoavel, tanto faz pra quem le).
ALTER TABLE desvio_estado ADD COLUMN IF NOT EXISTS ultima_via_principal_em timestamptz NULL;
ALTER TABLE desvio_estado ADD COLUMN IF NOT EXISTS saiu_parada_confirmada_em timestamptz NULL;
ALTER TABLE desvio_disparo_log ADD COLUMN IF NOT EXISTS classe_viaria_confirmou boolean NOT NULL DEFAULT false;
NOTIFY pgrst, 'reload schema';
