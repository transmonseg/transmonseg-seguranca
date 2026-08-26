-- 060_motivo_falso_positivo_detalhe.sql
--
-- Pedido do time (grupo DESVIO DE ROTA, 26/08, WhatsApp): "Não conseguimos
-- ler a opção para marca o desvio falso. obs: colocar uma aba para escrever
-- o motivo" -- as 4 categorias fixas (NAO_FOI_AO_CLIENTE/NAO_SAIU_DA_BASE/
-- DESATUALIZADO/MUDOU_DE_ROTA, ver migration 053) nem sempre descrevem o
-- caso real. Coluna NOVA e opcional pra texto livre do operador, separada
-- do enum estruturado que a calibração automática usa (motivo_falso_positivo
-- continua só com as 4 categorias -- ver registrarCasosDesvioRevisao) --
-- NUNCA aparece em nenhum CHECK constraint, é só anotação humana.
ALTER TABLE alertas ADD COLUMN IF NOT EXISTS motivo_falso_positivo_detalhe text;
ALTER TABLE alertas_romaneio ADD COLUMN IF NOT EXISTS motivo_falso_positivo_detalhe text;
NOTIFY pgrst, 'reload schema';
