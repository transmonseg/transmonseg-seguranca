# Entrega por Proximidade + Desvio via Tapete — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** (1) Deixar operador confirmar manualmente uma entrega que o Unitrac não confirmou mas o veículo claramente fez (parou perto do endereço); (2) trocar o detector de desvio "linha reta idealizada" (matematicamente quebrado pra rotas espalhadas) por "fora do tapete real que a frota já percorreu".

**Architecture:** Migration aditiva (1 tabela nova + 1 coluna nova). Motor (`src/app/api/motor/route.ts`) ganha: detecção de candidato a entrega (usa `parado_desde` + `alvoMaisProximoQualquer` já existentes) e a nova Camada 3 do desvio (reaproveita `dentroTapete`/`celulasTapeteCliente` já computados hoje). Nova rota + server actions pra confirmar/rejeitar candidatos. Sidebar ganha uma faixa nova (mesmo padrão visual da faixa de desvio).

**Tech Stack:** Next.js 16 App Router, Supabase (Postgres direto via `pg.Pool`, já usado no motor), Vitest.

## Global Constraints
- Migrations aplicadas manualmente: `node --env-file=.env.local scripts/aplicar-migration.mjs <arquivo.sql>` (auto-deploy não roda migration).
- Nunca escrever no Unitrac (API deles é read-only pra isso) — confirmação de entrega só existe no nosso banco.
- Português com acentos corretos em código/commits/UI.
- Sem travessão (—) em copy de UI (motivo do alerta, labels) — usar vírgula ou ponto.
- 330 testes existentes não podem quebrar; rodar `npx vitest run` a cada task.
- `npx tsc --noEmit` limpo antes de cada commit.

---

### Task 1: Migration 012 — tabela de confirmação + coluna do streak fora-do-tapete

**Files:**
- Create: `scripts/migrations/012_entrega_proximidade_e_tapete_streak.sql`

**Interfaces:**
- Produces: tabela `entregas_confirmacao_manual` (colunas: id, cliente_id, veiculo_id, alvo_codigo, ponto_codigo, lat, lng, distancia_m, parado_min, status, detectado_em, resolvido_em, operador_id); coluna `posicoes_atuais.fora_tapete_streak integer not null default 0`.

- [ ] **Step 1: Escrever a migration**

```sql
-- 012: confirmacao manual de entrega por proximidade (compensa bug de
-- perimetro do Unitrac) + streak de "fora do tapete" pra nova Camada 3
-- do desvio (ver docs/plans/2026-07-08-entrega-proximidade-e-desvio-tapete-design.md).
create table entregas_confirmacao_manual (
  id            uuid primary key default gen_random_uuid(),
  cliente_id    uuid not null references clientes(id) on delete cascade,
  veiculo_id    uuid not null references veiculos(id) on delete cascade,
  alvo_codigo   bigint not null,
  ponto_codigo  bigint,
  lat           double precision not null,
  lng           double precision not null,
  distancia_m   integer not null,
  parado_min    integer not null,
  status        text not null default 'pendente'
                check (status in ('pendente','confirmado','rejeitado')),
  detectado_em  timestamptz not null default now(),
  resolvido_em  timestamptz,
  operador_id   uuid references operadores(id),
  unique (cliente_id, alvo_codigo)
);
alter table entregas_confirmacao_manual enable row level security;
create index idx_entregas_confirmacao_status on entregas_confirmacao_manual (cliente_id, status);

alter table posicoes_atuais add column fora_tapete_streak integer not null default 0;
```

- [ ] **Step 2: Aplicar no banco**

Run: `node --env-file=.env.local scripts/aplicar-migration.mjs 012_entrega_proximidade_e_tapete_streak.sql`
Expected: `OK — migration aplicada.` e a lista de tabelas inclui `entregas_confirmacao_manual`.

- [ ] **Step 3: Commit**

```bash
git add scripts/migrations/012_entrega_proximidade_e_tapete_streak.sql
git commit -m "feat(db): migration 012 - entregas_confirmacao_manual + fora_tapete_streak"
```

---

### Task 2: Lib pura — candidato a entrega por proximidade (TDD)

**Files:**
- Create: `src/lib/entrega-proximidade.ts`
- Test: `src/lib/entrega-proximidade.test.ts`

**Interfaces:**
- Consumes: `PontoEntrega` (já existe em `src/lib/unitrac.ts`), `haversineM` (já existe em `src/lib/unitrac.ts`).
- Produces: `RAIO_CONFIRMACAO_M = 500`, `PARADO_MIN_CONFIRMACAO = 5`, `candidatoEntregaProximidade(pos: {lat,lng}, paradoMin: number, pendentes: PontoEntrega[]): PontoEntrega | null` — usado pelo motor na Task 3.

- [ ] **Step 1: Escrever o teste que falha**

