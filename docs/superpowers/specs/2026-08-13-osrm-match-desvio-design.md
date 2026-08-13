# Map matching (OSRM /match) no detector de desvio v2 — Design

## Contexto

13/08: no mesmo dia, 4 falsos positivos de "afastando de tudo" (RBG-5G18,
TTH-6G37, RQU-2H61, TOS-2B69) mostraram um padrão idêntico e estatisticamente
impossível de ser divergência real: o delta de distância (atual − anterior)
era **praticamente idêntico para todos os destinos avaliados**, mesmo entre
destinos a 6,9km e 287km de distância um do outro. Movimento real produz
deltas diferentes por destino (proporcional à geometria de cada rota); um
delta uniforme é assinatura de outra coisa.

Causa raiz identificada: o motor usa o endpoint `/table` do OSRM
(`src/lib/distancia-real.ts`) para medir distância de rua entre a posição
atual/anterior e cada destino. Cada chamada ao `/table` encaixa
(*snap*) o ponto de origem na rua mais próxima **independentemente**, sem
contexto de trajeto. Quando o veículo se move pouco entre duas leituras
(saindo de uma parada, manobrando), o ponto atual e o ponto anterior podem
encaixar em nós ligeiramente diferentes da malha viária — essa pequena
diferença de "última milha" se propaga quase igual pra todas as rotas
adiante, porque compartilham o mesmo corredor até ali.

Um patch pontual (`LIMIAR_MOVIMENTO_MINIMO_M = 50`, "Achado real 13/08" em
`route.ts`) já suprime a avaliação quando o deslocamento real (haversine)
entre as duas leituras é pequeno demais — mas isso é um remendo que corta
recall também (ciclos com movimento real pequeno *e* válido ficam de fora).
O problema de fundo é que `/table` não foi desenhado pra limpar ruído de
GPS — quem faz isso é *map matching* de verdade (encaixar uma trajetória
inteira na malha viária, considerando a sequência), e o OSRM já tem esse
endpoint pronto: `/match`. Testado nesta sessão contra o OSRM self-hosted
no Contabo (`rj-latest.osrm`, algoritmo `mld`) — já habilitado, responde
corretamente, nenhuma infra nova necessária.

## Objetivo

Quando o detector de desvio v2 já está construindo um possível alerta
(`afastandoStreak > 0` no ciclo anterior), usar o `/match` do OSRM pra
corrigir a posição atual e a posição anterior antes de medir distância —
em vez das coordenadas brutas do GPS. O cálculo de distância-aos-destinos
em si (`/table`, `avaliarAfastandoDeTudo`) **não muda** — só a entrada que
alimenta ele fica mais limpa.

## Não-objetivos

- Não substitui `/table` para ciclos "limpos" (`afastandoStreak == 0`) —
  nesses, o custo de rodar `/match` pra toda a frota (347 veículos, a cada
  30s) não se justifica: hoje, na maioria dos ciclos, zero veículos têm
  streak > 0 (confirmado ao vivo nesta sessão).
- Não mexe no sinal `rua_rara_frota` (já desligado por decisão do usuário
  13/08) nem nos limiares/streak existentes (`LIMIAR_STREAK_AFASTANDO`,
  `LIMIAR_TRANSITO_LONGO_M`, etc.).
- Não tenta re-processar/corrigir o histórico de posições já gravado —
  só afeta a leitura ATUAL do ciclo em avaliação.

## Arquitetura

Novo módulo `src/lib/osrm-match.ts`, mesmo padrão de
`src/lib/distancia-real.ts` (função pura, chamada de rede isolada, sem
lógica de decisão):

```ts
export type PosicaoCorrigida = { lat: number; lng: number };

export async function corrigirPosicoesComMatch(
  pontos: { lat: number; lng: number; timestamp: Date }[]
): Promise<{ atual: PosicaoCorrigida; anterior: PosicaoCorrigida; confidence: number } | null>
```

