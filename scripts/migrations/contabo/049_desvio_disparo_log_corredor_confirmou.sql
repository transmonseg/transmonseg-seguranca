-- 049_desvio_disparo_log_corredor_confirmou.sql
--
-- Ver docs/superpowers/specs/2026-08-14-desvio-corredor-corroboracao-design.md.
-- Registra se um disparo especifico foi corroborado pelo corredor real
-- (OSRM self-hosted confirmou que o veiculo esta fora de qualquer rota
-- legitima ate os destinos pendentes) -- permite medir depois quantos
-- disparos reais o corredor de fato corrobora, sem precisar reconstruir
-- do texto de `motivo`.
ALTER TABLE desvio_disparo_log ADD COLUMN IF NOT EXISTS corredor_confirmou boolean NOT NULL DEFAULT false;
NOTIFY pgrst, 'reload schema';
