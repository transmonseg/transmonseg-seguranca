# Transmonseg Central — Plano de Implementação

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development para implementar tarefa-a-tarefa. Cada tarefa termina com VERIFICAÇÃO (inclui ver a tela no Chrome quando for visual) e só é aceita após o orquestrador testar.

**Goal:** Construir a central de inteligência de risco multi-cliente da Transmonseg: detecta desvio/roubo de carga em tempo real e mostra numa tela que o operador vigia.

**Architecture:** Next.js (App Router) hospeda a Tela de Segurança e o motor (API route). Um despertador (cron 1 min) chama o motor, que busca a Unitrac, roda os detectores e grava no Supabase (Postgres + PostGIS). A tela lê via Realtime e atualiza no instante.

**Tech Stack:** Next.js 15 + TypeScript + Tailwind · Supabase (Postgres/PostGIS/Auth/Realtime) · API Unitrac · OSRM/Overpass/SABREN/Fogo Cruzado · Vitest.

## Global Constraints
- **Repo é PÚBLICO:** nunca commitar `.env.local`; segredos só via variável de ambiente; `service_role` só no backend.
- **Design:** dark premium (fundo `#0a0a0a`, cards `#141414`, accent navy `#9fb3ce`, fonte Geist), ícones SVG (NUNCA emoji), seguir a apresentação `transmonseg-seguranca.triforce-media.workers.dev`.
- **Copy:** português correto com acentos; NUNCA usar travessão (—).
- **Custo:** tudo no free tier (Supabase/Vercel grátis).
- **Unitrac:** usar `posicoes/N/N` e SEMPRE filtrar `atraso` baixo (dado fresco) antes de avaliar.
- **Verificação visual obrigatória:** toda tarefa de UI termina com o agente rodando o app e tirando screenshot no Chrome headless (`chrome --headless --screenshot`) e o orquestrador conferindo a imagem.
- **Não mexer** no painel teste (Cloudflare painel-frotas) nem na apresentação.
- Migrations: `node --env-file=.env.local scripts/aplicar-migration.mjs <arquivo.sql>`.

---

## FASE 0 — Fundação ✅ (feita)
Next.js + git/push · PostGIS + schema 001 (clientes, operadores, veiculos, bases, geofences, posicoes_atuais, alertas, eventos) · lib Supabase (admin/browser/server). Ver `ESTADO.md`.

---

## FASE 1 — Dados base (seed) — MULTI-CLIENTE (Nutry + Benassi)
Objetivo: os DOIS clientes (Nutry e Benassi), suas frotas e as favelas do RJ dentro do banco, visíveis numa página de debug. A API Unitrac é aberta; pega cada frota pelo `cod_user_unitrac` (Nutry 4096, Benassi 4586).

### Tarefa 1.1 — Seed dos clientes (Nutry + Benassi) e base
- **Arquivos:** Create `scripts/seed/01_clientes.mjs`
- **Fazer:** inserir em `clientes`: Nutry (`nome='Nutry Max'`, `cod_user_unitrac='4096'`, `empresa_cod_unitrac='722'`) e Benassi (`nome='Benassi'`, `cod_user_unitrac='4586'`, `empresa_cod_unitrac=null`). Inserir em `bases` a base da Nutry "Penha Circular" (lat -22.8151, lng -43.2779, raio 250) via `ST_SetSRID(ST_MakePoint(lng,lat),4326)::geography`. (Base da Benassi: desconhecida por ora, deixar sem base.) Idempotente (`on conflict (cod_user_unitrac) do nothing`).
- **Verificação:** rodar; imprime "2 clientes, 1 base". Query confirma.
- **Aceite:** os dois clientes e a base da Nutry existem, sem duplicar ao rodar 2x.

### Tarefa 1.2 — Importar as frotas (Nutry + Benassi)
- **Arquivos:** Create `scripts/seed/02_veiculos.mjs`
- **Fazer:** para CADA cliente (4096 e 4586): GET `datalayer.portalunitrac.com/veiculos/masn/{cod}`, mapear (cv, placa, gvn=grupo), inserir em `veiculos` ligados ao cliente certo. Idempotente por (cliente_id, cv).
- **Verificação:** rodar; imprime nº por cliente (Nutry ~95, Benassi ~346). Query `select cliente_id, count(*) from veiculos group by cliente_id`.
- **Aceite:** as duas frotas no banco, ligadas ao cliente correto.

### Tarefa 1.3 — Importar favelas do SABREN como geofences
- **Arquivos:** Create `scripts/seed/03_favelas.mjs`
- **Fazer:** GET o GeoJSON do SABREN (`pgeo3.rio.rj.gov.br/.../FeatureServer/13/query?where=1=1&outFields=nome,bairro,complexo&returnGeometry=true&outSR=4326&f=geojson`, paginando por `resultOffset` se preciso). Para cada feature, inserir em `geofences` (`tipo='favela'`, `fonte='sabren'`, `cliente_id=null` global, `geom` do polígono via `ST_GeomFromGeoJSON`, `meta` com nome/bairro/complexo). Idempotente.
- **Verificação:** rodar; imprime nº de favelas importadas. Query `select count(*) from geofences where tipo='favela'` (deve ser centenas). Testar um ponto conhecido dentro de favela com `ST_Contains`.
- **Aceite:** favelas no banco com geometria válida.

