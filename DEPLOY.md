# Deploy — Transmonseg Central

## 1. Vercel (feito pelo Joaquim)
1. Conectar o repo `transmonseg/transmonseg-seguranca` na Vercel.
2. Em Settings → Environment Variables, adicionar as 5 (valores no `.env.local`):
   - `NEXT_PUBLIC_SUPABASE_URL`
   - `NEXT_PUBLIC_SUPABASE_ANON_KEY`
   - `SUPABASE_SERVICE_ROLE_KEY`
   - `DATABASE_URL` (a do pooler `aws-1-sa-east-1`)
   - `MOTOR_SECRET`
3. Deploy. O `npm run build` já passa limpo.

## 2. Cron do motor (a cada 1 min) — JÁ CONFIGURADO via Supabase pg_cron
O motor roda sozinho a cada 1 min pelo PRÓPRIO Supabase (pg_cron + pg_net),
sem serviço externo. Configurado por `scripts/dev/setup-cron.mjs`:
- extensões `pg_cron` e `pg_net` habilitadas;
- job `motor-1min` (`* * * * *`) faz `net.http_post` na URL `/api/motor` com o header `x-motor-key`.
- Ver execuções: `select status, start_time from cron.job_run_details order by start_time desc`.
- Reconfigurar/atualizar a URL: editar e rodar `node --env-file=.env.local scripts/dev/setup-cron.mjs`.

A tela (que se atualiza sozinha a cada 30s via AutoRefresh) reflete os dados
que o motor grava a cada minuto. PRODUÇÃO: https://transmonseg-seguranca.vercel.app

Importante: a função do motor roda na região `gru1` (São Paulo, ver vercel.json),
perto do Supabase, senão a latência EUA-Brasil estoura o timeout.

## Desenvolvimento local
- App: `npm run dev` (porta 3000).
- Motor automático local: `node --env-file=.env.local scripts/motor-loop.mjs`
  (dispara o motor a cada 60s contra o localhost).
- Migrations: `node --env-file=.env.local scripts/aplicar-migration.mjs <arquivo.sql>`.

## Notas
- Conexão do banco: usar SEMPRE o pooler (`aws-1-sa-east-1.pooler.supabase.com`),
  não a direta `db.xxx.supabase.co` (IPv6-only, falha no Node).
- `.env.local` nunca vai pro git (repo é público).
