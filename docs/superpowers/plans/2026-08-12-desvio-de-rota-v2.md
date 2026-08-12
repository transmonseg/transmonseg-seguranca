# Detector de Desvio de Rota v2 — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Apagar todo o sistema de detecção de desvio de rota atual (placar, modo teste, corredor, classe viária, rumo diverge, cerca virtual) e substituir por 2 sinais simples e independentes — afastando de todos os destinos (distância real de rua) e entrando em trecho raro no histórico da frota — direto em produção, sem modo sombra.

**Arquitetura:** Dois módulos novos e puros (`src/lib/distancia-real.ts` pra distância via OSRM `/table`, `src/lib/desvio.ts` pra avaliar os 2 sinais e montar o alerta), mais uma tabela de estado (`desvio_estado`) e uma tabela de frequência histórica por célula (`celula_frequencia_cliente`, com backfill a partir de `posicoes_historico`). Tudo plugado no lugar do bloco antigo de desvio em `src/app/api/motor/route.ts`, reaproveitando a construção de `pendentes`/`destinos` e o gate de chegada (`suspenderPorChegada`) que já existem.

**Tech Stack:** Next.js 16 (App Router) + TypeScript, Supabase/Postgres (via `pg` Pool direto em `route.ts`), Vitest, OSRM self-hosted no Contabo.

## Global Constraints

- Spec: `docs/superpowers/specs/2026-08-12-desvio-de-rota-v2-design.md` — toda tarefa abaixo implementa um pedaço dela.
- Vai direto pra produção — **sem** modo teste/sombra pro sistema novo (o modo teste ANTIGO é apagado, não reaproveitado).
- Sem roteirização/sequenciamento (nada de OSRM `/trip`/TSP).
- Distância nunca em linha reta — sempre via OSRM `/table` (self-hosted, `OSRM_LOCAL_URL`, default `http://127.0.0.1:5001`).
- Prioridade: recall sobre precisão — aceitar falso positivo, nunca perder desvio real (ver `feedback_desvio_priorizar_recall`, fora do repo).
- Repos: `MONITORAMENTO TEMP` (`/Users/joaquimsalles/Projects/Transmonseg/monitoramento/MONITORAMENTO TEMP`, trabalho acontece aqui) e `MONITORAMENTO transmonseg` (definitivo, replicado só na Task 9).
- Deploy real: Contabo VPS (`ssh transmonseg-vps`, apps em `/srv/transmonseg/temp` e `/srv/transmonseg/definitivo`, PM2 `transmonseg-temp`/`transmonseg-definitivo`) — só acontece na Task 9.
- `npm test` = `vitest run`. Typecheck: `npx tsc --noEmit -p .`.

---

### Task 1: Migrations — `desvio_estado` e `celula_frequencia_cliente`

**Files:**
- Create: `scripts/migrations/041_desvio_estado.sql`
- Create: `scripts/migrations/042_celula_frequencia_cliente.sql`
- Create: `scripts/migrations/contabo/041_desvio_estado.sql`
- Create: `scripts/migrations/contabo/042_celula_frequencia_cliente.sql`

**Interfaces:**
- Produces: tabelas `desvio_estado(veiculo_id, afastando_streak, rua_rara_streak, atualizado_em)` e `celula_frequencia_cliente(cliente_id, celula, n_visitas, primeira_vez, ultima_vez)`, consumidas pela Task 6.

- [ ] **Step 1: Escrever a migration local de `desvio_estado`**

`scripts/migrations/041_desvio_estado.sql`:
```sql
-- 041_desvio_estado.sql
-- Estado do detector de desvio v2 (spec 2026-08-12-desvio-de-rota-v2-design.md).
-- 1 linha por veiculo. Substitui TODAS as colunas de desvio antigas em
-- posicoes_atuais (removidas na migration 043) -- tabela propria, isolada.
CREATE TABLE desvio_estado (
  veiculo_id uuid PRIMARY KEY REFERENCES veiculos(id) ON DELETE CASCADE,
  afastando_streak int NOT NULL DEFAULT 0,
  rua_rara_streak int NOT NULL DEFAULT 0,
  atualizado_em timestamptz NOT NULL DEFAULT now()
);
```

- [ ] **Step 2: Escrever a migration local de `celula_frequencia_cliente`**

`scripts/migrations/042_celula_frequencia_cliente.sql`:
```sql
-- 042_celula_frequencia_cliente.sql
-- Frequencia historica de visitas por celula (~100m, mesma grade de
-- src/lib/celulas.ts), por CLIENTE (frota inteira, nao por veiculo -- pra
-- rota nova atribuida hoje a 1 caminhao nao disparar falso positivo so
-- porque ESSE veiculo nunca foi ali). Ver Sinal B na spec.
CREATE TABLE celula_frequencia_cliente (
  cliente_id uuid NOT NULL REFERENCES clientes(id) ON DELETE CASCADE,
  celula text NOT NULL,
  n_visitas int NOT NULL DEFAULT 0,
  primeira_vez date NOT NULL DEFAULT current_date,
  ultima_vez date NOT NULL DEFAULT current_date,
  PRIMARY KEY (cliente_id, celula)
);
CREATE INDEX idx_celula_frequencia_cliente_ultima_vez ON celula_frequencia_cliente (ultima_vez);
```

- [ ] **Step 3: Escrever as duas migrations contabo (mesmo conteúdo + `IF NOT EXISTS` + `NOTIFY pgrst` + `GRANT`)**

`scripts/migrations/contabo/041_desvio_estado.sql`:
```sql
-- 041_desvio_estado.sql
CREATE TABLE IF NOT EXISTS desvio_estado (
  veiculo_id uuid PRIMARY KEY REFERENCES veiculos(id) ON DELETE CASCADE,
  afastando_streak int NOT NULL DEFAULT 0,
  rua_rara_streak int NOT NULL DEFAULT 0,
  atualizado_em timestamptz NOT NULL DEFAULT now()
);
GRANT SELECT, INSERT, UPDATE ON desvio_estado TO app_service;
NOTIFY pgrst, 'reload schema';
```

`scripts/migrations/contabo/042_celula_frequencia_cliente.sql`:
```sql
-- 042_celula_frequencia_cliente.sql
CREATE TABLE IF NOT EXISTS celula_frequencia_cliente (
  cliente_id uuid NOT NULL REFERENCES clientes(id) ON DELETE CASCADE,
  celula text NOT NULL,
  n_visitas int NOT NULL DEFAULT 0,
  primeira_vez date NOT NULL DEFAULT current_date,
  ultima_vez date NOT NULL DEFAULT current_date,
  PRIMARY KEY (cliente_id, celula)
);
CREATE INDEX IF NOT EXISTS idx_celula_frequencia_cliente_ultima_vez ON celula_frequencia_cliente (ultima_vez);
GRANT SELECT, INSERT, UPDATE ON celula_frequencia_cliente TO app_service;
NOTIFY pgrst, 'reload schema';
```

- [ ] **Step 4: Aplicar as duas migrations locais**

Run: `node --env-file=.env.local scripts/aplicar-migration.mjs 041_desvio_estado.sql`
Run: `node --env-file=.env.local scripts/aplicar-migration.mjs 042_celula_frequencia_cliente.sql`
Expected: `OK — migration aplicada.` nas duas, `desvio_estado` e `celula_frequencia_cliente` aparecem na lista de tabelas impressa.

- [ ] **Step 5: Commit**

```bash
git add scripts/migrations/041_desvio_estado.sql scripts/migrations/042_celula_frequencia_cliente.sql scripts/migrations/contabo/041_desvio_estado.sql scripts/migrations/contabo/042_celula_frequencia_cliente.sql
git commit -m "feat: migrations do detector de desvio v2 (desvio_estado, celula_frequencia_cliente)"
```

---

