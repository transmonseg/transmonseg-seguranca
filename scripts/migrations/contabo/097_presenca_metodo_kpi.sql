-- 097_presenca_metodo_kpi.sql (07/11)
--
-- /api/romaneio/presenca-kpi grava presenca_metodo = 'kpi' (nota que o KPI Ao
-- vivo deu como entregue). A CHECK da 088 so' aceitava dwell/vizinhanca.
-- NOT VALID + VALIDATE: troca a regra sem travar a tabela pra escrita.
--
-- COMO APLICAR: scp pra /tmp e
--   ssh transmonseg-vps 'sudo -u postgres psql -d transmonseg -v ON_ERROR_STOP=1 -f /tmp/097_presenca_metodo_kpi.sql'
-- ROLLBACK: update romaneio_pontos set presenca_metodo = null where presenca_metodo = 'kpi';
--   e recriar a CHECK da 088.

alter table romaneio_pontos drop constraint if exists romaneio_pontos_presenca_metodo_check;
alter table romaneio_pontos add constraint romaneio_pontos_presenca_metodo_check
  check (presenca_metodo is null or presenca_metodo in ('dwell', 'vizinhanca', 'kpi')) not valid;
alter table romaneio_pontos validate constraint romaneio_pontos_presenca_metodo_check;

comment on column romaneio_pontos.presenca_metodo is
  'Como a presenca foi confirmada: dwell (parada no proprio ponto), vizinhanca (emprestada de ponto confirmado do mesmo veiculo+dia) ou kpi (nota entregue no KPI Ao vivo). NULL = antigo ou motor ao vivo.';

NOTIFY pgrst, 'reload schema';
