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
- [x] **Polish do MVP:** (1) motor robusto (try/catch por cliente/veículo, timeout 20s, erros parciais) + detector de FAVELA (point-in-polygon); (2) visual premium (centro de operações: métricas, barras por cliente, alertas com ícone, relógio ao vivo); (3) autonomia.
- [x] **Deploy AO VIVO:** https://transmonseg-seguranca.vercel.app — autônomo via **pg_cron + pg_net** (job `motor-1min`, motor roda a cada 1 min; região gru1/SP, maxDuration 60).
- [x] **Mapa (Leaflet + CartoDB dark):** toggle Lista|Mapa, abre enquadrando o estado; veículos por cor + popup; `?foco=base` enquadra nas bases. `MapaWrapper` (ssr:false).
- [x] **Áreas de risco — estado inteiro do RJ (1.641):** 1.072 SABREN (capital) + 569 IBGE Aglomerados Subnormais 2010 (resto do estado, `/api/favelas` cacheado, precisão ~2m).
- [x] **Bases = terreno real (polígono):** `06_bases_cluster.mjs` casa cluster de veículos parados com landuse do OSM (Benassi → CEASA-RJ; Nutry → convex hull fallback). Motor usa point-in-polygon. migration 004. Ver [[project_transmonseg_bases_cluster]].
- [x] **Bug crítico corrigido:** upsert gravava `geom` como POINT(lng,lng) → favela nunca detectava. Corrigido; favela voltou a funcionar.
- [x] **Fase 8 (parcial) — Desvio de rota FUNCIONANDO ao vivo:** sem rota traçada do Unitrac, a "rota" são os pontos de entrega (alvos). `detectarDesvio` só dispara em operação + fora da base + em movimento + com pendentes + **se afastando** (dist ao alvo pendente mais próximo cresceu >200m vs ciclo anterior — esse filtro mata os falsos positivos de viagem longa que se aproxima). >=5km afastando = crítico(72), >=2,5km = atenção(48). `unitrac.ts` (agruparPontosPorPlaca, distAlvoPendenteMaisProximoM, haversineM), `motor/route.ts` (dist atual vs anterior), `mapa` mostra a malha de pontos (azul). 49 testes. **Verificado em produção 23/06: TTL-2H39 12,4km e TUE-1C12 5,3km, ambos críticos se afastando.** OSRM/Google Routes fica pra refinamento futuro (rate limit a 441 veíc/min).

## Próximos passos (retomar aqui)
- [ ] **Fase 5 — Auth + RLS (PRIORIDADE: a URL é pública hoje, sem login).** Login operadores, policies RLS por papel/cliente → destrava Realtime.
- [ ] Fase 6 — Tiroteios (Fogo Cruzado) como camada/dashboard.
- [ ] Fase 7 — Dashboards/relatórios (muita informação visual).
- [ ] Fase 8 — Refino do desvio: confirmar afastamento com OSRM/Google Routes real (hoje é haversine ao alvo) + POI + score/encadeamento.
- [ ] Fase 9 — Landing page.
- [ ] Melhorias pendentes: base da Nutry no terreno OSM real (hoje convex hull); `local` "Base" às vezes fica stale (COALESCE) — cosmético.

## Notas
- `.env.local` tem as chaves (gitignored, repo é público — nunca commitar).
- Migrations: `node --env-file=.env.local scripts/aplicar-migration.mjs <arquivo.sql>`
- Schema/detectores/fontes detalhados na memória do Claude (project_transmonseg_*).
