# Classificação viária (via principal → rua estranha) como reforço de desvio, Design

**Data:** 2026-07-21
**Status:** aprovado pelo usuário, indo para plano

## Problema

Continuação da lista de ideias de melhoria de desvio organizada nesta
sessão: detectar quando um veículo sai de uma via principal (avenida/
rodovia) pra uma rua estreita/desconhecida, POR SI SÓ — independente de a
área já ter sido percorrida antes pela frota/veículo (isso já é coberto
pela feature de familiaridade histórica, implementada mais cedo hoje).

Pesquisa já concluída (não repetir): nem OSRM nem Valhalla (as duas APIs
de roteamento já usadas por `src/lib/corredor-verificacao.ts`) expõem
classificação viária nas chamadas já feitas hoje — confirmado em
documentação oficial. Overpass API existe mas tem throttle real que cresce
sob carga, inviável dentro do ciclo de 30s do motor.

## Decisão

**Extrato estático do OpenStreetMap**, já baixado e preparado nesta sessão:
Geofabrik Sudeste (813MB) → recorte bbox RJ via `osmium extract` (124MB) →
filtro só vias (`osmium tags-filter w/highway`) → export GeoJSON via
`osmium export --geometry-types=linestring` → resultado em
`rj-vias.geojsonseq` (480.005 vias, cada uma com geometria LineString +
`properties.highway`). Ingestão ÚNICA/manual, sem chamada de API
recorrente — mesmo espírito de `corredor_celulas`.

**Papel do sinal: só reforça um desvio que já está se formando, nunca
dispara sozinho** (confirmado explicitamente com o usuário, duas vezes —
a primeira decisão de escopo e depois uma correção de mecanismo). Uma rua
residencial é normal pra última milha de entrega; usar classificação
viária como gatilho próprio geraria falso positivo em toda entrega comum.

## Escopo

### 1. Taxonomia simplificada

Das ~15 tags `highway=*` do OSM, agrupadas em 3 classes:

| Classe | Tags OSM |
|---|---|
| `principal` | motorway, motorway_link, trunk, trunk_link, primary, primary_link, secondary, secondary_link |
| `intermediaria` | tertiary, tertiary_link, unclassified, living_street |
| `estreita` | residential, service, track |

Descartado (não veicular, ignorado se aparecer): path, footway, cycleway,
pedestrian, steps, bridleway e qualquer outra tag `highway` fora da lista
acima.

### 2. Ingestão (script standalone, fora do motor)

Migration `026_vias_celulas.sql` — nova tabela (mesmo shape/filosofia de
`corredor_celulas`):

```sql
CREATE TABLE vias_celulas (
  celula text PRIMARY KEY,
  classe text NOT NULL CHECK (classe IN ('principal', 'intermediaria', 'estreita'))
);
```

Script Node standalone (não roda no motor, não faz parte de nenhum cron):
lê `rj-vias.geojsonseq` linha a linha; para cada via, mapeia sua tag
`highway` pra uma das 3 classes (ignora a via se a tag não estiver na
taxonomia); percorre os vértices consecutivos da `LineString` reaproveitando
`celulasDoSegmento` (já existe em `src/lib/celulas.ts`, hoje usada só para
pares de posições GPS — aqui aplicada par a par entre os vértices da via)
pra obter todas as células ~100m que a via cruza. Acumula num
`Map<celula, classe>` em memória, mantendo a classe de MAIOR prioridade
quando duas vias diferentes cruzam a mesma célula (`principal` >
`intermediaria` > `estreita` — uma célula "tem acesso" à melhor via que
passa por ela). Ao final, um `INSERT ... ON CONFLICT (celula) DO UPDATE`
em lotes (batches de alguns milhares de linhas, não tudo de uma vez).

**Atualização do dado**: processo manual esporádico — rodar o script de
novo quando fizer sentido (ruas mudam com pouca frequência). Sem
automação/cron.

### 3. Leitura no motor (mesmo padrão de `dentroTapete`/`familiarVeiculo`)