```typescript
// src/lib/entrega-proximidade.test.ts
import { describe, it, expect } from "vitest";
import { candidatoEntregaProximidade, RAIO_CONFIRMACAO_M, PARADO_MIN_CONFIRMACAO } from "./entrega-proximidade";
import type { PontoEntrega } from "./unitrac";

function pontoBase(overrides: Partial<PontoEntrega> = {}): PontoEntrega {
  return {
    lat: -22.9, lng: -43.2, raio: 50, ordem: 1, nome: "Cliente Teste",
    feito: false, situacao: 0, codigo: 111, pontoCodigo: 222,
    documento: null, identificador: null, dataInicio: null,
    dataRealizado: null, observacoes: null, rota: null,
    ...overrides,
  };
}

describe("candidatoEntregaProximidade", () => {
  it("parado >=5min a <=500m de um pendente retorna esse pendente", () => {
    // ~450m ao norte (0.004 grau de lat ~ 444m)
    const pos = { lat: -22.896, lng: -43.2 };
    const pendente = pontoBase();
    const r = candidatoEntregaProximidade(pos, 5, [pendente]);
    expect(r).toEqual(pendente);
  });

  it("parado menos de 5min nao retorna candidato mesmo perto", () => {
    const pos = { lat: -22.896, lng: -43.2 };
    const r = candidatoEntregaProximidade(pos, 4, [pontoBase()]);
    expect(r).toBeNull();
  });

  it("mais de 500m nao retorna candidato mesmo parado tempo suficiente", () => {
    // ~1.1km ao norte (0.01 grau ~ 1110m)
    const pos = { lat: -22.89, lng: -43.2 };
    const r = candidatoEntregaProximidade(pos, 10, [pontoBase()]);
    expect(r).toBeNull();
  });

  it("ja feito (nao pendente) nao entra na busca (lista so deve ter pendentes)", () => {
    const pos = { lat: -22.896, lng: -43.2 };
    const r = candidatoEntregaProximidade(pos, 10, []);
    expect(r).toBeNull();
  });

  it("varios pendentes no raio: retorna o MAIS PROXIMO", () => {
    const pos = { lat: -22.9, lng: -43.2 };
    const longe = pontoBase({ lat: -22.9035, lng: -43.2, codigo: 1 }); // ~390m
    const perto = pontoBase({ lat: -22.901, lng: -43.2, codigo: 2 }); // ~111m
    const r = candidatoEntregaProximidade(pos, 10, [longe, perto]);
    expect(r?.codigo).toBe(2);
  });

  it("constantes exportadas batem com o design (500m, 5min)", () => {
    expect(RAIO_CONFIRMACAO_M).toBe(500);
    expect(PARADO_MIN_CONFIRMACAO).toBe(5);
  });
});
```

- [ ] **Step 2: Rodar e confirmar que falha**

Run: `npx vitest run src/lib/entrega-proximidade.test.ts`
Expected: FAIL — `Cannot find module './entrega-proximidade'`

- [ ] **Step 3: Implementar**

```typescript
// src/lib/entrega-proximidade.ts
// Confirmacao manual de entrega por proximidade: compensa o bug do Unitrac
// que as vezes nao marca entrega feita mesmo o veiculo tendo parado no
// endereco certo (perimetro deles, tipicamente ~50m, falha por GPS
// impreciso/estacionamento longe da porta/condominio grande). Nunca marca
// sozinho -- so aponta um CANDIDATO pro operador confirmar (ver design em
// docs/plans/2026-07-08-entrega-proximidade-e-desvio-tapete-design.md).
import { haversineM, type PontoEntrega } from "./unitrac";

export const RAIO_CONFIRMACAO_M = 500;
export const PARADO_MIN_CONFIRMACAO = 5;

// pendentes: SO os alvos ainda pendentes (situacao=0) do veiculo -- filtrar
// antes de chamar esta funcao. Retorna o pendente mais proximo dentro do
// raio, ou null se nenhum qualifica (raio ou tempo parado insuficiente).
export function candidatoEntregaProximidade(
  pos: { lat: number; lng: number },
  paradoMin: number,
  pendentes: PontoEntrega[]
): PontoEntrega | null {
  if (paradoMin < PARADO_MIN_CONFIRMACAO) return null;
  let melhor: { ponto: PontoEntrega; dist: number } | null = null;
  for (const p of pendentes) {
    const dist = haversineM(pos.lat, pos.lng, p.lat, p.lng);
    if (dist > RAIO_CONFIRMACAO_M) continue;
    if (!melhor || dist < melhor.dist) melhor = { ponto: p, dist };
  }
  return melhor?.ponto ?? null;
}
```

- [ ] **Step 4: Rodar e confirmar que passa**

Run: `npx vitest run src/lib/entrega-proximidade.test.ts`
Expected: PASS (6 testes)

- [ ] **Step 5: Commit**

```bash
git add src/lib/entrega-proximidade.ts src/lib/entrega-proximidade.test.ts
git commit -m "feat(entrega): candidato a entrega por proximidade (funcao pura, TDD)"
```

---

### Task 3: Motor — detectar candidatos e gravar na tabela

**Files:**
- Modify: `src/app/api/motor/route.ts`

**Interfaces:**
- Consumes: `candidatoEntregaProximidade` (Task 2), `parado_desde`/`paradoMin` (já calculados no loop do motor), `pontosVeiculo` (já existe, `pontosPorPlaca.get(pos.placa)`).
- Produces: linhas em `entregas_confirmacao_manual` com `status='pendente'`.

- [ ] **Step 1: Importar a função nova**

No topo de `src/app/api/motor/route.ts`, junto dos outros imports de `@/lib`:

```typescript
import { candidatoEntregaProximidade } from "@/lib/entrega-proximidade";
```

- [ ] **Step 2: Coletar candidatos no loop por veículo**

Localizar o bloco onde `pendentes` já é calculado (procurar `const pendentes = (pontosVeiculo ?? []).filter((pt) => !pt.feito);`, próximo à Camada 1 do desvio). Logo depois desse bloco, adicionar:

