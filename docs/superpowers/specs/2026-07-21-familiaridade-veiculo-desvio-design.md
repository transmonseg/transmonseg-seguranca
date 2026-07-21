# Familiaridade histórica por veículo na Camada 3 de desvio, Design

**Data:** 2026-07-21
**Status:** aprovado pelo usuário, indo para plano

## Problema

Continuação da pergunta de hoje ("e a questão dos desvios como podemos
melhorar?", escopo restrito a desvio de rota). A Camada 3 de desvio
(`foraTapeteStreak`, `src/lib/detectores.ts:627`) dispara quando um veículo
se aproxima de um destino mas por caminho fora do "tapete histórico"
(`corredor_celulas`) — uma grade de células ~100m de todas as vias já
percorridas pela **frota inteira** do cliente nos últimos 30 dias.

O problema: `corredor_celulas` é agregado por `cliente_id`, não por
`veiculo_id`. Ele não distingue "esse motorista específico tem esse atalho
como rotina pessoal" de "foi só outro caminhão da frota que passou aqui uma
vez". Isso gera falso positivo quando um motorista usa uma variação de rota
legítima e recorrente que nenhum outro veículo da frota costuma usar — e
desperdiça um sinal que poderia reforçar a suspeita quando NEM a frota nem
aquele veículo específico jamais estiveram na área.

Investigação prévia relevante (já documentada, não repetir): uma abordagem
de baseline por **par origem-destino exato** foi tentada e abandonada em
11/07 — só 1,2% dos pares se repetem em 2+ dias, dado insuficiente. Esta
proposta é deliberadamente diferente: não exige que a mesma rota/destino se
repita, só que o veículo tenha estado fisicamente na mesma **área** antes
(célula ~100m), independente do motivo daquela vez.

## Decisão

**Amortecer, nunca suprimir** (confirmado com o usuário). Familiaridade
pessoal do veículo com uma área aumenta o limiar de streak exigido antes do
alerta virar crítico, mas nunca impede o alerta de disparar se o padrão
persistir. Mantém intacta a regra de segurança de 11/07 (desvio nunca fecha
sozinho, nunca é suprimido por completo por um único sinal).

**Não usar `posicoes_historico` como fonte de leitura.** Essa tabela (criada
hoje, Problema C) é log bruto por ciclo — 90 dias × 456 veículos × ~30s de
cadência, cara demais pra consultar em todo ciclo do motor. Em vez disso,
espelha-se a estrutura que `corredor_celulas` já usa com sucesso: uma tabela
pequena e deduplicada de "célula já visitada", só que chaveada por
`veiculo_id` em vez de `cliente_id`. Zero novo custo de I/O externo (não
chama OSRM/Valhalla).

## Escopo

### 1. Migration `025_corredor_celulas_veiculo.sql`

```sql
CREATE TABLE corredor_celulas_veiculo (
  veiculo_id uuid NOT NULL REFERENCES veiculos(id),
  celula text NOT NULL,
  ultimo_visto date NOT NULL,
  PRIMARY KEY (veiculo_id, celula)
);
CREATE INDEX corredor_celulas_veiculo_visto_idx ON corredor_celulas_veiculo (ultimo_visto);
```

Mesmo shape de `corredor_celulas` (`scripts/migrations/010_...sql` /
`014_...sql`), sem RLS — tabela interna do motor, nunca exposta a rota
pública/client, mesma classe de `corredor_celulas` e `cerca_sombra`.

### 2. Escrita (`src/app/api/motor/route.ts`)

No mesmo ponto onde `celulasCiclo.push({ cliente_id, celula: c, origem,
destino })` já roda hoje (linha ~1242-1244, dentro do
`for (const c of celulasDoSegmento(...))`), adiciona em paralelo:

```ts
celulasVeiculoCiclo.push({ veiculo_id, celula: c });
```

Novo array de ciclo `celulasVeiculoCiclo: { veiculo_id: string; celula:
string }[]`, declarado perto de `celulasCiclo`. Upsert em lote ao lado do
upsert existente de `corredor_celulas` (linha ~2400), usando `UNNEST` (mesmo
padrão de `posicoes_historico`):

```sql
INSERT INTO corredor_celulas_veiculo (veiculo_id, celula, ultimo_visto)
SELECT v.veiculo_id, v.celula, current_date
FROM unnest($1::uuid[], $2::text[]) AS v(veiculo_id, celula)
ON CONFLICT (veiculo_id, celula) DO UPDATE
  SET ultimo_visto = EXCLUDED.ultimo_visto
  WHERE corredor_celulas_veiculo.ultimo_visto < EXCLUDED.ultimo_visto
```

Mesmo padrão defensivo de `corredor_celulas`/`cerca_sombra`: erro vira
`console.warn`, nunca `erros.push` (não derruba o ciclo).

### 3. Leitura (pré-passada por ciclo, batch)

Análoga a `buscarCelulasTapeteCandidatas` (linha ~844), mas por veículo. Para
cada veículo fresco do ciclo, monta os pares `(veiculo_id, célula)` da
vizinhança 3x3 da posição atual (`vizinhanca3x3`, já usada em
`dentroTapete`), e busca em lote:

```sql
SELECT c.veiculo_id, c.celula
FROM corredor_celulas_veiculo c
JOIN unnest($1::uuid[], $2::text[]) AS cand(veiculo_id, celula)
  USING (veiculo_id, celula)
```

Uma query por ciclo (não por veículo), igual ao padrão já usado em todo o
resto do arquivo. Resultado vira `Set<string>` de chaves `"${veiculo_id}:${celula}"`
pra checagem O(1) por veículo no loop.

### 4. Piso de cold-start por veículo

Análogo a `TAPETE_MIN_CELULAS = 300` (que é por frota inteira), mas
calibrado bem menor por ser por veículo único:

```ts
const FAMILIARIDADE_MIN_CELULAS = 30;
```

Contagem de células distintas do próprio veículo
(`SELECT count(*) FROM corredor_celulas_veiculo WHERE veiculo_id = $1`),
cacheada por veículo com o mesmo TTL de `CACHE_TAPETE_MS` já usado pra
`contagemTapeteCliente`. Sem essa cobertura mínima, `familiarVeiculo` fica
`null` — veículo novo na frota (ou recém-substituído) não ganha nenhum
desconto de suspeita por falta de histórico, mesma proteção anti-cold-start
já usada em `dentroTapete`.

### 5. Consumo em `detectores.ts`

Novo campo em `ContextoDesvio`: `familiarVeiculo: boolean | null` (mesmo
shape de `dentroTapete`). Em `detectarDesvio` (linha ~627), o limiar de
streak passa a ser condicional:

```ts
const FORA_TAPETE_STREAK_MIN = 2; // já existe, frota-padrão
const FORA_TAPETE_STREAK_MIN_FAMILIAR = 5; // novo, quando familiarVeiculo === true

const limiar = ctx.familiarVeiculo === true
  ? FORA_TAPETE_STREAK_MIN_FAMILIAR
  : FORA_TAPETE_STREAK_MIN;

if (CAMADA3_TAPETE_ATIVA && !afastandoDeTudo && ctx.foraTapeteStreak >= limiar) {
  // dispara igual, só exige mais leituras consecutivas quando o veículo
  // já é "familiar" com aquela área
}
```

Escopo cirúrgico: só a Camada 3 é tocada. Camada 1 (comportamental/Welford)
e cerca virtual (OSRM/Valhalla) ficam fora — a Camada 3 é a única que já
existe especificamente pra "via conhecida ou não", então é o ponto natural
pra essa refinação, sem introduzir uma camada nova.

## Fora de escopo

- Nenhuma mudança em `posicoes_historico` (continua só auditoria/debug).
- Nenhuma mudança em cerca virtual, comportamental (Welford) ou UI do
  operador.
- Limpeza de `corredor_celulas_veiculo`: reaproveita o mesmo padrão de
  limpeza de `corredor_celulas` (`DELETE ... WHERE ultimo_visto < current_date - 30`,
  linha ~2637) — adiciona a mesma linha pra tabela nova, mesma janela de 30
  dias (não 90 — é sinal de rota conhecida, não auditoria).

## Testes

Migration aplicada e coluna/índice/PK confirmados. Teste unitário puro pra
qualquer nova função auxiliar (se houver extração de lógica de limiar).
Validação isolada do INSERT/query em lote contra a tabela real (nunca rodar
o motor de produção): script Node avulso simulando o upsert e a leitura,
confirmando o comportamento do `ON CONFLICT` e do `JOIN unnest`, dado
revertido depois. `tsc`/`eslint`/suite completa (`vitest`)/`build` limpos nos
dois repos antes do push.
