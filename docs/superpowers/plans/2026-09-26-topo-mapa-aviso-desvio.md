# Topo do mapa: aviso de desvio — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Trocar a faixa de chips de desvio do topo do mapa por um aviso que aparece quando chega desvio novo, fica 8 s e minimiza para uma pílula "Ver mais desvios (n)" que abre a lista.

**Architecture:** Lógica pura (detectar novos do lote, montar texto, máquina de estados pílula/aviso/lista) num módulo `.ts` testado com vitest; um componente fino `AvisoDesvioTopo.tsx` que só renderiza e controla o timer; `MonitorV2.tsx` passa a guardar o "último lote de novos" do poll e troca as 3 chamadas de `renderFaixaDesvio` pelo componente.

**Tech Stack:** Next.js 16 (App Router, client component), React, TypeScript, framer-motion (já no projeto), vitest (ambiente node, sem RTL).

**Spec:** `docs/superpowers/specs/2026-09-26-topo-mapa-aviso-desvio-design.md`

## Global Constraints

- Aviso destacado dura exatamente **8000 ms** (`AVISO_DESVIO_MS = 8000`); desvio novo durante o aviso substitui e reinicia os 8 s.
- Texto do aviso: 1 alerta de tipo `desvio` → `"<PLACA> em desvio agora"`; 1 alerta de outro tipo → `"<PLACA> · <nome do tipo>"`; 2+ → `"<N> desvios novos: A, B, C"` e, acima de 3, `" e mais <N-3>"`.
- Pílula: `"Ver mais desvios (<n>)"`; com n = 0 nada é renderizado.
- Tipos notificáveis = `TIPOS_NOTIFICAM_POR_CLIENTE[cliente]` (Nutry: `desvio`, `parada_fora_tapete`, `parada_sem_marcacao`, `parada_anomala`). Pânico não entra (overlay próprio).
- O mapa só se move quando o operador clica em "ver no mapa" (usa `painel.setAlertaAtivoId` + `painel.selecionarVeiculo`). Nada de escurecer nem zoom automático.
- Nenhum som novo: o apito continua sendo o `AlertaSonoro` existente.
- Lateral esquerda, cards e "Outros avisos" intocados.
- Texto de UI em português, sem emoji.

## Review Focus

1. **Trocar o escopo (TODOS → SELECIONADOS → ROMANEIO) não pode disparar o aviso.** Alertas que "aparecem" por mudança de filtro não são novos. Por isso o "novo" vem do lote do poll (`ultimoLoteNovos`), nunca de diff da lista filtrada. Teste em Task 1 (`novosDoLoteNoEscopo`).
2. **Abrir a página não pode anunciar os ~70 desvios que já existem.** `alertasRef` nasce com `alertasIniciais`, então o primeiro poll só traz novos de verdade; o componente ignora o lote inicial vazio. Teste em Task 1 (lote vazio → sem aviso).
3. **n cai para 0 com a lista aberta** (operador resolve o último pela lateral): a lista precisa fechar e nada ficar desenhado. Teste em Task 1 (`proximoModo` com `n: 0`).
4. **Rajada de muitos novos** (ex.: motor reinicia e 10 aparecem num poll): texto não pode estourar a largura. Teste em Task 1 (10 novos → "10 desvios novos: A, B, C e mais 7").
5. **Split view (AMBOS):** cada painel tem seu próprio componente e estado; o lote é filtrado pelo escopo de cada painel. Verificação visual em Task 3.

---

## File Structure

- Create `src/app/(app)/central-v2/aviso-desvio.ts` — lógica pura (sem React).
- Create `src/app/(app)/central-v2/aviso-desvio.test.ts` — testes vitest.
- Create `src/app/(app)/central-v2/AvisoDesvioTopo.tsx` — componente client.
- Modify `src/app/(app)/central-v2/MonitorV2.tsx` — estado `ultimoLoteNovos`, filtros das listas, troca de `renderFaixaDesvio`.

---

### Task 1: Lógica pura do aviso

**Files:**
- Create: `src/app/(app)/central-v2/aviso-desvio.ts`
- Test: `src/app/(app)/central-v2/aviso-desvio.test.ts`