### Task 2: `src/lib/distancia-real.ts` — distância via OSRM `/table`

**Files:**
- Create: `src/lib/distancia-real.ts`
- Test: `src/lib/distancia-real.test.ts`

**Interfaces:**
- Consumes: nada de novo (só `fetch` global).
- Produces: `buscarDistanciasReais(posAtual, destinos): Promise<number[] | null>` — usado pela Task 6 (`route.ts`). `null` = OSRM indisponível (fail-open, ver Task 6).

- [ ] **Step 1: Escrever o teste (mock de `fetch`)**

```ts
import { describe, it, expect, vi, afterEach } from "vitest";
import { buscarDistanciasReais } from "./distancia-real";

describe("buscarDistanciasReais", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("retorna array vazio sem chamar a rede quando não há destinos", async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    const r = await buscarDistanciasReais({ lat: -22.9, lng: -43.2 }, []);
    expect(r).toEqual([]);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("retorna as distâncias reais quando o OSRM responde Ok", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue({
        ok: true,
        json: async () => ({ code: "Ok", distances: [[1200, 800]] }),
      })
    );
    const r = await buscarDistanciasReais(
      { lat: -22.9, lng: -43.2 },
      [{ lat: -22.91, lng: -43.21 }, { lat: -22.92, lng: -43.22 }]
    );
    expect(r).toEqual([1200, 800]);
  });

  it("retorna null se o OSRM responder HTTP não-ok", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue({ ok: false }));
    const r = await buscarDistanciasReais({ lat: -22.9, lng: -43.2 }, [{ lat: -22.91, lng: -43.21 }]);
    expect(r).toBeNull();
  });

  it("retorna null se code !== 'Ok'", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue({ ok: true, json: async () => ({ code: "NoRoute" }) })
    );
    const r = await buscarDistanciasReais({ lat: -22.9, lng: -43.2 }, [{ lat: -22.91, lng: -43.21 }]);
    expect(r).toBeNull();
  });

  it("retorna null se alguma distância vier null (destino inalcançável)", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue({ ok: true, json: async () => ({ code: "Ok", distances: [[1200, null]] }) })
    );
    const r = await buscarDistanciasReais(
      { lat: -22.9, lng: -43.2 },
      [{ lat: -22.91, lng: -43.21 }, { lat: -22.92, lng: -43.22 }]
    );
    expect(r).toBeNull();
  });

  it("retorna null se o fetch lançar (rede fora do ar)", async () => {
    vi.stubGlobal("fetch", vi.fn().mockRejectedValue(new Error("ECONNREFUSED")));
    const r = await buscarDistanciasReais({ lat: -22.9, lng: -43.2 }, [{ lat: -22.91, lng: -43.21 }]);
    expect(r).toBeNull();
  });
});
```

- [ ] **Step 2: Rodar e confirmar que falha (módulo não existe ainda)**

Run: `npx vitest run src/lib/distancia-real.test.ts`
Expected: FAIL — `Cannot find module './distancia-real'`.

- [ ] **Step 3: Implementar**

```ts
// Distância REAL de rua (nunca linha reta) via OSRM /table self-hosted.
// Ver docs/superpowers/specs/2026-08-12-desvio-de-rota-v2-design.md,
// componente 1. Puramente uma chamada de rede -- sem lógica de decisão.

const OSRM_LOCAL_URL = process.env.OSRM_LOCAL_URL ?? "http://127.0.0.1:5001";
const DEADLINE_MS = 5000;

export async function buscarDistanciasReais(
  posAtual: { lat: number; lng: number },
  destinos: { lat: number; lng: number }[]
): Promise<number[] | null> {
  if (destinos.length === 0) return [];

  const coords = [posAtual, ...destinos].map((p) => `${p.lng},${p.lat}`).join(";");
  const destIdx = destinos.map((_, i) => i + 1).join(";");

  try {
    const res = await fetch(
      `${OSRM_LOCAL_URL}/table/v1/driving/${coords}?sources=0&destinations=${destIdx}&annotations=distance`,
      { signal: AbortSignal.timeout(DEADLINE_MS) }
    );
    if (!res.ok) return null;

    const data = (await res.json()) as { code: string; distances?: (number | null)[][] };
    if (data.code !== "Ok" || !data.distances || !data.distances[0]) return null;

    const linha = data.distances[0];
    if (linha.length !== destinos.length || linha.some((d) => d === null)) return null;
    return linha as number[];
  } catch {
    return null;
  }
}
```

- [ ] **Step 4: Rodar e confirmar que passa**

Run: `npx vitest run src/lib/distancia-real.test.ts`
Expected: PASS (6/6).

- [ ] **Step 5: Commit**

```bash
git add src/lib/distancia-real.ts src/lib/distancia-real.test.ts
git commit -m "feat: distância real de rua via OSRM /table (buscarDistanciasReais)"
```

---

### Task 3: `src/lib/desvio.ts` — os 2 sinais + montagem do alerta

**Files:**
- Create: `src/lib/desvio.ts`
- Test: `src/lib/desvio.test.ts`

**Interfaces:**
- Consumes: `type { Alerta } from "./detectores"` (tipo existente, não muda nesta task).
- Produces: `avaliarAfastandoDeTudo`, `avaliarRuaRara`, `montarAlertaDesvio`, `celulaRara` (helper), constantes `LIMIAR_STREAK_AFASTANDO`, `LIMIAR_STREAK_RUA_RARA`, `LIMIAR_VISITAS_RARA` — todos consumidos pela Task 6.

- [ ] **Step 1: Escrever os testes**

```ts
import { describe, it, expect } from "vitest";
import { avaliarAfastandoDeTudo, avaliarRuaRara, montarAlertaDesvio } from "./desvio";

describe("avaliarAfastandoDeTudo", () => {
  it("não acumula streak sem destinos (guard 0 pendentes)", () => {
    const r = avaliarAfastandoDeTudo([], [], 2);
    expect(r).toEqual({ streak: 0, disparou: false, aproximandoAlgum: false });
  });

  it("não acumula streak se o conjunto de destinos mudou de tamanho (entrega confirmada no meio do streak)", () => {
    const r = avaliarAfastandoDeTudo([1000, 2000], [900], 2);
    expect(r.streak).toBe(0);
    expect(r.disparou).toBe(false);
  });

  it("zera o streak se aproximou de PELO MENOS UM destino", () => {
    const r = avaliarAfastandoDeTudo([1100, 900], [1000, 1000], 2);
    expect(r.streak).toBe(0);
    expect(r.disparou).toBe(false);
    expect(r.aproximandoAlgum).toBe(true);
  });

  it("acumula streak quando afasta de TODOS", () => {
    const r = avaliarAfastandoDeTudo([1100, 2100], [1000, 2000], 1);
    expect(r.streak).toBe(2);
    expect(r.aproximandoAlgum).toBe(false);
    expect(r.disparou).toBe(false); // ainda não bateu o limiar (3)
  });

  it("dispara na 3a leitura seguida afastando de todos", () => {
    const r = avaliarAfastandoDeTudo([1300, 2300], [1200, 2200], 2);
    expect(r.streak).toBe(3);
    expect(r.disparou).toBe(true);
  });
});

describe("avaliarRuaRara", () => {
  it("não acumula se a célula é comum (acima do limiar de visitas)", () => {
    const r = avaliarRuaRara(50, false, 1);
    expect(r).toEqual({ streak: 0, disparou: false });
  });

  it("não acumula se está aproximando de algum destino, mesmo em célula rara", () => {
    const r = avaliarRuaRara(0, true, 1);
    expect(r.streak).toBe(0);
    expect(r.disparou).toBe(false);
  });

  it("acumula em célula rara e sem aproximar de nada", () => {
    const r = avaliarRuaRara(1, false, 0);
    expect(r.streak).toBe(1);
    expect(r.disparou).toBe(false); // limiar é 2
  });

  it("dispara na 2a leitura seguida", () => {
    const r = avaliarRuaRara(0, false, 1);
    expect(r.streak).toBe(2);
    expect(r.disparou).toBe(true);
  });
});

describe("montarAlertaDesvio", () => {
  it("retorna null se nenhum sinal disparou", () => {
    const a = montarAlertaDesvio(
      { disparou: false, streak: 0 },
      { disparou: false, streak: 0, celula: "0:0", nVisitas: 10 }
    );
    expect(a).toBeNull();
  });

  it("prioriza afastando-de-tudo quando os dois disparam no mesmo ciclo", () => {
    const a = montarAlertaDesvio(
      { disparou: true, streak: 3 },
      { disparou: true, streak: 2, celula: "0:0", nVisitas: 0 }
    );
    expect(a?.origemDesvio).toBe("afastando_geral");
  });

  it("monta alerta de rua rara com a célula e contagem no motivo", () => {
    const a = montarAlertaDesvio(
      { disparou: false, streak: 0 },
      { disparou: true, streak: 2, celula: "-22900:-43200", nVisitas: 1 }
    );
    expect(a?.tipo).toBe("desvio");
    expect(a?.origemDesvio).toBe("rua_rara_frota");
    expect(a?.motivo).toContain("-22900:-43200");
    expect(a?.motivo).toContain("1");
  });
});
```

