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
- [x] **Fase 8 (parcial) — Desvio de rota FUNCIONANDO ao vivo (v2 verificada):** sem rota traçada do Unitrac, a "rota" são os pontos de entrega (alvos). Gatilho de criação exige 3 sinais: faixa LOCAL [2,5km a 25km] + **afastando** (>200m vs ciclo anterior) + **rumo do movimento OPOSTO ao alvo** (>90°). Acima de 25km é deslocamento interurbano, não desvio. Permanência via `foraDeRota` (frouxa, sem teto): um desvio = um único alerta, resolve só quando volta pra rota (anti-pisca). `unitrac.ts` (alvoPendenteMaisProximo, rumoGraus, difAngulo), `motor` (rumos + ciclo de vida próprio do desvio). 59 testes. Verificador `scripts/dev/verifica-desvio.mjs` cruza 3 evidências independentes (afastamento + rumo + **rota real OSRM**). **Verificado em produção 23/06 ~14:47: máx 9,9km, zero duplicados, deslocamentos 25-116km descartados.** Refino futuro: rota OSRM/Google no próprio motor (hoje rate limit a 441 veíc/min impede no ciclo de 1 min).

- [x] **Fluxo do operador (sistema operável, não só visualização):** cada alerta tem ações Reconhecer / Resolver / Falso positivo (`AcoesAlerta` + server actions em `(app)/acoes-alertas.ts`, grava `operador_id`). Reconhecer = assume e mostra "em atendimento" (continua em aberto). Falso positivo = encerra E silencia o tipo+veículo por 2h no motor (rótulo de treino). Motor trata 'reconhecido' como em aberto (não duplica) e respeita 'falso_positivo' recente. Tela busca 'ativo'+'reconhecido'. Validado E2E em produção.
- [x] **Fase 5 — Login + proteção de rotas (Auth Supabase):** a URL não é mais pública. `proxy.ts` (Next 16 renomeou middleware→proxy) protege todas as páginas (sem sessão → /login); `/api/mapa` valida sessão internamente. Login/cadastro/logout via server actions. Modelo: **central Transmonseg vê todas as frotas** (sem RBAC por cliente ainda). **Signup ABERTO** (decisão do produto): cria operador já confirmado e entra; fácil de trancar depois em `login/actions.ts`. Tela de login split premium (design system dark) + header com operador logado + Sair. Route groups: `(app)/` (central) vs `/login`. Validado E2E (puppeteer) em produção: redirect, cadastro, central, logout, re-login. Env vars já no Vercel.

- [x] **Roubo de carga no RJ (ISP-RJ, grátis):** dado público oficial por município, mensal. `lib/roubocarga.ts` (baixa CSV do ispdados.rj.gov.br, soma `roubo_carga` dos 12 meses mais recentes por `fmun_cod`, casa com malha municipal do IBGE por código, 92/92; cache 6h). `/api/roubo-carga` (GeoJSON coroplético + ranking). Mapa: camadas de risco num `LayersControl` (Favelas/Tiroteios/Roubo de carga toggleáveis); coroplético amarelo→vinho. `PainelRoubo` na vista lista (ranking com barras). Validado: 3.385 roubos 12m (Rio 1.687, D.Caxias 758, S.Gonçalo 320). **PRF não tem dado aberto de roubo de carga** (só acidentes/multas). Ponto exato é sigiloso (só gerenciadora paga).
- [x] **Caminhões no mapa + endereço em tempo real + Google geocode:** marcadores de veículo agora são ícone de caminhão (disco escuro colorido por status, críticos maiores). Motor geocoda também os veículos EM ALERTA em movimento (antes só parados; em movimento ficavam "Em deslocamento"). `geocodeReverso` usa Google Geocoding se `GOOGLE_MAPS_API_KEY` existe (limite 30/ciclo), senão Nominatim (limite 3). **Produção precisa de `GOOGLE_MAPS_API_KEY` (Vercel + .env.local) pro endereço pleno em tempo real.**
- [x] **Tiroteio próximo (tempo real) + apito:** detector no motor cruza cada veículo com tiroteios ATIVOS (últimas 3h, Fogo Cruzado, cache 2min): <1,5km crítico, <3km atenção (`detectarTiroteioProximo`, score 88). `AlertaSonoro` toca bip ao entrar novo alerta crítico (botão "Ativar apito", Web Audio). Tiroteios no mapa: janela 24h, "AGORA"=<3h (selo + idade no popup), refresh 90s. Roubo de carga suavizado (opacidade 0,25, escala clara). Cadeia validada ao vivo (veículos a 1,2km de tiroteios). 64 testes.
- [x] **Fase 6 — Tiroteios no mapa (Fogo Cruzado):** risco dinâmico além das favelas. `lib/fogocruzado.ts` (login email+senha → token JWT, cache 55min; busca ocorrências RJ últimos 3 dias, idState `b112ffbe-17b3-4ad0-8f2a-2038745d1d14`), `/api/tiroteios` (cacheada 10min, protegida por login), camada no `MapaFrota` (recentes 24h em laranja com anel branco, antigos âmbar; popup com bairro/data/motivo/vítimas; `?foco=rio`). Favelas com fill mais sutil (0.22). Validado ao vivo: 18 tiroteios reais. **Credenciais no .env.local; produção exige `FOGO_CRUZADO_EMAIL` e `FOGO_CRUZADO_SENHA` no Vercel.**

## Próximos passos (retomar aqui)
- [ ] **Fase 5b — RBAC por cliente (quando precisar):** cliente Nutry/Benassi logar e ver só a frota dele (policies RLS + claim de cliente). Hoje só central. Destrava Realtime.
- [ ] Fase 7 — Dashboards/relatórios (muita informação visual).
- [ ] Fase 8 — Refino do desvio: confirmar afastamento com OSRM/Google Routes real (hoje é haversine ao alvo) + POI + score/encadeamento.
- [ ] Fase 9 — Landing page.
- [ ] Melhorias pendentes: base da Nutry no terreno OSM real (hoje convex hull); `local` "Base" às vezes fica stale (COALESCE) — cosmético.

## Notas
- `.env.local` tem as chaves (gitignored, repo é público — nunca commitar).
- Migrations: `node --env-file=.env.local scripts/aplicar-migration.mjs <arquivo.sql>`
- Schema/detectores/fontes detalhados na memória do Claude (project_transmonseg_*).