Uma função `buscarClassesViariasCandidatas(candidatas: string[]):
Promise<Map<string, string>>` (mesmo formato de
`buscarCelulasTapeteCandidatas`), chamada 1x por cliente por ciclo com a
vizinhança 3x3 dos veículos frescos do ciclo — nunca uma query por
veículo. Sem tabela por cliente/veículo (essa tabela é geográfica pura,
sem coluna de escopo).

No loop por veículo: `classeViaAtual = melhor classe entre as 9 células da
vizinhança 3x3 da posição atual` (reaproveita `vizinhanca3x3`, mesmo padrão
de `.some()`/lookup em `dentroTapete`), ou `null` se nenhuma célula
mapeada.

### 4. Estado persistido por veículo

Mesma migration `026_vias_celulas.sql` (Seção 2) adiciona a coluna:
`ALTER TABLE posicoes_atuais ADD COLUMN ultima_via_principal_em
timestamptz NULL;`. A cada ciclo, se `classeViaAtual === "principal"`,
atualiza essa coluna pra `agora`. Caso contrário, mantém o valor anterior
(decai naturalmente pela checagem de janela abaixo, sem precisar resetar
explicitamente).

```ts
const JANELA_QUEDA_CLASSE_MIN = 10; // minutos
const quedaClasseViaria =
  classeViaAtual === "estreita" &&
  ultimaViaPrincipalEm !== null &&
  (agora.getTime() - new Date(ultimaViaPrincipalEm).getTime()) <= JANELA_QUEDA_CLASSE_MIN * 60_000;
```

### 5. Reforço do score (NÃO um novo tipo de alerta)

`quedaClasseViaria: boolean` entra em `CtxDesvio`/`CtxAvaliacao` (mesmo
padrão de `familiarVeiculo`), mas **não é lido dentro de
`detectarDesvio`**. Em vez disso, é aplicado como pós-processamento do
RESULTADO dessa função, nos dois call sites que já existem
(`montarCandidatosCore` e `avaliarTodos`, mesmos dois pontos tocados pela
feature de familiaridade):

```ts
const BONUS_CLASSE_VIARIA = 15; // mesma magnitude de BONUS_CORROBORACAO_POR_SINAL
let desvioAlerta = detectarDesvio(p, {...});
if (desvioAlerta && ctx.quedaClasseViaria) {
  desvioAlerta = {
    ...desvioAlerta,
    score: Math.min(100, desvioAlerta.score + BONUS_CLASSE_VIARIA),
    motivo: `${desvioAlerta.motivo} — saiu de via principal recentemente`,
  };
}
```

Isso garante por construção que o sinal nunca aparece sozinho: se
`detectarDesvio` não retornar nada, não há nada pra reforçar.

## Fora de escopo

- Qualquer novo "tipo" de alerta na tabela `alertas` (decisão explícita:
  isso seria capaz de disparar sozinho).
- Automação/cron de reingestão do extrato OSM.
- Uso desse dado em qualquer outra detecção além do desvio (cerca virtual,
  comportamental/Welford, etc. ficam intocados).
- Cobertura fora do RJ (o recorte é só bbox do estado do RJ, suficiente
  pra frota atual).

## Testes

Lógica pura testável: função de mapeamento tag→classe (`classificarVia`,
em algum lib novo ou reaproveitando `celulas.ts`), e o cálculo de
`quedaClasseViaria`/aplicação do bônus (testável via unit test simulando
`classeViaAtual`/`ultimaViaPrincipalEm` variados). Script de ingestão:
validado rodando contra o arquivo real (`rj-vias.geojsonseq`) e conferindo
uma amostra de células conhecidas (ex.: uma célula sabidamente numa
rodovia grande do RJ recebe classe `principal`). Migration aplicada e
confirmada. `tsc`/`eslint`/suite completa/`build` limpos nos dois repos
antes do push. Nunca rodar o motor de produção diretamente.