- [ ] **Step 2: Rodar e confirmar que falha**

Run: `npx vitest run src/lib/desvio.test.ts`
Expected: FAIL — `Cannot find module './desvio'`.

- [ ] **Step 3: Implementar**

```ts
// Detector de desvio de rota v2 -- 2 sinais independentes, funcoes PURAS.
// Ver docs/superpowers/specs/2026-08-12-desvio-de-rota-v2-design.md.
// Nunca importe nada de 'next'/'pg' aqui.

import type { Alerta } from "./detectores";

export const LIMIAR_STREAK_AFASTANDO = 3;
export const LIMIAR_STREAK_RUA_RARA = 2;
export const LIMIAR_VISITAS_RARA = 2;

export type ResultadoAfastando = { streak: number; disparou: boolean; aproximandoAlgum: boolean };

// Sinal A: o veiculo se afastou (distancia REAL de rua, ja calculada pelo
// chamador) de TODOS os destinos (pendentes + base) por N leituras
// seguidas. Sem decaimento -- distancia real de rua e mais estavel que
// linha reta, entao um streak binario simples deve bastar (validar contra
// dia real na Task 8 antes de considerar o parametro final).
export function avaliarAfastandoDeTudo(
  distanciasAtuais: number[],
  distanciasAnteriores: number[],
  streakAnterior: number
): ResultadoAfastando {
  if (
    distanciasAtuais.length === 0 ||
    distanciasAnteriores.length === 0 ||
    distanciasAtuais.length !== distanciasAnteriores.length
  ) {
    return { streak: 0, disparou: false, aproximandoAlgum: false };
  }

  const aproximandoAlgum = distanciasAtuais.some((d, i) => d < distanciasAnteriores[i]);
  const afastouDeTodos = distanciasAtuais.every((d, i) => d > distanciasAnteriores[i]);

  const streak = afastouDeTodos ? streakAnterior + 1 : 0;
  return { streak, disparou: streak >= LIMIAR_STREAK_AFASTANDO, aproximandoAlgum };
}

export type ResultadoRuaRara = { streak: number; disparou: boolean };

// Sinal B: o veiculo entrou numa celula rara no historico da FROTA
// (celula_frequencia_cliente.n_visitas <= LIMIAR_VISITAS_RARA) e nao esta
// aproximando de nenhum destino pendente no mesmo ciclo (requisito
// explicito do usuario: nunca disparar indo em direcao a um cliente, MESMO
// por rua rara/estreita).
export function avaliarRuaRara(
  nVisitasHistorico: number,
  aproximandoAlgum: boolean,
  streakAnterior: number,
  limiarVisitas: number = LIMIAR_VISITAS_RARA
): ResultadoRuaRara {
  const condicao = nVisitasHistorico <= limiarVisitas && !aproximandoAlgum;
  const streak = condicao ? streakAnterior + 1 : 0;
  return { streak, disparou: streak >= LIMIAR_STREAK_RUA_RARA };
}

// Monta o Alerta final. Se os dois sinais dispararem no mesmo ciclo,
// "afastando de tudo" tem prioridade (sinal mais direto/menos ambiguo).
export function montarAlertaDesvio(
  afastando: { disparou: boolean; streak: number },
  ruaRara: { disparou: boolean; streak: number; celula: string; nVisitas: number }
): Alerta | null {
  if (afastando.disparou) {
    return {
      nivel: "atencao",
      tipo: "desvio",
      motivo: "Afastando de todos os clientes pendentes e da base (distância real de rua)",
      score: 60,
      origemDesvio: "afastando_geral",
    };
  }
  if (ruaRara.disparou) {
    return {
      nivel: "atencao",
      tipo: "desvio",
      motivo: `Entrou em trecho raramente percorrido pela frota (célula ${ruaRara.celula}, ${ruaRara.nVisitas} visita(s) no histórico)`,
      score: 55,
      origemDesvio: "rua_rara_frota",
    };
  }
  return null;
}
```

- [ ] **Step 4: Ajustar `Alerta.origemDesvio` em `detectores.ts` (linha 59)**

O tipo `origemDesvio` ainda lista as origens antigas (`"comportamental" | "cerca_virtual" | "saida_parada" | "classe_viaria" | "rumo_diverge"`). Trocar por:
```ts
  origemDesvio?: "afastando_geral" | "rua_rara_frota";
```
(A limpeza do resto do arquivo — deletar `detectarDesvio` e companhia, que são os únicos consumidores das origens antigas — acontece na Task 5; fazer essa troca de tipo agora só quebra o build até lá, o que é esperado e confirmado na Task 5.)

- [ ] **Step 5: Rodar e confirmar que os testes passam**

Run: `npx vitest run src/lib/desvio.test.ts`
Expected: PASS (10/10). (Typecheck vai falhar até a Task 5 remover os usos antigos de `origemDesvio` — não rodar `tsc --noEmit` completo ainda nesta task.)

- [ ] **Step 6: Commit**

```bash
git add src/lib/desvio.ts src/lib/desvio.test.ts src/lib/detectores.ts
git commit -m "feat: sinais de desvio v2 (afastando de tudo + rua rara) e montarAlertaDesvio"
```

---

### Task 4: Frequência de célula — helper de incremento + backfill histórico

**Files:**
- Create: `scripts/backfill-celula-frequencia.mjs`

**Interfaces:**
- Consumes: `celulaDe` de `src/lib/celulas.ts` (reaproveitado, replicado em SQL puro pra rodar em lote no banco — ver Step 1).
- Produces: popula `celula_frequencia_cliente` (Task 1) a partir de `posicoes_historico` — pré-requisito pra Task 6 não começar contando do zero.

- [ ] **Step 1: Escrever o script de backfill**

Roda uma vez, direto via SQL (agregação no banco é muito mais rápido que paginar em JS pra ~90 dias de `posicoes_historico`). Replica `celulaDe` (`round(lat*1000):round(lng*1000)`) em SQL. Simplificação aceita: usa só os pings brutos (sem interpolar segmentos como `celulasDoSegmento` faz em tempo real) — suficiente pra semear uma frequência de base, não precisa ser exato.

