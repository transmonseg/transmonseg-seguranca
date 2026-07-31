# Filtro de coerência de rumo pro detector "rua estranha" (classe_viaria)

**Data:** 2026-07-31
**Status:** desenhado a partir de conversa já fechada com o usuário na mesma sessão, indo para plano

## Contexto

Achado real 31/07 (`TTS-1A71`, veículo Nutry Max): o detector `classe_viaria`
(`src/lib/detectores.ts:1313`, motivo `MOTIVO_RUA_ESTRANHA`) disparou um alerta de
desvio enquanto o veículo estava indo em linha reta na direção de um destino real do
romaneio do dia (`EXPRESSO PALMITAL`) — a 664m no momento do alerta, parou a 202m do
mesmo endereço 4,5 minutos depois (confirmado via `posicoes_historico` +
`romaneio_pontos`, ver memória do projeto).

A regra dispara com só 3 condições: não estar se afastando de TODOS os destinos, ter
saído de via principal pra rua estreita nos últimos 10 minutos, e não ter acabado de
sair de uma parada confirmada. `suspensoPorChegada` (`src/lib/unitrac.ts:334`) é a
única proteção contra chegada legítima, mas só suspende dentro do raio do destino
(mínimo 150m) — deixa um buraco de ~150m a ~1km sem nenhuma proteção, exatamente onde
mora a navegação normal de última milha (sair da avenida, entrar na rua do cliente).

**Por que não alargar o raio de `suspensoPorChegada`:** decisão explícita do usuário em
27/07 (documentada em comentário no código, `detectores.ts:1278-1281`) foi deliberada —
a regra TEM que disparar mesmo aproximando, porque um roubo pode acontecer perto do
cliente (ex.: 100m depois de virar numa rua errada). Alargar o raio mataria essa
sensibilidade. Achado de 27/07 já mostrado nesta sessão: essa regra tem ~69% de falso
positivo histórico — o problema é real e recorrente, não um caso isolado.

## Design

### Sinal: coerência de rumo, não distância

`divergenciaGrausAtual` já é computado TODO ciclo em `route.ts` (linha ~1747, mesmo
campo que alimenta `rumo_diverge` e `saida_parada`) — é a divergência entre o rumo de
movimento do veículo e a direção até o destino pendente mais próximo. Já está presente
em `CtxDesvio`/`CtxAvaliacao`, nenhuma wiring nova de dado é necessária.

Ideia: se o rumo de movimento está ALINHADO com a direção do destino mais próximo
(divergência baixa), a rua estreita provavelmente É o caminho certo pra chegar lá — não
é desvio. Se diverge muito (virou pro lado errado, direção oposta), mantém o alerta —
continua pegando o cenário de sequestro/virada errada que a regra existe pra cobrir.

### Função pura nova (`src/lib/detectores.ts`)

```ts
// Limiar inicial (dado real de 31/07, calibrar com o periodo de sombra) --
// mesmo valor ja usado como "divergencia significativa" em
// divergenciaRumoAcimaDoLimiar (unitrac.ts), por consistencia de
// interpretacao do angulo nesta base de codigo. Pode divergir no futuro
// se o dado de sombra mostrar que devia.
const RUA_ESTRANHA_LIMIAR_RUMO_COERENTE_GRAUS = 100;

export function rumoCoerenteComDestino(
  divergenciaGraus: number | null,
  limiarGraus: number
): boolean {
  if (divergenciaGraus === null) return false; // sem sinal confiavel, erra pro lado de manter o alerta
  return divergenciaGraus <= limiarGraus;
}
```

### Wiring (`src/app/api/motor/route.ts`) — mesmo padrão do filtro de rumo_diverge

**Não muda a condição de disparo dentro de `detectarDesvio`** (a função pura,
`detectores.ts:1313`, continua criando o alerta exatamente como hoje — três
condições inalteradas). A supressão acontece DEPOIS, em `route.ts`, no mesmo lugar
onde o resultado final já arbitrado é conhecido (mesma área do bloco de sombra do
`rumo_diverge`, ~linha 2560+):

