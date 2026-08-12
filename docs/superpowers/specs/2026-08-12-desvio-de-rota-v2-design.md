# Detector de Desvio de Rota v2 — reescrita completa (12/08)

## Contexto

Depois de ~2 meses de iterações (streak binário → placar acumulativo com
decaimento → modo teste com corredor+OSRM `/trip` → corredor como regra
primária), nenhuma versão do detector de desvio ficou boa o suficiente pra
confiar. O sistema acumulou ~15 sinais/regras empilhados (placar S1-S6/D1-D4,
`rumo_diverge`, `classe_viaria`, `saida_parada`, corredor só como confirmação,
6 iterações de modo teste) sem convergir. Decisão do usuário: **apagar tudo
relacionado a desvio de rota e recomeçar do zero**, com o design mais simples
possível que ainda funcione, indo direto pra produção (sem modo
teste/sombra).

Ver histórico completo em `docs/analise-desvio-raiz-2026-08-11.md` (mantido
como registro histórico, não como base do novo design) e na memória de
projeto `project_monitoramento_transmonseg` (fora do repo).

## Requisitos (na ordem em que o usuário os deu)

1. Carro se afastando de **todos** os clientes pendentes = desvio.
2. Carro entrando num caminho que não faz sentido pra nenhum cliente (rua
   estreita/sem saída) = desvio, baseado no **histórico real de trajetos da
   frota** — não numa regra hardcoded de classificação viária.
3. Nunca disparar desvio indo em direção a um cliente ou já dentro dele,
   mesmo que o caminho até lá seja uma rua rara/estreita.
4. Nunca disparar desvio com o carro já no cliente, mesmo se movendo
   (manobrando, estacionando).
5. Distância nunca em linha reta — sempre distância real seguindo a malha
   viária.
6. Voltando pra base é um caso legítimo, não pode ser lido como afastamento.
7. Sem roteirização/sequenciamento de paradas (nada de TSP/OSRM `/trip`) —
   só cálculo de distância real, sem tentar adivinhar a ordem de visita.
8. O mais simples e rápido de construir possível, dado que 2 meses de
   complexidade crescente não funcionaram.

## Por que não reaproveitar o que existe

- `verificarCorredor` (rota real + buffer por destino) é robusto, mas como
  regra PRIMÁRIA sem sequenciamento já foi tentado (11/08) e deu 380
  disparos em 66% da frota — depois que o veículo visita 1-2 paradas reais,
  a rota da origem "velha" até o PRÓXIMO destino não bate mais com o
  trajeto real. Corrigir isso exigiria `/trip` (proibido pelo requisito 7).
- As tabelas de célula (`corredor_celulas`/`corredor_celulas_veiculo`) já
  existem mas são só presença binária (visitou nos últimos 30 dias ou não)
  — não contam frequência, não servem pra "rua rara" sem extensão.
- `RAIO_CHEGADA_MIN_M`/`suspenderPorChegada` (raio de chegada, hoje 300m)
  já resolve boa parte dos requisitos 3 e 4 — reaproveitado como está.

## Arquitetura

Módulo novo `src/lib/desvio.ts` (funções puras, sem I/O) + tabela nova
`desvio_estado` (1 linha por veículo). Chamado direto do loop do motor em
`route.ts`, no lugar de todo o bloco antigo de desvio. Vai direto pra
`alertas` (tipo `desvio`) — sem modo sombra, sem modo teste.

**Apagado por completo**: `src/lib/detectores-teste.ts`,
`src/lib/placar-desvio.ts` (+ tabelas `placar_desvio`,
`placar_desvio_estado`, `placar_desvio_log`), `src/lib/classificacao-viaria.ts`,
`src/lib/corredor-verificacao.ts` (inclui `sequenciaOtimizadaOSRM`),
`src/lib/rastro-matching.ts` uso relacionado a desvio (mantido se usado só
pro desenho do rastro no mapa — não é usado pela detecção, então fica),
tabela `desvio_teste_estado`, colunas de desvio antigas em `posicoes_atuais`
(`desvio_streak`, `desvio_inicio`, `fora_tapete_streak`,
`divergencia_rumo_*`, `origem_celula`, `ultima_via_principal_em`). Regras
`afastando_de_tudo`/`rumo_diverge`/`saida_parada`/`classe_viaria` removidas
de `detectores.ts`/`route.ts`.

**Mantido sem alteração**: todos os outros tipos de alerta (pânico, baú,
jammer, velocidade, parada longa/anômala, favela, bypass_entrega), a
construção de `pendentes`/`destinos` (Unitrac + `romaneio_pontos` + bases +
`escala_pontos`), `entregas_presenca`, `RAIO_CHEGADA_MIN_M`/
`suspenderPorChegada`.

## Componentes

### 1. Distância real de rua (`src/lib/distancia-real.ts`)

```
buscarDistanciasReais(posAtual, destinos: {id, lat, lng}[]): Promise<Map<id, metros> | null>
```

- OSRM `/table` self-hosted (`OSRM_LOCAL_URL`, mesmo usado hoje por
  `corredor-verificacao.ts`), 1 chamada por veículo por ciclo com todos os
  destinos de uma vez (mesma técnica já validada em 11/08, ~1000s pra frota
  inteira/ciclo completo).
- Sem fallback público — se o self-hosted não responder, retorna `null`
  (ver Erros/Fail-open abaixo).
- Puramente uma função de infraestrutura (chamada de rede), sem lógica de
  decisão.

### 2. Sinal A — afastando de tudo (`avaliarAfastandoDeTudo` em `desvio.ts`)

```
avaliarAfastandoDeTudo(distanciasAtuais, distanciasAnteriores, streakAnterior): {streak, disparou, aproximandoAlgum}
```

