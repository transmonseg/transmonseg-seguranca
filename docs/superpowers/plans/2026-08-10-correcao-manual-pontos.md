# Correção Manual de Pontos Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Adicionar um mecanismo de correção MANUAL de posição de cliente,
complementar ao `pontos_aprendidos` automático já ativado hoje — uma
coluna `fonte` na mesma tabela protege linhas manuais do recálculo
noturno, e um script CLI reutilizável grava correções.

**Architecture:** Migration adiciona `fonte` + concede `INSERT`/`UPDATE`
pro role da aplicação + reescreve a função do cron com um `WHERE`
condicional no `ON CONFLICT DO UPDATE` (só toca linhas `fonte='aprendido'`).
Script standalone (`node scripts/corrigir-pontos-manual.mjs <csv>`) faz
upsert com `fonte='manual'`. Nenhum consumidor de produção
(`route.ts`/`unitrac.ts`) muda — já lê a tabela inteira sem filtrar por
`fonte`.

**Tech Stack:** Postgres (Contabo), Node.js (script standalone, `pg`
client, mesmo padrão de `scripts/backtest-desvio/carregar-corpus.mjs`).

## Global Constraints

- Spec de origem: `docs/superpowers/specs/2026-08-10-correcao-manual-pontos-design.md`
  — ler o arquivo inteiro antes de qualquer task.
- Ambos os repos (`MONITORAMENTO TEMP` e `MONITORAMENTO transmonseg`)
  recebem os mesmos commits ao final. Deploy real no Contabo
  (`transmonseg-vps`, pm2 `transmonseg-temp` e `transmonseg-definitivo`)
  só no último task — inclui aplicar a migration 034 via `psql` em
  produção, além do deploy de código normal.
- `app_service` (role usado tanto pelo motor quanto pelo script CLI) só
  tinha `GRANT SELECT` em `pontos_aprendidos` (migration 028) — a
  migration 034 PRECISA conceder `INSERT, UPDATE` também, senão o script
  falha com erro de permissão em produção.
- Sem teste automatizado pro script (utilitário standalone, mesmo padrão
  já confirmado hoje pra `scripts/backtest-desvio/carregar-corpus.mjs` e
  `scripts/backtest-desvio/index.mjs` — nenhum script utilitário deste
  projeto tem teste automatizado).
- `DATABASE_URL` de produção:
  `postgres://app_service:5cf0fd1c8cfc0dfdf66a19196d5e6ebc691bbc628d7e637c@localhost:5432/transmonseg`,
  só acessível de dentro do Contabo (via `ssh transmonseg-vps`).

---

### Task 1: Migration 034 — coluna `fonte`, grant, e proteção do cron

**Files:**
- Create: `scripts/migrations/contabo/034_fonte_pontos_aprendidos.sql`

**Interfaces:**
- Consumes: nada de outras tasks.
- Produces: coluna `pontos_aprendidos.fonte` (`text`, default `'aprendido'`,
  `CHECK (fonte IN ('aprendido', 'manual'))`) e a função
  `aprender_pontos_entrega()` reescrita — consumidos pelo Task 2 (o script
  grava `fonte='manual'` nessa coluna) e pela verificação de produção do
  Task 3.

Este projeto não tem framework de migration automatizado — os arquivos em
`scripts/migrations/contabo/` são aplicados manualmente via `psql` contra
produção (confirmar isso rodando o Step 3 abaixo LOCALMENTE primeiro,
contra um snapshot/dry-run mental da sintaxe — a aplicação real em
produção acontece só no Task 3, com autorização do controller).

- [ ] **Step 1: Criar o arquivo de migration**

