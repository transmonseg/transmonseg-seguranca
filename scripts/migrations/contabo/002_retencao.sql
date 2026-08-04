-- scripts/migrations/contabo/002_retencao.sql
--
-- 3 buracos de retencao encontrados em auditoria desta sessao, nunca
-- corrigidos no Supabase -- corrigidos ja no schema novo do Contabo.
--
-- Step 1 (confirmacao da rotina atual, src/app/api/motor/route.ts):
--   DELETE FROM alertas
--   WHERE status IN ('resolvido', 'falso_positivo')
--     AND COALESCE(resolvido_em, created_at) < now() - interval '30 days'
-- Essa rotina so cobre alertas ja fechados (resolvido/falso_positivo).
-- Os jobs abaixo NAO a substituem -- o job 3 e' um mecanismo ADICIONAL
-- que so expira o que fica em 'ativo' (nunca nem reconhecido) por 7+ dias.

-- 1. Limpeza de cerca_sombra (nunca existia) -- mesmo horizonte de 30 dias
--    usado pros outros dados operacionais deste sistema.
select cron.schedule(
  'limpar-cerca-sombra',
  '0 4 * * *',
  $$delete from cerca_sombra where criado_em < now() - interval '30 days'$$
);

-- 2. Limpeza de cron.job_run_details (nunca existia) -- reter so 14 dias,
--    e' log operacional, nao dado de negocio.
select cron.schedule(
  'limpar-cron-job-run-details',
  '0 4 * * *',
  $$delete from cron.job_run_details where end_time < now() - interval '14 days'$$
);

-- 3. Expirar alertas 'ativo' esquecidos -- achado mais serio: hoje a limpeza
--    de 30 dias so cobre resolvido/falso_positivo, entao um alerta que
--    nunca foi resolvido fica pra sempre. Resolve automaticamente pra
--    'resolvido' (com nota no contexto) apos 7 dias sem interacao --
--    prazo bem maior que qualquer desvio real levaria pra ser tratado,
--    so existe pra parar o acumulo indefinido.
select cron.schedule(
  'expirar-alertas-ativos-esquecidos',
  '0 4 * * *',
  $$update alertas set status = 'resolvido', resolvido_em = now(),
      contexto = coalesce(contexto, '{}'::jsonb) || '{"auto_expirado": true}'::jsonb
    where status = 'ativo' and desde < now() - interval '7 days'$$
);
