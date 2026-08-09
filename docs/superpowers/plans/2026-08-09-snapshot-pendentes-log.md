# Log de snapshot de pendentes por ciclo — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** gravar um snapshot leve e periódico (throttle de 5min/veículo) dos
destinos pendentes que a Unitrac manda pro motor a cada ciclo — puramente
pra investigação futura de "por que um detector não disparou", nunca lido
por nenhum detector.

**Architecture:** nova tabela de log (mesmo padrão de `placar_desvio_log`)
+ coleta throttled por ciclo no motor + flush em lote no final, tolerante a
falha parcial. Retenção de 30 dias via pg_cron, criada junto da tabela.

**Tech Stack:** Postgres (migração SQL), TypeScript/Node (route.ts).

## Global Constraints

- Nunca lido por nenhum detector/lógica de decisão — puramente auditoria.
- Throttle de 5 minutos por veículo (não grava todo ciclo de 30s).
- Retenção de 30 dias via pg_cron, na MESMA migração que cria a tabela.
- Toda mudança de código replicada pro repo espelho e deployada nos 2
  processos PM2. Migração SQL aplicada nos DOIS bancos (TEMP e definitivo
  compartilham o mesmo Postgres real do Contabo — confirmar antes de rodar
  duas vezes à toa).
- Spec completa: `docs/superpowers/specs/2026-08-09-snapshot-pendentes-log-design.md`.

---

### Task 1: Migração SQL (tabela + retenção)

**Files:**
- Create: `scripts/migrations/contabo/029_pendentes_snapshot_log.sql`
- Create: `scripts/migrations/contabo/030_retencao_pendentes_snapshot_log.sql`

**Interfaces:**
- Produces: tabela `pendentes_snapshot_log` no Postgres do Contabo,
  consumida pela Task 2.

- [ ] **Step 1: Criar a migração da tabela**

`scripts/migrations/contabo/029_pendentes_snapshot_log.sql`:

```sql
-- Log de snapshot de pendentes por ciclo -- ver
-- docs/superpowers/specs/2026-08-09-snapshot-pendentes-log-design.md.
-- Puramente auditoria/investigacao (mesmo padrao de placar_desvio_log) --
-- NUNCA lido por nenhum detector.
CREATE TABLE IF NOT EXISTS pendentes_snapshot_log (
  id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  veiculo_id uuid NOT NULL REFERENCES veiculos(id),
  criado_em timestamptz NOT NULL DEFAULT now(),
  tem_pendentes boolean NOT NULL,
  alvos_api_ok boolean NOT NULL,
  pendentes jsonb NOT NULL
);
CREATE INDEX IF NOT EXISTS pendentes_snapshot_log_veiculo_tempo_idx
  ON pendentes_snapshot_log (veiculo_id, criado_em);
CREATE INDEX IF NOT EXISTS pendentes_snapshot_log_criado_em_idx
  ON pendentes_snapshot_log (criado_em);

GRANT SELECT, INSERT ON pendentes_snapshot_log TO app_service;
GRANT USAGE ON SEQUENCE pendentes_snapshot_log_id_seq TO app_service;
```

- [ ] **Step 2: Criar a migração de retenção**

`scripts/migrations/contabo/030_retencao_pendentes_snapshot_log.sql`:

```sql
select cron.schedule(
  'limpar-pendentes-snapshot-log',
  '0 4 * * *',
  $$delete from pendentes_snapshot_log where criado_em < now() - interval '30 days'$$
);
```

- [ ] **Step 3: Aplicar as duas migrações no Postgres real do Contabo**

```bash
ssh transmonseg-vps "sudo -u postgres psql -d transmonseg -f -" < scripts/migrations/contabo/029_pendentes_snapshot_log.sql
ssh transmonseg-vps "sudo -u postgres psql -d transmonseg -f -" < scripts/migrations/contabo/030_retencao_pendentes_snapshot_log.sql
```

Expected: `CREATE TABLE`, `CREATE INDEX` (x2), `GRANT` (x2) na primeira;
uma linha de retorno do `cron.schedule` (um id numérico) na segunda.

- [ ] **Step 4: Confirmar que a tabela existe e o cron job foi agendado**

```bash
ssh transmonseg-vps "sudo -u postgres psql -d transmonseg -c \"\\d pendentes_snapshot_log\""
ssh transmonseg-vps "sudo -u postgres psql -d transmonseg -c \"select jobname, schedule from cron.job where jobname='limpar-pendentes-snapshot-log';\""
```