**Interfaces:**
- Produces:
  - `export const AVISO_DESVIO_MS = 8000;`
  - `export type ModoAviso = "pilula" | "aviso" | "lista";`
  - `export type EventoAviso = { tipo: "novos"; quantidade: number } | { tipo: "timeout" } | { tipo: "clique" } | { tipo: "fechar" };`
  - `export function proximoModo(atual: ModoAviso, evento: EventoAviso, n: number): ModoAviso`
  - `export function rotuloPilula(n: number): string | null`
  - `export function textoAviso(novos: { placa: string; tipo: string }[], nomeTipo: (tipo: string) => string): string`
  - `export function novosDoLoteNoEscopo<A extends { id: string }>(loteIds: readonly string[], escopo: readonly A[]): A[]`

- [ ] **Step 1: Write the failing test**

```ts
// src/app/(app)/central-v2/aviso-desvio.test.ts
import { describe, it, expect } from "vitest";
import {
  AVISO_DESVIO_MS, proximoModo, rotuloPilula, textoAviso, novosDoLoteNoEscopo,
} from "./aviso-desvio";

const nome = (t: string) => ({ desvio: "Desvio em movimento", parada_sem_marcacao: "Parada sem marcação" } as Record<string, string>)[t] ?? t;

describe("AVISO_DESVIO_MS", () => {
  it("é 8 segundos", () => expect(AVISO_DESVIO_MS).toBe(8000));
});

describe("rotuloPilula", () => {
  it("n = 0 não renderiza nada", () => expect(rotuloPilula(0)).toBeNull());
  it("n > 0 mostra a contagem", () => expect(rotuloPilula(3)).toBe("Ver mais desvios (3)"));
});

describe("textoAviso", () => {
  it("1 desvio", () => {
    expect(textoAviso([{ placa: "RQU-9D10", tipo: "desvio" }], nome)).toBe("RQU-9D10 em desvio agora");
  });
  it("1 alerta de outro tipo usa o nome do tipo", () => {
    expect(textoAviso([{ placa: "TOS-4J82", tipo: "parada_sem_marcacao" }], nome)).toBe("TOS-4J82 · Parada sem marcação");
  });
  it("2 novos", () => {
    expect(textoAviso([{ placa: "A", tipo: "desvio" }, { placa: "B", tipo: "desvio" }], nome)).toBe("2 desvios novos: A, B");
  });
  it("3 novos cabem inteiros", () => {
    const n = ["A", "B", "C"].map(placa => ({ placa, tipo: "desvio" }));
    expect(textoAviso(n, nome)).toBe("3 desvios novos: A, B, C");
  });
  it("10 novos: 3 placas + e mais 7", () => {
    const n = "ABCDEFGHIJ".split("").map(placa => ({ placa, tipo: "desvio" }));
    expect(textoAviso(n, nome)).toBe("10 desvios novos: A, B, C e mais 7");
  });
});

describe("proximoModo", () => {
  it("novos a partir da pílula viram aviso", () => {
    expect(proximoModo("pilula", { tipo: "novos", quantidade: 1 }, 3)).toBe("aviso");
  });
  it("novos durante o aviso mantêm aviso (o timer é reiniciado pelo componente)", () => {
    expect(proximoModo("aviso", { tipo: "novos", quantidade: 2 }, 5)).toBe("aviso");
  });
  it("novos com a lista aberta não fecham a lista", () => {
    expect(proximoModo("lista", { tipo: "novos", quantidade: 1 }, 4)).toBe("lista");
  });
  it("lote vazio não muda nada", () => {
    expect(proximoModo("pilula", { tipo: "novos", quantidade: 0 }, 3)).toBe("pilula");
  });
  it("timeout do aviso volta pra pílula", () => {
    expect(proximoModo("aviso", { tipo: "timeout" }, 3)).toBe("pilula");
  });
  it("timeout com a lista aberta não fecha a lista", () => {
    expect(proximoModo("lista", { tipo: "timeout" }, 3)).toBe("lista");
  });
  it("clique na pílula ou no aviso abre a lista", () => {
    expect(proximoModo("pilula", { tipo: "clique" }, 3)).toBe("lista");
    expect(proximoModo("aviso", { tipo: "clique" }, 3)).toBe("lista");
  });
  it("clique com a lista aberta fecha", () => {
    expect(proximoModo("lista", { tipo: "clique" }, 3)).toBe("pilula");
  });
  it("fechar (Esc / clique fora / ver no mapa) volta pra pílula", () => {
    expect(proximoModo("lista", { tipo: "fechar" }, 3)).toBe("pilula");
  });
  it("n = 0 sempre volta pra pílula (que não renderiza), mesmo com a lista aberta", () => {
    expect(proximoModo("lista", { tipo: "timeout" }, 0)).toBe("pilula");
    expect(proximoModo("aviso", { tipo: "clique" }, 0)).toBe("pilula");
  });
});

describe("novosDoLoteNoEscopo", () => {
  const escopo = [{ id: "a" }, { id: "b" }, { id: "c" }];
  it("só devolve ids do lote que estão no escopo do painel", () => {
    expect(novosDoLoteNoEscopo(["b", "z"], escopo)).toEqual([{ id: "b" }]);
  });
  it("lote vazio (primeiro poll / nenhum novo) não devolve nada", () => {
    expect(novosDoLoteNoEscopo([], escopo)).toEqual([]);
  });
  it("mudar o escopo não inventa novos: só o lote decide", () => {
    const escopoMaior = [...escopo, { id: "d" }, { id: "e" }];
    expect(novosDoLoteNoEscopo([], escopoMaior)).toEqual([]);
  });
  it("mantém a ordem do escopo (mais novo primeiro)", () => {
    expect(novosDoLoteNoEscopo(["c", "a"], escopo)).toEqual([{ id: "a" }, { id: "c" }]);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run "src/app/(app)/central-v2/aviso-desvio.test.ts"`