```sql
-- scripts/migrations/contabo/034_fonte_pontos_aprendidos.sql
--
-- Correcao manual de posicao (usuario, 10/08) -- complementa
-- pontos_aprendidos (migration 028, automatico por acumulo de paradas
-- reais). Ver docs/superpowers/specs/2026-08-10-correcao-manual-pontos-design.md.
--
-- Motivacao: investigacao real com planilha oficial de clientes (Nutry
-- Max) + geocodificacao via Google Maps achou casos de posicao/nome
-- desatualizado que JA TEM pontocodigo na Unitrac -- nao precisam esperar
-- 5+ observacoes se acumularem, o endereco certo ja foi confirmado por
-- fonte externa confiavel.

ALTER TABLE pontos_aprendidos
  ADD COLUMN IF NOT EXISTS fonte text NOT NULL DEFAULT 'aprendido'
  CHECK (fonte IN ('aprendido', 'manual'));

-- app_service so tinha SELECT (migration 028) -- o script de gravacao
-- manual (scripts/corrigir-pontos-manual.mjs) roda com esse mesmo role,
-- precisa escrever.
GRANT INSERT, UPDATE ON pontos_aprendidos TO app_service;

-- Cron noturno (aprender_pontos_entrega) nunca mais toca numa linha
-- marcada manual -- so atualiza linhas 'aprendido', e so cria linha nova
-- se nao existir nenhuma pra aquele (cliente_id, ponto_codigo). Unica
-- mudanca real vs a versao original (migration 028): o WHERE no final do
-- ON CONFLICT DO UPDATE.
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

- [ ] **Step 2: Confirmar sintaxe localmente (sem banco disponível fora do Contabo)**

Este repo não tem Postgres local — não dá pra rodar a migration aqui.
Confirme que o SQL é sintaticamente equivalente à função original
(`scripts/migrations/contabo/028_pontos_aprendidos.sql`, função
`aprender_pontos_entrega`) com APENAS estas 2 diferenças: (a) `fonte`
adicionado à lista de colunas do `INSERT` e ao `SELECT` (valor literal
`'aprendido'`); (b) a linha `WHERE pontos_aprendidos.fonte = 'aprendido'`
adicionada como última linha da função, depois do `ON CONFLICT DO UPDATE
SET ...`. Faça um diff mental linha a linha contra o arquivo 028 pra
confirmar que nada mais mudou.

- [ ] **Step 3: Commit**

```bash
git add scripts/migrations/contabo/034_fonte_pontos_aprendidos.sql
git commit -m "feat(db): coluna fonte em pontos_aprendidos + protege linhas manuais do cron"
```

(A aplicação real em produção — `psql < 034_...sql` — acontece no Task 3,
não aqui.)

---

### Task 2: Script CLI de gravação manual

**Files:**
- Create: `scripts/corrigir-pontos-manual.mjs`

**Interfaces:**
- Consumes: coluna `fonte` (Task 1) — assume que já existe em produção
  quando rodar de verdade (só roda contra produção no Task 3).
- Produces: nada consumido por outra task deste plano — é a entrega final
  do mecanismo.

- [ ] **Step 1: Criar o script**

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

- [ ] **Step 2: Confirmar que o script roda sem erro sintático localmente**

Run: `node --check scripts/corrigir-pontos-manual.mjs`
Expected: sem output (sintaxe válida). Não dá pra testar contra banco de
verdade fora do Contabo — a execução real acontece no Task 3.

- [ ] **Step 3: Commit**

```bash
git add scripts/corrigir-pontos-manual.mjs
git commit -m "feat(scripts): CLI reutilizavel pra gravar correcoes manuais de posicao"
```

---

### Task 3: Sincronizar mirror, aplicar migration e deploy real

**Files:** nenhum arquivo novo — task de integração/deploy.

- [ ] **Step 1: Push do repo principal**

```bash
cd "/Users/joaquimsalles/Projects/Transmonseg/monitoramento/MONITORAMENTO TEMP"
git push origin master
```

- [ ] **Step 2: Sincronizar o mirror `MONITORAMENTO transmonseg`**

```bash
cd "/Users/joaquimsalles/Projects/Transmonseg/monitoramento/MONITORAMENTO transmonseg"
git remote add temp-local "/Users/joaquimsalles/Projects/Transmonseg/monitoramento/MONITORAMENTO TEMP"
git fetch temp-local master
git cherry-pick <hash-Task-1>..<hash-Task-2>
git remote remove temp-local
git push origin main
```

- [ ] **Step 3: Aplicar a migration 034 em produção**

```bash
ssh transmonseg-vps "psql 'postgres://app_service:5cf0fd1c8cfc0dfdf66a19196d5e6ebc691bbc628d7e637c@localhost:5432/transmonseg' -f /srv/transmonseg/temp/scripts/migrations/contabo/034_fonte_pontos_aprendidos.sql"
```

(Rodar DEPOIS do `git pull` no VPS — ver Step 4 — pra garantir que o
arquivo já está lá. Reordene se necessário: pull primeiro, depois aplicar
a migration, depois build/restart.)

Expected: sem erro. Confirmar via SQL:
```bash
ssh transmonseg-vps "psql 'postgres://app_service:5cf0fd1c8cfc0dfdf66a19196d5e6ebc691bbc628d7e637c@localhost:5432/transmonseg' -c \"select column_name, column_default from information_schema.columns where table_name='pontos_aprendidos' and column_name='fonte';\""
```
Expected: 1 linha, `column_default` mostrando `'aprendido'::text`.

- [ ] **Step 4: Deploy real, os dois processos**

```bash
ssh transmonseg-vps "cd /srv/transmonseg/temp && git pull origin master && npm run build && pm2 restart transmonseg-temp"
ssh transmonseg-vps "cd /srv/transmonseg/definitivo && git pull origin main && npm run build && pm2 restart transmonseg-definitivo"
```

(Sem mudança de `package.json` neste plano — confirmar com `git diff HEAD
origin/master -- package.json package-lock.json` antes de assumir que dá
pra pular `npm install`.)

- [ ] **Step 5: Verificar via pm2 que os dois processos subiram sem erro fatal**

```bash
ssh transmonseg-vps "pm2 describe transmonseg-temp | grep -E 'status|restart'; pm2 logs transmonseg-temp --lines 30 --nostream | grep -iE 'error|exception|fatal' | grep -v ECONNREFUSED | grep -v ConnectTimeout | grep -v 'fetch failed'"
ssh transmonseg-vps "pm2 describe transmonseg-definitivo | grep -E 'status|restart'; pm2 logs transmonseg-definitivo --lines 30 --nostream | grep -iE 'error|exception|fatal' | grep -v ECONNREFUSED | grep -v ConnectTimeout | grep -v 'fetch failed'"
```

- [ ] **Step 6: Verificação real do mecanismo — gravar 1 correção de teste, confirmar aplicação**

Escolher UM `(cliente_id, ponto_codigo)` real e ativo hoje (ex: reusar um
dos códigos já investigados hoje, como `633161`, cliente_id
`cfcb52f5-fd01-47c7-988c-d13a10f0d8fd`) com uma posição de teste
propositalmente deslocada ~50m da atual (não precisa ser a posição real
verificada — é só validação do mecanismo, a lista de correções reais de
hoje é trabalho separado, fora deste plano):

```bash
ssh transmonseg-vps "cd /srv/transmonseg/temp && echo 'cliente_id,ponto_codigo,lat,lng,motivo
cfcb52f5-fd01-47c7-988c-d13a10f0d8fd,633161,-22.986800,-43.197800,teste de verificacao do mecanismo' > /tmp/teste-manual.csv && node scripts/corrigir-pontos-manual.mjs /tmp/teste-manual.csv"
```

Expected: log `Gravado: cliente=... ponto=633161 (...)`, `1 correções
manuais gravadas.`

Confirmar via SQL:
```bash
ssh transmonseg-vps "psql 'postgres://app_service:5cf0fd1c8cfc0dfdf66a19196d5e6ebc691bbc628d7e637c@localhost:5432/transmonseg' -c \"select cliente_id, ponto_codigo, lat, lng, fonte from pontos_aprendidos where ponto_codigo=633161;\""
```
Expected: `fonte='manual'`, `lat`/`lng` batendo com o valor de teste
gravado.

- [ ] **Step 7: Verificar que o cron noturno NÃO sobrescreveria essa linha**

Rodar a função isoladamente (sem esperar até 04:20):
```bash
ssh transmonseg-vps "psql 'postgres://app_service:5cf0fd1c8cfc0dfdf66a19196d5e6ebc691bbc628d7e637c@localhost:5432/transmonseg' -c \"select lat, lng, fonte from pontos_aprendidos where ponto_codigo=633161;\" -c \"select aprender_pontos_entrega();\" -c \"select lat, lng, fonte from pontos_aprendidos where ponto_codigo=633161;\""
```
Expected: `lat`/`lng`/`fonte` idênticos ANTES e DEPOIS de rodar
`aprender_pontos_entrega()` — a linha de teste não muda, mesmo que
existam observações reais em `entregas_presenca` pra esse ponto (o
`WHERE fonte='aprendido'` bloqueia o update).

- [ ] **Step 8: Reverter a linha de teste**

Como o valor gravado no Step 6 foi só de teste (não é a posição real
verificada), reverter pra não deixar dado de teste contaminando produção:

```bash
ssh transmonseg-vps "psql 'postgres://app_service:5cf0fd1c8cfc0dfdf66a19196d5e6ebc691bbc628d7e637c@localhost:5432/transmonseg' -c \"delete from pontos_aprendidos where ponto_codigo=633161 and fonte='manual';\""
```

Confirmar que a linha sumiu (ou, se já existisse uma linha `fonte='aprendido'`
pra esse ponto antes do teste, que ela continua lá intacta — o `DELETE`
acima só mira `fonte='manual'`, não apaga uma linha aprendida por engano).

- [ ] **Step 9: Atualizar o ledger do plano com o resumo final**

Documentar no ledger: hashes de commit finais nos dois repos, confirmação
de que a migration foi aplicada, resultado dos Steps 6-8 (mecanismo
verificado funcionando + protegido do cron + limpo depois do teste).
