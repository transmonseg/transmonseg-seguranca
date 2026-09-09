-- 076_mapa_provider_estado_atualizado_por.sql
--
-- Coluna que a Decisao 3 da spec pedia e a migracao 075 esqueceu:
-- "identifica qual sessao/operador reportou". Sem ela nao ha' rastro forense
-- de quem/o que disparou uma mudanca de estado -- importante especialmente
-- porque o detector de cota (src/lib/deteccao-cota-google.ts) podia disparar
-- falso positivo antes da correcao da regex generica /quota/i.
--
-- Nullable e sem valor obrigatorio por enquanto: a rota /api/mapa-provider
-- ainda nao tem identificacao de operador disponivel pra gravar aqui. E' o
-- campo pronto pro uso futuro.
--
-- Roda como postgres (app_service nao tem permissao de DDL), mesmo padrao das
-- migracoes 070-075:
--   ssh transmonseg-vps "sudo -u postgres psql -d transmonseg -f -" \
--     < scripts/migrations/contabo/076_mapa_provider_estado_atualizado_por.sql

ALTER TABLE mapa_provider_estado ADD COLUMN IF NOT EXISTS atualizado_por text;

NOTIFY pgrst, 'reload schema';
