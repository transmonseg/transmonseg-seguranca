-- 090_veiculos_sumiu_da_api.sql
--
-- F2-15 (MON-12) do plano mestre da Central (23/10). PENDENTE DONO: nao aplicada.
--
-- scripts/seed/02_veiculos.mjs (cron de hora em hora) passa a marcar o
-- veiculo ATIVO que nao veio na API da Unitrac (masn) -- em 24/10: TTJ-0F00,
-- TTP-0H36, TTI-6D27, TUC-1D15 e TTT-1E20 -- e limpar a marca quando ele volta.
-- A posicao desses carros e' envelhecida pelo mesmo script com ou sem esta
-- coluna; sem ela so' nao ha' a marca (o script detecta a coluna pelo
-- information_schema). Pode aplicar antes ou depois do deploy, em qualquer ordem.
--
-- COMO APLICAR (dono): coluna nullable sem default = so' catalogo, instantaneo.
--   scp scripts/migrations/contabo/090_veiculos_sumiu_da_api.sql transmonseg-vps:/tmp/
--   ssh transmonseg-vps 'sudo -u postgres psql -d transmonseg -v ON_ERROR_STOP=1 -f /tmp/090_veiculos_sumiu_da_api.sql'
--   ou: node --env-file=.env.production scripts/aplicar-migration.mjs contabo/090_veiculos_sumiu_da_api.sql
--
-- VERIFICACAO (depois da proxima sincronizacao, minuto 5 de cada hora):
--   select placa, cv, sumiu_da_api_em from veiculos where sumiu_da_api_em is not null;
--   (esperado hoje: os 5 da Nutry acima) e um GET do PostgREST em
--   veiculos?select=sumiu_da_api_em&limit=1.
--
-- ROLLBACK: alter table veiculos drop column if exists sumiu_da_api_em;

alter table veiculos
  add column if not exists sumiu_da_api_em timestamptz;

comment on column veiculos.sumiu_da_api_em is
  'Desde quando o veiculo ativo nao vem na lista da API da Unitrac (masn), marcado por scripts/seed/02_veiculos.mjs. NULL = presente na API (ou cliente sem masn, como a RQ).';

NOTIFY pgrst, 'reload schema';