Expected: FAIL — `Failed to resolve import "./aviso-desvio"`.

- [ ] **Step 3: Write minimal implementation**

```ts
// src/app/(app)/central-v2/aviso-desvio.ts
// Lógica pura do aviso de desvio no topo do mapa (spec
// docs/superpowers/specs/2026-09-26-topo-mapa-aviso-desvio-design.md).
// Sem React: o componente AvisoDesvioTopo só renderiza e controla o timer.

export const AVISO_DESVIO_MS = 8000;

export type ModoAviso = "pilula" | "aviso" | "lista";

export type EventoAviso =
  | { tipo: "novos"; quantidade: number }
  | { tipo: "timeout" }
  | { tipo: "clique" }
  | { tipo: "fechar" };

export function proximoModo(atual: ModoAviso, evento: EventoAviso, n: number): ModoAviso {
  if (n === 0) return "pilula";
  switch (evento.tipo) {
    case "novos":
      if (evento.quantidade === 0 || atual === "lista") return atual;
      return "aviso";
    case "timeout":
      return atual === "aviso" ? "pilula" : atual;
    case "clique":
      return atual === "lista" ? "pilula" : "lista";
    case "fechar":
      return "pilula";
  }
}

export function rotuloPilula(n: number): string | null {
  return n > 0 ? `Ver mais desvios (${n})` : null;
}

const MAX_PLACAS_NO_AVISO = 3;

export function textoAviso(novos: { placa: string; tipo: string }[], nomeTipo: (tipo: string) => string): string {
  if (novos.length === 1) {
    const [a] = novos;
    return a.tipo === "desvio" ? `${a.placa} em desvio agora` : `${a.placa} · ${nomeTipo(a.tipo)}`;
  }
  const placas = novos.slice(0, MAX_PLACAS_NO_AVISO).map(a => a.placa).join(", ");
  const resto = novos.length - MAX_PLACAS_NO_AVISO;
  return `${novos.length} desvios novos: ${placas}${resto > 0 ? ` e mais ${resto}` : ""}`;
}

// O "novo" vem do LOTE do poll (ids que não existiam no poll anterior), nunca
// de um diff da lista filtrada -- senão trocar TODOS -> SELECIONADOS faria
// alertas antigos "aparecerem" e disparar o aviso.
export function novosDoLoteNoEscopo<A extends { id: string }>(loteIds: readonly string[], escopo: readonly A[]): A[] {
  if (loteIds.length === 0) return [];
  const lote = new Set(loteIds);
  return escopo.filter(a => lote.has(a.id));
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run "src/app/(app)/central-v2/aviso-desvio.test.ts"`
Expected: PASS (todos os testes).