```typescript
          // Candidato a entrega por proximidade (compensa bug de perimetro
          // do Unitrac) -- so registra, nunca confirma sozinho.
          if (pos.fresco && pos.velocidade === 0 && paradoMin >= 5) {
            const candidato = candidatoEntregaProximidade(
              { lat: pos.lat, lng: pos.lng },
              paradoMin,
              pendentes
            );
            if (candidato && candidato.codigo != null) {
              candidatosEntregaCiclo.push({
                cliente_id,
                veiculo_id,
                alvo_codigo: candidato.codigo,
                ponto_codigo: candidato.pontoCodigo,
                lat: pos.lat,
                lng: pos.lng,
                distancia_m: Math.round(haversineM(pos.lat, pos.lng, candidato.lat, candidato.lng)),
                parado_min: paradoMin,
              });
            }
          }
```

Adicionar a declaração do array coletor `candidatosEntregaCiclo` junto das outras variáveis coletoras do ciclo (procurar `const celulasCiclo: ...[] = [];`, próximo ao topo da função, e adicionar ao lado):

```typescript
    const candidatosEntregaCiclo: {
      cliente_id: string; veiculo_id: string; alvo_codigo: number;
      ponto_codigo: number | null; lat: number; lng: number;
      distancia_m: number; parado_min: number;
    }[] = [];
```

- [ ] **Step 3: Gravar em batch no fim do ciclo**

Localizar o bloco de upsert em batch de `posicoes_atuais` (procurar `INSERT INTO posicoes_atuais`) e, logo depois dele (mesmo padrão de `celulasCiclo`/`corredor_celulas`), adicionar:

```typescript
    // Candidatos a entrega por proximidade -- insert, ignora se ja existe
    // (unique cliente_id+alvo_codigo: so vira candidato 1 vez).
    if (candidatosEntregaCiclo.length > 0) {
      const pgEntregas = await pool.connect();
      try {
        await pgEntregas.query(
          `INSERT INTO entregas_confirmacao_manual
             (cliente_id, veiculo_id, alvo_codigo, ponto_codigo, lat, lng, distancia_m, parado_min)
           SELECT c.cid::uuid, c.vid::uuid, c.ac::bigint, c.pc::bigint, c.lat::float8, c.lng::float8, c.dm::integer, c.pm::integer
           FROM unnest(
             $1::uuid[], $2::uuid[], $3::bigint[], $4::bigint[],
             $5::float8[], $6::float8[], $7::integer[], $8::integer[]
           ) AS c(cid, vid, ac, pc, lat, lng, dm, pm)
           ON CONFLICT (cliente_id, alvo_codigo) DO NOTHING`,
          [
            candidatosEntregaCiclo.map(c => c.cliente_id),
            candidatosEntregaCiclo.map(c => c.veiculo_id),
            candidatosEntregaCiclo.map(c => c.alvo_codigo),
            candidatosEntregaCiclo.map(c => c.ponto_codigo),
            candidatosEntregaCiclo.map(c => c.lat),
            candidatosEntregaCiclo.map(c => c.lng),
            candidatosEntregaCiclo.map(c => c.distancia_m),
            candidatosEntregaCiclo.map(c => c.parado_min),
          ]
        );
      } catch (e) {
        erros.push(`Erro ao gravar candidatos de entrega: ${String(e)}`);
      } finally {
        pgEntregas.release();
      }
    }
```

- [ ] **Step 4: Verificar tipos e testes**

Run: `npx tsc --noEmit`
Expected: sem erros

Run: `npx vitest run`
Expected: 336 testes passando (330 + 6 novos da Task 2)

- [ ] **Step 5: Commit**

```bash
git add src/app/api/motor/route.ts
git commit -m "feat(motor): detecta e grava candidatos a entrega por proximidade"
```

---

### Task 4: Server actions — listar, confirmar, rejeitar candidatos

**Files:**
- Create: `src/app/(app)/entregas-confirmacao-actions.ts`

**Interfaces:**
- Consumes: `createClient` de `@/lib/supabase/server` (mesmo padrão de `acoes-alertas.ts`).
- Produces: `listarCandidatosEntrega(clienteId: string): Promise<CandidatoEntrega[]>`, `confirmarEntrega(id: string): Promise<{ok: boolean}>`, `rejeitarEntrega(id: string): Promise<{ok: boolean}>` — usados pela UI na Task 6.

- [ ] **Step 1: Ler o padrão existente**

Ler `src/app/(app)/acoes-alertas.ts` por completo antes de escrever este arquivo — as novas actions devem seguir o MESMO padrão (server action `"use server"`, client Supabase via `createClient()`, grava `operador_id` a partir do usuário logado).

- [ ] **Step 2: Implementar**

