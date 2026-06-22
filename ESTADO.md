# Transmonseg Central — Estado do projeto

Central de inteligência de risco multi-cliente da Transmonseg (detecção de desvio/roubo de carga).
Piloto: Nutry Max. Apresentação da ideia: https://transmonseg-seguranca.triforce-media.workers.dev

## Stack
- **Next.js** (App Router, TypeScript, Tailwind, src/) — frontend + motor (API routes)
- **Supabase** (Postgres + PostGIS + Auth + Realtime) — banco e geofence
- **GitHub** transmonseg/transmonseg-seguranca (público)
- Dados ao vivo: **API Unitrac** (datalayer.portalunitrac.com)
- Rota: OSRM/Google · POI/zonas: Overpass, SABREN (favela), Fogo Cruzado
- Despertador (cron 1 min) chamando a API route do motor (a definir: cron-job.org / GitHub Actions)

## Pronto
- [x] Next.js inicializado + deps Supabase (@supabase/supabase-js, @supabase/ssr)
- [x] Repo conectado, primeiro push (branch main)
- [x] Banco: PostGIS + schema 001 (clientes, operadores, veiculos, bases, geofences, posicoes_atuais, alertas, eventos), RLS habilitado
- [x] Lib de conexão: admin (service_role, backend), browser e server (anon, RLS)
- [x] **Fase 1 (seed):** 2 clientes (Nutry 4096, Benassi 4586), 95+346 veículos, 1072 favelas do SABREN (geofence point-in-polygon testado). Coluna geofences.geom relaxada para `geography(geometry)` (aceita MultiPolygon: Rocinha/Alemão).
- [x] **Fase 2 (motor):** detectores puros (pânico, baú, jammer, excesso, parada_longa >=90min) com 29 testes Vitest; cliente Unitrac (filtro de frescor); migration 002 (parado_desde + fn_favela_em); API route POST `/api/motor` (x-motor-key). Testado ao vivo: 325 posições gravadas, 2 alertas jammer (Benassi), 401 sem chave, idempotente.

- [x] **Fase 3 (painel):** Tela de Segurança dark, resumo + alertas + frota multi-cliente + filtro; sem-comunicação tratado; build dinâmico.
- [x] **Polish do MVP:** (1) motor robusto (try/catch por cliente/veículo, timeout 20s, erros parciais) + detector de FAVELA (point-in-polygon, testado na Rocinha); (2) visual premium (centro de operações: métricas, barras por cliente, alertas com ícone, relógio ao vivo); (3) autonomia: `motor-loop.mjs` (60s) + `AutoRefresh` (tela revalida a cada 30s).

## Próximos passos
- [ ] Fase 4 — Deploy (USUÁRIO faz na Vercel; ver DEPLOY.md: 5 env vars + cron-job.org 1 min)
- [ ] Fase 5 — Auth + RLS (login operadores) → destrava Realtime
- [ ] FUTURO (visão do fundador): mapa com áreas de perigo desenhadas · API Google · dashboards de tiroteio · landing page
- [ ] Despertador (cron 1 min) chamando o motor
- [ ] Tela de Segurança (Realtime): alertas ativos, mapa, histórico
- [ ] Auth dos operadores + policies RLS por papel/cliente
- [ ] Detectores avançados (off-route OSRM, POI, score, encadeamento)

## Notas
- `.env.local` tem as chaves (gitignored, repo é público — nunca commitar).
- Migrations: `node --env-file=.env.local scripts/aplicar-migration.mjs <arquivo.sql>`
- Schema/detectores/fontes detalhados na memória do Claude (project_transmonseg_*).
