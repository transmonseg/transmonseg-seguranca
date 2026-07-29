-- scripts/migrations/contabo/016_posicoes_atuais_perto_sem_marcacao.sql
--
-- Achado real 28/07 (cliente Nutry Max, casos TTM-7C13 e TUS-1A47 mandados
-- pelo cliente): veiculo parou perto de um cliente de verdade (9min direto,
-- TTM-7C13, 11:55-12:04) mas FORA do raio registrado da entrega -- nenhum
-- alerta disparou. Existe deteccao pro caso oposto (bypass_entrega: passou
-- rapido demais pra ser entrega real, DENTRO do raio) mas nao pro veiculo
-- que para tempo suficiente perto do cliente, so que fora do raio marcado
-- -- fica num buraco de cobertura. Mesmo padrao de origem do proprio
-- bypass_entrega (achado de audio do cliente Nutry Max, 11/07/2026).
--
-- Coluna nova, mesmo padrao de no_raio_dwell_segundos: acumula so quando
-- devagar/parado E dentro da faixa "perto mas fora do raio", zera fora
-- dessa faixa (sem estado por-ponto -- simplificacao aceita pra v1, ver
-- comentario em detectarParadaSemMarcacao/detectores.ts).
ALTER TABLE posicoes_atuais ADD COLUMN IF NOT EXISTS perto_sem_marcacao_segundos integer NOT NULL DEFAULT 0;

NOTIFY pgrst, 'reload schema';
