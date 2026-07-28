-- scripts/migrations/contabo/012_casos_desvio_revisao_retencao_30_dias.sql
--
-- Achado real 28/07: contexto de resolucao MANUAL (casos_desvio_revisao,
-- 14 dias) expirava 16 dias ANTES do contexto de auto-resolucao
-- (alertas.contexto, 30 dias, ver retencao em route.ts) -- o dado mais
-- valioso pra calibracao (veredito humano de verdade) sumia primeiro.
-- Iguala as duas janelas em 30 dias.
UPDATE cron.job
SET command = replace(command, 'now() - interval ''14 days''', 'now() - interval ''30 days''')
WHERE jobname = 'limpar-casos-desvio-revisao';