```typescript
// src/app/(app)/entregas-confirmacao-actions.ts
"use server";

import { createClient } from "@/lib/supabase/server";

export type CandidatoEntrega = {
  id: string;
  veiculo_id: string;
  alvo_codigo: number;
  ponto_codigo: number | null;
  lat: number;
  lng: number;
  distancia_m: number;
  parado_min: number;
  detectado_em: string;
  placa: string;
};

export async function listarCandidatosEntrega(clienteId: string): Promise<CandidatoEntrega[]> {
  const supabase = await createClient();
  const { data, error } = await supabase
    .from("entregas_confirmacao_manual")
    .select("id, veiculo_id, alvo_codigo, ponto_codigo, lat, lng, distancia_m, parado_min, detectado_em, veiculos(placa)")
    .eq("cliente_id", clienteId)
    .eq("status", "pendente")
    .order("detectado_em", { ascending: false });

  if (error || !data) return [];
  return data.map((d) => ({
    id: d.id,
    veiculo_id: d.veiculo_id,
    alvo_codigo: d.alvo_codigo,
    ponto_codigo: d.ponto_codigo,
    lat: d.lat,
    lng: d.lng,
    distancia_m: d.distancia_m,
    parado_min: d.parado_min,
    detectado_em: d.detectado_em,
    // @ts-expect-error -- join aninhado do supabase-js vem tipado como array
    placa: d.veiculos?.placa ?? "?????",
  }));
}

async function resolverCandidato(id: string, status: "confirmado" | "rejeitado"): Promise<{ ok: boolean }> {
  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  const { error } = await supabase
    .from("entregas_confirmacao_manual")
    .update({ status, resolvido_em: new Date().toISOString(), operador_id: user?.id ?? null })
    .eq("id", id)
    .eq("status", "pendente");
  return { ok: !error };
}

export async function confirmarEntrega(id: string): Promise<{ ok: boolean }> {
  return resolverCandidato(id, "confirmado");
}

export async function rejeitarEntrega(id: string): Promise<{ ok: boolean }> {
  return resolverCandidato(id, "rejeitado");
}
```

- [ ] **Step 3: Verificar tipos**

Run: `npx tsc --noEmit`
Expected: sem erros

- [ ] **Step 4: Commit**

```bash
git add "src/app/(app)/entregas-confirmacao-actions.ts"
git commit -m "feat(entrega): server actions pra listar/confirmar/rejeitar candidatos"
```

---

### Task 5: Motor — aplicar confirmações no cálculo de pendentes/entregas

**Files:**
- Modify: `src/app/api/motor/route.ts`

**Interfaces:**
- Consumes: tabela `entregas_confirmacao_manual` (status='confirmado').
- Produces: `pendentes` (usado pela Camada 1 do desvio) passa a excluir alvos confirmados manualmente; `entregas_feitas` conta os confirmados também.

- [ ] **Step 1: Buscar confirmações do cliente (batch, 1x por cliente por ciclo)**

Localizar o bloco `// Batch: carregar alertas do cliente de uma vez` (perto da pré-passada) e adicionar ANTES dele:

```typescript
      // Confirmacoes manuais de entrega (ver Task 3/4) -- 1 busca por
      // cliente, mesmo padrao das outras buscas em batch do ciclo.
      const { data: confirmacoesRows } = await supabase
        .from("entregas_confirmacao_manual")
        .select("alvo_codigo")
        .eq("cliente_id", cliente.id)
        .eq("status", "confirmado");
      const alvosConfirmadosManualmente = new Set(
        (confirmacoesRows ?? []).map((r) => r.alvo_codigo)
      );
```

- [ ] **Step 2: Excluir confirmados da lista de pendentes**

Localizar `const pendentes = (pontosVeiculo ?? []).filter((pt) => !pt.feito);` e substituir por:

```typescript
          const pendentes = (pontosVeiculo ?? []).filter(
            (pt) => !pt.feito && !(pt.codigo != null && alvosConfirmadosManualmente.has(pt.codigo))
          );
```

- [ ] **Step 3: Contar confirmados em entregas_feitas**

Localizar onde `entregas_feitas`/`entregas_total` são lidos de `entregasPorPlaca` (procurar `entregasPorPlaca.get(pos.placa)`) e ajustar a leitura de `feitos` pra somar os confirmados manualmente daquele veículo:

```typescript
          const entregaInfo = entregasPorPlaca.get(pos.placa);
          const confirmadosDoVeiculo = (pontosVeiculo ?? []).filter(
            (pt) => pt.codigo != null && alvosConfirmadosManualmente.has(pt.codigo) && !pt.feito
          ).length;
          const entregas_feitas = (entregaInfo?.feitos ?? 0) + confirmadosDoVeiculo;
          const entregas_total = entregaInfo?.total ?? 0;
```

(Ajustar o uso subsequente de `entregaInfo.feitos`/`entregaInfo.total` nessa função pra `entregas_feitas`/`entregas_total` -- conferir com `grep -n "entregaInfo\." src/app/api/motor/route.ts` antes de editar pra pegar todos os usos.)

- [ ] **Step 4: Retenção — limpar confirmações resolvidas há mais de 60 dias**

Localizar o bloco de limpeza periódica (comentário `// Tapete: células sem visita há mais de 30 dias saem do corredor.` seguido de `DELETE FROM corredor_celulas ...`, dentro do `if (horaSP_cleanup === 20)`) e adicionar logo depois, mesmo padrão:

```typescript
        // Confirmacao manual de entrega: linhas resolvidas (confirmado ou
        // rejeitado) ha mais de 60 dias saem — a tabela cresce devagar (1
        // linha por candidato real, nao por ciclo) mas ainda precisa de teto,
        // mesmo padrao de geocode_cache/corredor_celulas.
        await pgClean.query(
          `DELETE FROM entregas_confirmacao_manual
           WHERE status IN ('confirmado','rejeitado')
             AND resolvido_em < now() - interval '60 days'`
        );
```

- [ ] **Step 5: Testes e tipos**

Run: `npx tsc --noEmit && npx vitest run`
Expected: sem erros, 336 testes passando

