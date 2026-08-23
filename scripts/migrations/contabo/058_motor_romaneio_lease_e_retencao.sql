-- 058_motor_romaneio_lease_e_retencao.sql
--
-- Duas lacunas do motor paralelo do romaneio (migrations 055/056/057)
-- achadas na revisão final de 22/08. Nenhuma delas existe pra Central: são
-- rotinas que a Central já tem há tempos e que a tabela nova
-- (alertas_romaneio) simplesmente nunca herdou.
--
-- NÃO aplicada em produção por esta task (os jobs 21/22 do motor-romaneio
-- estão desligados, active=false, até o usuário autorizar religar).

-- ─── 1. Linha PRÓPRIA de lease pro motor do romaneio ──────────────────────
-- src/app/api/motor-romaneio/route.ts passa a adquirir um lease com
-- expiração antes de rodar o ciclo, exatamente como /api/motor faz
-- (motor_lease, migration 016 / 001_schema_base.sql:276). Motivo, medido na
-- Central: sem trava, dois ciclos sobrepostos leem o mesmo snapshot de
-- alertas abertos, ambos inserem, e o estado vira last-write-wins -- até 34
-- alertas de desvio por dia pro MESMO veículo. O motor do romaneio tem
-- exatamente a mesma exposição: 2 jobs de pg_cron por minuto (um na hora
-- exata, outro com pg_sleep(30), ver 057) contra a mesma rota.
--
-- LINHA SEPARADA (id = 2), NÃO a id = 1: a id = 1 é da Central. Compartilhar
-- a linha faria um motor bloquear o outro -- os dois pipelines rodam de
-- propósito ao mesmo tempo pros mesmos carros (o produto da entrega é
-- comparar os dois no mesmo dia).
--
-- ON CONFLICT DO NOTHING: rodar esta migration de novo não pode ressetar um
-- lease em uso.
--
-- expira_em no passado (now() - 1s) pra que o PRIMEIRO ciclo depois desta
-- migration consiga adquirir o lease (a condição de aquisição é
-- `expira_em < now()`); o default da coluna é now(), que travaria o
-- primeiro disparo por um instante sem necessidade.
insert into motor_lease (id, expira_em, token, adquirido_em)
values (2, now() - interval '1 second', null, null)
on conflict (id) do nothing;

-- ─── 2. Retenção/expiração de alertas_romaneio ────────────────────────────
-- Mesmo par de rotinas que a Central tem pra `alertas`, estendido pra tabela
-- nova. Confirmado no banco em 22/08: NENHUM job cobria alertas_romaneio.
--
-- Por que virou urgente: depois do fix desta mesma revisão, o motor do
-- romaneio NUNCA fecha um alerta de desvio (TIPOS_NAO_GERENCIADOS, pedido
-- explícito do usuário após o churn de cerca virtual de 11/07) -- e todo
-- alerta desta tabela é tipo "desvio" hoje. Sem estas duas rotinas, um
-- alerta ativo de um veículo que amanhã não tiver romaneio nunca mais é
-- reprocessado: fica ativo pra sempre, ocupa a vaga de dedup e ABSORVE
-- silenciosamente os desvios novos do mesmo veículo.
--
-- 2a. Expirar 'ativo' esquecido há 7+ dias -- espelha
--     'expirar-alertas-ativos-esquecidos' (002_retencao.sql), inclusive o
--     marcador contexto.auto_expirado, que é como contaComoRotuloHumano
--     (src/lib/detectores.ts) distingue "o operador nunca chegou a ver"
--     de "operador julgou". Mesmo horário (4h da manhã) dos outros jobs de
--     limpeza.
select cron.schedule(
  'expirar-alertas-romaneio-ativos-esquecidos',
  '0 4 * * *',
  $$update alertas_romaneio set status = 'resolvido', resolvido_em = now(),
      contexto = coalesce(contexto, '{}'::jsonb) || '{"auto_expirado": true}'::jsonb
    where status = 'ativo' and desde < now() - interval '7 days'$$
);

-- 2b. Retenção de 30 dias dos já fechados -- espelha o DELETE que o motor
--     da Central roda em `alertas` (src/app/api/motor/route.ts, bloco de
--     limpeza diária). Aqui vira cron próprio porque o motor do romaneio
--     não tem (nem deve ganhar) um bloco de limpeza de fim de ciclo.
--     Mesmos 3 status da Central ('limpo' incluído: é o status do botão
--     "Limpar avisos", sem ele essas linhas nunca seriam apagadas).
select cron.schedule(
  'limpar-alertas-romaneio-antigos',
  '0 4 * * *',
  $$delete from alertas_romaneio
     where status in ('resolvido', 'falso_positivo', 'limpo')
       and coalesce(resolvido_em, desde) < now() - interval '30 days'$$
);