- Recebe a janela de posições recentes (já ordenada por tempo, ver "Janela
  de dados" abaixo) e devolve os dois últimos pontos da trajetória
  corrigida (o mais recente = "atual", o penúltimo = "anterior"), mais o
  `confidence` (0–1) que o OSRM devolve pra correspondência inteira.
- Retorna `null` em qualquer falha (rede, timeout, `code != "Ok"`,
  trajetória sem correspondência) — nunca lança exceção. Mesmo contrato
  de `buscarDistanciasReais`.
- Chama `GET /match/v1/driving/{coords}?timestamps={ts}&annotations=false`
  no `OSRM_LOCAL_URL` já configurado (`distancia-real.ts` reusa a mesma
  env var).

### Ponto de integração em `route.ts`

No bloco do detector de desvio v2 (`src/app/api/motor/route.ts`, em torno
da avaliação atual de `avaliarAfastandoDeTudo`):

1. Antes de montar `distAtuaisReais`/`distAnterioresReais`, checa
   `estadoDesvioAnterior.afastandoStreak > 0`.
2. Se **true**: busca a janela de posição recente do veículo (ver abaixo),
   chama `corrigirPosicoesComMatch`. Se retornar um resultado com
   `confidence` acima do piso calibrado (ver "Piso de confiança"), usa
   `atual`/`anterior` corrigidos em vez de `pos`/`anterior` brutos pra
   alimentar `buscarDistanciasReais` (que continua idêntico).
3. Se **false**, ou se o `/match` falhar/vier com confiança baixa: segue
   exatamente como hoje (posição bruta).
4. `desvio_disparo_log` ganha uma coluna nova (`posicao_corrigida boolean`)
   registrando se aquele disparo específico usou posição corrigida —
   permite comparar os dois métodos lado a lado com dado real depois do
   deploy, sem precisar reconstruir nada.

### Janela de dados

Últimos 5 minutos de `posicoes_historico` do veículo (mesma tabela já
usada por `validar-desvio-v2.mjs` e pela investigação de casos reais desta
sessão) — cobre 8-10 leituras no ciclo de 30s atual, suficiente pro HMM do
OSRM contextualizar o trajeto sem carregar histórico demais nem atrasar o
ciclo do motor. Query simples, mesmo padrão das outras queries de
`posicoes_historico` já existentes no arquivo.

### Piso de confiança

Valor exato **calibrado durante a implementação**, não fixado aqui —
testado contra:
1. As trajetórias reais dos 4 casos de falso positivo do dia (13/08:
   RBG-5G18, TTH-6G37, RQU-2H61, TOS-2B69) — devem ficar acima do piso
   (matches válidos, só que agora sem o artefato de delta uniforme).
2. Trajetórias de veículos parados/manobrando (baixa confiança esperada
   nesses casos, já cobertos pelo fallback bruto de qualquer forma).

## Tratamento de erro

Fallback silencioso pro método bruto (`pos`/`anterior` originais) em TODA
falha: rede, timeout, OSRM fora do ar, `code != "Ok"`, confiança abaixo do
piso. Mesmo padrão já usado em `buscarDistanciasReais` — nunca bloqueia a
avaliação do ciclo, só perde a correção extra daquele ciclo específico.

Pior cenário se `/match` tiver algum bug: no máximo atrasa/distorce um
alerta que **já estava se formando** (streak > 0) — nunca cria um alerta do
zero, porque só entra em ação quando já há streak.

## Teste

- Teste unitário de `corrigirPosicoesComMatch` mockando a resposta HTTP do
  OSRM (sucesso, falha de rede, `code != "Ok"`, confiança baixa) — mesmo
  padrão dos testes existentes de funções de rede isoladas neste repo.
- Antes do deploy: script de validação (`scripts/validar-match-desvio.mjs`
  ou similar, rodado manualmente contra produção) que reproduz os 4 casos
  reais de 13/08 através do `/match` e confirma que o delta deixa de ser
  uniforme entre destinos de distâncias muito diferentes.
- Testes existentes de `desvio.ts`/`route.ts` não devem quebrar — a
  mudança é só na ENTRADA (coordenadas), a lógica de streak/limiar
  continua testada como está.

## Rollout

Deploy normal (sem migration de schema além da nova coluna
`desvio_disparo_log.posicao_corrigida`). Acompanhamento pelo monitor já
existente (`desvio_disparo_log` + explicação automática de falso
positivo) — se o padrão de delta uniforme reaparecer mesmo com correção
ativa, é sinal de que o piso de confiança ou a janela precisam de ajuste.