- [ ] **Step 6: Commit**

```bash
git add src/app/api/motor/route.ts
git commit -m "feat(motor): confirmacao manual de entrega remove pendente, conta no progresso e expira em 60 dias"
```

---

### Task 6: UI — faixa de candidatos com Confirmar/Descartar

**Files:**
- Modify: `src/app/(app)/central-v2/MonitorV2.tsx`

**Interfaces:**
- Consumes: `listarCandidatosEntrega`, `confirmarEntrega`, `rejeitarEntrega` (Task 4).
- Produces: faixa visual nova, mesmo padrão da faixa de desvios já existente (`renderFaixaDesvio`).

- [ ] **Step 1: Estado + fetch dos candidatos**

Adicionar junto dos outros `useState` de dados poll­ados (perto de `const [alertas, setAlertas] = useState...`):

```typescript
  const [candidatosEntrega, setCandidatosEntrega] = useState<CandidatoEntrega[]>([]);
```

E o import no topo do arquivo:

```typescript
import { listarCandidatosEntrega, confirmarEntrega, rejeitarEntrega, type CandidatoEntrega } from "../entregas-confirmacao-actions";
```

No `useEffect` que já faz poll de alertas a cada tick do motor (procurar `const poll = async () => { ... fetch(\`/api/alertas?cliente=...\`)`), adicionar a busca dos candidatos no mesmo poll:

```typescript
        listarCandidatosEntrega(clienteAtivoId).then(setCandidatosEntrega).catch(() => {});
```

(`clienteAtivoId` já é uma prop do componente, ver assinatura de `MonitorV2`.)

- [ ] **Step 2: Handlers de confirmar/rejeitar**

Junto de `handleResolver`/`handleFalso`:

```typescript
  const handleConfirmarEntrega = useCallback(async (id: string) => {
    setCandidatosEntrega((c) => c.filter((x) => x.id !== id));
    await confirmarEntrega(id);
  }, []);

  const handleRejeitarEntrega = useCallback(async (id: string) => {
    setCandidatosEntrega((c) => c.filter((x) => x.id !== id));
    await rejeitarEntrega(id);
  }, []);
```

- [ ] **Step 3: Faixa visual**

Adicionar logo abaixo da faixa de desvios no JSX (procurar o bloco `{!splitView ? renderFaixaDesvio(...) : (...)}`), fora do split view por enquanto (so no modo unico, YAGNI -- expandir pro split view depois se o cliente pedir):

```typescript
          {!splitView && candidatosEntrega.length > 0 && (
            <div style={{
              position: "absolute", top: 100, left: "50%", transform: "translateX(-50%)",
              zIndex: Z.toasts, display: "flex", flexWrap: "wrap", justifyContent: "center", gap: 6,
              maxWidth: "calc(100% - 24px)",
            }}>
              {candidatosEntrega.map((c) => (
                <div key={c.id} style={{
                  ...BASE_BTN, flexShrink: 0, gap: 8, padding: "7px 13px", borderRadius: 8,
                  background: tema === "dark" ? "rgba(0,0,0,0.82)" : "rgba(255,255,255,0.92)",
                  backdropFilter: "blur(6px)", border: `1px solid ${T.green}55`, borderLeft: `3px solid ${T.green}`,
                  boxShadow: "0 4px 14px rgba(0,0,0,0.25)", cursor: "default",
                }}>
                  <span style={{ fontFamily: FONT_MONO, fontWeight: 900, fontSize: 13, color: T.text }}>{c.placa}</span>
                  <span style={{ fontSize: 10, color: T.muted }}>parece ter entregue aqui ({c.distancia_m}m, {c.parado_min}min parado)</span>
                  <button onClick={() => handleConfirmarEntrega(c.id)} style={tinyBtn(T.green)}>Confirmar</button>
                  <button onClick={() => handleRejeitarEntrega(c.id)} style={tinyBtn(T.dim)}>Descartar</button>
                </div>
              ))}
            </div>
          )}
```

- [ ] **Step 4: Tipos e build**

Run: `npx tsc --noEmit && npm run build`
Expected: sem erros, build limpo

- [ ] **Step 5: Commit**

```bash
git add "src/app/(app)/central-v2/MonitorV2.tsx"
git commit -m "feat(ui): faixa de candidatos a entrega com confirmar/descartar"
```

---

### Task 7: detectores.ts — nova regra da Camada 3 (fora do tapete)

**Files:**
- Modify: `src/lib/detectores.ts`
- Modify: `src/lib/detectores.test.ts`

**Interfaces:**
- Consumes: `CtxDesvio` (modificado: remove `desvioTrajetoM`, `desvioTrajetoAnteriorM`, `perfilRotaMedia`, `perfilRotaDesvioPadrao`, `perfilRotaAmostras`; adiciona `foraTapeteStreak: number`).
- Produces: `detectarDesvio` com a nova regra da Camada 3.

- [ ] **Step 1: Atualizar o tipo `CtxDesvio`**

Localizar o tipo `CtxDesvio` (`export type CtxDesvio = {`) e substituir os campos:

```typescript
  // Camada 3 (ponto cego do afastamento -- veiculo tecnicamente aproximando
  // de ALGUM destino, mas por caminho que a frota nunca percorreu antes).
  // Substituiu o calculo por linha reta (ver docs/plans/2026-07-08-entrega-
  // proximidade-e-desvio-tapete-design.md): a reta base->destino "colapsava"
  // em distancia crua quando a base fica longe (achado real: TUK-0H45,
  // veiculo aproximando de entrega real a 4,2km, marcado como desvio so
  // porque a base ficava a 45km). foraTapeteStreak: ciclos consecutivos
  // aproximando (afastandoDeTudo=false) MAS fora do tapete conhecido.
  foraTapeteStreak: number;
```

(Remover os campos antigos `desvioTrajetoM`, `desvioTrajetoAnteriorM`, `perfilRotaMedia`, `perfilRotaDesvioPadrao`, `perfilRotaAmostras` do tipo.)

- [ ] **Step 2: Remover as constantes obsoletas**

Remover `TRAJETO_PERPENDICULAR_LIMIAR_M`, `PERFIL_ROTA_MIN_AMOSTRAS`, `PERFIL_ROTA_Z`, `PERFIL_ROTA_LIMIAR_MIN_M` (buscar `export const TRAJETO_PERPENDICULAR_LIMIAR_M` e as 3 linhas seguintes de `PERFIL_ROTA_*`). Adicionar no lugar:

```typescript
// Ciclos consecutivos (aproximando de algum destino, mas fora do tapete
// conhecido) antes de disparar a Camada 3. 2 ciclos (~2min) mesmo padrao
// de persistencia minima da Camada 1 -- filtra ruido de 1 leitura de GPS.
export const FORA_TAPETE_STREAK_MIN = 2;
```

- [ ] **Step 3: Reescrever o bloco de disparo dentro de `detectarDesvio`**

Localizar o bloco (dentro de `detectarDesvio`, logo depois do comentário `// Ponto cego do gatilho principal`) que hoje calcula `temPerfilConfiavel`/`limiarTrajetoEfetivo` e faz o `if (!afastandoDeTudo && ctx.desvioTrajetoM !== null && ...)`. Substituir TODO esse bloco por:

```typescript
  // Ponto cego do gatilho principal: aproximar de QUALQUER destino cancela
  // a suspeita, mesmo que o caminho ate la nunca tenha sido percorrido pela
  // frota antes (ex.: sequestro que ainda assim segue "na direcao" de uma
  // entrega). ctx.foraTapeteStreak conta ciclos consecutivos assim -- o
  // motor so incrementa quando afastandoDeTudo=false E dentroTapete=false
  // (cobertura minima confirmada, ver TAPETE_MIN_CELULAS no motor).
  if (!afastandoDeTudo && ctx.foraTapeteStreak >= FORA_TAPETE_STREAK_MIN) {
    return {
      nivel: "critico",
      tipo: "desvio",
      motivo: `Aproximando de um destino, mas por caminho que a frota nunca percorreu antes (fora de via conhecida há ${ctx.foraTapeteStreak} leituras)`,
      score: 65,
    };
  }
```

- [ ] **Step 4: Atualizar `detectores.test.ts`**

Localizar o describe `"detectarDesvio + perfil de rota (limiar por-destino via EWMA, ver rotaperfil.ts)"` (por volta da linha 372) e SUBSTITUIR o bloco inteiro (da declaração de `baseAproximando` até o `});` final do describe) por:

```typescript
describe("detectarDesvio + Camada 3 (fora do tapete, ponto cego do afastamento)", () => {
  // Aproximando (nao afastando de tudo) -- so assim a Camada 3 entra em jogo.
  const baseAproximando = {
    distDestinosM: [4000],
    distDestinosAnteriorM: [4500],
    temPendentes: true,
    emOperacao: true,
    foraDaBase: true,
    entregasFeitas: 2,
    streak: 0,
    afastamentoAcumuladoM: 0,
    dentroTapete: null as boolean | null,
    riscoAreaAtual: 0,
  };
  const emMov2 = posicaoBase({ velocidade: 40 });

  it("aproximando de destino real MAS fora do tapete por 2 leituras: dispara (caso real TUK-0H45)", () => {
    const a = detectarDesvio(emMov2, { ...baseAproximando, foraTapeteStreak: 2 });
    expect(a?.nivel).toBe("critico");
    expect(a?.motivo).toContain("fora de via conhecida há 2 leituras");
  });

  it("aproximando e DENTRO do tapete (streak 0): nao dispara -- caso real TUK-0H45/TTM-2G01 corrigido", () => {
    const a = detectarDesvio(emMov2, { ...baseAproximando, foraTapeteStreak: 0 });
    expect(a).toBeNull();
  });

  it("fora do tapete so 1 leitura (abaixo do minimo): nao dispara ainda", () => {
    const a = detectarDesvio(emMov2, { ...baseAproximando, foraTapeteStreak: 1 });
    expect(a).toBeNull();
  });

  it("afastando de tudo (Camada 1) tem prioridade -- fora do tapete nao importa nesse caso", () => {
    const a = detectarDesvio(emMov2, {
      ...baseAproximando,
      distDestinosM: [6300], distDestinosAnteriorM: [6000], streak: 2,
      foraTapeteStreak: 5,
    });
    expect(a?.motivo).not.toContain("nunca percorreu");
  });
});
```

Buscar TODOS os outros usos de `desvioTrajetoM`/`perfilRotaMedia`/`perfilRotaDesvioPadrao`/`perfilRotaAmostras` em `detectores.test.ts` (`grep -n "desvioTrajetoM\|perfilRota" src/lib/detectores.test.ts`) e remover esses campos dos objetos de contexto passados em QUALQUER outro teste (ex.: no describe `"detectarDesvio (v4: ...)"`, o objeto `base` tem esses campos -- trocar por `foraTapeteStreak: 0`).