```ts
if (alerta?.origemDesvio === "classe_viaria") {
  const rumoCoerente = rumoCoerenteComDestino(divergenciaGrausAtual, RUA_ESTRANHA_LIMIAR_RUMO_COERENTE_GRAUS);
  // grava no contexto flat da classe_viaria (contextoClasseViaria) -- ver onde
  // esse objeto é montado hoje, ~linha 3013-3029
  contextoClasseViaria.rumo_coerente_sombra = {
    divergencia_graus: divergenciaGrausAtual,
    limiar: RUA_ESTRANHA_LIMIAR_RUMO_COERENTE_GRAUS,
    suprimiria: rumoCoerente,
  };
  if (CLASSE_VIARIA_FILTRO_RUMO_ATIVO && rumoCoerente) {
    alerta = null;
  }
}
```

`CLASSE_VIARIA_FILTRO_RUMO_ATIVO = false` (constante em `route.ts`, mesmo padrão de
`RUMO_DIVERGE_FILTRO_COMPORTAMENTAL_ATIVO`/`CERCA_VIRTUAL_MODO`). Em modo sombra: o
alerta continua sendo criado exatamente como hoje, só o campo
`rumo_coerente_sombra` é informativo.

### Rollout (sombra → ativa)

Mesmo processo já usado 2x nesta sessão:
1. Deploy em modo sombra.
2. Depois de alguns dias de dado real, revisar manualmente uma amostra dos casos com
   `suprimiria: true` (mesmo método usado pra confirmar o caso TTS-1A71 — posição real
   de `posicoes_historico` cruzada com destino real) — algum desvio genuíno seria
   suprimido erroneamente?
3. Se limpo (ou com ajuste do limiar), vira `CLASSE_VIARIA_FILTRO_RUMO_ATIVO = true`.

**Backtest manual executado (31/07, antes do deploy em sombra):** amostra de 30
alertas `classe_viaria` reais do dia, reconstruindo `divergenciaRumoGraus`/
`rumoCoerenteComDestino` (as MESMAS funções de produção, via `posicoes_historico` +
`romaneio_pontos` do dia como proxy de destino). 4 casos sem romaneio disponível
(pulados); dos 26 restantes, 9 teriam `suprimiria: true`, incluindo o `TTS-1A71`
(664m do destino real, divergência 85,2° — confirma a análise manual original).
Nenhum caso com sinal de desvio genuíno apareceu suprimido, mas a amostra não tinha
nenhum alerta com confirmação individual forte de desvio real pra testar contra (só
`status='falso_positivo'` é sinal forte nesta base — ver achado 27/07); a garantia é
por ausência de bandeira vermelha, não verificação caso-a-caso como a do TTS-1A71.
Achado adicional: o piso de 10km/h de `divergenciaRumoGraus` (pensado pro cenário de
rodovia do `rumo_diverge`) zera o sinal em boa parte dos casos com destino resolvido
justamente porque rua estreita é onde o veículo anda devagar — reduz a taxa de
supressão sobre falso-positivos confirmados pra ~38% (5 de 13) na amostra. Não é
motivo pra não ativar (falso positivo residual é aceitável, mesma diretriz de
sempre), mas é um limite real de eficácia a considerar durante a calibração do
limiar. Detalhe completo (tabela linha-a-linha) em
`.superpowers/sdd/2026-07-31-classe-viaria-coerencia-rumo/task-4-report.md` (local,
não versionado).

### Testes

- `detectores.test.ts`: casos unitários pra `rumoCoerenteComDestino` (coerente, não
  coerente, exatamente no limiar, `null` mantém o alerta).
- Backtest manual (mesmo padrão do `rumo_diverge`): pegar uma amostra recente de
  alertas `classe_viaria` reais (incluindo o TTS-1A71 e casos já classificados como
  falso positivo em 27/07) e confirmar que o novo sinal os teria suprimido, sem
  suprimir nenhum dos poucos casos confirmados-reais da mesma amostra.

## Fora de escopo

- Verificação de corredor real (OSRM) pra classe_viaria — mais pesado (chamada de
  rede, orçamento por ciclo já disputado por cerca_virtual/rumo_diverge) e não
  necessário: o sinal de rumo já resolve o caso concreto encontrado. Registrado como
  possível reforço futuro se o dado de sombra mostrar que rumo sozinho não basta.
- Qualquer mudança em `suspensoPorChegada` ou no raio de 150m — continua exatamente
  como está, essa spec não mexe nisso.