- Pura. Compara `distanciasAtuais` vs `distanciasAnteriores` (mesmo
  conjunto de destinos — pendentes + centroide da base, igual já é montado
  hoje).
- `aproximandoAlgum = true` se a distância caiu (ficou mais perto) pra
  **qualquer** destino — usado pelo Sinal B (requisito 3).
- `disparou = true` quando **todos** os destinos cresceram de distância por
  3 ciclos seguidos (streak simples, sem decaimento — distância real é mais
  estável que linha reta, então o problema de zigue-zague que motivou o
  placar com decaimento deve ser bem menor; validar isso no teste de dia
  real antes de finalizar o parâmetro).

### 3. Sinal B — rua rara (`avaliarRuaRara` em `desvio.ts` + tabela de frequência)

- Tabela `celula_frequencia_cliente` (`cliente_id, celula, n_visitas,
  primeira_vez, ultima_vez`) — substitui/complementa
  `corredor_celulas`/`corredor_celulas_veiculo` pra desvio (as tabelas
  antigas continuam existindo se outra coisa as usar; a checar na
  implementação — provavelmente só desvio usava, aí são substituídas).
  Contagem **por cliente** (frota toda), não por veículo — pra rota nova
  atribuída hoje a 1 caminhão não disparar falso positivo por esse veículo
  especificamente nunca ter passado ali.
- **Backfill único** a partir de `posicoes_historico` (90 dias já
  existentes) rodando `celulaDe(lat,lng)` (reaproveita `src/lib/celulas.ts`
  como está) em cada ping histórico por cliente, antes de ligar a regra em
  produção — pra não começar contando do zero.
- `avaliarRuaRara(celulaAtual, nVisitasHistorico, aproximandoAlgum,
  streakAnterior): {streak, disparou}` — pura. Só avalia/incrementa streak
  se `nVisitasHistorico` abaixo de um piso (a definir com dado real, ex.
  ≤2) **e** `aproximandoAlgum === false` (requisito 3). 2 ciclos seguidos
  pra disparar (tolerância a 1 leitura de GPS ruim).

### 4. Supressão (requisitos 3, 4, 6)

- Reaproveita o gate já validado: dentro de `max(raioDestino,
  RAIO_CHEGADA_MIN_M=300m)` do destino pendente mais próximo OU dentro do
  polígono/raio da base → nenhum dos dois sinais é avaliado nem acumula
  streak nesse ciclo (equivalente a `suspenderPorChegada` hoje).
- Base sendo tratada como destino no cálculo de distância (já é assim hoje)
  cobre "voltando pra base" automaticamente pro Sinal A: aproximar da base
  conta como aproximar de um destino.

### 5. Fluxo no motor (`route.ts`)

Por veículo, por ciclo:
1. Monta `pendentes`/`destinos` (reaproveitado, sem mudança).
2. Se suspenso por chegada (perto de destino/base) → zera streaks, não
   avalia nada.
3. Senão: busca distâncias reais (`buscarDistanciasReais`). Se `null`
   (OSRM indisponível) → pula o ciclo pra desvio, não altera streak, loga
   aviso — não gera alerta nem falso "aproximando".
4. Avalia Sinal A. Avalia célula atual + Sinal B (usa `aproximandoAlgum` do
   Sinal A).
5. Se algum disparou → insere/atualiza `alertas` (tipo `desvio`, `motivo`
   distinguindo `afastando_geral` vs `rua_rara_frota`), mesmo pipeline de
   dedupe/escalação que os outros tipos de alerta já usam.
6. Atualiza `desvio_estado` (streaks, últimas distâncias) e incrementa
   `celula_frequencia_cliente` pra célula atual (mesmo fora do caminho de
   disparo — o histórico cresce sempre que o veículo anda).

## Erros / fail-open

- OSRM self-hosted fora do ar → pula avaliação do ciclo (sem alerta). Sem
  fallback pra linha reta (já provado ruidoso) nem pra OSRM público (mantém
  o sistema simples, conforme requisito 8). Risco aceito: uma janela de
  indisponibilidade do OSRM = zero detecção de desvio nessa janela — mesmo
  tipo de fail-open que `verificarCorredor` já usava.
- Falha ao gravar `celula_frequencia_cliente` não deve bloquear o resto do
  ciclo (best-effort, como o insert em `posicoes_historico` hoje).

## Testes / validação

- TDD nas funções puras (`avaliarAfastandoDeTudo`, `avaliarRuaRara`) —
  cenários sintéticos primeiro.
- Antes de considerar pronto pra produção real (mesmo indo direto sem modo
  sombra, a validação continua obrigatória antes do primeiro deploy):
  - Rodar contra um dia real de frota inteira (mede volume de ruído).
  - Rodar contra `casos_desvio_revisao` com `status_final='resolvido'`
    (mede recall — não pode perder nenhum caso confirmado como real).
  - Revisão visual manual pra qualquer caso ambíguo (instrução explícita já
    dada antes pelo usuário — nunca delegar esse julgamento a classificador
    automático).
- Prioridade explícita: recall sobre precisão — aceitar falso positivo,
  nunca perder desvio real.

## Fora de escopo (não decidido/adiado)

- Piso exato de `n_visitas` pro Sinal B e streaks (3 ciclos Sinal A, 2
  ciclos Sinal B) são pontos de partida, não valores finais — ajustar com
  dado real durante a validação, não no design.
- O que fazer com `corredor_celulas`/`corredor_celulas_veiculo` antigas se
  nada mais as usar (deletar ou deixar órfãs) — decidir na implementação
  depois de confirmar que nada além do desvio antigo as consome.