- [ ] **Step 5: Commit**

```bash
git add "src/app/(app)/central-v2/aviso-desvio.ts" "src/app/(app)/central-v2/aviso-desvio.test.ts"
git commit -m "feat(central-v2): logica pura do aviso de desvio no topo do mapa"
```

---

### Task 2: Componente `AvisoDesvioTopo`

**Files:**
- Create: `src/app/(app)/central-v2/AvisoDesvioTopo.tsx`

**Interfaces:**
- Consumes (Task 1): `AVISO_DESVIO_MS`, `ModoAviso`, `proximoModo`, `rotuloPilula`, `textoAviso`, `novosDoLoteNoEscopo`.
- Produces:

```ts
export type ItemAvisoDesvio = {
  id: string; placa: string; tipo: string; nivel: "critico" | "atencao";
  desde: string; lat: number | null; lng: number | null; cv: string;
};
export type CoresAviso = { red: string; yellow: string; text: string; muted: string; dim: string; border: string; card: string };
export default function AvisoDesvioTopo(props: {
  itens: ItemAvisoDesvio[];                      // alertas notificáveis do escopo, mais novo primeiro
  lote: { ids: string[]; seq: number };          // último lote de novos do poll; seq muda a cada poll com novos
  left: string; width: string;                   // posição (mesma da faixa antiga; split usa metade)
  compacto?: boolean;
  tema: "dark" | "light";
  cores: CoresAviso;
  nomeTipo: (tipo: string) => string;
  tempoAtras: (desde: string) => string;
  onVerNoMapa: (item: ItemAvisoDesvio) => void;  // único jeito de mover o mapa
}): JSX.Element | null
```

Sem teste de componente (o repo não tem RTL/jsdom; ver comentário em `MonitorV2.test.ts`). O comportamento está nos testes da Task 1; este componente só liga eventos à máquina de estados. Verificação: `tsc` aqui e visual na Task 3.

- [ ] **Step 1: Escrever o componente**

