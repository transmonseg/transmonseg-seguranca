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

## Próximos passos
- [ ] Motor: API route que busca a Unitrac, roda os detectores e grava em alertas/posicoes_atuais
- [ ] Detector PARADA LONGA (>= 1h30 parado em qualquer lugar, sem exceção, pras 2 frotas) + coluna `parado_desde`
- [ ] Despertador (cron 1 min) chamando o motor
- [ ] Tela de Segurança (Realtime): alertas ativos, mapa, histórico
- [ ] Auth dos operadores + policies RLS por papel/cliente
- [ ] Detectores avançados (off-route OSRM, POI, score, encadeamento)

## Notas
- `.env.local` tem as chaves (gitignored, repo é público — nunca commitar).
- Migrations: `node --env-file=.env.local scripts/aplicar-migration.mjs <arquivo.sql>`
- Schema/detectores/fontes detalhados na memória do Claude (project_transmonseg_*).
