# Log de snapshot de pendentes por ciclo — Design

**Contexto:** investigação de 3 misses reais reportados no grupo WhatsApp
(TTF-5I09 21/07, TTM-7C13 28/07, TTL-2H39 08/08) bateu num limite
estrutural: a lista de destinos pendentes que a Unitrac manda pro motor a
cada ciclo (`pontosVeiculo`/`pendentes` em `route.ts`) é **efêmera** — só
existe na memória durante aquele ciclo, nunca é persistida. Pra 2 dos 3
casos (7C13, 2H39) não foi possível determinar SE havia um destino
pendente perto da posição real do veículo no momento certo, porque esse
dado já não existe mais. Toda investigação futura de "por que não
disparou" vai bater na mesma parede.

**Goal:** persistir um snapshot leve e periódico dos pendentes de cada
veículo, puramente pra auditoria/investigação — nunca lido por nenhum
detector, mesmo padrão de "sombra" já usado por `placar_desvio_log`/
`rumo_diverge_sombra`/`cerca_sombra`.

## Volume e throttle

Gravar em TODO ciclo (30s) seria caro sem necessidade — pra investigar um
miss, granularidade de minutos já basta (não precisa saber o pendente
exato no segundo 17 vs segundo 47). Throttle de **5 minutos por veículo**:
com ~105 veículos ativos, isso é ~30 mil linhas/dia, mesma ordem de
grandeza dos outros logs de sombra já em produção (`placar_desvio_log`
sozinho já passa de 2,5 milhões de linhas acumuladas, com retenção de 30
dias mantendo isso saudável).

## Mudanças

### `scripts/migrations/contabo/029_pendentes_snapshot_log.sql`

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

### `scripts/migrations/contabo/030_retencao_pendentes_snapshot_log.sql`

Mesmo padrão de `025_retencao_placar_desvio_log.sql` — 30 dias via pg_cron,
criado na MESMA migração que a tabela desta vez (achado da revisão do
placar: criar tabela de log sem job de retenção junto já causou retrabalho
antes, não repetir):

```sql
select cron.schedule(
  'limpar-pendentes-snapshot-log',
  '0 4 * * *',
  $$delete from pendentes_snapshot_log where criado_em < now() - interval '30 days'$$
);
```

### `src/app/api/motor/route.ts`

Novo Map em nível de módulo (mesmo padrão de
`ultimaVerificacaoCorredorPorVeiculo`, persiste entre ciclos porque o
processo Node fica vivo via PM2):

```typescript
const ultimoSnapshotPendentesPorVeiculo = new Map<string, number>();
const SNAPSHOT_PENDENTES_INTERVALO_MS = 5 * 60 * 1000;
```

Array de coleta por ciclo (mesmo local de `progressoDestinoCiclo` etc.):

```typescript
const pendentesSnapshotCiclo: {
  veiculo_id: string;
  temPendentes: boolean;
  alvosApiOk: boolean;
  pendentes: { lat: number; lng: number; raio: number; codigo: number | null; nome: string }[];
}[] = [];
```

Coleta, logo depois que `pendentes`/`temPendentes`/`alvosDestinosDisponiveis`
já estão calculados no loop por veículo (mesmo ponto de onde
`todosPendentesPriorizados` já lê essas variáveis):

```typescript
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

Flush em lote no final do ciclo (mesmo padrão de `placarSombraCiclo`, um
insert por linha via `Promise.allSettled`, tolerante a falha parcial):

```typescript
if (pendentesSnapshotCiclo.length > 0) {
  const resultados = await Promise.allSettled(
    pendentesSnapshotCiclo.map((p) =>
      pool.query(
        `insert into pendentes_snapshot_log (veiculo_id, tem_pendentes, alvos_api_ok, pendentes) values ($1, $2, $3, $4::jsonb)`,
        [p.veiculo_id, p.temPendentes, p.alvosApiOk, JSON.stringify(p.pendentes)]
      )
    )
  );
  const falhas = resultados.filter((r) => r.status === "rejected").length;
  if (falhas > 0) console.warn(`Aviso: ${falhas} falha(s) ao gravar snapshot de pendentes neste ciclo`);
}
```

## Não-objetivos

- Não é lido por NENHUM detector, NENHUMA lógica de decisão — puramente
  para consulta manual/investigação, mesmo padrão dos outros logs de
  sombra.
- Não resolve os 3 misses já investigados (esse dado já se perdeu antes de
  existir este log) — só destrava investigações a partir de agora.
- Não substitui o `contexto.dist_destinos_m` já persistido em alertas que
  disparam (isso continua existindo do jeito que está) — este log cobre
  especificamente o caso que falta: ciclos onde NADA dispara.

## Testes

Sem teste unitário dedicado (é um bloco de coleta+flush simples, mesmo
padrão de `placarSombraCiclo`/`progressoDestinoCiclo`, que também não
tiveram teste próprio — a garantia vem de `pendentes.map(...)` ser uma
transformação pura e trivial). Validação real: confirmar via SQL, após o
deploy, que a tabela está recebendo linhas novas.
