# Correção manual de posição de cliente — Design

**Contexto:** no mesmo dia em que `pontos_aprendidos` foi ativado (correção
automática de posição por acúmulo de paradas reais, ≥5 observações), o
usuário mandou uma planilha oficial de 576 clientes de entrega (Nutry Max)
com endereço completo de cada um. Comparando por nome contra as 648
marcações que o sistema tem hoje (vindas da API Unitrac), a investigação
achou casos reais de posição/nome desatualizado que **já têm `pontocodigo`
na Unitrac** — não precisam esperar histórico se acumular, o endereço real
já está confirmado (planilha + Google Maps) e pode corrigir hoje.

Achado importante que define o escopo: parte dos "sem match" (redes como
HNT, GPA, Hortigil) **não têm `pontocodigo` nenhum** — nunca aparecem como
alvo na resposta da API Unitrac, confirmado consultando a API ao vivo.
Esses são um problema de cadastro na Unitrac (sistema de terceiro), fora
do alcance de qualquer correção de posição — não existe "ponto" pra
corrigir. **Fora de escopo desta feature.**

## O que ativa

Um mecanismo de correção MANUAL, complementar ao automático já existente,
pra casos onde já se sabe a posição certa (endereço confirmado por fonte
externa confiável — hoje: planilha oficial do cliente + Google Maps) sem
precisar esperar 5+ paradas reais.

## Schema

`scripts/migrations/contabo/034_fonte_pontos_aprendidos.sql`:

```sql
ALTER TABLE pontos_aprendidos
  ADD COLUMN IF NOT EXISTS fonte text NOT NULL DEFAULT 'aprendido'
  CHECK (fonte IN ('aprendido', 'manual'));

-- Cron noturno (aprender_pontos_entrega, migration 028) nunca mais toca
-- numa linha marcada manual -- so atualiza linhas 'aprendido', e so cria
-- linha nova se nao existir nenhuma pra aquele (cliente_id, ponto_codigo).
-- Substitui o ON CONFLICT DO UPDATE incondicional por um com WHERE.
CREATE OR REPLACE FUNCTION aprender_pontos_entrega() RETURNS void
LANGUAGE sql AS $$
  WITH medianas AS (
    SELECT cliente_id, ponto_codigo,
           percentile_cont(0.5) WITHIN GROUP (ORDER BY lat) AS mlat,
           percentile_cont(0.5) WITHIN GROUP (ORDER BY lng) AS mlng
      FROM entregas_presenca
     WHERE cliente_id IS NOT NULL AND ponto_codigo IS NOT NULL
       AND lat IS NOT NULL AND lng IS NOT NULL
     GROUP BY cliente_id, ponto_codigo
  ),
  observacoes AS (
    SELECT o.cliente_id, o.ponto_codigo, o.lat, o.lng, o.dia,
           ST_Distance(
             ST_SetSRID(ST_MakePoint(o.lng, o.lat), 4326)::geography,
             ST_SetSRID(ST_MakePoint(m.mlng, m.mlat), 4326)::geography
           ) AS dist_mediana_m
      FROM entregas_presenca o
      JOIN medianas m USING (cliente_id, ponto_codigo)
     WHERE o.lat IS NOT NULL AND o.lng IS NOT NULL
  )
  INSERT INTO pontos_aprendidos (cliente_id, ponto_codigo, lat, lng, raio_m, n_observacoes, primeira_observacao, ultima_observacao, fonte)
  SELECT cliente_id, ponto_codigo,
         avg(lat), avg(lng),
         GREATEST(max(dist_mediana_m), 30),
         count(*), min(dia), max(dia), 'aprendido'
    FROM observacoes
   WHERE dist_mediana_m <= 500
   GROUP BY cliente_id, ponto_codigo
  HAVING count(*) >= 5
  ON CONFLICT (cliente_id, ponto_codigo) DO UPDATE SET
    lat = EXCLUDED.lat, lng = EXCLUDED.lng, raio_m = EXCLUDED.raio_m,
    n_observacoes = EXCLUDED.n_observacoes,
    primeira_observacao = EXCLUDED.primeira_observacao,
    ultima_observacao = EXCLUDED.ultima_observacao,
    atualizado_em = now()
  WHERE pontos_aprendidos.fonte = 'aprendido';
$$;
```

`WHERE pontos_aprendidos.fonte = 'aprendido'` no final do `ON CONFLICT DO
UPDATE`: Postgres suporta condição na cláusula de update do conflito — se
a linha existente tiver `fonte='manual'`, a condição falha, o `UPDATE` não
roda, a linha manual fica intocada. Efeito prático: manual trava pra
sempre, sem graduação automática de volta pro aprendido — decisão
explícita do usuário (clientes são fixos, correção manual já é dado
verificado, não precisa ceder pro automático depois).

`GRANT` já existe pra `app_service` (migration 028) e cobre a coluna nova
automaticamente (não é por coluna).

## Consumo

**Nenhuma mudança** em `src/lib/unitrac.ts` nem em
`src/app/api/motor/route.ts` — `mapaPontosAprendidos` já carrega `SELECT
cliente_id, ponto_codigo, lat, lng FROM pontos_aprendidos` sem filtro por
`fonte`, então uma linha manual é lida e aplicada exatamente como uma
aprendida. `corrigirComPontoAprendido` não precisa saber a origem.

## Script de gravação (reutilizável, não é código de uma vez só)

`scripts/corrigir-pontos-manual.mjs`: recebe um CSV com colunas
`cliente_id, ponto_codigo, lat, lng, motivo` e faz upsert em
`pontos_aprendidos` com `fonte='manual'`. Serve pra qualquer correção
manual futura, não só a de hoje.

