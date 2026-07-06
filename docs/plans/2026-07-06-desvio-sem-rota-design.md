# Design: detecção de desvio sem rota planejada (v2)

Data: 2026-07-06. Status: implementado, corrigido para v3 após observação ao vivo.

## Amendment v3 (mesmo dia, pós-implementação)

Observando o sistema ao vivo na operação, o v2 falhou por dois motivos:

1. **"Afastar de TODOS os destinos" é frágil demais.** Com várias entregas
   pendentes espalhadas, quase sempre tem alguma pra qual o carro está
   "chegando mais perto" por pura geometria de rua — mesmo estando desviado
   de verdade. Isso reseta o streak com frequência e mascara o desvio real.
2. **Piso de acumulado (1,5km/4 ciclos) para crítico é lento e alto demais.**
   Um desvio de só 500m já pode ser um assalto em andamento; não dá pra
   esperar acumular distância.

**Correção (v3):** desvio = afastando-se do destino **mais próximo** (não de
todos). Sem piso de distância acumulada — streak>=2 (~2min, o mínimo físico
pra filtrar ruído de 1 leitura GPS) já dispara atenção. O **tapete histórico**
deixa de ser só modulador e vira o sinal **primário** de precisão: calculado
TODO ciclo (não mais só quando streak>=2) via um `Set<string>` cacheado em
memória por cliente (`getTapeteCliente`, TTL 3min, busca única via `pool` sem
o limite de linhas do PostgREST) — fora de via conhecida da frota = crítico
direto no 2º ciclo. Isso também resolve o caso "passa reto sem parar porque
não é hora de descarga": rua conhecida da frota não alarma mesmo sem parar no
cliente; só alarma ao sair do que a frota realmente percorre.

Ver `src/lib/detectores.ts` (`detectarDesvio`, `distanciaAumentou`) e
`src/app/api/motor/route.ts` (bloco "Desvio v3") para a implementação atual.
As seções abaixo descrevem o v2 original (contexto histórico da decisão).

## O problema

A Unitrac não fornece rota planejada (`ult_rota` vazio, `ordem` dos alvos não é
confiável). O sistema atual finge que existe uma:

1. O modo "corredor OSRM" do detector traça uma rota sintética pelos alvos na
   ordem do campo `ordem` e alerta quando o veículo sai 800m dela. A rota é
   inventada: o motorista nunca prometeu seguir essa sequência nem esse trajeto.
2. A UI desenha uma listra laranja pontilhada do veículo até `alvosPendentes[0]`
   ("próximo cliente") com ETA, afirmando uma ordem que não existe.
3. Bug independente: o rastro azul do veículo focado é buscado uma vez na
   seleção e nunca acompanha as atualizações de posição (poll de 10-15s).

## Princípio da solução

Sem rota planejada, desvio é comportamento: **o veículo está agindo como quem
não vai para nenhum destino legítimo dele**. Destinos legítimos = todos os
alvos pendentes do dia + as bases do cliente. Duas camadas:

- **Camada 1 (comportamental, sempre ativa):** se afastando de TODOS os
  destinos legítimos, sustentado por N ciclos.
- **Camada 2 (memória espacial, ativa quando há dado):** o "tapete" de células
  de ~100m que a frota realmente percorreu nos últimos 30 dias. Fora do tapete
  = caminho que nenhum caminhão da frota usou; escala a severidade.

É o que as gerenciadoras de risco fazem quando não há rota carregada (zonas
permitidas + corredores históricos + peso por horário), e a técnica de grade é
validada na literatura de trajetória de carga (grid ~100m, vizinhança 3x3,
interpolação entre fixes esparsos).

## Camada 1: detector comportamental

Substitui os dois modos atuais de `detectarDesvio` (corredor OSRM e
clássico min-dist + rumo). O teste de rumo por cone morre: com 10+ pendentes
espalhados, a união dos cones de 75° cobre a rosa dos ventos inteira e o
detector nunca dispararia.

Sinal primário, por ciclo do motor (1min, pg_cron):

