# Transmonseg Central — Estado do projeto

Central de inteligência de risco multi-cliente da Transmonseg (detecção de desvio/roubo de carga).
Piloto: Nutry Max. Apresentação da ideia: https://transmonseg-seguranca.triforce-media.workers.dev

## Stack
- **Next.js** (App Router, TypeScript, Tailwind, src/) — frontend + motor (API routes)
- **Supabase** (Postgres + PostGIS + Auth + Realtime) — banco e geofence
- **GitHub** transmonseg/transmonseg-seguranca (público)
- Dados ao vivo: **API Unitrac** (datalayer.portalunitrac.com)
- Rota: OSRM/Google · POI/zonas: Overpass, SABREN (favela), Fogo Cruzado
- Despertador: pg_cron + pg_net chamando a API route do motor a cada **30s** (2x/min via pg_sleep, `scripts/dev/setup-cron-30s.mjs`)

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
- [x] **Fase 8 — Desvio "sem rota planejada" v4 (redesign completo, produção):** a Unitrac não fornece rota real, então o v1 (corredor OSRM sintético) e o v2 inicial (rumo por cone) foram **substituídos**. Ver `docs/plans/2026-07-06-desvio-sem-rota-design.md` (+ amendment v3) e `2026-07-06-desvio-sem-rota-plano.md`. Modelo atual, 3 camadas:
  - **Camada 1 (comportamental):** afastando-se de **TODOS** os destinos legítimos (alvos pendentes + bases) por N ciclos — v4 voltou a exigir afastamento de todos (não só do mais próximo) após observação ao vivo. Guarda anti-teleporte (>150km/h implícito congela o streak). Faixa local 2,5-25km (acima é deslocamento interurbano).
  - **Camada 2 (tapete histórico, `corredor_celulas`, migration 010):** grade de células ~100m por cliente, populada todo ciclo do motor (interpolação a cada ~80m) + bootstrap inicial (`scripts/bootstrap-corredor.mjs`, rastro de 96h). Fora do tapete = crítico direto no 2º ciclo. Em produção: **152k+ células** acumuladas.
  - **Camada 3 (score de risco de área, `calcularRiscoArea`):** favela + tiroteio recente (Fogo Cruzado, <1,5km) + roubo de carga do CISP + corredor rodoviário de risco + fator horário multiplicativo — nunca dispara sozinho, só acelera a escalada do gatilho comportamental.
  - **Perfil estatístico por rota (`rota_perfil`, migration 011, EWMA):** ~~baseline de desvio perpendicular normal POR destino específico~~ **substituído em 08/07/2026** (ver bullet abaixo) — tabela mantida (dado histórico), mas não é mais lida pelo detector.
  - Nível "atenção" **eliminado** — tudo que dispara vira crítico direto (pedido explícito).
  - `desvio_inicio` (jsonb, migration 010) grava o ponto de início real do desvio (não o ciclo do disparo); UI marca esse ponto + traça o trecho desviado no mapa.
  - Migrations 010/011 **aplicadas em produção** (verificado: tabelas + colunas presentes, dado real acumulando).
  - `rotas_cache`/`fora_corredor`/`lib/osrm.ts` (corredor sintético) removidos.

- [x] **Fluxo do operador (sistema operável, não só visualização):** cada alerta tem ações Reconhecer / Resolver / Falso positivo (`AcoesAlerta` + server actions em `(app)/acoes-alertas.ts`, grava `operador_id`). Reconhecer = assume e mostra "em atendimento" (continua em aberto). Falso positivo = encerra E silencia o tipo+veículo por 2h no motor (rótulo de treino). Motor trata 'reconhecido' como em aberto (não duplica) e respeita 'falso_positivo' recente. Tela busca 'ativo'+'reconhecido'. Validado E2E em produção.
- [x] **Fase 5 — Login + proteção de rotas (Auth Supabase):** a URL não é mais pública. `proxy.ts` (Next 16 renomeou middleware→proxy) protege todas as páginas (sem sessão → /login); `/api/mapa` valida sessão internamente. Login/cadastro/logout via server actions. Modelo: **central Transmonseg vê todas as frotas** (sem RBAC por cliente ainda). **Signup ABERTO** (decisão do produto): cria operador já confirmado e entra; fácil de trancar depois em `login/actions.ts`. Tela de login split premium (design system dark) + header com operador logado + Sair. Route groups: `(app)/` (central) vs `/login`. Validado E2E (puppeteer) em produção: redirect, cadastro, central, logout, re-login. Env vars já no Vercel.