- [ ] **Step 5: Commit dos arquivos de migração**

```bash
git add scripts/migrations/contabo/029_pendentes_snapshot_log.sql scripts/migrations/contabo/030_retencao_pendentes_snapshot_log.sql
git commit -m "feat(desvio): migração do log de snapshot de pendentes por ciclo"
```

---

### Task 2: Coleta e flush no motor (`route.ts`)

**Files:**
- Modify: `src/app/api/motor/route.ts`

**Interfaces:**
- Consumes: tabela `pendentes_snapshot_log` da Task 1 (já aplicada em produção).
- Consumes: `pendentes`, `temPendentes`, `alvosDestinosDisponiveis` (já existentes no loop por veículo).

- [ ] **Step 1: Declarar o Map e a constante de throttle em nível de módulo**

Logo depois de `const ultimaVerificacaoCorredorPorVeiculo = new Map<string, number>();` (linha 354 atual):

```typescript
// Log de snapshot de pendentes por ciclo -- ver
// docs/superpowers/specs/2026-08-09-snapshot-pendentes-log-design.md.
// Achado real 09/08: investigacao de 3 misses reportados no grupo bateu
// num limite estrutural -- a lista de pendentes da Unitrac e efemera,
// nunca persistida, entao nao da pra provar retroativamente se havia
// destino perto da posicao real no momento de um miss. Throttle de 5min
// por veiculo (nao grava todo ciclo de 30s) -- granularidade de minutos
// ja basta pra investigacao, sem custo de escrita desnecessario.
const ultimoSnapshotPendentesPorVeiculo = new Map<string, number>();
const SNAPSHOT_PENDENTES_INTERVALO_MS = 5 * 60 * 1000;
```

- [ ] **Step 2: Declarar o array de coleta por ciclo**

Logo depois de `const progressoDestinoCiclo: { alerta_id: string; deltaM: number }[] = [];` (linha 951 atual, mesmo bloco de arrays de coleta por ciclo):

```typescript
    // Snapshot de pendentes por ciclo (throttled) -- ver
    // docs/superpowers/specs/2026-08-09-snapshot-pendentes-log-design.md.
    // Puramente auditoria, nunca lido por nenhum detector.
    const pendentesSnapshotCiclo: {
      veiculo_id: string;
      temPendentes: boolean;
      alvosApiOk: boolean;
      pendentes: { lat: number; lng: number; raio: number; codigo: number | null; nome: string }[];
    }[] = [];
```

- [ ] **Step 3: Coletar no loop por veículo, logo depois de `temPendentes`**

Logo depois de `const temPendentes = pendentes.length > 0;` (linha 1761 atual):

```typescript
          // Snapshot throttled de pendentes -- ver declaração do Map acima.
          const ultimoSnapshot = ultimoSnapshotPendentesPorVeiculo.get(veiculo_id) ?? 0;
          if (Date.now() - ultimoSnapshot >= SNAPSHOT_PENDENTES_INTERVALO_MS) {
            ultimoSnapshotPendentesPorVeiculo.set(veiculo_id, Date.now());
            pendentesSnapshotCiclo.push({
              veiculo_id,
              temPendentes,
              alvosApiOk: alvosDestinosDisponiveis,
              pendentes: pendentes.map((pt) => ({
                lat: pt.lat, lng: pt.lng, raio: pt.raio, codigo: pt.pontoCodigo, nome: pt.nome,
              })),
            });
          }
```

- [ ] **Step 4: Flush em lote no final do ciclo**

Logo depois do bloco de flush de `placarSombraCiclo` (termina na linha 4506 atual, `if (falhasPlacar > 0) console.warn(...)`):

```typescript
    // Flush do snapshot de pendentes -- mesmo padrao de flush em lote,
    // tolerante a falha parcial, dos outros logs de sombra.
    if (pendentesSnapshotCiclo.length > 0) {
      const resultadosSnapshot = await Promise.allSettled(
        pendentesSnapshotCiclo.map((p) =>
          pool.query(
            `insert into pendentes_snapshot_log (veiculo_id, tem_pendentes, alvos_api_ok, pendentes) values ($1, $2, $3, $4::jsonb)`,
            [p.veiculo_id, p.temPendentes, p.alvosApiOk, JSON.stringify(p.pendentes)]
          )
        )
      );
      const falhasSnapshot = resultadosSnapshot.filter((r) => r.status === "rejected").length;
      if (falhasSnapshot > 0) console.warn(`Aviso: ${falhasSnapshot} falha(s) ao gravar snapshot de pendentes neste ciclo`);
    }
```