### Tarefa 1.4 — Página de debug (primeira visual)
- **Arquivos:** Create `src/app/debug/page.tsx`
- **Fazer:** Server Component que lê via `createClient` (server) e lista: contagem de clientes, veículos, favelas, e uma tabela com 10 veículos. Estilo dark básico (tokens globais).
- **Verificação (CHROME):** `npm run dev`, abrir `http://localhost:3000/debug` no Chrome headless, screenshot, conferir que mostra os números e a tabela.
- **Aceite:** página renderiza os dados reais do banco, sem erro.

---

## FASE 2 — Motor de detecção (v1)
Objetivo: uma API route que busca a Unitrac, roda os detectores básicos e grava posições/alertas.

### Tarefa 2.1 — Detectores como funções puras (com testes)
- **Arquivos:** Create `src/lib/detectores.ts`, Test `src/lib/detectores.test.ts` (Vitest)
- **Fazer:** funções puras que recebem o objeto de posição normalizado e retornam `{nivel, tipo, motivo, score}`: `detectarPanico`, `detectarBau`, `detectarJammer` (atraso alto + ignição), `detectarExcessoVelocidade`, `detectarParadaAnomala` (parado + fora de base/alvo — favela/POI entram na fase 6), e **`detectarParadaLonga`** (parado há >= 90 min em QUALQUER lugar, sem exceção — recebe `parado_min`; nível 'atencao', tipo 'parada_longa', motivo "Parado há Xh Ymin, contatar equipe"; vale para TODOS os clientes). Função `avaliar(pos, contexto)` que combina e devolve o alerta de maior severidade.
- **Verificação:** instalar vitest; escrever testes para cada função (casos: pânico=1 → crítico; atraso 30min+ignição → jammer; **parado 95min → parada_longa atenção**; parado 40min → nada). `npx vitest run` PASSA.
- **Aceite:** todos os testes verdes.

### Tarefa 2.1b — Coluna `parado_desde` (rastrear duração da parada)
- **Arquivos:** Create `scripts/migrations/002b_parado_desde.sql`
- **Fazer:** `alter table posicoes_atuais add column if not exists parado_desde timestamptz;`. O motor (2.4) seta: se o veículo está parado (vel 0) e continua na mesma posição (raio ~50m) do ciclo anterior, mantém `parado_desde`; se moveu, seta `parado_desde = now()`. A duração = `now() - parado_desde` alimenta `detectarParadaLonga`.
- **Verificação:** aplicar migration; coluna existe.
- **Aceite:** coluna criada.

### Tarefa 2.2 — Cliente Unitrac
- **Arquivos:** Create `src/lib/unitrac.ts`
- **Fazer:** `buscarPosicoes(cvs: string[])` (POST `mapa_servicos/posicoes/N/N`), `normalizar(p)` que converte os campos string em tipos (lat/lng number, ignicao bool, atraso int, panico/bau bool, parse de `datagps`). Marcar `fresco = atraso < 60`.
- **Verificação:** script temporário busca a frota da Nutry e imprime 3 posições normalizadas. Apagar o script depois.
- **Aceite:** retorna posições normalizadas corretas.

### Tarefa 2.3 — Geofence no banco (favela)
- **Arquivos:** Create `scripts/migrations/002_fn_geofence.sql`
- **Fazer:** função SQL `fn_favela_em(lat double, lng double) returns text` que retorna o nome da favela que contém o ponto (ST_Contains sobre geofences tipo favela) ou null.
- **Verificação:** aplicar migration; `select fn_favela_em(-22.87,-43.33)` retorna nome ou null coerente.
- **Aceite:** função existe e responde.

### Tarefa 2.4 — API route do motor
- **Arquivos:** Create `src/app/api/motor/route.ts`
- **Fazer:** handler POST (protegido por header secreto `x-motor-key` comparado a env `MOTOR_SECRET`): usa `createAdminClient`, carrega clientes ativos + seus veículos, busca Unitrac, normaliza, roda `avaliar`, faz upsert em `posicoes_atuais`, e para cada alerta: se já existe alerta ativo igual mantém, senão cria; resolve alertas que sumiram. Retorna `{processados, alertas_ativos}`.
- **Verificação:** `POST /api/motor` com o header; ver resposta e conferir linhas em `posicoes_atuais` e `alertas` no banco.
- **Aceite:** posições e alertas gravados; rodar 2x não duplica alerta ativo.

---

## FASE 3 — Tela de Segurança (v1)
Objetivo: a central que o operador vigia, em tempo real, bonita.

### Tarefa 3.1 — Tokens de design + layout base
- **Arquivos:** Modify `src/app/globals.css`, Create `src/app/(central)/layout.tsx`
- **Fazer:** tokens dark (cores da apresentação), fonte Geist, header da central. Ícones SVG inline (sem emoji).
- **Verificação (CHROME):** screenshot do layout, conferir dark premium consistente.
- **Aceite:** visual alinhado à apresentação.

