-- 092_alertas_romaneio_disparos.sql
--
-- DSV-01 + DSV-02 (auditoria 03/11/2026). PENDENTE DONO: nao aplicada.
--
-- Problema: a Central Romaneio nao guardava trilha nenhuma de disparo de
-- desvio (desvio_disparo_log e' so' da Central Unitrac). Sem ela nao da' para
-- saber quando foi o ultimo disparo de um carro (o card ficava congelado no 1o
-- episodio do dia) nem medir episodio perdido, falso positivo ou volume no
-- relatorio das 22 h.
--
-- O que cria:
--   alertas_romaneio_disparos: 1 linha por ciclo em que o motor-romaneio
--   disparou desvio para o carro (inclusive quando o card ja estava aberto,
--   silenciado por falso positivo ou em cooldown -- alerta_id nulo nesses
--   dois). Retencao de 30 dias por pg_cron.
--
-- Ordem de deploy: pode aplicar ANTES ou DEPOIS do build. Sem a tabela o
-- motor segue como antes (card nao reabre) e deixa 1 aviso por ciclo em
-- `erros`. Re-executavel (IF NOT EXISTS; cron.schedule com nome substitui).
--
-- COMO APLICAR (janela 21:30-23:45 BRT):
--   scp scripts/migrations/contabo/092_alertas_romaneio_disparos.sql transmonseg-vps:/tmp/
--   ssh transmonseg-vps 'sudo -u postgres psql -d transmonseg -v ON_ERROR_STOP=1 -f /tmp/092_alertas_romaneio_disparos.sql'
--
-- VERIFICACAO (depois do 1o ciclo com desvio):
--   \d alertas_romaneio_disparos
--   select count(*), max(criado_em) from alertas_romaneio_disparos;      -- cresce durante o dia
--   select jobname, schedule from cron.job where jobname = 'limpar-alertas-romaneio-disparos';
--   select contexto->>'decisao', count(*) from alertas_romaneio_disparos
--    where criado_em > now() - interval '1 day' group by 1;              -- novo_alerta/novo_episodio/mesmo_episodio
--   pm2 logs: sem "trilha alertas_romaneio_disparos indisponivel".
--
-- ROLLBACK:
--   select cron.unschedule('limpar-alertas-romaneio-disparos');
--   drop table if exists alertas_romaneio_disparos;   -- o motor volta sozinho ao card congelado
--   NOTIFY pgrst, 'reload schema';

create table if not exists alertas_romaneio_disparos (
  id bigserial primary key,
  -- sem FK de proposito: o card pode ser apagado pela retencao de 30 dias de
  -- alertas_romaneio e a trilha e' evidencia propria.
  alerta_id uuid,
  veiculo_id uuid not null,
  cliente_id uuid not null,
  tipo text not null,
  criado_em timestamptz not null default now(),
  lat double precision,
  lng double precision,
  contexto jsonb not null default '{}'::jsonb
);

-- relatorio diario / analise (por cliente e dia)
create index if not exists idx_alertas_romaneio_disparos_cliente_criado
  on alertas_romaneio_disparos (cliente_id, criado_em);
-- "ultimo disparo do carro" a cada ciclo do motor
create index if not exists idx_alertas_romaneio_disparos_veiculo_criado
  on alertas_romaneio_disparos (veiculo_id, tipo, criado_em desc);

comment on table alertas_romaneio_disparos is
  'DSV-01/02 (03/11/2026): 1 linha por disparo de desvio da Central Romaneio (motor-romaneio). contexto.decisao = novo_alerta | novo_episodio | mesmo_episodio | silenciado | cooldown | erro_insert. Retencao 30 dias.';

grant select, insert on alertas_romaneio_disparos to app_service;
grant usage, select on sequence alertas_romaneio_disparos_id_seq to app_service;

select cron.schedule(
  'limpar-alertas-romaneio-disparos',
  '15 4 * * *',
  $$delete from alertas_romaneio_disparos where criado_em < now() - interval '30 days'$$
);

NOTIFY pgrst, 'reload schema';
