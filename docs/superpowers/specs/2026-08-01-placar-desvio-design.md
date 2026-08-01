# Placar de Desvio — design

Data: 2026-08-01
Status: aprovado em conversa (casos reais de 01/08 como motivação)

## Problema

Os três detectores de desvio de rota (`afastando_de_tudo`, `rumo_diverge`,
`classe_viaria`) são alarmes binários independentes: cada um decide sozinho,
com a própria régua. Isso produz os dois defeitos reclamados pelo cliente no
mesmo dia (01/08, 16 casos revisados pelo operador):

- **Falso positivo**: um sinal fraco sozinho grita. 11 dos 16 casos de 01/08
  eram veículo em entrega normal (zigue-zague de última milha, parada perto
  de cliente, saída de entrega) marcados como desvio só por "rua estreita".
- **Alerta atrasado**: pra um sinal sozinho não gritar à toa, a régua é alta
  (`DESVIO_MIN_M = 2500`). Um desvio real a 40 km/h ganha ~4 min de vantagem.
  Os 3-4 casos reais de 01/08 avisaram tarde demais na visão do operador.

Ajustar régua por régua não resolve: é o desenho (binário e isolado) que
está errado. A indústria (gerenciadoras de risco BR, Geotab/Tive/project44)
soma camadas de evidência; ninguém usa alarme isolado.

## Decisão

Substituir os três detectores de desvio por um **placar acumulativo de
desvio** (0–100) por veículo, atualizado a cada ciclo do motor. Os
detectores atuais NÃO são apagados: viram **componentes** (entradas) do
placar. Alertas de outros tipos (favela, jammer, tiroteio, parada fora do
tapete, cerca virtual, saída não autorizada) ficam intocados.

Rollout em duas fases, mesmo padrão já usado 3x no projeto
(`CERCA_VIRTUAL_MODO`, `RUMO_DIVERGE_FILTRO_COMPORTAMENTAL_ATIVO`,
`CLASSE_VIARIA_FILTRO_RUMO_ATIVO`):

- **Fase 1 — sombra**: placar calculado e logado todo ciclo; UI e alertas
  não mudam em nada. Serve pra calibrar os pesos contra a rotulagem real do
  operador.
- **Fase 2 — valendo** (só após validação): nível amarelo aparece na
  Central como "observando" (sem apito); nível vermelho passa a ser O
  alerta de desvio, e os três branches antigos param de emitir alerta
  próprio.

## Sinais e pesos iniciais

Contribuição POR CICLO (~30s — `cron motor-tick-30s`; corrigido na revisão
pós-implementação de 01/08, este documento originalmente assumia ~1min).
Pesos iniciais são chute educado — a calibração da Fase 1 os ajusta contra
o gabarito. Todos os sinais somam só
sob os guards já existentes dos streaks de desvio (`pos.fresco`,
`!saltoImplausivel`, `!suspensoPorChegada`, `podeAvancarStreaksDesvio`,
`alvosDestinosDisponiveis`, `destinos.length > 0`).

| # | Sinal | Contribuição | Fonte (já existe?) |
|---|-------|--------------|--------------------|
| S1 | Distância mínima pra TODOS os destinos+base cresceu vs ciclo anterior (>100 m) | +8 | sim — mesmo cálculo do streak de afastamento |
| S2 | Rumo diverge de tudo (`divergenciaGrausAtual > 100°`) | +6 | sim — `divergenciaRumoMinima` |
| S3 | Fora do corredor de rota calculado (quando corredor conhecido) | +8 | sim — `verificarCorredor`/`dentroDoCorredor` |
| S4 | Célula de mapa nunca visitada por este veículo | +3 | sim — `corredor_celulas_veiculo` |
| S5 | Progresso do dia estagnado (nenhuma entrega confirmada há 45+ min com 2+ pendentes e veículo em movimento) | +2 | sim — rota do dia |
| D1 | Parou ≥2 min a ≤ raio+300 m de uma entrega nos últimos 10 min | −15 | parcial — `noCliente` usa raio exato; alargar leitura |
| D2 | Padrão de entrega: média ≤25 km/h com ≥2 paradas (velocidade 0 por ≥1 min) nos últimos 10 min | −6 | novo — janela sobre `posicoes_historico` já em memória |
| D3 | Rumo coerente (<100°) com entrega a <1500 m E distância pra ela caindo | −10 | parcial — sombra de rumo já existe; falta o gate de proximidade+aproximação |
| D4 | Dentro do corredor calculado | −6 | sim |

Achado de 01/08 que motiva o D3 composto: rumo coerente SOZINHO esconde
desvio real (RQV-6C22 apontava por coincidência pra entrega distante,
divergência 1,1°). Coerência só desconta com o trio direção+perto+aproximando.

## Fórmula

```
placar = clamp(0, 100, placar_anterior * 0.90 + soma_dos_sinais_do_ciclo)
```

- Decaimento de 10%/ciclo. **Correção pós-revisão-final (01/08)**: o ciclo
  real do motor é ~30s (`cron motor-tick-30s`), não ~1min como este
  documento assumia originalmente na tabela de sinais abaixo — decaimento
  efetivo é portanto ~0.81/min (dois ciclos de 0.90 por minuto), e o carro
  que voltou ao normal zera em ~5min (não ~10min), sem precisar de reset
  explícito. Com o piso adicionado na correção pós-revisão-final (abaixo de
  0.5 o placar zera de vez, `PLACAR_PISO_ZERAR` em `placar-desvio.ts`) isso
  agora é um zero de verdade, não só assintótico — decaimento puro nunca
  batia 0 sozinho antes dessa correção.
