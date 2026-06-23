# Plano de evolução — Transmonseg Central

Documento-mestre da próxima grande rodada. Cada fase é executada por um agente
Sonnet, com **propriedade de arquivos disjunta** (dois agentes nunca editam o mesmo
arquivo ao mesmo tempo). O orquestrador faz a verificação final (build + tela rodando).

Regras para todo agente: português com acentos; nunca usar travessão (—); repo é
PÚBLICO, nunca commitar segredo; Next 16 (middleware virou `proxy.ts`, ler
`node_modules/next/dist/docs/` antes de mexer em UI); detectores são funções PURAS
(sem I/O); validar com `npx vitest run` e `npx tsc --noEmit` antes de entregar.

---

## Achados da sondagem (base factual do plano)

- **Raio do cliente:** cada alvo do Unitrac tem `pontoraio` próprio. Em 201 alvos da
  Benassi: mín 50m, **mediana 100m**, p90 100m, máx 300m. Regra adotada:
  `raioCliente = max(pontoraio, 150)` (piso de 150m para tolerância de GPS e pátio).
- **Rastro (trajeto):** `GET /mapa_servicos/rastro/{cv}/{horas}` funciona até 96h
  (4 dias) → `{posicoes:[{lat,long}]}` (sem timestamp por ponto). Ex.: 2.974 pontos em 96h.
- **Paradas:** `GET /mapa_servicos/stops/{cv}/{horas}` → `{paradas:[{_data, localparada,
  tempoparada(min), latitude, longitude}]}`. Ex.: 35 paradas em 96h.
- **Posição rica:** `tipevnome` (último evento em texto), `posicentrada1..10` +
  `posicsaida1..4` (sensores), `posicvelocidade`/`posicvelocidadereal`, ignição, pânico,
  baú, `atraso`. `ult_rota` sempre vazio (não há rota planejada).
- **Benassi = `cod_user_unitrac` "4586"** (346 veículos). Nutry = "4096".

---

## FASE 1 — Núcleo de detecção (agente DETECT + agente MOTOR)

### 1A. Benassi: parada NO CLIENTE acima de 1h30 (alerta diferente) [PRIORIDADE]
Hoje `parada_longa` dispara em qualquer lugar fora da base aos 90min, igual para todos.
O caminhão da Benassi fica legitimamente ~1h30 dentro de um cliente. Mudança:

- **unitrac.ts**: novo helper `alvoMaisProximoQualquer(lat, lng, pontos)` que considera
  TODOS os alvos (feito OU pendente) e retorna `{ ponto, distM }`. (o atual
  `alvoPendenteMaisProximo` ignora os feitos).
- **detectores.ts**: novo detector `detectarParadaCliente(ctx)` e ajuste de `avaliar`:
  - ctx ganha `noCliente: boolean` e `ehBenassi: boolean`.
  - `noCliente` = parado e `distAlvoQualquerM <= max(raioAlvo, 150)`.
  - SE `ehBenassi && noCliente && paradoMin >= 90` → alerta `tipo: "parada_cliente"`,
    nível "atencao", score ~52, motivo "Parado no cliente há {dur}, confirmar o que
    está acontecendo". Este tipo TOCA O APITO (ver Fase 2/AlertaSonoro).
  - SE `ehBenassi && !noCliente && paradoMin >= 90` → `parada_longa` normal (atual).
  - Nutry (não Benassi) → `parada_longa` como hoje, sem mudança.
- **motor/route.ts**: calcular `ehBenassi = cliente.cod_user_unitrac === "4586"`;
  calcular `alvoMaisProximoQualquer` e `noCliente`; passar para `avaliar`.
- **Apito**: `parada_cliente` precisa soar mesmo sendo "atenção". Passar ao
  `AlertaSonoro` a lista de tipos sonoros (incluir `parada_cliente`) além dos críticos.
- Testes vitest cobrindo: Benassi no cliente +90min (dispara parada_cliente), Benassi
  fora do cliente +90min (parada_longa), Nutry no cliente +90min (parada_longa), <90min (nada).

### 1B. Parada anômala de verdade (a maior lacuna — análise §2/§6)
Detectar a parada CURTA e suspeita, não só 90min. Levanta a mão, não prova roubo.
- `detectarParadaAnomala`: parado N min (cidade ~12, estrada ~25 por velocidade
  sustentada/distância da base) fora de base, fora de cliente (raio do alvo) e fora de
  POI legítimo, com peso por hora (madrugada) e zona (favela/Baixada).
- POI check via Overpass (`amenity=fuel/restaurant/fast_food/...` raio ~80m) com cache
  em tabela `poi_cache`. Motor só consulta POI para candidatos (orçamento por ciclo).
- Persistência: só dispara após sustentar por >= 2 ciclos.

---

## FASE 2 — Ordem e prioridade dos sinais (agente DETECT/LAYOUT)
"Os avisos mais loucos (perdeu sinal) por último na barra de vermelho."
- Função `ordemSeveridade(tipo)` com ranking explícito:
  panico > bau > favela > tiroteio > parada_cliente/parada_anomala > desvio > excesso >
  **jammer/sinal por último**.
- A tela ordena os cards críticos e de atenção por esse ranking (hoje vêm sem ordem).
- `sem_comunicacao` continua cinza informativo na faixa colapsável do rodapé (já é assim).

