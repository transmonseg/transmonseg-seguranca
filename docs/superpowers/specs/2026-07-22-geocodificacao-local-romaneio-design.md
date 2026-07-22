# Geocodificação local do romaneio via extrato OSM, Design

**Data:** 2026-07-22
**Status:** aprovado pelo usuário, indo para plano

## Problema

A geocodificação assíncrona do romaneio (feature anterior desta sessão)
já resolve o "nunca completa" do upload, mas ainda depende do Nominatim
público (throttle real de 1 req/s) pra praticamente todos os endereços —
só 6 endereços em cache em todo o histórico. Achado real: o próprio
código já documenta que Nominatim gratuito cobre mal ruas de cidade
pequena do interior — as cidades do romaneio de hoje (Natividade,
Itaperuna, Varre-Sai, Laje do Muriaé, todas municípios pequenos do
Noroeste Fluminense) são exatamente o cenário onde essa cobertura é
fraca. Ou seja, boa parte dos 2041 endereços provavelmente FALHARIA no
Nominatim de qualquer forma — não é só questão de velocidade.

Decisão já tomada nesta sessão: manter tudo gratuito, sem configurar
`GOOGLE_MAPS_API_KEY` server-side por enquanto.

## Decisão

Construir um geocodificador LOCAL, usando o extrato OSM já baixado e
processado nesta sessão (`rj-vias.geojsonseq`, 480 mil vias do RJ com
`properties.name`/`official_name` + geometria), inserido na cadeia de
fallback ANTES do Nominatim. Precisão de RUA (ponto médio da via), não
número exato de porta — aceitável dado que o raio de entrega do sistema
já opera na casa de 50-150m.

**Desambiguação por cidade**: o extrato tem `addr:city` em menos de 0,1%
das vias (confirmado por amostragem) — não dá pra confiar nisso. Em vez
disso, geocodifica-se (via Nominatim, throttled) só os NOMES DE CIDADE
ÚNICOS do lote sendo processado (dezenas, não milhares) uma única vez,
cacheado, e usa-se esse ponto de referência pra escolher — entre os
candidatos de mesmo nome de rua — o geometricamente mais próximo.

**Salvaguarda de distância**: se o candidato mais próximo ainda estiver
muito longe do ponto de referência da cidade (nome bateu, mas é
claramente outra "Rua Direita" numa região distante), o match local é
rejeitado e cai pro próximo nível da cadeia (Nominatim) — mesmo espírito
de outras salvaguardas já usadas neste projeto (`saltoImplausivel`,
`DESVIO_GATILHO_TETO_M`).

## Escopo

### 1. Migration `027_vias_nomes.sql`

```sql
CREATE TABLE vias_nomes (
  id bigint generated always as identity primary key,
  nome_normalizado text NOT NULL,
  lat double precision NOT NULL,
  lng double precision NOT NULL
);
CREATE INDEX idx_vias_nomes_nome ON vias_nomes (nome_normalizado);
```

Múltiplas linhas com o mesmo `nome_normalizado` são esperadas e
desejadas (candidatos pra desambiguação) — sem PK composta nem
`ON CONFLICT`, é um `INSERT` simples em lote.

### 2. Funções puras de parsing/normalização

Novo módulo `src/lib/romaneio-geocode-local.ts`:

- `extrairRuaDoEndereco(enderecoBruto: string): string` — texto antes da
  primeira vírgula, trim.
- `extrairCidadeDoEndereco(enderecoBruto: string): string | null` —
  primeiro token do trecho depois da ÚLTIMA vírgula, separado por `" - "`,
  trim. Retorna `null` se o formato não bater (endereço mal formado).
- `normalizarNomeRua(rua: string): string` — maiúsculas, remove acentos
  (`normalize("NFD").replace(/[\u0300-\u036f]/g, "")`), remove prefixo de
  tipo de via como primeiro token quando reconhecido (`RUA, R, AV,
  AVENIDA, TRAVESSA, TRAV, ESTRADA, EST, RODOVIA, ROD, ALAMEDA, AL,
  PRACA, PC, LARGO`), colapsa espaços múltiplos, trim. Aplica-se tanto ao
  nome extraído do romaneio quanto ao `name`/`official_name` do OSM na
  ingestão — mesma função, mesmo resultado dos dois lados.
- `haversineM` já existe em `src/lib/unitrac.ts` — reaproveitado, não
  duplicado neste módulo (diferente do script `.mjs`, que É standalone e
  duplica por convenção já estabelecida).

### 3. Script de ingestão `scripts/ingerir-vias-nomes.mjs`