```javascript
// scripts/corrigir-pontos-manual.mjs
//
// Grava correcoes manuais de posicao em pontos_aprendidos (fonte='manual').
// Uma vez gravada, o cron noturno (aprender_pontos_entrega) nunca mais
// sobrescreve essa linha -- ver migration 034 e
// docs/superpowers/specs/2026-08-10-correcao-manual-pontos-design.md.
//
// Uso: node scripts/corrigir-pontos-manual.mjs <arquivo.csv>
// CSV precisa ter header: cliente_id,ponto_codigo,lat,lng,motivo
import pg from "pg";
import { readFileSync } from "node:fs";

const DATABASE_URL =
  process.env.DATABASE_URL ??
  "postgres://app_service:5cf0fd1c8cfc0dfdf66a19196d5e6ebc691bbc628d7e637c@localhost:5432/transmonseg";

const arquivo = process.argv[2];
if (!arquivo) {
  console.error("Uso: node scripts/corrigir-pontos-manual.mjs <arquivo.csv>");
  process.exit(1);
}

function parseCsv(texto) {
  const linhas = texto.trim().split("\n");
  const header = linhas[0].split(",");
  return linhas.slice(1).map((l) => {
    const valores = l.split(",");
    return Object.fromEntries(header.map((h, i) => [h.trim(), valores[i]?.trim()]));
  });
}

const linhas = parseCsv(readFileSync(arquivo, "utf-8"));
const client = new pg.Client({ connectionString: DATABASE_URL });
await client.connect();

let gravados = 0;
for (const l of linhas) {
  const { cliente_id, ponto_codigo, lat, lng, motivo } = l;
  if (!cliente_id || !ponto_codigo || !lat || !lng) {
    console.warn(`Pulando linha incompleta: ${JSON.stringify(l)}`);
    continue;
  }
  await client.query(
    `INSERT INTO pontos_aprendidos (cliente_id, ponto_codigo, lat, lng, raio_m, n_observacoes, primeira_observacao, ultima_observacao, fonte)
     VALUES ($1, $2, $3, $4, 30, 1, current_date, current_date, 'manual')
     ON CONFLICT (cliente_id, ponto_codigo) DO UPDATE SET
       lat = EXCLUDED.lat, lng = EXCLUDED.lng, fonte = 'manual', atualizado_em = now()`,
    [cliente_id, Number(ponto_codigo), Number(lat), Number(lng)]
  );
  gravados++;
  console.log(`Gravado: cliente=${cliente_id} ponto=${ponto_codigo} (${motivo ?? "sem motivo"})`);
}

await client.end();
console.log(`\n${gravados} correções manuais gravadas.`);
```

Nota: `raio_m=30` (piso mínimo já usado pelo cron real, `GREATEST(...,
30)`) e `n_observacoes=1` são valores nominais pra uma linha manual — não
representam observações de verdade, só preenchem os campos NOT NULL da
tabela de forma honesta (não inventam um histórico que não existe).

## Montagem da lista de hoje (análise, não faz parte do mecanismo)

Separado do script acima (que é genérico): cruzar os achados de hoje
(52 casos individuais geocodificados + os `MESMO_CLIENTE_CONFIRMADO` que
vierem da reclassificação dos 334 "match fraco", ainda rodando) contra o
`pontocodigo` real de cada cliente (via dump da API Unitrac, já baixado
hoje em investigação anterior) — produz o CSV de entrada do script acima.
**Essa lista é revisada manualmente antes de rodar o script** — é escrita
permanente em produção, correspondência por nome/fuzzy match tem risco
real de erro (confirmado repetidas vezes nesta mesma sessão), não roda
sem revisão humana.

## Testes

- Sem teste automatizado pro script (é utilitário standalone, mesmo
  padrão de `scripts/backtest-desvio/carregar-corpus.mjs` de hoje mais
  cedo — sem teste, verificado manualmente contra produção real).
- Verificação real pós-deploy: gravar 1 correção manual de teste (ou a
  primeira real da lista revisada), confirmar via SQL que
  `pontos_aprendidos.fonte='manual'` pra aquela linha, esperar o próximo
  ciclo do motor, confirmar via `pendentes_snapshot_log` (`latBruta` vs
  `lat`) que a correção está sendo aplicada — mesmo padrão de verificação
  já usado hoje pra `pontos_aprendidos` automático.
- Verificação da proteção do cron: não dá pra esperar até 04:20 pra testar
  ao vivo dentro desta sessão — testar a query da função
  `aprender_pontos_entrega()` isoladamente via `psql`, inserindo uma linha
  manual de teste + observações fake em `entregas_presenca` que bateriam
  o limiar de 5, rodar a função manualmente (`SELECT
  aprender_pontos_entrega();`), confirmar que a linha manual NÃO mudou.

## Não-objetivos

- Não corrige os clientes sem `pontocodigo` (HNT, GPA, Hortigil, etc.) —
  precisam de cadastro na Unitrac em si, fora do nosso sistema.
- Não constrói UI pra gravar correção manual pelo operador — só o script
  CLI. Uma tela fica pra depois, se a necessidade aparecer (mesmo padrão
  de "não constrói UI de relatório" já usado nas specs de hoje).
- Não muda o teto de divergência (500m) nem a lógica de
  `corrigirComPontoAprendido` — reusa exatamente como está.
- Não resolve automaticamente qual `pontocodigo` corresponde a qual linha
  da planilha — isso é trabalho de análise (fuzzy match + revisão humana),
  não parte do mecanismo em si.