- [ ] **Step 5: Rodar e ajustar até passar**

Run: `npx vitest run src/lib/detectores.test.ts`
Expected: PASS -- se algum teste antigo quebrar por causa dos campos removidos, ajustar esse teste especificamente (adicionar `foraTapeteStreak: 0` no lugar dos campos antigos).

- [ ] **Step 6: Commit**

```bash
git add src/lib/detectores.ts src/lib/detectores.test.ts
git commit -m "fix(desvio): Camada 3 troca linha reta por 'fora do tapete' (bug real corrigido)"
```

---

### Task 8: motor — computar e persistir `foraTapeteStreak`, remover perfil de rota

**Files:**
- Modify: `src/app/api/motor/route.ts`

**Interfaces:**
- Consumes: `dentroTapete` (já calculado por ciclo, Task existente), `afastouDeTudo` (já calculado).
- Produces: `fora_tapete_streak` persistido em `posicoes_atuais`; `CtxDesvio.foraTapeteStreak` passado pro detector.

- [ ] **Step 1: Remover o bloco de perfil de rota**

Localizar e remover POR COMPLETO o bloco que começa em `// Perfil de rota (baseline por destino...` (calcula `perfilRotaMedia`/`perfilRotaDesvioPadrao`/`perfilRotaAmostras`, chama `getPerfilRotaCliente`, `atualizarPerfilRota`) -- esse bloco fica obsoleto com a Camada 3 nova. Junto, remover:
- O import `import { atualizarPerfilRota, desvioPadraoDe } from "@/lib/rotaperfil";` e `import type { PerfilRotaEstado } from "@/lib/rotaperfil";`.
- A função `getPerfilRotaCliente` e o cache `cachePerfilRotaPorCliente`/`CACHE_PERFIL_ROTA_MS`/`PerfilRotaCache`.
- A constante `PERFIL_ROTA_PROXIMIDADE_M`.
- O array coletor `perfilRotaTocadoCiclo` e o bloco de escrita em `rota_perfil` no fim do ciclo (buscar `INSERT INTO rota_perfil`).

Buscar `grep -n "perfilRota\|PerfilRota\|PERFIL_ROTA" src/app/api/motor/route.ts` antes de editar pra confirmar que pegou todas as ocorrências.

- [ ] **Step 2: Remover o cálculo de `desvioTrajetoM`**

Localizar e remover o bloco `// Trajeto perpendicular (ponto cego do afastamento...` que calcula `segmentosPlausiveis`/`desvioTrajetoM`/`desvioTrajetoAnteriorM`.

- [ ] **Step 3: Calcular `foraTapeteStreak` (reaproveita `dentroTapete` já calculado)**

Localizar o bloco onde `dentroTapete` é calculado (`if (pos.fresco && contagemTapeteCliente >= TAPETE_MIN_CELULAS) { dentroTapete = ...}`) e adicionar logo depois:

```typescript
          // Streak de "aproximando mas fora do tapete" -- Camada 3 nova
          // (ver detectores.ts). So incrementa com cobertura minima
          // confirmada (contagemTapeteCliente >= TAPETE_MIN_CELULAS),
          // igual ao dentroTapete -- sem tapete confiavel ainda, fica 0
          // (nunca dispara por cold-start, mesma protecao de sempre).
          let foraTapeteStreak = anterior?.fora_tapete_streak ?? 0;
          if (pos.fresco && !saltoImplausivel && contagemTapeteCliente >= TAPETE_MIN_CELULAS) {
            if (!afastouDeTudo(distDestinosM, distDestinosAnteriorM) && dentroTapete === false) {
              foraTapeteStreak += 1;
            } else {
              foraTapeteStreak = 0;
            }
          }
```

(`TAPETE_MIN_CELULAS` já está declarado no escopo desse bloco -- conferir com `grep -n "TAPETE_MIN_CELULAS" src/app/api/motor/route.ts` que continua visível nesse ponto do arquivo depois das remoções da Task 8 Step 1-2.)

- [ ] **Step 4: Passar pro detector e persistir**

Localizar onde `detectarDesvio`/`avaliar` é chamado com o objeto de contexto do desvio (buscar `desvioTrajetoM: ctx.desvioTrajetoM ?? null,` -- vai aparecer 2 vezes, uma pra cada chamada) e substituir cada ocorrência do bloco de 5 linhas (`desvioTrajetoM`, `desvioTrajetoAnteriorM`, `perfilRotaMedia`, `perfilRotaDesvioPadrao`, `perfilRotaAmostras`) por uma linha:

```typescript
          foraTapeteStreak,
```

Localizar `anterior?.desvio_streak` e `type LinhaPosicaoCiclo` (ou equivalente -- o objeto que alimenta o upsert em batch de `posicoes_atuais`) e adicionar `fora_tapete_streak: foraTapeteStreak` no objeto empurrado pra `posicoesCiclo`, seguindo o MESMO padrão de `desvio_streak`. Atualizar o SQL do `INSERT INTO posicoes_atuais` (batch, via `unnest`) pra incluir a coluna nova `fora_tapete_streak` (mesmo padrão de `desvio_streak`: adicionar no `unnest(...)`, na lista de colunas do INSERT, e no `ON CONFLICT DO UPDATE SET`).