```tsx
// src/app/(app)/central-v2/AvisoDesvioTopo.tsx
"use client";

// Topo do mapa: pílula "Ver mais desvios (n)" que vira aviso destacado por
// 8 s quando chega alerta notificável novo, e abre a lista ao clicar. O mapa
// só se move por "ver no mapa". Spec:
// docs/superpowers/specs/2026-09-26-topo-mapa-aviso-desvio-design.md
import { useEffect, useRef, useState } from "react";
import {
  AVISO_DESVIO_MS, type ModoAviso, proximoModo, rotuloPilula, textoAviso, novosDoLoteNoEscopo,
} from "./aviso-desvio";

export type ItemAvisoDesvio = {
  id: string; placa: string; tipo: string; nivel: "critico" | "atencao";
  desde: string; lat: number | null; lng: number | null; cv: string;
};
export type CoresAviso = { red: string; yellow: string; text: string; muted: string; dim: string; border: string; card: string };

const FONT_MONO = "var(--font-geist-mono), ui-monospace, 'Cascadia Code', monospace";

export default function AvisoDesvioTopo(props: {
  itens: ItemAvisoDesvio[];
  lote: { ids: string[]; seq: number };
  left: string; width: string;
  compacto?: boolean;
  tema: "dark" | "light";
  cores: CoresAviso;
  nomeTipo: (tipo: string) => string;
  tempoAtras: (desde: string) => string;
  onVerNoMapa: (item: ItemAvisoDesvio) => void;
}) {
  const { itens, lote, cores, tema } = props;
  const n = itens.length;
  const [modo, setModo] = useState<ModoAviso>("pilula");
  const [texto, setTexto] = useState("");
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const raiz = useRef<HTMLDivElement | null>(null);
  const seqVisto = useRef(lote.seq);

  // Lote novo do poll -> aviso (e reinicia os 8 s).
  useEffect(() => {
    if (lote.seq === seqVisto.current) return;
    seqVisto.current = lote.seq;
    const novos = novosDoLoteNoEscopo(lote.ids, itens);
    if (novos.length === 0) return;
    setTexto(textoAviso(novos, props.nomeTipo));
    setModo(m => proximoModo(m, { tipo: "novos", quantidade: novos.length }, n));
    if (timer.current) clearTimeout(timer.current);
    timer.current = setTimeout(() => setModo(m => proximoModo(m, { tipo: "timeout" }, n)), AVISO_DESVIO_MS);
  }, [lote.seq]); // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => () => { if (timer.current) clearTimeout(timer.current); }, []);

  // n caiu pra 0 (resolveram o último): fecha tudo.
  useEffect(() => { if (n === 0) setModo("pilula"); }, [n]);

  // Esc e clique fora fecham a lista.
  useEffect(() => {
    if (modo !== "lista") return;
    const onKey = (e: KeyboardEvent) => { if (e.key === "Escape") setModo(m => proximoModo(m, { tipo: "fechar" }, n)); };
    const onDown = (e: MouseEvent) => {
      if (raiz.current && !raiz.current.contains(e.target as Node)) setModo(m => proximoModo(m, { tipo: "fechar" }, n));
    };
    window.addEventListener("keydown", onKey);
    window.addEventListener("mousedown", onDown);
    return () => { window.removeEventListener("keydown", onKey); window.removeEventListener("mousedown", onDown); };
  }, [modo, n]);

  const rotulo = rotuloPilula(n);
  if (!rotulo) return null;

  const clicar = () => setModo(m => proximoModo(m, { tipo: "clique" }, n));
  const fundo = tema === "dark" ? "rgba(10,10,10,0.9)" : "rgba(255,255,255,0.94)";

  return (
    <div style={{ position: "absolute", top: 56, left: props.left, width: props.width, display: "flex", justifyContent: "center", zIndex: 800, pointerEvents: "none" }}>
      <div ref={raiz} style={{ pointerEvents: "auto", display: "flex", flexDirection: "column", alignItems: "center", gap: 6 }}>
        {modo === "aviso" ? (
          <button type="button" onClick={clicar} style={{
            display: "flex", alignItems: "center", gap: 10, cursor: "pointer",
            padding: props.compacto ? "7px 12px" : "9px 16px", borderRadius: 999,
            background: tema === "dark" ? "#1a0b0c" : "#fff1f1", border: `1px solid ${cores.red}`,
            boxShadow: `0 0 0 4px ${cores.red}2e, 0 8px 22px rgba(0,0,0,0.35)`,
            color: cores.text, fontWeight: 800, fontSize: props.compacto ? 12 : 13,
          }}>
            <span className="animate-pulse-live" style={{ width: 9, height: 9, borderRadius: "50%", background: cores.red }} />
            {texto}
          </button>
        ) : (
          <button type="button" onClick={clicar} aria-expanded={modo === "lista"} style={{
            display: "flex", alignItems: "center", gap: 6, cursor: "pointer",
            padding: props.compacto ? "5px 11px" : "6px 13px", borderRadius: 999,
            background: fundo, border: `1px solid ${cores.red}66`, backdropFilter: "blur(6px)",
            color: cores.red, fontWeight: 800, fontSize: props.compacto ? 11 : 12,
            boxShadow: "0 4px 14px rgba(0,0,0,0.25)",
          }}>
            {rotulo}<span aria-hidden style={{ fontSize: 10 }}>{modo === "lista" ? "▴" : "▾"}</span>
          </button>
        )}

        {modo === "lista" && (
          <div role="dialog" aria-label="Desvios abertos" style={{
            width: props.compacto ? 260 : 320, maxHeight: 320, overflowY: "auto",
            background: cores.card, border: `1px solid ${cores.border}`, borderRadius: 10, padding: 6,
            boxShadow: "0 14px 30px rgba(0,0,0,0.45)",
          }}>
            {itens.map(a => {
              const cor = a.nivel === "critico" ? cores.red : cores.yellow;
              return (
                <button key={a.id} type="button"
                  onClick={() => { props.onVerNoMapa(a); setModo(m => proximoModo(m, { tipo: "fechar" }, n)); }}
                  style={{
                    width: "100%", display: "flex", alignItems: "center", gap: 8, cursor: "pointer",
                    padding: "7px 8px", borderRadius: 7, background: "transparent", border: "none",
                    borderLeft: `3px solid ${cor}`, marginBottom: 2, color: cores.text, textAlign: "left",
                  }}>
                  <span style={{ fontFamily: FONT_MONO, fontWeight: 900, fontSize: 12 }}>{a.placa}</span>
                  <span style={{ fontSize: 10.5, color: cor, fontWeight: 700 }}>{props.nomeTipo(a.tipo)}</span>
                  <span suppressHydrationWarning style={{ fontSize: 10.5, color: cores.dim, fontFamily: FONT_MONO }}>{props.tempoAtras(a.desde)}</span>
                  <span style={{ marginLeft: "auto", fontSize: 10.5, color: cores.muted }}>ver no mapa →</span>
                </button>
              );
            })}
          </div>
        )}
      </div>
    </div>
  );
}
```