Mesmo padrão de `scripts/ingerir-vias-celulas.mjs` (streaming via
`readline`, lotes de alguns milhares, `pg.Pool`). Pra cada feature do
`rj-vias.geojsonseq`: extrai `properties.name` (ou `official_name` se
`name` ausente), normaliza (duplicando a lógica de
`normalizarNomeRua`/remoção de acento em JS puro, mesma convenção de
scripts `.mjs` não importarem de `src/lib/*.ts`), calcula o ponto médio
da geometria (média aritmética simples de todas as coordenadas do
`LineString` — não pesado por comprimento de trecho, aproximação
suficiente pra ruas do porte típico dessas cidades). Ignora features sem
`name` nem `official_name`. Insere em lote (sem `ON CONFLICT` — duplicatas
de nome são esperadas).

### 4. Nova função `geocodificarLocal` em `src/lib/romaneio-geocode.ts`

```ts
const DISTANCIA_MAX_MATCH_LOCAL_M = 30_000; // 30km -- acima disso, nome bateu mas e outra regiao

export async function geocodificarLocal(
  enderecoBruto: string,
  pontoCidade: { lat: number; lng: number } | null,
  buscarCandidatosPorNome: (nomeNormalizado: string) => Promise<{ lat: number; lng: number }[]>
): Promise<{ lat: number; lng: number } | null> {
  const rua = extrairRuaDoEndereco(enderecoBruto);
  const nomeNormalizado = normalizarNomeRua(rua);
  const candidatos = await buscarCandidatosPorNome(nomeNormalizado);
  if (candidatos.length === 0) return null;
  if (!pontoCidade || candidatos.length === 1) return candidatos[0];

  let melhor = candidatos[0];
  let menorDist = haversineM(pontoCidade.lat, pontoCidade.lng, melhor.lat, melhor.lng);
  for (const c of candidatos.slice(1)) {
    const d = haversineM(pontoCidade.lat, pontoCidade.lng, c.lat, c.lng);
    if (d < menorDist) { menorDist = d; melhor = c; }
  }
  return menorDist <= DISTANCIA_MAX_MATCH_LOCAL_M ? melhor : null;
}
```

Nota: quando `candidatos.length === 1` e não há `pontoCidade` (cidade não
resolvida), retorna o único candidato sem checar distância — um nome de
rua único no país inteiro é, por si só, forte o suficiente. Quando há
`pontoCidade` E só 1 candidato, mesma lógica se aplica hoje sem checagem
de distância (simplificação aceita — o caso realmente perigoso é nome
AMBíGUO longe da cidade certa, coberto pela checagem de distância nos
demais candidatos).

### 5. Resolução de cidade por lote, com cache

`geocodificarEndereco` ganha um parâmetro novo (posicional, antes de
`deps`): `pontoCidade: { lat: number; lng: number } | null`. A cadeia
interna vira: cache → `geocodificarLocal` (novo, usando `pontoCidade`) →
Google → Nominatim (endereço completo, comportamento inalterado).

Em `src/app/api/romaneio/processar-geocode/route.ts`: antes do loop de
geocodificação do lote, extrai as cidades únicas das linhas pendentes
(via `extrairCidadeDoEndereco`), resolve cada uma via
`geocodificarNominatim` (reaproveitando `romaneio_geocode_cache`, com uma
chave prefixada `CIDADE:<nomeNormalizado>` pra não colidir com endereços
reais — sem tabela nova), respeitando o MESMO throttle de ~1,1s já usado
pro loop principal (cidades únicas por lote são poucas, dezenas no
máximo, então isso soma pouco tempo). Monta um `Map<cidade, ponto>` e
passa o ponto certo pra cada linha ao chamar `geocodificarEndereco`.

## Fora de escopo

- Configurar `GOOGLE_MAPS_API_KEY` (decisão já tomada, mantida).
- Interpolação por número de porta ao longo da via (sem dado
  `addr:housenumber` confiável no extrato).
- Atualização automática de `vias_nomes` (mesmo espírito de
  `vias_celulas`: ingestão manual esporádica, sem cron).
- Cobertura fora do RJ.

## Testes

Lógica pura testável isoladamente: `extrairRuaDoEndereco`,
`extrairCidadeDoEndereco`, `normalizarNomeRua`, `geocodificarLocal`
(mockando `buscarCandidatosPorNome`, cobrindo: zero candidatos, um
candidato sem cidade, múltiplos candidatos com escolha do mais próximo,
candidato único longe rejeitado pela salvaguarda de distância). Script de
ingestão validado contra uma amostra real (ex.: buscar `"MONS MIGUEL REIS
MELLO"` depois de rodar e confirmar que aparece com coordenada plausível
na região de Natividade). Migration aplicada e confirmada. `tsc`/
`eslint`/suite completa/`build` limpos nos dois repos antes do push.
Nunca rodar o motor de produção diretamente.