```js
// Backfill único de celula_frequencia_cliente a partir de posicoes_historico
// (90 dias já existentes) -- ver Task 4 do plano
// docs/superpowers/plans/2026-08-12-desvio-de-rota-v2.md. Rodar UMA VEZ,
// antes de ligar o Sinal B (rua rara) em produção (Task 6).
// Uso: node --env-file=.env.local scripts/backfill-celula-frequencia.mjs
import pg from "pg";

const conn = process.env.DATABASE_URL;
if (!conn) { console.error("DATABASE_URL ausente"); process.exit(1); }

const client = new pg.Client({ connectionString: conn, ssl: { rejectUnauthorized: false } });

try {
  await client.connect();
  console.log("conectado. agregando posicoes_historico por celula/cliente...");

  const { rowCount } = await client.query(`
    INSERT INTO celula_frequencia_cliente (cliente_id, celula, n_visitas, primeira_vez, ultima_vez)
    SELECT
      v.cliente_id,
      round(ph.lat * 1000)::text || ':' || round(ph.lng * 1000)::text AS celula,
      count(*)::int AS n_visitas,
      min(ph.criado_em)::date AS primeira_vez,
      max(ph.criado_em)::date AS ultima_vez
    FROM posicoes_historico ph
    JOIN veiculos v ON v.id = ph.veiculo_id
    WHERE ph.lat IS NOT NULL AND ph.lng IS NOT NULL
    GROUP BY v.cliente_id, celula
    ON CONFLICT (cliente_id, celula) DO UPDATE SET
      n_visitas = celula_frequencia_cliente.n_visitas + EXCLUDED.n_visitas,
      primeira_vez = LEAST(celula_frequencia_cliente.primeira_vez, EXCLUDED.primeira_vez),
      ultima_vez = GREATEST(celula_frequencia_cliente.ultima_vez, EXCLUDED.ultima_vez)
  `);

  console.log(`OK — ${rowCount} linhas de célula/cliente inseridas/atualizadas.`);
  const { rows } = await client.query(`SELECT count(*)::int AS n FROM celula_frequencia_cliente`);
  console.log("total de células conhecidas:", rows[0].n);
} catch (e) {
  console.error("ERRO:", e.message);
  process.exitCode = 1;
} finally {
  await client.end();
}
```

- [ ] **Step 2: Rodar contra o banco local**

Run: `node --env-file=.env.local scripts/backfill-celula-frequencia.mjs`
Expected: `OK — N linhas...` sem erro, `total de células conhecidas` > 0.

- [ ] **Step 3: Commit**

```bash
git add scripts/backfill-celula-frequencia.mjs
git commit -m "feat: backfill de celula_frequencia_cliente a partir do histórico de posições"
```

(A execução em produção — Contabo — acontece na Task 9, depois do deploy e ANTES de confirmar que o Sinal B está confiável, já que sem isso toda célula começaria com `n_visitas=0` e disparia em qualquer lugar.)

---

### Task 5: Apagar o sistema antigo de desvio

**Files:**
- Delete: `src/lib/detectores-teste.ts`, `src/lib/detectores-teste.test.ts`
- Delete: `src/lib/placar-desvio.ts`, `src/lib/placar-desvio.test.ts`
- Delete: `src/lib/classificacao-viaria.ts`, `src/lib/classificacao-viaria.test.ts`
- Delete: `src/lib/corredor-verificacao.ts`, `src/lib/corredor-verificacao.test.ts`
- Modify: `src/lib/detectores.ts` (funções antigas de desvio)
- Modify: `src/lib/detectores.test.ts` (remover testes das funções apagadas)
- Modify: `src/app/api/motor/route.ts` (bloco "cerca virtual", bloco antigo de streak/afastamento, imports)

**Interfaces:**
- Consumes: nada.
- Produces: `detectores.ts` limpo (só as funções confirmadas como usadas por OUTROS tipos de alerta sobrevivem), `route.ts` sem nenhuma referência aos módulos apagados — pré-requisito pra Task 6 poder inserir o código novo sem duplicidade.

**IMPORTANTE — este arquivo é enorme e entrelaçado (5000+ linhas em `route.ts`, várias funções de `detectores.ts` compartilhadas entre tipos de alerta diferentes). Siga o procedimento abaixo EXATAMENTE, não pule a etapa de verificação por grep — já foi confirmado nesta investigação que remover a função errada quebra um tipo de alerta DIFERENTE de desvio (ex: `dentroTapete`/`calcularRiscoArea` alimentam `detectarParadaForaTapete`, um alerta separado que fica intocado neste plano).**

- [ ] **Step 1: Apagar os 4 arquivos (+ testes) confirmados como exclusivos do sistema antigo**

```bash
rm src/lib/detectores-teste.ts src/lib/detectores-teste.test.ts
rm src/lib/placar-desvio.ts src/lib/placar-desvio.test.ts
rm src/lib/classificacao-viaria.ts src/lib/classificacao-viaria.test.ts
rm src/lib/corredor-verificacao.ts src/lib/corredor-verificacao.test.ts
```

Confirmado nesta investigação: os 4 são usados APENAS pelo caminho de desvio antigo (modo teste, placar sombra, bônus de classe viária, e confirmação de corredor + cerca virtual do desvio — nada mais no código chama `verificarCorredor`/`avaliarDesvioTeste`/`aplicarBonusClasseViaria` fora do que está sendo apagado nesta task).

- [ ] **Step 2: Em `src/lib/detectores.ts`, apagar as funções/tipos confirmados como exclusivos de desvio**

Lista (nome, motivo confirmado): `CtxDesvio` (type), `DesvioInicio` (type), `ContextoDesvio` (interface), `montarContextoDesvio`, `desvioInicioEfetivoParaContexto`, `StreaksDesvio` (type), `zerarStreakDaOrigemVencedora`, `reancorarOrigemVencedora`, `afastouDeTudo`, `razaoRetidaoRumo`, `limiarRazaoRetidaoRumo`, `viradaErradaSaindoDeParada`, `devAvancarStreaksDesvio`, `avancarStreaksDesvio`, `foraDeRota`, `detectarDesvio`, `aplicarBonusClasseViaria`, `elegivelParaAnotarPlacarSombra`, `elegivelParaAutoResolveAfastandoPorIdade`, `origemMenorDistDestinoM`, `deveAutoResolverAfastandoChegadaReal`, `contaComoEventoDeSilenciamento`, `contaComoRotuloHumano` — todas só existem pra alimentar `detectarDesvio`/placar/auto-resolve de desvio, confirmado via `montarCandidatosCore` (só `detectarDesvio` usa `CtxDesvio`) e via nome (as `*Afastando*`/`*RotuloHumano*`/`*Silenciamento*` são específicas de calibração/auto-resolve de desvio).

**NÃO apagar** (confirmado compartilhado com outros tipos de alerta): `calcularRiscoArea` (usado por `detectarParadaForaTapete` via `riscoAreaAtual`), `temCoordenadaValida` (usado direto em `route.ts` no filtro de `pendentes`), `elegivelParaAcaoMassa` (feature geral de "resolver em massa", não específica de desvio).

**Verificar antes de decidir** (grep, não apagar de cabeça): `saiuParadaConfirmadaHaMenosDe`, `deveMarcarSaidaParadaConfirmada`, `rumoCoerenteComDestino`, `deveAutoResolverAfastandoRotaConcluida`, `elegivelParaAutoResolveAfastando`. Pra cada uma:
```bash
grep -rn "nomeDaFuncao(" src --include="*.ts" | grep -v "\.test\.ts" | grep -v "detectores.ts"
```
Se não houver NENHUM resultado fora de `detectores.ts`/`route.ts` (que serão limpos nesta e na próxima task) → apagar. Se houver uso em outro arquivo → manter e anotar no commit por quê.

- [ ] **Step 3: Trocar `origemDesvio` no `Alerta` type (se ainda não foi feito na Task 3, confirmar)**

Já feito na Task 3, Step 4 — confirmar que o valor é `"afastando_geral" | "rua_rara_frota"`.

