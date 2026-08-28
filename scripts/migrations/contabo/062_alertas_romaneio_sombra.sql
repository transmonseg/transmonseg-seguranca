-- 062_alertas_romaneio_sombra.sql
--
-- Task Fase 4 Incremento 1 (27/08 -- ver
-- .superpowers/sdd/2026-08-27-romaneio-fonte-unica-plano-geral/task-fase4-inc1-brief.md):
-- 3 detectores puros de telemetria (panico, jammer, excesso de velocidade)
-- passam a rodar no motor-romaneio em SHADOW MODE -- geram linha em
-- alertas_romaneio pra comparar contra a Central Unitrac, mas nunca aparecem
-- na tela /central-romaneio nem coloreram o mapa. `sombra` é o interruptor:
-- true = escrito só pra comparação, nunca lido pelos caminhos de UI.
--
-- DEFAULT false: toda linha já existente (desvio, paradas) e todo insert que
-- não passe o campo continua com o comportamento de hoje -- visível, sem
-- mudança nenhuma.
--
-- IMPORTANTE: roda como superuser/dono da tabela (ex: `sudo -u postgres
-- psql -d transmonseg -f <arquivo>`), NAO com a DATABASE_URL normal da
-- aplicacao (role app_service) -- alertas_romaneio e' owned by postgres
-- (confirmado: `select tableowner from pg_tables where
-- tablename='alertas_romaneio'` -> postgres) e ALTER TABLE exige
-- ownership. Mesmo motivo ja documentado nas migrations 034, 044, 059 e 061.
--
-- Coluna nova em tabela ja concedida (GRANT da migration 055 cobre
-- SELECT/INSERT/UPDATE/DELETE pra app_service): nenhum GRANT novo
-- necessario.
ALTER TABLE alertas_romaneio ADD COLUMN IF NOT EXISTS sombra boolean NOT NULL DEFAULT false;

CREATE INDEX IF NOT EXISTS idx_alertas_romaneio_sombra
  ON alertas_romaneio (sombra);

NOTIFY pgrst, 'reload schema';