```
afastouDeTudo = para CADA destino legítimo (alvos pendentes + centroide de
                CADA base do cliente):
                dist(posAtual, destino) > dist(posAnterior, destino) + 50m
```

Computável em memória: os alvos do veículo e a posição anterior
(posicoes_atuais) já estão carregados no ciclo. Sem chamada externa.

Condições de contorno:

- `emOperacao` (seg-sex 6h-20h SP) e `foraDaBase` (fora de todos os polígonos), como hoje.
- Posição fresca (`atraso < 60min`), como hoje.
- Guarda anti-teleporte: se a velocidade implícita entre posAnterior e posAtual
  passa de 150 km/h, o ciclo é ignorado (streak congela, não incrementa nem
  reseta). Mata salto de GPS/reconexão.
- Faixa de criação: menor distância a qualquer destino entre 2,5km e 25km
  (mantém a semântica atual: acima é deslocamento interurbano).
- Com 0 pendentes (fim de rota), os destinos viram só as bases: afastar-se da
  base em operação também alerta (fecha o buraco atual do `temPendentes`).
  Nesse caso exige streak 3+ e afastamento acumulado 2km+, nível atenção.
- Curva de retorno/contorno não acumula streak: em algum ciclo do retorno o
  veículo se aproxima de algum destino e a sequência reseta sozinha.

Estado entre ciclos (novas colunas em `posicoes_atuais`, migration 010):

- `desvio_streak int not null default 0`: ciclos consecutivos com afastouDeTudo.
- `desvio_inicio jsonb null`: `{lat, lng, ts}` do primeiro ciclo da sequência
  (gravado na transição 0 para 1). É o ponto de início do desvio.

Severidade (fusão com a camada 2):

| Condição | Resultado |
|---|---|
| streak >= 2 E fora do tapete | crítico direto |
| streak >= 4 E afastamento acumulado >= 1,5km | crítico |
| streak >= 2 E afastamento acumulado >= 500m | atenção |
| tapete sem dado na região | só camada 1 decide (nunca bloqueia) |

Afastamento acumulado = menor distância a qualquer destino agora menos a menor
distância no início da sequência.

Manutenção/resolução do alerta (anti-pisca): mantém enquanto a menor distância
a qualquer destino (incluindo bases) >= 2,5km; resolve quando o veículo volta a
se aproximar. Igual à semântica do `foraDeRota` atual, com bases no conjunto.

## Camada 2: tapete histórico (corredor_celulas)

Tabela nova (migration 010), desenhada para respeitar o banco (nada de posição
crua: 15M linhas/mês era o custo do design ingênuo):

```sql
create table corredor_celulas (
  cliente_id   uuid not null references clientes(id) on delete cascade,
  celula       text not null,          -- "latMil:lngMil" (round(lat*1000)) ~ 111m x 102m no RJ
  ultimo_visto date not null default current_date,
  primary key (cliente_id, celula)
);
alter table corredor_celulas enable row level security;  -- padrão do schema, motor usa service_role
```

Escrita (no ciclo do motor, para cada veículo fresco que se moveu):

- Interpola a linha posAnterior -> posAtual a cada ~80m e coleta as células do
  segmento (a 70km/h o veículo cruza ~11 células por minuto; sem interpolar o
  tapete fica esburacado). Segmento > 2,5km não interpola (teleporte).
- Um único upsert batch por ciclo com todas as células de todos os veículos:
  `insert ... on conflict (cliente_id, celula) do update set ultimo_visto =
  excluded.ultimo_visto where corredor_celulas.ultimo_visto < current_date`.
  A cláusula where evita churn de dead tuples (só escreve 1x por dia por célula).

Leitura (só para os veículos candidatos, isto é, com desvio_streak >= 1):

- `select celula from corredor_celulas where cliente_id = $1 and celula = any($2)`
  onde $2 são as células 3x3 em volta da posição atual dos candidatos.
  Consulta minúscula (egress quase zero). Dentro do tapete = qualquer célula da
  vizinhança 3x3 presente.

Expiração: no bloco de limpeza horária que já existe no motor, deletar células
com `ultimo_visto < current_date - 30`.