- [ ] **Step 4: Em `route.ts`, apagar o bloco "CERCA VIRTUAL"**

Bloco começa no comentário `// ─── CERCA VIRTUAL (ver CERCA_VIRTUAL_MODO no topo) ──` e termina no fechamento do `} else if (pendentes.length === 0) { cacheCercaPorVeiculo.delete(veiculo_id); }` — logo antes do comentário `// Bypass de entrega sem parar`. Apagar o bloco inteiro, incluindo a declaração `let alertaCerca: Alerta | null = null;` alguns comentários acima dele.

Também apagar, no topo do arquivo: o bloco de comentário/constante `CERCA_VIRTUAL_MODO` (perto da linha 326, comentário `// ─── CERCA VIRTUAL de rota (Fase 1 do plano de 10/07) -- ATIVA (11/07) ───`) e qualquer `cacheCercaPorVeiculo`/`cercaSombraCiclo`/`ultimaVerificacaoCorredorPorVeiculo`/`chamadasCorredorNoCiclo`/`ORCAMENTO_CORREDOR_POR_CICLO`/`RESERVA_COMPORTAMENTAL_POR_CICLO`/`CERCA_CACHE_MS` que só existiam pra alimentar esse bloco — o compilador (`tsc --noEmit`, Step 6) vai apontar qualquer um desses que sobrar sem uso.

Também remover `alertaCerca` do array de "extras" (`route.ts:3586`, `[..., alertaCerca, ...]` dentro da chamada final de `arbitrarCandidatos`).

- [ ] **Step 5: Em `route.ts`, apagar o bloco de modo teste e o cálculo antigo de afastamento**

Dois blocos, já com âncora exata confirmada nesta investigação:
1. Bloco de modo teste dentro do loop por veículo: do comentário `// Modo teste: caminho totalmente paralelo, so roda se o cliente tiver o` (perto da construção de `destinos`) até o `}` que fecha o `if (clientesModoTesteAtivo.has(cliente_id)) {` — logo antes do comentário `// Achado CRITICO da revisao final de branch (docs/superpowers/plans/2026-08-09-escala-rota.md)`.
2. O prefetch de modo teste ANTES do loop por cliente (mesmo padrão do bloco 1, mas fora do loop de veículo — procurar `clientesModoTesteAtivo = new Set` e apagar o bloco de prefetch inteiro: `clientesModoTesteAtivo`, `romaneioTestePorPlaca`, `estadoTestePorVeiculo` e os 3 `try/catch` que os populam).

Apagar também as declarações antigas de streak/estado que ficavam logo depois do bloco 1 (`NAO_ESCALA_LEN`, `distDestinosM`/`distDestinosAnteriorM` calculados via `haversineM` — **serão recriados na Task 6, mas via distância REAL, não `haversineM`** — pode apagar essas 2 linhas específicas agora), `menorDistDestinoM`, `desvioStreak`, `desvioInicio`, e toda a lógica de `afastandoDeTudoAtual`/`indiceReferencia`/streak que vem depois, até o ponto onde o código volta a ser sobre OUTRA coisa (`dentroTapete`/`familiarVeiculo`/rumo/etc — esses ficam, não são desvio-exclusivos). Usar o mesmo procedimento de verificação por grep do Step 2 pra qualquer variável intermediária que sobrar sem uso.

- [ ] **Step 6: Rodar o typecheck e resolver os erros um por um**

Run: `npx tsc --noEmit -p .`

Cada erro vai apontar uma referência a algo apagado. Pra cada um:
- Se for dentro de `montarCandidatosCore` (a chamada de `detectarDesvio`/`aplicarBonusClasseViaria`) — apagar essa entrada do array por enquanto (a Task 6 recoloca a versão nova).
- Se for um import de módulo apagado (`corredor-verificacao`, `detectores-teste`, `placar-desvio`, `classificacao-viaria`) — apagar o import.
- Se for uma variável/função que só existia pra alimentar algo já apagado — apagar.
- Se não tiver certeza — rodar `grep -rn "nomeDoSimbolo" src --include="*.ts"` e decidir pela mesma regra do Step 2.

Repetir até `npx tsc --noEmit -p .` não reportar mais nenhum erro relacionado a desvio/cerca/placar/modo-teste. (Podem sobrar erros da Task 6 ainda não feita, tipo `distDestinosM is not defined` no ponto de uso dentro de `montarCandidatosCore` — esses ficam pendentes até a próxima task; **não** inserir a chamada nova ainda aqui, só garantir que nada aponta mais pro código apagado.)

- [ ] **Step 7: Remover do array `posicoesCiclo.push({...})` (linhas ~3883-3919) os campos exclusivos de desvio**

Remover: `desvio_streak`, `desvio_inicio`, `fora_tapete_streak`, `divergencia_rumo_streak`, `divergencia_rumo_inicio`, `divergencia_rumo_caminho_m`, `aproximando_streak`, `origem_celula`, `ultima_via_principal_em`, `saiu_parada_confirmada_em`, `perto_sem_marcacao_codigo`, `perto_sem_marcacao_segundos`, `placar_desvio`, `placar_desvio_estado`.

Manter: `veiculo_id`, `lat`, `lng`, `velocidade`, `ignicao`, `atraso_min`, `panico`, `bau_aberto`, `nivel`, `motivo`, `datagps`, `parado_desde`, `updated_at`, `entregas_feitas`, `entregas_total`, `local`, `rumo`, `ultimo_evento`.

`no_raio_alvo_codigo`/`no_raio_desde`/`no_raio_dwell_segundos`: verificar via grep (`CtxParadaSemMarcacao`/`detectarParadaSemMarcacao` em `detectores.ts:2115-2153` — se esses campos alimentam essa struct, MANTER; confirmar antes de apagar).

Aplicar a mesma lista de remoção na query `.select(...)` de `posicoes_atuais` perto da linha 860.

- [ ] **Step 8: Rodar typecheck e testes de novo**

Run: `npx tsc --noEmit -p .`
Expected: limpo (ou só erros esperados que a Task 6 resolve, documentados no commit).

Run: `npx vitest run`
Expected: nenhum teste dos arquivos apagados sobrevive (já removidos junto); resto passa.

- [ ] **Step 9: Commit**

```bash
git add -A
git commit -m "refactor: apaga sistema antigo de desvio (modo teste, placar, corredor, cerca virtual, classe viária)"
```

---

### Task 6: Wiring — os 2 sinais novos no motor

**Files:**
- Modify: `src/app/api/motor/route.ts`

**Interfaces:**
- Consumes: `buscarDistanciasReais` (Task 2), `avaliarAfastandoDeTudo`/`avaliarRuaRara`/`montarAlertaDesvio` (Task 3), tabelas `desvio_estado`/`celula_frequencia_cliente` (Task 1), `celulaDe` (`src/lib/celulas.ts`, já existe).
- Produces: alertas `tipo="desvio"` reais em produção; nenhuma outra task depende deste wiring além da Task 8 (validação).

- [ ] **Step 1: Adicionar os imports no topo de `route.ts`**

```ts
import { buscarDistanciasReais } from "@/lib/distancia-real";
import { avaliarAfastandoDeTudo, avaliarRuaRara, montarAlertaDesvio } from "@/lib/desvio";
import { celulaDe } from "@/lib/celulas";
```

- [ ] **Step 2: Prefetch de `desvio_estado` (mesmo lugar/idioma de outros prefetches em lote, ex. `riscoPorVeiculo`)**