- [ ] **Step 5: Tipos e testes**

Run: `npx tsc --noEmit && npx vitest run`
Expected: sem erros, todos os testes passando

- [ ] **Step 6: Validação manual contra o caso real**

Chamar o motor manualmente e conferir que TUK-0H45 (ou o veículo real disponível no momento, aproximando de um pendente e dentro do tapete) NÃO abre alerta de desvio nesse ciclo:

Run: `curl -s -X POST "https://transmonseg-seguranca.vercel.app/api/motor" -H "x-motor-key: $MOTOR_SECRET"` (só depois do deploy) ou testar localmente contra o banco de dev.

- [ ] **Step 7: Commit**

```bash
git add src/app/api/motor/route.ts
git commit -m "refactor(motor): Camada 3 usa fora_tapete_streak, remove perfil de rota e linha reta"
```

---

### Task 9: Motivo detalhado do alerta (Camada 1)

**Files:**
- Modify: `src/lib/detectores.ts`

**Interfaces:**
- Consumes: `ctx.afastamentoAcumuladoM`, `ctx.streak`, `ctx.dentroTapete`, `ctx.riscoAreaAtual` (todos já existem em `CtxDesvio`).
- Produces: motivo mais descritivo pros disparos da Camada 1 (afastando de tudo).

- [ ] **Step 1: Localizar os motivos da Camada 1**

Dentro de `detectarDesvio`, localizar os 3 pontos que retornam motivo pra Camada 1 (buscar `Afastando-se de todos os` -- aparecem em 3 lugares: `dentroTapete === false`, `streak >= 4`, e o caso genérico de baixo).

- [ ] **Step 2: Enriquecer o motivo com fase + sinais**

No caso genérico (streak >= 2, dentro do tapete, sem área de risco elevada -- o `return` mais simples, sem `dentroTapete === false` nem `streak >= 4`), trocar:

```typescript
      motivo: `Afastando-se de todos os ${nDest} destinos há ${ctx.streak} leituras (+${kmAcum}km)`,
```

por:

```typescript
      motivo: `Afastando-se de todos os ${nDest} destinos há ${ctx.streak} leituras seguidas (~${ctx.streak}min), +${kmAcum}km acumulado`,
```

No caso `dentroTapete === false` (o primeiro `if`), trocar:

```typescript
      motivo: `Afastando-se de todos os ${nDest} destinos há ${ctx.streak} leituras, fora de via conhecida da frota (+${kmAcum}km)`,
```

Confirmar o texto exato atual com `grep -n "fora de via conhecida" src/lib/detectores.ts` antes de editar (o texto pode já mencionar isso -- só adicionar a fase/tempo se ainda não tiver). Adicionar, nesse mesmo motivo, o sinal de área de risco quando `ctx.riscoAreaAtual >= RISCO_AREA_LIMIAR` só é reportado no bloco de score 80 -- conferir se esse bloco já é o certo e enriquecer de forma equivalente.

- [ ] **Step 3: Testes**

Run: `npx vitest run src/lib/detectores.test.ts`
Expected: PASS -- ajustar as asserções de `toContain(...)` nos testes existentes que checam o texto exato do motivo (buscar `.motivo).toContain` no arquivo de teste) pra bater com o novo texto.

- [ ] **Step 4: Commit**

```bash
git add src/lib/detectores.ts src/lib/detectores.test.ts
git commit -m "feat(desvio): motivo do alerta mostra fase e tempo, nao so o numero seco"
```

---

### Task 10: Validação final end-to-end

**Files:** nenhum (só validação)

- [ ] **Step 1: Suite completa**

Run: `npx tsc --noEmit && npx vitest run && npm run build`
Expected: tudo limpo, build ok

- [ ] **Step 2: QA visual (puppeteer + login QA temporário)**

Seguir o processo já usado nesta sessão (memória `reference_transmonseg_qa_visual`): subir dev, criar usuário QA via Supabase admin, logar, confirmar que:
1. A faixa de candidatos a entrega aparece quando existe algum (ou confirmar que a lista fica vazia se não houver candidato real no momento -- não é bug se não aparecer nada).
2. Clicar Confirmar remove o candidato da faixa.
3. Nenhum erro no console.

Apagar o usuário QA e os scripts temporários no fim (nunca commitar).

- [ ] **Step 3: Deploy e observação em produção**

Push já deve ter acontecido a cada commit das tasks anteriores. Depois do deploy do Vercel, observar por ~15-20min os alertas de desvio novos (`select tipo, motivo, created_at from alertas where tipo='desvio' order by created_at desc limit 20`) e confirmar: (a) nenhum motivo antigo ("Trajeto Xkm fora de qualquer caminho reto") aparece mais, (b) os motivos novos ("fora de via conhecida", "aproximando... nunca percorreu antes") fazem sentido pros veículos reais checados manualmente (comparar com posição/pendentes reais de 1-2 veículos, mesmo processo do TUK-0H45 nesta sessão).

- [ ] **Step 4: Atualizar ESTADO.md**

Adicionar uma entrada no `## Pronto` de `ESTADO.md` descrevendo as duas mudanças (confirmação de entrega por proximidade; Camada 3 do desvio via tapete real, substituindo a linha reta). Commit:

```bash
git add ESTADO.md
git commit -m "docs(estado): atualiza ESTADO.md com entrega por proximidade e desvio via tapete"
git push origin main
```