- [ ] **Step 5: Typecheck e suite completa**

Run: `npx tsc --noEmit && npx vitest run`
Expected: limpo, nenhum teste existente deveria mudar de resultado (este bloco não tem teste unitário dedicado — ver spec, seção Testes).

- [ ] **Step 6: Commit**

```bash
git add src/app/api/motor/route.ts
git commit -m "feat(desvio): gravar snapshot throttled de pendentes por ciclo pra investigação de miss"
```

---

### Task 3: Replicar pro repo espelho + deploy + validação real

**Files:**
- Nenhum arquivo novo além da Task 2 — cópia exata do diff pro repo `MONITORAMENTO transmonseg`. Migração da Task 1 já foi aplicada direto no banco (compartilhado pelos 2 processos) — não precisa repetir.

**Interfaces:**
- Consumes: commit da Task 2 (repo `MONITORAMENTO TEMP`), tabela da Task 1 (já em produção).
- Produces: mesma mudança de código rodando em produção real — encerra o plano.

- [ ] **Step 1: Confirmar que os repos não divergiram**

```bash
cd ~/Projects/Transmonseg/monitoramento
diff "MONITORAMENTO TEMP/src/app/api/motor/route.ts" "MONITORAMENTO transmonseg/src/app/api/motor/route.ts"
```

Se o diff não estiver vazio fora a mudança da Task 2, pare e reporte BLOCKED.

- [ ] **Step 2: Copiar os arquivos**

```bash
cp "MONITORAMENTO TEMP/src/app/api/motor/route.ts" "MONITORAMENTO transmonseg/src/app/api/motor/route.ts"
mkdir -p "MONITORAMENTO transmonseg/scripts/migrations/contabo"
cp "MONITORAMENTO TEMP/scripts/migrations/contabo/029_pendentes_snapshot_log.sql" "MONITORAMENTO transmonseg/scripts/migrations/contabo/"
cp "MONITORAMENTO TEMP/scripts/migrations/contabo/030_retencao_pendentes_snapshot_log.sql" "MONITORAMENTO transmonseg/scripts/migrations/contabo/"
cp "MONITORAMENTO TEMP/docs/superpowers/specs/2026-08-09-snapshot-pendentes-log-design.md" "MONITORAMENTO transmonseg/docs/superpowers/specs/"
cp "MONITORAMENTO TEMP/docs/superpowers/plans/2026-08-09-snapshot-pendentes-log.md" "MONITORAMENTO transmonseg/docs/superpowers/plans/"
```

- [ ] **Step 3: Testes e typecheck no repo espelho**

```bash
cd "MONITORAMENTO transmonseg"
npx tsc --noEmit
npx vitest run
```

- [ ] **Step 4: Commit e push dos dois repos**

```bash
git add -A
git commit -m "feat(desvio): log de snapshot de pendentes por ciclo (replica de MONITORAMENTO TEMP)"
git push origin main
cd "../MONITORAMENTO TEMP"
git push origin master
```

- [ ] **Step 5: Deploy manual no Contabo**

```bash
ssh transmonseg-vps "cd /srv/transmonseg/temp && git pull && npm ci && npm run build && pm2 restart transmonseg-temp --update-env"
ssh transmonseg-vps "cd /srv/transmonseg/definitivo && git pull && npm ci && npm run build && pm2 restart transmonseg-definitivo --update-env"
```

- [ ] **Step 6: Confirmar não regressão**

```bash
ssh transmonseg-vps "pm2 jlist | node -e 'let d=\"\"; process.stdin.on(\"data\",c=>d+=c); process.stdin.on(\"end\",()=>{JSON.parse(d).forEach(p=>console.log(p.name, p.pid, p.pm2_env.status, p.pm2_env.restart_time))})'"
ssh transmonseg-vps "pm2 logs transmonseg-definitivo --lines 40 --nostream"
```

Expected: ambos online, sem erro novo relacionado a "pendentes_snapshot"/"snapshot".

- [ ] **Step 7: Validação real — confirmar que a tabela está recebendo linhas**

```bash
ssh transmonseg-vps "sudo -u postgres psql -d transmonseg -c \"select count(*), min(criado_em), max(criado_em) from pendentes_snapshot_log;\""
```

Expected: pode levar alguns minutos pro primeiro throttle de 5min completar por veículo — se `count(*)` ainda for 0 logo após o deploy, aguarde ~5-10min e rode de novo antes de considerar um problema real.