- [ ] **Step 2: Typecheck**

Run: `npx tsc --noEmit 2>&1 | grep "error TS" | grep -v "kpi/base-horarios"`
Expected: nenhuma linha (os erros pré-existentes só em `src/app/api/kpi/base-horarios/route.test.ts` são filtrados).

- [ ] **Step 3: Commit**

```bash
git add "src/app/(app)/central-v2/AvisoDesvioTopo.tsx"
git commit -m "feat(central-v2): componente AvisoDesvioTopo (pilula, aviso 8s, lista)"
```

---

### Task 3: Ligar no `MonitorV2`, tirar a faixa, subir e conferir visualmente

**Files:**
- Modify: `src/app/(app)/central-v2/MonitorV2.tsx` — estados (~linha 612-618), poll (~992-1020), `desviosAtivos*` (~1426-1452), `renderFaixaDesvio` (~1733-1834, removido), chamadas (~2828-2858).

**Interfaces:**
- Consumes (Task 2): `AvisoDesvioTopo`, `ItemAvisoDesvio`.

- [ ] **Step 1: Estado do último lote de novos**

Depois de `const [novosIdsArr, setNovosIdsArr] = useState<string[]>([]);` adicionar:

```ts
  // Último lote de alertas notificáveis NOVOS vindos do poll (ids que não
  // existiam no poll anterior). seq muda a cada lote não vazio, pra o
  // AvisoDesvioTopo reagir mesmo se os ids se repetirem entre painéis.
  const [ultimoLoteNovos, setUltimoLoteNovos] = useState<{ ids: string[]; seq: number }>({ ids: [], seq: 0 });
```

E remover as 3 linhas de estado `mostrarTodosDesvios`, `mostrarTodosDesviosSplitTodos`, `mostrarTodosDesviosSplitSelecionados` (e o comentário acima delas).

- [ ] **Step 2: Alimentar o lote no poll**

Dentro do `if (novosParaNotificar.length > 0) {` do poll de alertas, logo após `setNovosIdsArr(...)`:

```ts
          setUltimoLoteNovos(prev => ({
            ids: novosParaNotificar.filter(a => a.tipo !== "panico").map(a => a.id),
            seq: prev.seq + 1,
          }));
```

- [ ] **Step 3: Listas usam os tipos notificáveis**

Em `desviosAtivos` e `desviosAtivosSplitTodos`, trocar

```ts
    .filter(a => a.tipo === "desvio" || a.tipo === "parada_fora_tapete")
```

por

```ts
    .filter(a => tiposNotificamCliente.includes(a.tipo) && a.tipo !== "panico")
```

- [ ] **Step 4: Remover `renderFaixaDesvio` e `MAX_CHIPS_DESVIO`**

Apagar a função `renderFaixaDesvio` inteira (de `const renderFaixaDesvio = (` até o `};` que a fecha, logo antes do comentário "Barra inferior de detalhe do veiculo selecionado") e a constante `MAX_CHIPS_DESVIO` com seu comentário. Confirmar que não sobrou referência:

Run: `grep -n "renderFaixaDesvio\|MAX_CHIPS_DESVIO\|mostrarTodosDesvios" "src/app/(app)/central-v2/MonitorV2.tsx"`
Expected: nenhuma linha.