Antes do loop por cliente:
```ts
// Detector de desvio v2 (spec 2026-08-12-desvio-de-rota-v2-design.md):
// prefetch do estado (streaks) de todos os veiculos de uma vez.
const desvioEstadoPorVeiculo = new Map<string, { afastandoStreak: number; ruaRaraStreak: number }>();
try {
  const { rows } = await pool.query<{ veiculo_id: string; afastando_streak: number; rua_rara_streak: number }>(
    `SELECT veiculo_id, afastando_streak, rua_rara_streak FROM desvio_estado`
  );
  for (const r of rows) {
    desvioEstadoPorVeiculo.set(r.veiculo_id, { afastandoStreak: r.afastando_streak, ruaRaraStreak: r.rua_rara_streak });
  }
} catch (errDesvioEstado) {
  erros.push(`Aviso: desvio v2 indisponivel neste ciclo (estado): ${String(errDesvioEstado)}`);
}
```

- [ ] **Step 3: Dentro do loop por veículo, logo após a construção de `destinos` (mesmo ponto onde o bloco antigo de modo-teste/afastamento foi removido na Task 5) — calcular distância real e avaliar os 2 sinais**

```ts
// Detector de desvio v2: distancia REAL de rua (nunca linha reta) contra
// pendentes + base. Suspenso perto de chegada, igual o resto do motor ja
// fazia (suspenderPorChegada, calculado abaixo igual antes).
const estadoDesvioAnterior = desvioEstadoPorVeiculo.get(veiculo_id) ?? { afastandoStreak: 0, ruaRaraStreak: 0 };
let afastandoStreakNovo = 0;
let ruaRaraStreakNovo = 0;
let alertaDesvioV2: Alerta | null = null;

if (pos.fresco && !saltoImplausivel && !suspensoPorChegada && destinos.length > 0) {
  const distAtuaisReais = await buscarDistanciasReais(
    { lat: pos.lat, lng: pos.lng },
    destinos
  );
  const distAnterioresReais =
    temAnterior && distAtuaisReais
      ? await buscarDistanciasReais({ lat: anterior!.lat!, lng: anterior!.lng! }, destinos)
      : null;

  if (distAtuaisReais && distAnterioresReais) {
    const afastando = avaliarAfastandoDeTudo(distAtuaisReais, distAnterioresReais, estadoDesvioAnterior.afastandoStreak);
    afastandoStreakNovo = afastando.streak;

    const celulaAtual = celulaDe(pos.lat, pos.lng);
    const nVisitasHistorico = celulasFrequenciaCliente.get(celulaAtual) ?? 0;
    const ruaRara = avaliarRuaRara(nVisitasHistorico, afastando.aproximandoAlgum, estadoDesvioAnterior.ruaRaraStreak);
    ruaRaraStreakNovo = ruaRara.streak;

    alertaDesvioV2 = montarAlertaDesvio(afastando, { ...ruaRara, celula: celulaAtual, nVisitas: nVisitasHistorico });
  } else {
    // OSRM indisponivel neste ciclo -- fail-open: nao avalia, streak nao muda.
    afastandoStreakNovo = estadoDesvioAnterior.afastandoStreak;
    ruaRaraStreakNovo = estadoDesvioAnterior.ruaRaraStreak;
  }
}
```

`celulasFrequenciaCliente` (Map por célula → `n_visitas`, só do cliente atual) precisa ser carregada em lote antes do loop por veículo, no mesmo bloco de prefetch por cliente que já carrega `basesCliente`/`escalaPontosPorPlaca` (perto da linha 1479 mencionada na Task 4 do plano de 11/08 — procurar `basesCliente = ` como âncora):

```ts
const { rows: rowsFreqCelula } = await pool.query<{ celula: string; n_visitas: number }>(
  `SELECT celula, n_visitas FROM celula_frequencia_cliente WHERE cliente_id = $1`,
  [cliente_id]
);
const celulasFrequenciaCliente = new Map(rowsFreqCelula.map((r) => [r.celula, r.n_visitas]));
```

(Ajustar o nome exato do `try`/loop por cliente conforme o código real ao redor — usar o mesmo padrão de try/catch com `erros.push` que os outros prefetches por cliente já usam nesse trecho.)

- [ ] **Step 4: Incluir `alertaDesvioV2` na composição final de candidatos**

Em vez de reintroduzir a chamada dentro de `montarCandidatosCore` (que exigiria mexer na assinatura de `CtxAvaliacao` de novo pra passar as distâncias reais — mais simples manter fora, como `alertaCerca` já fazia), adicionar `alertaDesvioV2` na MESMA lista de "extras" onde `alertaCerca` foi removido na Task 5, Step 4 (`route.ts:3586`, dentro do array passado pra `arbitrarCandidatos` final):

```ts
alerta = arbitrarCandidatos([...candidatosCoreFinal, ...extras, alertaDesvioV2]);
```

(Confirmar o nome exato da variável `extras`/`candidatosCoreFinal` no ponto real — é a MESMA chamada final de `arbitrarCandidatos` de onde `alertaCerca` foi removido.)

- [ ] **Step 5: Persistir `desvio_estado` e incrementar `celula_frequencia_cliente` (mesmo lugar onde o antigo `desvio_teste_estado` upsert acontecia, agora removido)**

```ts
try {
  await pool.query(
    `INSERT INTO desvio_estado (veiculo_id, afastando_streak, rua_rara_streak, atualizado_em)
     VALUES ($1, $2, $3, now())
     ON CONFLICT (veiculo_id) DO UPDATE SET
       afastando_streak = EXCLUDED.afastando_streak,
       rua_rara_streak = EXCLUDED.rua_rara_streak,
       atualizado_em = now()`,
    [veiculo_id, afastandoStreakNovo, ruaRaraStreakNovo]
  );
  if (pos.fresco) {
    const celulaAgora = celulaDe(pos.lat, pos.lng);
    await pool.query(
      `INSERT INTO celula_frequencia_cliente (cliente_id, celula, n_visitas, primeira_vez, ultima_vez)
       VALUES ($1, $2, 1, current_date, current_date)
       ON CONFLICT (cliente_id, celula) DO UPDATE SET
         n_visitas = celula_frequencia_cliente.n_visitas + 1,
         ultima_vez = current_date`,
      [cliente_id, celulaAgora]
    );
  }
} catch (errDesvioV2Gravacao) {
  erros.push(`Aviso: falha ao gravar desvio v2 pro veiculo ${veiculo_id}: ${String(errDesvioV2Gravacao)}`);
}
```

- [ ] **Step 6: Typecheck e testes**

Run: `npx tsc --noEmit -p .`
Expected: limpo.

Run: `npx vitest run`
Expected: tudo passa.

- [ ] **Step 7: Teste manual local — 1 ciclo do motor**

Run: `npm run dev` (outro terminal) e depois `node --env-file=.env.local scripts/motor-loop.mjs` (ou disparar `/api/motor` uma vez manualmente, conforme `DEPLOY.md`).
Expected: ciclo roda sem exceção; `SELECT * FROM desvio_estado LIMIT 5;` mostra linhas sendo gravadas; `SELECT * FROM celula_frequencia_cliente ORDER BY ultima_vez DESC LIMIT 5;` mostra incremento.

- [ ] **Step 8: Commit**

```bash
git add src/app/api/motor/route.ts
git commit -m "feat: liga o detector de desvio v2 em produção (afastando de tudo + rua rara)"
```

---

### Task 7: Migração de limpeza — apagar tabelas/colunas órfãs

**Files:**
- Create: `scripts/migrations/043_limpeza_desvio_antigo.sql`
- Create: `scripts/migrations/contabo/043_limpeza_desvio_antigo.sql`

**Interfaces:**
- Consumes: confirmação da Task 6 (código novo já rodando, nada mais referencia as colunas/tabelas antigas).

**Só rodar depois de confirmar (Task 6, Step 7/8) que o código novo funciona sem essas colunas — esta migration é destrutiva (DROP).**

- [ ] **Step 1: Confirmar por grep que nada no código referencia mais as colunas/tabelas a apagar**

