# Fallback automático de mapa quando a cota do Google estoura

**Data:** 2026-09-08
**Status:** aprovado pelo usuário, indo para plano

## Contexto

Incidente real 08/09 (grupo WhatsApp "DESVIO DE ROTA", 15:39-15:57): mapa da Central
parou de carregar ("Oops! Something went wrong"), operadores reportaram como "erro de
banco de dados". Investigação (console do navegador ao vivo) achou a causa real:

```
Maps Demo Key limit reached: Your daily quota for Maps JavaScript 2D has been met.
```

`NEXT_PUBLIC_GOOGLE_MAPS_API_KEY` (usada em `src/app/(app)/central-v2/MapaLeafletV2.tsx`,
apesar do nome do arquivo é 100% `@react-google-maps/api`, não Leaflet) roda como "Demo
Key" — nunca teve billing vinculado no Google Cloud (mesmo achado de 31/07 sobre a
Geocoding API nessa mesma chave, ver `[[project_monitoramento_transmonseg_romaneio_vs_unitrac]]`
na memória). Backend/banco/alertas funcionaram normal o tempo todo — confirmado pelos
próprios prints do incidente (contagem de alertas e veículos corretos, só o tile do mapa
não renderizava).

**Pesquisa de alternativas (mesma sessão) descartou "trocar de provedor pago":** Google,
MapTiler, Stadia Maps e CARTO têm todos a mesma cláusula — tier grátis não cobre uso
comercial/asset-tracking (CARTO cita "asset-tracking" literalmente). Não existe SaaS de
mapa com tier grátis liberado pra uma empresa que vende monitoramento de frota a
clientes. A única exceção real é dado aberto self-hospedado (OpenStreetMap, licença
ODbL permite uso comercial — só os SERVIDORES DE TILE compartilhados deles pedem pra
uso pesado se auto-hospedar, não o dado em si).

**Decisão explícita do usuário**: não tentar contornar/burlar a cota do Google (chaves
múltiplas, cache de tile fora do serviço deles, etc.) — isso violaria os termos de uso e
arrisca banimento total da chave/projeto, pior que a situação atual. Vincular billing
(crédito de US$200/mês do Google, provavelmente cobre o volume real sem gerar cobrança)
seguido de um fallback automático pra quando mesmo assim a cota estourar (ex.: pico de
uso, mudança de política do Google) é a direção aprovada.

## Decisão 1 — Google continua sendo o provedor padrão

Nenhuma mudança no dia a dia normal: `MapaLeafletV2.tsx` continua sendo Google Maps JS,
com o tema escuro (`DARK_STYLES`) e o toggle satélite/rua exatamente como hoje. O
trabalho deste documento é o que acontece quando esse caminho falha, não substituí-lo.

## Decisão 2 — Detecção fica no cliente (só o navegador consegue ver o erro)

Pesquisado: `gm_authFailure` (callback global documentado do Google) **não dispara**
para erro de cota, só para falha de autenticação de chave. Não existe evento oficial
pra "cota estourou". A detecção confiável combina dois sinais, ambos só observáveis
dentro do navegador que está renderizando o mapa:

1. Interceptar `console.error` filtrando por padrão conhecido (regex cobrindo pelo
   menos `/Demo Key limit reached/i`, `/BillingNotEnabledMapError/i`,
   `/ApiNotActivatedMapError/i`, `/quota/i` — a lista de `error-messages` documentada
   pelo Google tem mais alguns códigos relacionados a billing/cota que valem cobrir).
2. `MutationObserver` no container do mapa observando o texto injetado pelo próprio
   Google ("Oops! Something went wrong" / variantes localizadas) como sinal secundário,
   caso o console não capture (ex.: erro em worker/iframe interno do SDK).

Qualquer um dos dois dispara `onQuotaExceeded()`.

## Decisão 3 — Estado do fallback é coordenado pelo backend, não por cliente

Sem coordenação, cada aba de operador (Ana, Erica, Natália, etc.) descobriria o erro
independentemente e cada uma tentaria se recuperar sozinha — inclusive testando o
Google de novo em paralelo, o que gastaria mais cota bem no momento em que ela já
estourou. Design escolhido:

- Tabela nova `mapa_provider_estado` (linha única, tipo singleton): `provider`
  (`'google' | 'fallback'`), `quota_excedida_em`, `proxima_tentativa_em`,
  `atualizado_por` (identifica qual sessão/operador reportou).
- Quando um cliente detecta o erro (Decisão 2), faz `POST /api/mapa-provider` com
  `{evento: "quota_excedida"}`. O backend grava `provider='fallback'`,
  `proxima_tentativa_em = now() + 20min` (ponto médio da janela de 15-30min aprovada).
- O componente de mapa já lê esse estado a cada ciclo de 30s de polling que TODA tela
  da Central já faz hoje (mesmo padrão de `MonitorV2.tsx`, sem endpoint/intervalo novo)
  — quando `provider='fallback'`, troca pro mapa OSM (Decisão 4) instantaneamente pra
  TODOS os operadores ao mesmo tempo, sem exigir F5.

