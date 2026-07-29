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
-- Achado CRITICO da revisao independente (round 1): a v1 disparava ENQUANTO
-- parado na faixa (mesma faixa que noCliente/suspenderPorChegada ja tratam
-- como "chegou") -- disparava em toda entrega normal em andamento. Redesenhado
-- pra sinal de TRANSICAO (sai da faixa sem confirmar), mesmo padrao exato de
-- no_raio_alvo_codigo/no_raio_desde/no_raio_dwell_segundos (bypass_entrega) --
-- precisa rastrear IDENTIDADE do ponto (nao so um contador solto), senao o
-- alvo mais proximo trocando no meio do dwell confunde o acumulador (achado
-- da mesma revisao).
ALTER TABLE posicoes_atuais ADD COLUMN IF NOT EXISTS perto_sem_marcacao_codigo integer NULL;
ALTER TABLE posicoes_atuais ADD COLUMN IF NOT EXISTS perto_sem_marcacao_segundos integer NOT NULL DEFAULT 0;

NOTIFY pgrst, 'reload schema';