```bash
grep -rn "placar_desvio\|desvio_teste_estado\|corredor_celulas_veiculo\|fora_tapete_streak\|divergencia_rumo\|origem_celula\b\|ultima_via_principal_em\|saiu_parada_confirmada_em\|perto_sem_marcacao" src --include="*.ts"
```
Expected: zero resultados (fora de comentários/histórico, se algum sobrar).

- [ ] **Step 2: Escrever a migration local**

```sql
-- 043_limpeza_desvio_antigo.sql
-- Remove tabelas/colunas do sistema de desvio ANTIGO, orfas apos o
-- redesign v2 (docs/superpowers/specs/2026-08-12-desvio-de-rota-v2-design.md).
DROP TABLE IF EXISTS placar_desvio_log;
DROP TABLE IF EXISTS desvio_teste_estado;
DROP TABLE IF EXISTS corredor_celulas_veiculo;

ALTER TABLE posicoes_atuais
  DROP COLUMN IF EXISTS desvio_streak,
  DROP COLUMN IF EXISTS desvio_inicio,
  DROP COLUMN IF EXISTS fora_tapete_streak,
  DROP COLUMN IF EXISTS divergencia_rumo_streak,
  DROP COLUMN IF EXISTS divergencia_rumo_inicio,
  DROP COLUMN IF EXISTS divergencia_rumo_caminho_m,
  DROP COLUMN IF EXISTS aproximando_streak,
  DROP COLUMN IF EXISTS origem_celula,
  DROP COLUMN IF EXISTS ultima_via_principal_em,
  DROP COLUMN IF EXISTS saiu_parada_confirmada_em,
  DROP COLUMN IF EXISTS perto_sem_marcacao_codigo,
  DROP COLUMN IF EXISTS perto_sem_marcacao_segundos,
  DROP COLUMN IF EXISTS placar_desvio,
  DROP COLUMN IF EXISTS placar_desvio_estado;
```

Nota: `corredor_celulas` (SEM `_veiculo`) **não é apagada** — alimenta `dentroTapete`, usado por `detectarParadaForaTapete`, tipo de alerta separado que fica intocado.

- [ ] **Step 3: Escrever a migration contabo (mesmo conteúdo + `NOTIFY pgrst`)**

```sql
-- 043_limpeza_desvio_antigo.sql
DROP TABLE IF EXISTS placar_desvio_log;
DROP TABLE IF EXISTS desvio_teste_estado;
DROP TABLE IF EXISTS corredor_celulas_veiculo;

ALTER TABLE posicoes_atuais
  DROP COLUMN IF EXISTS desvio_streak,
  DROP COLUMN IF EXISTS desvio_inicio,
  DROP COLUMN IF EXISTS fora_tapete_streak,
  DROP COLUMN IF EXISTS divergencia_rumo_streak,
  DROP COLUMN IF EXISTS divergencia_rumo_inicio,
  DROP COLUMN IF EXISTS divergencia_rumo_caminho_m,
  DROP COLUMN IF EXISTS aproximando_streak,
  DROP COLUMN IF EXISTS origem_celula,
  DROP COLUMN IF EXISTS ultima_via_principal_em,
  DROP COLUMN IF EXISTS saiu_parada_confirmada_em,
  DROP COLUMN IF EXISTS perto_sem_marcacao_codigo,
  DROP COLUMN IF EXISTS perto_sem_marcacao_segundos,
  DROP COLUMN IF EXISTS placar_desvio,
  DROP COLUMN IF EXISTS placar_desvio_estado;

NOTIFY pgrst, 'reload schema';
```

- [ ] **Step 4: Aplicar local, typecheck, testes**

Run: `node --env-file=.env.local scripts/aplicar-migration.mjs 043_limpeza_desvio_antigo.sql`
Run: `npx tsc --noEmit -p .` && `npx vitest run`
Expected: tudo limpo.

- [ ] **Step 5: Commit**

```bash
git add scripts/migrations/043_limpeza_desvio_antigo.sql scripts/migrations/contabo/043_limpeza_desvio_antigo.sql
git commit -m "chore: remove tabelas/colunas orfas do sistema de desvio antigo"
```

---

### Task 8: Validação — dia real de frota + recall contra casos confirmados

**Files:**
- Create: `scripts/validar-desvio-v2.mjs`

**Interfaces:**
- Consumes: `avaliarAfastandoDeTudo`/`avaliarRuaRara` (Task 3, via `tsx`), tabelas `pendentes_snapshot_log`, `posicoes_historico`, `casos_desvio_revisao`, `celula_frequencia_cliente`.

**Antes de escrever o script, checar a janela real de retenção disponível (não assumir):**
```sql
SELECT min(criado_em), max(criado_em), count(*) FROM pendentes_snapshot_log;
SELECT min(criado_em), max(criado_em), count(*) FROM casos_desvio_revisao;
```
`casos_desvio_revisao` tem retenção curta (2 dias, `scripts/migrations/029_casos_desvio_revisao.sql`) — a validação de recall só cobre o que estiver nessa janela no momento em que o script roda. Isso é uma limitação conhecida do dado disponível, não do detector — documentar no relatório final (Step 3).

- [ ] **Step 1: Escrever o script de replay/validação**

```js
// Valida o detector de desvio v2 contra dado real: (1) volume de disparo
// num dia de frota inteira via replay de posicoes_historico +
// pendentes_snapshot_log, (2) recall contra casos_desvio_revisao
// confirmados 'resolvido'. Ver Task 8 do plano
// docs/superpowers/plans/2026-08-12-desvio-de-rota-v2.md.
// Uso: node --env-file=.env.local scripts/validar-desvio-v2.mjs
import pg from "pg";
import { avaliarAfastandoDeTudo, avaliarRuaRara } from "../src/lib/desvio.ts";
import { celulaDe } from "../src/lib/celulas.ts";

const conn = process.env.DATABASE_URL;
const client = new pg.Client({ connectionString: conn, ssl: { rejectUnauthorized: false } });
await client.connect();

// 1. Replay por veiculo, cruzando posicoes_historico com o snapshot de
// pendentes mais recente <= aquele timestamp (aproximacao -- snapshot e
// throttled, nao existe 1 por ciclo exato).
const { rows: veiculos } = await client.query(`SELECT DISTINCT veiculo_id FROM posicoes_historico`);
let totalDisparos = 0;
const disparosPorVeiculo = new Map();

for (const { veiculo_id } of veiculos) {
  const { rows: posicoes } = await client.query(
    `SELECT lat, lng, criado_em FROM posicoes_historico WHERE veiculo_id = $1 ORDER BY criado_em ASC`,
    [veiculo_id]
  );
  const { rows: snapshots } = await client.query(
    `SELECT criado_em, pendentes FROM pendentes_snapshot_log WHERE veiculo_id = $1 ORDER BY criado_em ASC`,
    [veiculo_id]
  );
  const { rows: freq } = await client.query(
    `SELECT c.celula, f.n_visitas FROM celula_frequencia_cliente f
     JOIN veiculos v ON v.cliente_id = f.cliente_id
     CROSS JOIN LATERAL (SELECT f.celula AS celula) c
     WHERE v.id = $1`,
    [veiculo_id]
  );
  const freqMap = new Map(freq.map((r) => [r.celula, r.n_visitas]));

  let afastandoStreak = 0;
  let ruaRaraStreak = 0;
  let anterior = null;
  let snapIdx = 0;

  for (const pos of posicoes) {
    while (snapIdx + 1 < snapshots.length && snapshots[snapIdx + 1].criado_em <= pos.criado_em) snapIdx++;
    const pendentesAgora = (snapshots[snapIdx]?.pendentes ?? []).filter((p) => p.lat != null && p.lng != null);
    if (pendentesAgora.length === 0 || !anterior) {
      anterior = pos;
      continue;
    }

    // Simplificacao de backtest (documentada na Task 8): distancia
    // aproximada (haversine) em vez de OSRM real, pra nao fazer ~milhoes
    // de chamadas de rede no replay -- serve pra medir VOLUME relativo,
    // nao pra validar precisao de distancia (essa ja foi validada
    // separadamente em 11/08, ver docs/analise-desvio-raiz-2026-08-11.md).
    const dist = (a, b) => Math.sqrt((a.lat - b.lat) ** 2 + (a.lng - b.lng) ** 2) * 111_000;
    const distAtuais = pendentesAgora.map((p) => dist(pos, p));
    const distAnteriores = pendentesAgora.map((p) => dist(anterior, p));

    const afastando = avaliarAfastandoDeTudo(distAtuais, distAnteriores, afastandoStreak);
    afastandoStreak = afastando.streak;

    const celula = celulaDe(pos.lat, pos.lng);
    const nVisitas = freqMap.get(celula) ?? 0;
    const ruaRara = avaliarRuaRara(nVisitas, afastando.aproximandoAlgum, ruaRaraStreak);
    ruaRaraStreak = ruaRara.streak;

    if (afastando.disparou || ruaRara.disparou) {
      totalDisparos++;
      disparosPorVeiculo.set(veiculo_id, (disparosPorVeiculo.get(veiculo_id) ?? 0) + 1);
    }
    anterior = pos;
  }
}

console.log(`Total de disparos no replay: ${totalDisparos}`);
console.log(`Veiculos com >=1 disparo: ${disparosPorVeiculo.size} / ${veiculos.length}`);

// 2. Recall contra casos confirmados 'resolvido'.
const { rows: casosReais } = await client.query(
  `SELECT alerta_id, veiculo_id, criado_em FROM casos_desvio_revisao WHERE status_final = 'resolvido'`
);
console.log(`Casos confirmados 'resolvido' na janela disponivel: ${casosReais.length}`);
let cobertos = 0;
for (const caso of casosReais) {
  if (disparosPorVeiculo.has(caso.veiculo_id)) cobertos++;
}
console.log(`Recall aproximado (veiculo teve >=1 disparo no dia do caso confirmado): ${cobertos}/${casosReais.length}`);

await client.end();
```