---

## FASE 2.5 — Filtros por problema (lista + mapa) [CONCLUÍDA e verificada ao vivo]
"Filtros, tipo só desvio de rota etc, só com problema, pra ver isso no mapa e na lista."
Entregue: `FiltrosBar.tsx` (chips Desvio, Parada cliente, Parada longa, Tiroteio, Favela,
Jammer/Sinal, Excesso, Pânico, Baú + "Só com problema" + "Limpar"); estado na querystring
(`?tipos=...&problema=1`, preserva `cliente`); `page.tsx` filtra a fila e oculta operação/
concluídos no "Só com problema"; `/api/mapa` traz `tipo` do alerta ativo (LEFT JOIN LATERAL);
`MapaFrota` acende/apaga os pinos pelos mesmos filtros. Verificado no Benassi: 222 pinos →
7 (favela) / 3 (jammer) / 10 (só problema), batendo com o banco; zero erro de console.
Barra de filtros no topo da central, valendo nos DOIS lugares ao mesmo tempo:
- Chips por tipo: desvio, parada no cliente, parada longa, tiroteio, jammer/sinal, excesso,
  pânico, baú (toggle múltiplo). Reusa `ordemSeveridade`/ícones já existentes.
- Atalho "Só com problema": esconde os veículos ok (concluídos / em operação sem alerta).
- O filtro escolhido FILTRA a fila de alertas E acende/apaga os pinos do mapa da frota
  (estado compartilhado entre lista e `MapaFrota`; provavelmente sobe pra um wrapper client
  ou querystring `?tipos=desvio,tiroteio&problema=1`).
- Persistir a seleção (querystring) pra sobreviver ao auto-refresh de 30s.
- Mexe em `page.tsx` + `MapaFrota`/wrapper: roda SOZINHO depois que LAYOUT e MAP-UI terminarem
  (mesmos arquivos, não pode em paralelo).

## FASE 3 — Layout da tela (agente LAYOUT)
Hoje é uma coluna de 960px com scroll infinito. Virar um CENTRO DE OPERAÇÕES que usa a
largura da tela.
- Layout de duas colunas (desktop): ESQUERDA = fila de alertas (críticos/atenção,
  compactos, ordenados por severidade); DIREITA = mapa ao vivo + contexto (métricas,
  roubo de carga). Empilha em 1 coluna no mobile.
- Cards de alerta mais densos; "sem comunicação" e "concluídos" recolhidos.
- Manter design system dark premium. INVOCAR uma skill do taste-skill antes de mexer no visual.

---

## FASE 4 — Mapa de monitoramento estilo Unitrac (agentes MAP-API + MAP-UI) [GRANDE PEDIDO]
Clonar o "monitorar" do Unitrac: puxar placa, rastro de até 4 dias, paradas, telemetria,
todos os botões.
- **MAP-API (arquivos novos)**: `unitrac.ts` ganha `buscarRastro(cv, horas)`,
  `buscarStops(cv, horas)`, `buscarPosicaoUnica(cv)`. Rotas protegidas por sessão:
  `/api/rastro`, `/api/stops`, `/api/veiculo`.
- **MAP-UI (arquivos novos)**: página/aba `/monitoramento`:
  - Busca por placa (autocomplete da frota).
  - Clique no veículo → desenha o RASTRO (toggle 1 dia / 4 dias), marca as PARADAS com
    duração (popup tempoparada), painel de telemetria (velocidade, ignição, último
    evento `tipevnome`, sensores entrada/saída, alvos/entregas).
  - Botões estilo Unitrac: centralizar, seguir, rastro on/off, período, paradas on/off,
    ver alvos/rota, camadas de risco (favela/tiroteio/roubo de carga já existem).
- **Google Maps**: opção de basemap Google (Ruas/Satélite) quando houver
  `GOOGLE_MAPS_API_KEY`; sem a chave cai no CartoDB dark atual.

---

## FASE 5 — Google Maps API (transversal)
- Geocoding reverso JÁ está codado (usa a chave se existir, senão Nominatim).
- Adicionar tiles do Google ao mapa (basemap alternativo).
- Documentar ativação: GCP → ativar Geocoding + Maps JavaScript → billing/cartão →
  chave restrita por referer/IP + limite de cota. Pôr `GOOGLE_MAPS_API_KEY` no
  `.env.local` e no Vercel.

---

## FASE 6 — Desvio preciso por corredor OSRM (depois)
Da análise §1B: traçar rota base→alvos no OSRM, criar tubo de 300-500m, veículo fora do
tubo = desvio (independe da distância em linha reta ao alvo). Calcular 1x por viagem;
comparação posição×tubo é local (grátis). Eleva o desvio de "proxy bom" para "preciso".

---

## Execução por agentes (Sonnet)
Ordem com propriedade de arquivos disjunta para evitar conflito:
1. **Paralelo:** DETECT (`detectores.ts` + testes) · UNITRAC-LIB (`unitrac.ts` helpers) ·
   LAYOUT (`page.tsx` + cards + ordem dos sinais).
2. **Paralelo (após 1):** MOTOR (`api/motor/route.ts`) · MAP-API (rotas novas).
3. MAP-UI (componentes do mapa novos).
4. **Integração:** build completo + `vitest` + tela rodando (orquestrador verifica).