- [x] **Roubo de carga no RJ (ISP-RJ, grátis):** dado público oficial por município, mensal. `lib/roubocarga.ts` (baixa CSV do ispdados.rj.gov.br, soma `roubo_carga` dos 12 meses mais recentes por `fmun_cod`, casa com malha municipal do IBGE por código, 92/92; cache 6h). `/api/roubo-carga` (GeoJSON coroplético + ranking). Mapa: camadas de risco num `LayersControl` (Favelas/Tiroteios/Roubo de carga toggleáveis); coroplético amarelo→vinho. `PainelRoubo` na vista lista (ranking com barras). Validado: 3.385 roubos 12m (Rio 1.687, D.Caxias 758, S.Gonçalo 320). **PRF não tem dado aberto de roubo de carga** (só acidentes/multas). Ponto exato é sigiloso (só gerenciadora paga).
- [x] **Caminhões no mapa + endereço em tempo real + Google geocode:** marcadores de veículo agora são ícone de caminhão (disco escuro colorido por status, críticos maiores). Motor geocoda também os veículos EM ALERTA em movimento (antes só parados; em movimento ficavam "Em deslocamento"). `geocodeReverso` usa Google Geocoding se `GOOGLE_MAPS_API_KEY` existe (limite 30/ciclo), senão Nominatim (limite 3). **Produção precisa de `GOOGLE_MAPS_API_KEY` (Vercel + .env.local) pro endereço pleno em tempo real.**
- [x] **Tiroteio próximo (tempo real) + apito:** detector no motor cruza cada veículo com tiroteios ATIVOS (últimas 3h, Fogo Cruzado, cache 2min): <1,5km crítico, <3km atenção (`detectarTiroteioProximo`, score 88). `AlertaSonoro` toca bip ao entrar novo alerta crítico (botão "Ativar apito", Web Audio). Tiroteios no mapa: janela 24h, "AGORA"=<3h (selo + idade no popup), refresh 90s. Roubo de carga suavizado (opacidade 0,25, escala clara). Cadeia validada ao vivo (veículos a 1,2km de tiroteios). 64 testes.
- [x] **Fase 6 — Tiroteios no mapa (Fogo Cruzado):** risco dinâmico além das favelas. `lib/fogocruzado.ts` (login email+senha → token JWT, cache 55min; busca ocorrências RJ últimos 3 dias, idState `b112ffbe-17b3-4ad0-8f2a-2038745d1d14`), `/api/tiroteios` (cacheada 10min, protegida por login), camada no `MapaFrota` (recentes 24h em laranja com anel branco, antigos âmbar; popup com bairro/data/motivo/vítimas; `?foco=rio`). Favelas com fill mais sutil (0.22). Validado ao vivo: 18 tiroteios reais. **Credenciais no .env.local; produção exige `FOGO_CRUZADO_EMAIL` e `FOGO_CRUZADO_SENHA` no Vercel.** Agora com testes (`fogocruzado.test.ts`).
- [x] **Roubo de carga — granularidade CISP:** de município para área de delegacia (CISP), mais preciso que o coroplético municipal anterior.
- [x] **Motor — performance e realtime:** round-trips de banco por veículo eliminados (estouro de CPU Fluid da Vercel); tick do motor passou a usar Supabase Realtime (telas buscam quando há dado novo, não polling cego); cron reagendado de 1min para 30s (`scripts/dev/setup-cron-30s.mjs`, 2x/min via pg_sleep); pool de conexão compartilhado + cache de bases/malha (60s); limpeza de `geocode_cache` (90 dias, crescia sem limite).
- [x] **Rastro no mapa:** matching com OSRM pra colar saltos de GPS na rua real (rejeita ajuste desproporcional, "tiro" pior que a reta); remove rajadas de pico de GPS; rastro do veículo focado acompanha o poll em tempo real (antes só buscava na seleção).
- [x] **Mapa v2 — split view real:** TODOS + SELECIONADOS lado a lado com divisor arrastável (`SplitDivider`, estilo Apple — clique ou arrasto, funde pra tela cheia na borda); `EscopoMapaSwitcher`. Ícones de veículo (quadrado+triângulo), paradas vermelhas, cores por status revisadas várias vezes.
- [x] **Filtros de monitor:** "ver apenas veículos selecionados" em Configurações (não persiste ativo entre sessões, por decisão); 2ª aba de filtro virou "foco por cliente" (não mais "crítico"); toasts e painel de eventos removidos.
- [x] **Camada 3 do desvio via tapete real (08/07/2026):** ver `docs/plans/2026-07-08-entrega-proximidade-e-desvio-tapete-design.md`/`-plano.md`. Trocou o cálculo por linha reta base→destino (`TRAJETO_PERPENDICULAR_LIMIAR_M`/perfil de rota, removidos) por "aproximando de um destino mas fora do tapete conhecido por 2 leituras seguidas" (`fora_tapete_streak`, migration 012) — achado real (TUK-0H45): a linha reta degenerava em distância crua quando a base fica dezenas de km distante, disparando em aproximação normal. Motivo da Camada 1 agora mostra fase/tempo aproximado, não só o número seco.
  - ~~Confirmação de entrega por proximidade~~ (mesmo plano, parte 1): implementada e revertida no mesmo dia (pedido do cliente). Migration 012 continua no banco (tabela `entregas_confirmacao_manual`, não destrutivo) mas motor não detecta mais e a UI não mostra mais nada. Se for retomar, reescrever do zero (código removido, não só desativado).
  - **Camada 3 (tapete) DESATIVADA no mesmo dia (09/07/2026):** achado ao vivo via grupo de WhatsApp da operação — virou metade do ruído de desvio (74 Camada 1 vs 75 Camada 3 em 6h), disparando/resolvendo a cada 2min nas mesmas placas de rota rural/serra (TTM-7C14, TTM-2G01, TUS-1A47 — Nova Friburgo/Teresópolis/Saquarema), onde o tapete ainda não tem cobertura suficiente. `CAMADA3_TAPETE_ATIVA = false` em `detectores.ts` desliga só o gatilho; motor continua computando/persistindo `fora_tapete_streak` (dado útil pra redesenhar o limiar, ex.: cobertura mínima por região). Camada 1 e Camada 2 intactas. Outros achados reais do mesmo grupo (pendente de investigação): `desvio_inicio` às vezes marca o ponto onde o veículo PAROU, não onde o afastamento realmente começou; polígonos de favela do IBGE (ex. FONTE SANTA/QUINTA LEBRÃO, Teresópolis, ~1,8km² cada) parecem desproporcionais visualmente e podem estar inflando "área de risco elevado" perto de zonas urbanas normais.

## Próximos passos (retomar aqui)
- [ ] **Fase 5b — RBAC por cliente (quando precisar):** cliente Nutry/Benassi logar e ver só a frota dele (policies RLS + claim de cliente). Hoje só central. Destrava Realtime full.
- [ ] Fase 7 — Dashboards/relatórios (muita informação visual).
- [ ] Fase 9 — Landing page.
- [ ] Melhorias pendentes: base da Nutry no terreno OSM real (hoje convex hull); `local` "Base" às vezes fica stale (COALESCE) — cosmético.
- [ ] Comandos remotos (sirene/bloqueio de motor) via portal Unitrac: descobertos via HAR, sessão expira rápido (precisa keep-alive) — ver [[project_transmonseg_comando_sirene_bloqueio]].

## Notas
- `.env.local` tem as chaves (gitignored, repo é público — nunca commitar).
- Migrations: `node --env-file=.env.local scripts/aplicar-migration.mjs <arquivo.sql>` (manual, auto-deploy não roda migration).
- 334 testes Vitest passando (10 arquivos) em 2026-07-08.
- Schema/detectores/fontes detalhados na memória do Claude (project_transmonseg_*).