- `suspensoPorChegada` (chegou no destino): placar zera na hora.
- Histerese: amarelo liga em ≥40 e só desliga em <25; vermelho liga em ≥70
  e resolve com a mesma regra de resolução do desvio atual
  (`DESVIO_RESOLVE_M` / chegada). Evita pisca-pisca na fronteira.

Estado persistido junto dos streaks atuais (mesmo mecanismo
`anterior.divergencia_rumo_streak` etc. em `posicoes_atuais`): campo
`placar_desvio` (numeric) + `placar_desvio_componentes` (jsonb do último
ciclo, pra auditoria).

## Fase 1 — sombra e calibração

1. Motor calcula o placar todo ciclo e grava em
   `contexto.placar_desvio_sombra` dos alertas de desvio emitidos pelos
   detectores atuais (mesmo padrão do `rumo_coerente_sombra` já em produção)
   E numa tabela própria `placar_desvio_log` (veiculo_id, criado_em, placar,
   componentes jsonb, teria_amarelo, teria_vermelho) — quando placar > 0 OU
   há algum componente no ciclo (corrigido na revisão pós-implementação
   01/08: `placar > 0` sozinho escondia ciclos com desconto que segurou o
   placar em 0, e o ciclo de `zeradoPorChegada`), pra não inflar a tabela
   com frota parada sem nada acontecendo.
2. Rótulos: o clique do operador (Falso/Resolver) já alimenta
   `casos_desvio_revisao`. O join placar×rótulo é a base da calibração.
3. Backtest imediato: os 16 casos de 01/08 reprocessados manualmente
   (posicoes_historico + destinos atuais) pra sanity check dos pesos antes
   mesmo da sombra acumular volume.
4. Critério de aprovação pra Fase 2: na janela de sombra (mínimo 3 dias
   úteis), o vermelho teria coberto todos os casos que o operador marcou
   como reais (zero falso negativo) E suprimido ≥80% dos marcados como
   falso positivo. Empate/dúvida → mais sombra, não menos critério.

**Nota de metodologia (correção pós-revisão-final, 01/08)**: a avaliação
desse critério precisa EXCLUIR a contribuição de S3 (fora do corredor) do
placar. S3 só existe (o corredor só é verificado) quando os detectores
antigos (`afastando_de_tudo`/`rumo_diverge`/`classe_viaria`) já dispararam
— é `verificarCorredor` reaproveitando o MESMO veredito de camada 1 desses
detectores, não um cálculo independente. Contar S3 no critério de aprovação
é circular: mede se o placar concorda com os detectores que ele deveria
substituir, usando um sinal que só existe porque eles já concordaram.
Além disso, os números do backtest da Task 4 (16 casos de 01/08
reprocessados) NÃO servem de baseline pra essa avaliação — aquele backtest
rodou com posições em downsample de 1min (granularidade dos dados
históricos disponíveis na hora), não com o ciclo real de ~30s corrigido
acima; os pesos e durações (D1/D2, streaks) foram calibrados pra uma
cadência que não é a de produção.

## Fase 2 — troca

- Amarelo: novo estado visual na Central ("observando", lista própria
  discreta, sem apito). Vermelho: alerta `desvio` normal, mesmo fluxo de
  hoje (Focar/Resolver/Falso, score, contexto).
- Os branches `afastando_de_tudo`, `rumo_diverge` e `classe_viaria` em
  `detectores.ts` deixam de emitir alerta e passam a só exportar seus
  sinais pro placar. Código morto NÃO fica: flags de sombra antigas
  (`CLASSE_VIARIA_FILTRO_RUMO_ATIVO` e a sombra de rumo) são removidas
  nessa troca — o placar as substitui.
- `contexto` do alerta vermelho lista os componentes que somaram (ex.:
  "afastando há 6 min (+48), fora do corredor (+8), rua desconhecida (+3)")
  — explicabilidade pro operador no lugar dos motivos genéricos de hoje.
- **Requisito novo (correção pós-revisão-final, 01/08)**: a verificação de
  corredor (`verificarCorredor`/S3) não pode mais depender de um detector
  antigo já ter disparado pra existir (ver nota de metodologia da Fase 1
  acima — essa dependência é o que torna S3 circular hoje). Na Fase 2, a
  verificação de corredor passa a ser disparada pelo próprio placar
  (nível amarelo) e/ou mantendo as condições dos detectores antigos como
  gatilho INTERNO (dispara o cálculo do corredor) sem que isso, sozinho,
  gere alerta ao usuário — o alerta e o nível continuam vindo só do
  placar. Sem isso, S3 na Fase 2 herdaria o mesmo problema de circularidade
  que a Fase 1 tem hoje.

## Riscos e mitigação

- **Pesos iniciais errados** → Fase 1 é exatamente pra isso; nada muda na
  operação até bater o critério.
- **Replay histórico completo impossível** (destinos/alvos históricos não
  são versionados) → calibração usa a janela de sombra indo pra frente +
  os 16 casos de 01/08; não prometer backtest de semanas passadas.
- **Placar grudado no amarelo** (carro margeando a régua) → histerese +
  decaimento resolvem; monitorar na sombra.
- **Custo por ciclo** → todos os sinais caros (corredor, células, rumo) já
  são calculados hoje; o placar é aritmética em cima do que existe.

## Fora de escopo (explícito)

- Detecção de jammer, favela, tiroteio, cerca virtual: intocados.
- Sensores físicos (porta, câmera), macros de motorista: não existem na
  frota, não entram.
- IA/LLM opinando no ciclo (`observacoes_ia_desvio`): fica como está;
  pode virar componente do placar no futuro, não agora.