### Tarefa 3.2 — Painel: resumo + alertas ativos + frota
- **Arquivos:** Create `src/app/(central)/page.tsx`, `src/components/AlertasAtivos.tsx`, `src/components/ResumoChips.tsx`, `src/components/FrotaGrid.tsx`
- **Fazer:** Server Component lê `posicoes_atuais` + `alertas` ativos do Supabase. Mostra chips (em rota/atenção/alerta), bloco de alertas ativos no topo (placa, motivo, desde), grid de veículos por nível. Reaproveitar a linguagem visual da apresentação.
- **Verificação (CHROME):** screenshot, conferir que lista os alertas e a frota com dados reais.
- **Aceite:** dados reais renderizados, layout fiel.

### Tarefa 3.3 — Mapa ao vivo
- **Arquivos:** Create `src/components/MapaFrota.tsx` (client component, react-leaflet)
- **Fazer:** mapa centrado no RJ com pino por veículo colorido pelo nível; favelas como polígonos vermelhos translúcidos. Instalar leaflet/react-leaflet.
- **Verificação (CHROME):** screenshot, conferir pinos e polígonos de favela no mapa.
- **Aceite:** mapa renderiza veículos e favelas.

### Tarefa 3.4 — Tempo real (Realtime)
- **Arquivos:** Create `src/components/RealtimeAlertas.tsx` (client), Modify a página
- **Fazer:** assinar canal Realtime das tabelas `alertas`/`posicoes_atuais`; ao mudar, refazer a query/atualizar a UI. Habilitar Realtime nas tabelas no Supabase.
- **Verificação (CHROME):** abrir a tela; rodar o motor (ou inserir alerta manual); confirmar que a tela atualiza sem reload.
- **Aceite:** mudança no banco reflete na tela em segundos.

---

## FASE 4 — Cron + Deploy
### Tarefa 4.1 — Deploy na Vercel (FEITO PELO USUÁRIO)
- **Quem faz:** o USUÁRIO conecta o repo e clica em deploy na Vercel. Claude NÃO faz o deploy.
- **Claude prepara:** garante que o projeto builda (`npm run build` ok), cria `vercel.json` se preciso, e entrega ao usuário a LISTA EXATA de env vars pra colar no painel Vercel (NEXT_PUBLIC_SUPABASE_URL, NEXT_PUBLIC_SUPABASE_ANON_KEY, SUPABASE_SERVICE_ROLE_KEY, MOTOR_SECRET, DATABASE_URL) com os valores corretos.
- **Verificação (CHROME):** após o usuário deployar, abrir a URL de produção e conferir.
- **Aceite:** app no ar; Claude guiou, usuário deployou.

### Tarefa 4.2 — Despertador (cron 1 min)
- **Fazer:** configurar cron-job.org (ou GitHub Actions schedule) para POST em `/api/motor` com o header secreto, a cada 1 min.
- **Verificação:** observar `alertas`/`posicoes_atuais` atualizando sozinhos; tela ao vivo mexendo.
- **Aceite:** motor roda autônomo a cada 1 min.

---

## FASE 5 — Auth + RLS
### Tarefa 5.1 — Login do operador (Supabase Auth)
- **Arquivos:** Create `src/app/login/page.tsx`, middleware de sessão.
- **Verificação (CHROME):** login na tela, screenshot do fluxo.
- **Aceite:** operador loga e acessa a central; sem sessão, redireciona pro login.

### Tarefa 5.2 — Operadores + policies RLS
- **Arquivos:** Create `scripts/migrations/003_rls.sql`
- **Fazer:** policies: admin/operador vê tudo; papel 'cliente' vê só o próprio `cliente_id`. Ligar `operadores.id` ao `auth.users`.
- **Verificação:** logar como operador de teste; confirmar que vê o esperado (e um 'cliente' vê só a sua frota).
- **Aceite:** isolamento por papel/cliente funciona.

---

## FASE 6 — Detectores avançados
### Tarefa 6.1 — Parada anômala com POI (Overpass)
Perdoa parada perto de posto/restaurante (cache por coordenada). Verificação: parada em posto não alerta; em rua ermo alerta.

### Tarefa 6.2 — Off-route (OSRM)
Reconstruir rota dos alvos e medir distância da posição à rota; alertar desvio sustentado. Verificação: rota fora do corredor alerta.

### Tarefa 6.3 — Favela e tiroteio no score
Entrar em geofence favela = crítico; somar Fogo Cruzado (tiroteio recente) ao risco do trecho. Verificação: veículo em favela acende crítico na tela.

### Tarefa 6.4 — Score composto + encadeamento + comparação entre veículos
Fundir sinais com pesos; sequência (jammer→desvio→favela) eleva; vários parados na mesma via = trânsito (suprime). Verificação: cenários de teste produzem o nível esperado.

---

## Ordem de execução
Fases em sequência. Dentro de cada fase, tarefas em ordem. Cada tarefa: subagente constrói + verifica (Chrome quando visual) + reporta; orquestrador testa e dá ok antes da próxima.