- [ ] **Step 2: Rodar contra o banco (local ou, se necessário, apontando pro Contabo depois da Task 9 — decidir na hora conforme onde há dado real suficiente)**

Run: `node --env-file=.env.local scripts/validar-desvio-v2.mjs`
Expected: roda sem erro, imprime volume de disparos e recall.

- [ ] **Step 3: Revisão visual manual dos casos ambíguos**

Pra qualquer veículo com disparo mas SEM caso confirmado correspondente (possível falso positivo) — inspecionar manualmente via chrome-devtools/mapa (nunca delegar esse julgamento a classificador automático, instrução explícita já dada pelo usuário antes neste projeto). Reportar pro usuário: volume total, recall, e uma lista de até 10 casos ambíguos revisados manualmente antes de prosseguir pra Task 9.

Se o recall não for 100% dos casos confirmados — **não seguir pra Task 9 sem reportar isso ao usuário primeiro** (prioridade é recall, perder um caso real é o pior resultado possível aqui).

- [ ] **Step 4: Commit**

```bash
git add scripts/validar-desvio-v2.mjs
git commit -m "test: script de validação do desvio v2 (volume real + recall)"
```

---

### Task 9: Replicar pro repo definitivo + deploy real

**Files:**
- Modify: todos os arquivos das Tasks 1-8, replicados em `/Users/joaquimsalles/Projects/Transmonseg/monitoramento/MONITORAMENTO transmonseg`

**Interfaces:**
- Consumes: todo o trabalho anterior, já testado e commitado no TEMP.

- [ ] **Step 1: Conferir que TEMP está limpo e com tudo commitado**

Run: `cd "/Users/joaquimsalles/Projects/Transmonseg/monitoramento/MONITORAMENTO TEMP" && git status --short`
Expected: vazio.

- [ ] **Step 2: Replicar cada arquivo criado/modificado pro repo definitivo**

Copiar (criar/sobrescrever) no `MONITORAMENTO transmonseg` TODOS os arquivos tocados nas Tasks 1-8: `src/lib/distancia-real.ts(.test.ts)`, `src/lib/desvio.ts(.test.ts)`, `src/lib/detectores.ts`, `src/lib/detectores.test.ts`, `src/app/api/motor/route.ts`, `scripts/migrations/041-043_*.sql` (local + contabo), `scripts/backfill-celula-frequencia.mjs`, `scripts/validar-desvio-v2.mjs`, `docs/superpowers/specs/2026-08-12-desvio-de-rota-v2-design.md` (se ainda não copiado), `docs/superpowers/plans/2026-08-12-desvio-de-rota-v2.md`. Apagar (`rm`) os 4 arquivos deletados na Task 5 também no definitivo.

- [ ] **Step 3: Typecheck e testes no definitivo**

Run: `cd "/Users/joaquimsalles/Projects/Transmonseg/monitoramento/MONITORAMENTO transmonseg" && npx tsc --noEmit -p . && npx vitest run`
Expected: limpo.

- [ ] **Step 4: Commit no definitivo**

```bash
cd "/Users/joaquimsalles/Projects/Transmonseg/monitoramento/MONITORAMENTO transmonseg"
git add -A
git commit -m "feat: detector de desvio de rota v2 (reescrita completa)"
```

- [ ] **Step 5: Aplicar as migrations no Contabo (ordem: 041, 042, backfill, depois 043 SÓ depois de confirmar que o app novo já subiu e funciona)**

```bash
ssh transmonseg-vps "cd /srv/transmonseg/temp && git pull"
ssh transmonseg-vps "cd /srv/transmonseg/definitivo && git pull"
ssh transmonseg-vps "psql \$DATABASE_URL -f /srv/transmonseg/temp/scripts/migrations/contabo/041_desvio_estado.sql"
ssh transmonseg-vps "psql \$DATABASE_URL -f /srv/transmonseg/temp/scripts/migrations/contabo/042_celula_frequencia_cliente.sql"
```

- [ ] **Step 6: Rodar o backfill de célula em produção**

```bash
ssh transmonseg-vps "cd /srv/transmonseg/temp && node --env-file=.env.production scripts/backfill-celula-frequencia.mjs"
```
Expected: `OK — N linhas...`, sem erro.

- [ ] **Step 7: Build e deploy dos dois apps**

```bash
ssh transmonseg-vps "cd /srv/transmonseg/temp && npm run build"
ssh transmonseg-vps "cd /srv/transmonseg/definitivo && npm run build"
ssh transmonseg-vps "pm2 restart transmonseg-temp transmonseg-definitivo"
```

- [ ] **Step 8: Confirmar que subiu limpo**

```bash
ssh transmonseg-vps "sleep 3 && pm2 list"
ssh transmonseg-vps "pm2 logs transmonseg-temp --lines 30 --nostream"
ssh transmonseg-vps "pm2 logs transmonseg-definitivo --lines 30 --nostream"
```
Expected: `status: online` nos dois, sem stack trace novo relacionado a `desvio_estado`/`celula_frequencia_cliente`/módulos apagados.

- [ ] **Step 9: Rodar a migration de limpeza (Task 7) SÓ agora, depois de confirmar estabilidade em produção**

```bash
ssh transmonseg-vps "psql \$DATABASE_URL -f /srv/transmonseg/temp/scripts/migrations/contabo/043_limpeza_desvio_antigo.sql"
```

- [ ] **Step 10: Reportar pro usuário**

Confirmar por texto: detector de desvio v2 no ar em produção (sem modo teste), volume/recall observados na Task 8, e que o acompanhamento dos primeiros alertas reais é o próximo passo (fora deste plano).