- [ ] **Step 5: Trocar as chamadas pelo componente**

Adicionar o import no topo (junto dos outros de `./`):

```ts
import AvisoDesvioTopo, { type ItemAvisoDesvio } from "./AvisoDesvioTopo";
```

Substituir o bloco `{!splitView ? renderFaixaDesvio(...) : (<>...</>)}` por:

```tsx
          {(() => {
            // Mesmo gate da faixa antiga: cliente sem "desvio" nos tipos que
            // notificam (ex.: Benassi) não ganha pílula.
            if (!tiposNotificamCliente.includes("desvio")) return null;
            const cores = { red: T.red, yellow: T.yellow, text: T.text, muted: T.muted, dim: T.dim, border: T.border, card: T.card };
            const focarCom = (painel: ReturnType<typeof usePainelFoco>) => (a: ItemAvisoDesvio) => {
              painel.setAlertaAtivoId(a.id);
              painel.selecionarVeiculo(a.cv, a.lat && a.lng ? { lat: a.lat, lng: a.lng } : undefined);
            };
            const comum = { lote: ultimoLoteNovos, tema, cores, nomeTipo: nomeT, tempoAtras };
            return !splitView ? (
              <AvisoDesvioTopo {...comum} itens={desviosAtivos} left="0%" width="100%" onVerNoMapa={focarCom(painel1)} />
            ) : (
              <>
                <AvisoDesvioTopo {...comum} itens={desviosAtivosSplitTodos} compacto
                  left="0%" width={`${splitRatio * 100}%`} onVerNoMapa={focarCom(painel1)} />
                <AvisoDesvioTopo {...comum} itens={desviosAtivosSplitSelecionados}
                  left={`${splitRatio * 100}%`} width={`${(1 - splitRatio) * 100}%`} onVerNoMapa={focarCom(painel2)} />
              </>
            );
          })()}
```

Atualizar o comentário JSX logo acima do bloco (o que fala da "faixa" e dos chips) para uma linha: `{/* Topo do mapa: aviso de desvio (spec 2026-09-26-topo-mapa-aviso-desvio). */}`.

- [ ] **Step 6: Typecheck e testes**

Run: `npx tsc --noEmit 2>&1 | grep "error TS" | grep -v "kpi/base-horarios"`
Expected: nenhuma linha.

Run: `npx vitest run --exclude ".claude/**"`
Expected: todos passando.

- [ ] **Step 7: Commit, push e deploy**

```bash
git add "src/app/(app)/central-v2/MonitorV2.tsx"
git commit -m "feat(central-v2): topo do mapa usa AvisoDesvioTopo no lugar da faixa de chips"
git push origin main
ssh transmonseg-vps "cd /srv/transmonseg/definitivo && git fetch -q && git reset -q --hard origin/main && npm run build > /tmp/build-aviso-desvio.log 2>&1 && pm2 restart transmonseg-definitivo"
```

Conferir: `ssh transmonseg-vps "pm2 describe transmonseg-definitivo | grep -E 'status|unstable'"` → `online`, `unstable restarts 0`; `curl -s -o /dev/null -w "%{http_code}" https://monitoramento.transmonseg.com.br/` → `307`.

- [ ] **Step 8: Verificação visual (obrigatória)**

Com a conta QA (`qa-claude@transmonseg.com.br`, senha no cofre `chaves-apis-joaquim/monitoramento/chaves.md`), em 1600×900, tema escuro:
1. Central `/?cliente=4096`: print com a pílula "Ver mais desvios (n)" e sem chips no topo.
2. Clicar na pílula: print da lista aberta; clicar num "ver no mapa": mapa foca o caminhão e a lista fecha.
3. Esc e clique fora fecham a lista.
4. AMBOS: duas pílulas, uma por painel.
5. Trocar TODOS → SELECIONADOS → TODOS e confirmar que **nenhum** aviso vermelho aparece.
6. Deixar a página aberta até chegar um desvio novo real: print do aviso vermelho e, 8 s depois, da pílula.

Salvar os prints em `~/ClaudeGerado/monitoramento/` e mandar ao usuário.
