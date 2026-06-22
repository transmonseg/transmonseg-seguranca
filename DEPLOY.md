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

## 2. Cron do motor (a cada 1 min)
O motor é uma API route protegida. Algo de fora precisa chamá-la a cada 1 min.
O Vercel cron no plano grátis roda só 1x/dia, então usar um disparador externo:

**Opção recomendada — cron-job.org (grátis, 1 min):**
- Criar conta, novo cronjob.
- URL: `https://<seu-dominio-vercel>/api/motor`
- Método: `POST`
- Header: `x-motor-key: <valor do MOTOR_SECRET>`
- Intervalo: a cada 1 minuto.

Pronto: a tela (que se atualiza sozinha a cada 30s via AutoRefresh) reflete os
dados que o motor grava a cada minuto.

## Desenvolvimento local
- App: `npm run dev` (porta 3000).
- Motor automático local: `node --env-file=.env.local scripts/motor-loop.mjs`
  (dispara o motor a cada 60s contra o localhost).
- Migrations: `node --env-file=.env.local scripts/aplicar-migration.mjs <arquivo.sql>`.

## Notas
- Conexão do banco: usar SEMPRE o pooler (`aws-1-sa-east-1.pooler.supabase.com`),
  não a direta `db.xxx.supabase.co` (IPv6-only, falha no Node).
- `.env.local` nunca vai pro git (repo é público).