> **Correção pós-implementação (revisão final da branch):** o último bullet acima
> **não** foi o que a implementação real fez. Em vez de dobrar no polling existente do
> `MonitorV2`, foram criados um endpoint dedicado (`/api/mapa-provider`) **e** um
> segundo `setInterval` de 30s próprio dentro de `MapaComFallback.tsx`. Desvio
> deliberado: manter `MapaComFallback` um drop-in de fato (1 linha de mudança em
> `MonitorV2.tsx`, mesma assinatura de Props de `MapaLeafletV2`) em vez de espalhar o
> estado do mapa pelo pipeline de dados do monitor. **Custo aceito:** dobra o polling
> de banco por aba aberta, e cada `GET` abre/fecha um `pg.Pool` novo — com 5
> operadores isso é da ordem de ~14 mil ciclos de conexão por dia. Se isso virar
> problema de carga, o caminho é um pool de módulo reutilizado (ou dobrar no polling
> do monitor, como a decisão original dizia), não reverter o drop-in.
>
> **Correção pós-implementação (mesma revisão):** a coluna `atualizado_por` prevista
> aqui foi esquecida na migração `075` e adicionada depois pela `076`
> (`scripts/migrations/contabo/076_mapa_provider_estado_atualizado_por.sql`). Ela
> existe no banco mas ainda **não é preenchida** — a rota não tem identificação de
> operador disponível para gravar.

## Decisão 4 — Fallback de mapa de rua: OSM self-hospedado via PMTiles + MapLibre

Rejeitado: apontar pros servidores públicos `tile.openstreetmap.org` (violaria a
política deles pra uso comercial pesado, acesso pode ser cortado sem aviso). Rejeitado
também: montar um servidor de renderização ao vivo (`mod_tile`+`renderd`+import
completo em PostGIS) — processo pesado, novo serviço de longa duração pra manter no
Contabo, overkill pro objetivo (mapa só precisa mudar raramente, não precisa re-renderizar
a cada request).

