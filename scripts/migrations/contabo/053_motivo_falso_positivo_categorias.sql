-- 053_motivo_falso_positivo_categorias.sql
--
-- Amplia o CHECK de motivo_falso_positivo (alertas + casos_desvio_revisao)
-- pras 4 categorias novas (Erica/KPI Benassi: NAO_FOI_AO_CLIENTE,
-- NAO_SAIU_DA_BASE, DESATUALIZADO, MUDOU_DE_ROTA), MANTENDO os 2 valores
-- antigos (detector_errado, dado_entrada_errado) pro historico existente
-- (286 linhas com detector_errado em producao, 18/08) -- nao migra dado
-- antigo, so' para de gravar os 2 antigos daqui pra frente (a UI so' vai
-- mais oferecer as 4 categorias novas). Ver
-- docs/superpowers/specs/2026-08-18-correto-falso-motivo-estruturado-design.md.
ALTER TABLE alertas DROP CONSTRAINT IF EXISTS alertas_motivo_falso_positivo_check;
ALTER TABLE alertas ADD CONSTRAINT alertas_motivo_falso_positivo_check
  CHECK (motivo_falso_positivo IN (
    'detector_errado', 'dado_entrada_errado',
    'NAO_FOI_AO_CLIENTE', 'NAO_SAIU_DA_BASE', 'DESATUALIZADO', 'MUDOU_DE_ROTA'
  ));

ALTER TABLE casos_desvio_revisao DROP CONSTRAINT IF EXISTS casos_desvio_revisao_motivo_falso_positivo_check;
ALTER TABLE casos_desvio_revisao ADD CONSTRAINT casos_desvio_revisao_motivo_falso_positivo_check
  CHECK (motivo_falso_positivo IN (
    'detector_errado', 'dado_entrada_errado',
    'NAO_FOI_AO_CLIENTE', 'NAO_SAIU_DA_BASE', 'DESATUALIZADO', 'MUDOU_DE_ROTA'
  ));
NOTIFY pgrst, 'reload schema';