Bootstrap (a ideia dos 4 dias): script one-off `scripts/bootstrap-corredor.ts`
que puxa o rastro de 96h de cada veículo da frota (endpoint já existente, sem
timestamp por ponto, espacialmente válido), interpola e semeia as células. Roda
manual 1x no deploy; daí em diante o motor acumula sozinho. Não entra no ciclo
do motor (timeout de 60s é apertado).

## Ponto de início do desvio no mapa

- O INSERT do alerta de desvio passa a gravar lat/lng de `desvio_inicio` (hoje
  grava a posição do disparo, que é 2+ ciclos depois do começo). `contexto`
  jsonb leva `{inicio_ts, fora_tapete}`.
- UI (MapaLeafletV2): para alerta de desvio ativo do veículo selecionado,
  marcador de aviso no ponto de início + linha fina (polyline simples, 2 pontos)
  do início até a posição atual do veículo, mostrando o trecho desviado.
- O motivo do alerta usa o reverse-geocode que já existe (geocode_cache com
  orçamento por ciclo): "Afastando-se das 4 entregas pendentes e da base há 3
  leituras, fora de caminho conhecido da frota, desde 14:32 (Av. Brasil)".

## Remoções (UI de rota falsa + infra OSRM de corredor)

- MapaLeafletV2: `routeWaypoints`, `routeLinesRef`, linha pontilhada laranja,
  fetch OSRM do front, `etaMinutos`/`onEtaChange`.
- MonitorV2: estado `etaProxima`, bloco "próxima entrega" do drawer (fica o
  progresso X de Y e os pontos no mapa).
- detectores.ts: modo corredor de `detectarDesvio` (`distCorredorM`,
  `jaForaCorretor`), reescrito pelo detector v2.
- motor/route.ts: carga de `rotas_cache`, hash de alvos, chamadas
  `buscarRotaOSRM`, `distanciaAoCorredorM`, coluna `fora_corredor` no upsert.
- lib/osrm.ts: some quase todo; `centroideGeo` (usado para distância à base)
  migra para unitrac.ts.
- Migration 010: `drop table rotas_cache`, `alter table posicoes_atuais drop
  column fora_corredor`, novas colunas de streak, tabela corredor_celulas.
- Atenção operacional: migrations são aplicadas manualmente no Supabase
  (auto-deploy não roda migrations).

## Fix do rastro azul

No poll de posições (10-15s), se o veículo focado tem posição nova a mais de
10m do último ponto do rastro em memória, anexa `[lat, lng]` ao estado
`rastro`. Zero chamadas extras à API; o rastro acompanha o carro. O re-fetch
completo continua acontecendo só na seleção/troca de janela de horas.

## Testes (vitest, detectores.test.ts reescrito para o desvio)

1. Afastando de todos os destinos por 2 ciclos + acumulado 500m: atenção.
2. Idem fora do tapete: crítico.
3. 4 ciclos + 1,5km dentro do tapete: crítico.
4. Aproximando de UM pendente qualquer (mesmo afastando dos outros): nada, streak reseta.
5. Indo em direção à base (0 pendentes ou não): nada.
6. 0 pendentes + afastando da base 3 ciclos + 2km: atenção.
7. Teleporte (salto implausível): streak congela, sem alerta.
8. Fora da janela de operação / dentro da base / posição velha: nada.
9. desvio_inicio: transição 0 para 1 grava o ponto; alerta nasce com ele.
10. Células: interpolação de segmento gera células contíguas; vizinhança 3x3
    reconhece célula adjacente como dentro do tapete.

## O que fica de fora (decidido, YAGNI)

- Tabela de posições cruas (posicoes_historico): desnecessária, células agregadas bastam.
- Corredor por par placa-alvo: dado esparso demais; tapete é por cliente/frota.
- Alerta por camada 2 sozinha (fora do tapete sem camada 1): falso positivo em
  rota nova legítima; tapete só modula severidade.
- Map matching/snap-to-road, DBSCAN de paradas, ML: próximas iterações se precisar.