**Escolhido**: gerar um único arquivo estático `.pmtiles` (formato
[Protomaps](https://protomaps.com), tiles vetoriais, servido por HTTP range-request —
o Caddy já instalado no Contabo serve isso nativamente como arquivo estático, sem
processo novo rodando) cobrindo só a região onde a frota opera (RJ metro + Campos dos
Goytacazes, não o mundo — bounding box a definir no plano a partir dos dados reais de
`posicoes_historico`). Build via `planetiler` (ferramenta open-source, roda uma vez ou
periodicamente como job batch, não como serviço) a partir do extrato OSM da região.
Renderização client-side via `maplibre-gl` (não precisa de `react-leaflet`, que já
existe no projeto mas serve outro propósito hoje — `MapaMonitor.tsx`/`MapaFrota.tsx` —
ver Decisão 6).

**Tema escuro nativo**: ao contrário do CSS-filter-invert (gambiarra comum em raster),
tile vetorial permite estilo dark de verdade via JSON de estilo do MapLibre — mais
fiel ao visual atual do que a alternativa raster.

## Decisão 5 — Fallback de satélite: Sentinel-2 self-hospedado, baixa resolução

Usuário confirmou explicitamente que quer essa camada mesmo sabendo da limitação de
resolução (~10m/pixel, não mostra rua/veículo individual — só mancha urbana/vegetação/
relevo). Fonte: Sentinel-2 L2A (ESA Copernicus, aberto, licença permite uso comercial).

Processo (batch, não ao vivo):
1. Baixar cenas Sentinel-2 mais recentes com baixa cobertura de nuvem pra área de
   interesse (mesma bounding box da Decisão 4).
2. Mosaico + composição true-color via GDAL.
3. Tiles estáticos (XYZ, só as zoom levels realmente usadas pelo mapa — não a pirâmide
   completa 0-20) servidos como arquivo estático pelo Caddy, mesmo padrão da Decisão 4.
4. Atualização periódica (trimestral é suficiente — não é dado operacional, é só
   referência visual pro período raro de fallback).

**Escopo explicitamente Fase 2** (ver Decisão 8) — não bloqueia a Fase 1, que já resolve
o incidente real (mapa de rua nunca mais quebra).

## Decisão 6 — Toggle SAT/rua durante fallback é troca de biblioteca de mapa, não de camada

Nuance técnica já sinalizada ao usuário antes de aprovar: hoje SAT/rua é um
`mapTypeId` dentro do MESMO componente Google. No fallback, rua = MapLibre+PMTiles,
satélite = raster estático (Decisão 5) — **tecnicamente podem ser a mesma stack**
(MapLibre também renderiza raster), então SAT no modo fallback é só trocar a fonte de
tile dentro do MESMO componente MapLibre, não trocar de biblioteca de novo. Simplifica:
existem só 2 implementações de mapa no total (Google normal / MapLibre fallback com 2
fontes de tile), não 3.

## Decisão 7 — Retry coordenado, não um teste por aba

A cada ciclo em que `provider='fallback'` E `now() >= proxima_tentativa_em`, **um único**
cliente (o primeiro a rodar seu ciclo de 30s depois desse horário — sem eleição
explícita, race condition aceitável aqui: pior caso são 2 cliente tentando no mesmo
segundo, não um problema real) monta uma instância oculta/não visível do componente
Google real e tenta carregar. Sucesso → `POST /api/mapa-provider {evento:
"google_recuperado"}`, backend grava `provider='google'`, todos os operadores voltam
pro Google no próximo ciclo de 30s. Falha → grava nova `proxima_tentativa_em = now() +
20min`, mesmo ciclo se repete.

Frequência de 20min (dentro da janela 15-30min aprovada) escolhida pra equilibrar
"volta rápido quando o Google normaliza" com "não gasta cota de novo tentando toda
hora" — num dia inteiro de fallback (pior caso), são ~40-50 tentativas extras, muito
abaixo de qualquer teto razoável de cota mesmo se cada tentativa contasse como load
cheio.

> **Correção pós-implementação (revisão final da branch):** a suposição de "pior caso
> são 2 clientes tentando no mesmo segundo" está ERRADA para o código que foi
> escrito. `proxima_tentativa_em` só avança quando o probe **termina**, não quando
> começa — então a janela vulnerável não é "o mesmo segundo", é a **duração inteira do
> probe**: 5s no caminho de sucesso, até 15s no caminho de falha (ver `ProbeRetry` em
> `MapaComFallback.tsx`). Toda aba de operador que rodar seu ciclo de 30s dentro dessa
> janela vê o mesmo estado vencido e monta seu próprio probe oculto do Google. Pior
> caso real: **~N carregamentos simultâneos do Google Maps por ciclo de retry, onde N
> é o número de operadores online** — com 5 operadores, ~5, não 1.
>
> Isso continua **aceito** (raro: só durante fallback, a cada 20min; e o custo
> absoluto de ~5 loads é irrelevante perto do volume normal da Central). Mas a
> caracterização honesta não é mais "quase nunca acontece" — é "acontece toda vez que
> houver operadores suficientes online durante o retry". Resolver de verdade exigiria
> eleição real, ex.: um `UPDATE ... SET proxima_tentativa_em = <novo> WHERE id = 1 AND
> proxima_tentativa_em = <valor lido>` condicional, e só o cliente cujo UPDATE afetou
> 1 linha monta o probe. Não feito nesta fase — documentação errada é pior que a race
> em si, então a suposição fica corrigida aqui.

## Decisão 8 — Fases de entrega

- **Fase 1** (resolve o incidente real, prioridade): Decisões 1-4, 6 (só a parte
  MapLibre+OSM), 7. Mapa de rua nunca mais quebra por cota; satélite indisponível
  durante o fallback raro (aceitável — o incidente real de 08/09 foi sobre o mapa de
  rua sumir inteiro, essa fase já cobre isso).
- **Fase 2** (completude visual): Decisão 5, camada satélite Sentinel/Landsat.

## Decisão 9 — achado durante a investigação: CARTO e hotlink Google em outras 2 telas

`MapaMonitor.tsx`/`MapaFrota.tsx` (react-leaflet, telas separadas da Central) usam hoje
`https://{s}.basemaps.cartocdn.com/dark_all/...` sem registro (mesmo problema de ToS
que motivou este documento — CARTO proíbe uso comercial/asset-tracking no tier grátis)
e, quando `NEXT_PUBLIC_GOOGLE_MAPS_API_KEY` está setada (está, em produção),
`https://mt1.google.com/vt/lyrs=y&x={x}&y={y}&z={z}` como satélite — **hotlink direto
ao tile interno do Google, sem API/SDK/chave real nenhuma**, mais arriscado que a Demo
Key (sem aviso de erro, pode ser bloqueado silenciosamente a qualquer momento).

Usuário aprovou incluir a correção no escopo deste plano (não era o incidente
original, mas reaproveita a mesma infra `rj.pmtiles`/Caddy dos Tasks 6-7). Satélite
dessas 2 telas é **removido sem substituto** até a Fase 2 — trocar por outro provedor
"grátis" (Esri etc.) só trocaria um risco de ToS por outro, o problema que esta
investigação inteira existe pra evitar. Ver plano de implementação, Task 11.

## Fora de escopo

- Migrar `MapaMonitor.tsx`/`MapaFrota.tsx` (já usam `react-leaflet`/OSM hoje, por outro
  motivo — não fazem parte deste incidente, não tocar).
- Vincular billing no projeto Google (ação externa do usuário no Console, fora do
  escopo de código) — reduz a FREQUÊNCIA do fallback disparar, mas o fallback em si
  deve existir independentemente, já que "nunca mais estoura cota" não é uma garantia
  que dá pra fazer só com billing (pico de uso, mudança de política do provedor, etc.).
- Réplica deste mecanismo no repo `MONITORAMENTO TEMP` — esse repo foi removido de
  produção em 27/08 (só `transmonseg-definitivo` roda hoje, confirmado nesta mesma
  sessão), não precisa mais do padrão de replicar mudança nos dois repos.
