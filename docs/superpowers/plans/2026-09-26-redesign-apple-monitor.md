# Redesign estilo Apple do monitor — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Deixar a tela do monitor (Central Romaneio / Central) com cara de app da Apple — paleta única, 5 tamanhos de fonte (mín. 12px), 3 raios, painéis translúcidos, toolbar enxuta, cards calmos e cartão flutuante do veículo com confirmação de Sirene/Bloqueio — sem mudar detecção nem fluxo do operador.

**Architecture:** Um módulo puro `design.ts` vira a fonte única de tokens; `T` (MonitorV2), `tokens.ts` (Leaflet) e `globals.css` derivam/sincronizam com ele, garantido por teste. Um teste de varredura de código-fonte trava tamanho mínimo de fonte e raios permitidos nos arquivos do monitor. As mudanças de layout ficam em `MonitorV2.tsx` (estilo inline, padrão do repo), `layout.tsx` do header e dois componentes novos pequenos (`PopoverMapa.tsx`, `confirmacao-acao.ts`).

**Tech Stack:** Next.js 16 (App Router — ler `AGENTS.md`: "This is NOT the Next.js you know"), React client components com `style={{}}` inline, framer-motion, Tailwind v4 só em `layout.tsx`/páginas, vitest (ambiente node, sem RTL/jsdom).

**Spec:** `docs/superpowers/specs/2026-09-26-redesign-apple-monitor-design.md`

## Global Constraints

- Paleta escuro: bg `#000000`, surface `#1c1c1e`, surface2 `#2c2c2e`, separator `#38383a`, text `#f5f5f7`, secondary `#98989d`, tertiary `#636366`, accent `#0a84ff`, red `#ff453a`, orange `#ff9f0a`, green `#30d158`.
- Paleta claro: bg `#f2f2f7`, surface `#ffffff`, surface2 `#f2f2f7`, separator `#d1d1d6`, text `#1d1d1f`, secondary `#6e6e73`, tertiary `#aeaeb2`, accent `#0066cc`, red `#d70015`, orange `#c93400`, green `#248a3d`.
- `parado` do mapa continua `#2563eb` nos dois temas.
- Tipografia: title 20/700, headline 15/600, body 13/400, footnote 12/500, caption 12/600 uppercase letterSpacing ".04em". **Nenhum fontSize < 12** nos arquivos do monitor.
- Raios permitidos: 8 (control), 14 (panel), 999 (capsule), além de "50%" (círculos) e 0 (explicitamente reto, ex.: divisores). Nada mais.
- Material translúcido: `backdrop-filter: blur(20px) saturate(180%)` + fundo com alfa + borda hairline + sombra suave.
- Segmented control: thumb neutro (escuro `#636366`, claro `#ffffff` + sombra), texto primário — não azul.
- Mola framer-motion: `{ type: "spring", stiffness: 380, damping: 32 }`.
- Não mudar: motor/detecção, APIs, `handleResolver`, `MenuMotivoFalso`, fluxo de confirmação de Resolver todos/Limpar avisos, lógica de `filtroComm`, `usePainelFoco`, split (AMBOS), `AvisoDesvioTopo` (só estilo), textos operacionais dos alertas.
- Comentários de código em português sem acento, no estilo do arquivo (explicam o PORQUÊ com data 26/09).
- Rodar testes: `npx vitest run <arquivo>`; tipos: `npx tsc --noEmit -p tsconfig.json`. `next build` NÃO roda dentro de worktree (node_modules é symlink) — o build é validado no VPS no deploy.

## Review Focus

1. Tema claro: cada cor nova precisa funcionar nos DOIS temas — texto secundário legível no claro, thumb do segmented visível no claro (branco sobre `#f2f2f7` precisa sombra). Teste de contraste em Task 1 cobre texto; thumb conferido no print.
2. Split AMBOS: dois cartões flutuantes do veículo e dois popovers não podem se sobrepor nem sumir; cartão usa a largura do painel, não da janela. Conferido no print de verificação (Task 6).
3. Card ativo x hover: Correto/Falso tem que continuar alcançável sem mouse-hover (card ativo mostra sempre) — senão operador não consegue classificar. Teste puro `acoesVisiveis` em Task 5.
4. Confirmação da Sirene/Bloqueio: segundo clique fora da janela de 5 s não pode disparar; trocar de veículo cancela a confirmação pendente. Testes em Task 6.
5. Filtro COMM movido: estado `filtroComm` precisa continuar filtrando o mapa igual; nada de duplicar o estado. Revisor confere no diff (Task 4).

---

### Task 1: Tokens únicos (`design.ts`) + sincronizar `globals.css`, `tokens.ts` e `T`

**Files:**
- Create: `src/app/(app)/central-v2/design.ts`
- Create: `src/app/(app)/central-v2/design.test.ts`
- Modify: `src/app/globals.css:6-49` (valores dos tokens dark e light)
- Modify: `src/app/(app)/central-v2/tokens.ts` (DARK_TOKENS/LIGHT_TOKENS derivam de `design.ts`)
- Modify: `src/app/(app)/central-v2/MonitorV2.tsx:899-955` (objeto `T` deriva de `design.ts`, mesmas chaves)

**Interfaces:**
- Produces: `PALETA: Record<"dark"|"light", Paleta>`, `TIPO`, `RAIO`, `MOLA`, `material(tema)`, `contraste(a,b)`, `temaT(tema)` (retorna objeto com as MESMAS chaves do `T` atual: bg, card, cardHover, border, borderSubtle, text, muted, dim, accent, accentFg, accentDim, red, yellow, green, drawerBg, sidebarBg, toolbarBg, + novas: surface2, thumb, thumbShadow).

- [ ] **Step 1: Escrever `design.test.ts` (falha)**

```ts
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { PALETA, TIPO, RAIO, contraste, temaT } from "./design";
import { DARK_TOKENS, LIGHT_TOKENS } from "./tokens";

describe("design tokens", () => {
  it("tipografia nunca abaixo de 12px", () => {
    for (const t of Object.values(TIPO)) expect(t.fontSize).toBeGreaterThanOrEqual(12);
  });
  it("raios so 8/14/999", () => {
    expect(Object.values(RAIO).sort((a, b) => a - b)).toEqual([8, 14, 999]);
  });
  for (const tema of ["dark", "light"] as const) {
    const p = PALETA[tema];
    it(`${tema}: texto >= 4.5 sobre bg e surface`, () => {
      expect(contraste(p.text, p.bg)).toBeGreaterThanOrEqual(4.5);
      expect(contraste(p.text, p.surface)).toBeGreaterThanOrEqual(4.5);
    });
    it(`${tema}: secundario >= 4.5 sobre surface`, () => {
      expect(contraste(p.secondary, p.surface)).toBeGreaterThanOrEqual(4.5);
    });
    it(`${tema}: cores de status >= 3 sobre surface`, () => {
      for (const c of [p.red, p.orange, p.green, p.accent]) expect(contraste(c, p.surface)).toBeGreaterThanOrEqual(3);
    });
    it(`${tema}: temaT mantem as chaves antigas do T`, () => {
      const T = temaT(tema);
      for (const k of ["bg","card","cardHover","border","borderSubtle","text","muted","dim","accent","accentFg","accentDim","red","yellow","green","drawerBg","sidebarBg","toolbarBg"])
        expect(T).toHaveProperty(k);
      expect(T.yellow).toBe(p.orange);
      expect(contraste(T.accentFg, T.accent)).toBeGreaterThanOrEqual(3.5);
    });
  }
  it("tokens.ts (Leaflet) deriva da paleta", () => {
    expect(DARK_TOKENS.red).toBe(PALETA.dark.red);
    expect(LIGHT_TOKENS.text).toBe(PALETA.light.text);
    expect(DARK_TOKENS.parado).toBe("#2563eb");
    expect(LIGHT_TOKENS.parado).toBe("#2563eb");
  });
  it("globals.css sincronizado com a paleta", () => {
    const css = readFileSync(join(process.cwd(), "src/app/globals.css"), "utf8");
    const bloco = (sel: string) => css.slice(css.indexOf(sel), css.indexOf("}", css.indexOf(sel)));
    const dark = bloco(":root {"), light = bloco('[data-theme="light"] {');
    const par: [string, keyof typeof PALETA.dark][] = [["--bg", "bg"], ["--card", "surface"], ["--border", "separator"], ["--text", "text"], ["--text-muted", "secondary"], ["--text-dim", "tertiary"], ["--accent", "accent"], ["--vermelho", "red"], ["--amarelo", "orange"], ["--verde", "green"]];
    for (const [v, k] of par) {
      expect(dark).toMatch(new RegExp(`${v}:\\s*${PALETA.dark[k]};`, "i"));
      expect(light).toMatch(new RegExp(`${v}:\\s*${PALETA.light[k]};`, "i"));
    }
  });
});
```

- [ ] **Step 2: Rodar e ver falhar**

Run: `npx vitest run "src/app/(app)/central-v2/design.test.ts"` → FAIL (módulo `./design` não existe).

- [ ] **Step 3: Criar `design.ts`**

```ts
// Fonte UNICA de tokens visuais do monitor (26/09, redesign estilo Apple).
// Antes a paleta vivia em 3 copias divergentes (globals.css, tokens.ts e o
// objeto T do MonitorV2, com o bg claro diferente entre elas). Agora T e
// tokens.ts derivam daqui e design.test.ts trava globals.css em sincronia.

export type Tema = "dark" | "light";
export interface Paleta {
  bg: string; surface: string; surface2: string; separator: string;
  text: string; secondary: string; tertiary: string;
  accent: string; red: string; orange: string; green: string;
}

export const PALETA: Record<Tema, Paleta> = {
  dark: {
    bg: "#000000", surface: "#1c1c1e", surface2: "#2c2c2e", separator: "#38383a",
    text: "#f5f5f7", secondary: "#98989d", tertiary: "#636366",
    accent: "#0a84ff", red: "#ff453a", orange: "#ff9f0a", green: "#30d158",
  },
  light: {
    bg: "#f2f2f7", surface: "#ffffff", surface2: "#f2f2f7", separator: "#d1d1d6",
    text: "#1d1d1f", secondary: "#6e6e73", tertiary: "#aeaeb2",
    // #007aff da so 4,0:1 no branco; #0066cc e' o azul acessivel da Apple.
    accent: "#0066cc", red: "#d70015", orange: "#c93400", green: "#248a3d",
  },
};

export const PARADO = "#2563eb";

export const TIPO = {
  title:    { fontSize: 20, fontWeight: 700, letterSpacing: "-0.01em" },
  headline: { fontSize: 15, fontWeight: 600, letterSpacing: "-0.005em" },
  body:     { fontSize: 13, fontWeight: 400 },
  footnote: { fontSize: 12, fontWeight: 500 },
  caption:  { fontSize: 12, fontWeight: 600, letterSpacing: ".04em", textTransform: "uppercase" as const },
} as const;

export const RAIO = { control: 8, panel: 14, capsule: 999 } as const;

export const MOLA = { type: "spring", stiffness: 380, damping: 32 } as const;

export const FONT_SANS = "var(--font-geist), system-ui, sans-serif";
export const FONT_MONO = "var(--font-geist-mono), ui-monospace, monospace";
export const NUM: React.CSSProperties = { fontFamily: FONT_MONO, fontVariantNumeric: "tabular-nums" };

// Material translucido pra tudo que flutua sobre o mapa (Apple Maps).
export function material(tema: Tema): React.CSSProperties {
  return tema === "dark"
    ? { background: "rgba(28,28,30,0.72)", backdropFilter: "blur(20px) saturate(180%)", WebkitBackdropFilter: "blur(20px) saturate(180%)", border: "0.5px solid rgba(255,255,255,0.10)", boxShadow: "0 8px 32px rgba(0,0,0,0.45)" }
    : { background: "rgba(255,255,255,0.78)", backdropFilter: "blur(20px) saturate(180%)", WebkitBackdropFilter: "blur(20px) saturate(180%)", border: "0.5px solid rgba(0,0,0,0.10)", boxShadow: "0 8px 32px rgba(0,0,0,0.12)" };
}

function lum(hex: string): number {
  const n = hex.replace("#", "");
  const [r, g, b] = [0, 2, 4].map(i => parseInt(n.slice(i, i + 2), 16) / 255)
    .map(c => (c <= 0.03928 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4)));
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}
export function contraste(a: string, b: string): number {
  const [x, y] = [lum(a), lum(b)].sort((p, q) => q - p);
  return (x + 0.05) / (y + 0.05);
}

// Objeto T do MonitorV2: mesmas chaves de antes pra nao quebrar os ~2000
// usos no arquivo; "yellow" (atencao) agora e' o laranja do sistema.
export function temaT(tema: Tema) {
  const p = PALETA[tema];
  const dark = tema === "dark";
  return {
    bg: p.bg, card: p.surface, cardHover: p.surface2, surface2: p.surface2,
    border: p.separator, borderSubtle: dark ? "#2c2c2e" : "#e5e5ea",
    text: p.text, muted: p.secondary, dim: p.tertiary,
    accent: p.accent, accentFg: "#ffffff", accentDim: dark ? "rgba(10,132,255,0.18)" : "rgba(0,102,204,0.10)",
    red: p.red, yellow: p.orange, green: p.green,
    drawerBg: dark ? "rgba(28,28,30,0.72)" : "rgba(255,255,255,0.78)",
    sidebarBg: dark ? "#0b0b0c" : "#f7f7fa",
    toolbarBg: dark ? "rgba(0,0,0,0.72)" : "rgba(242,242,247,0.80)",
    thumb: dark ? "#636366" : "#ffffff",
    thumbShadow: dark ? "0 1px 3px rgba(0,0,0,0.4)" : "0 1px 3px rgba(0,0,0,0.12), 0 0 0 0.5px rgba(0,0,0,0.04)",
  };
}
export type TemaT = ReturnType<typeof temaT>;
```

Adicionar `import type React from "react";` no topo se o tsc reclamar do namespace `React`.

- [ ] **Step 4: Derivar `tokens.ts`**

Substituir os literais de `DARK_TOKENS`/`LIGHT_TOKENS` por valores de `PALETA` (import de `./design`), mantendo a interface `MapTokens` e as tile URLs:

```ts
import { PALETA, PARADO } from "./design";
const d = PALETA.dark, l = PALETA.light;
export const DARK_TOKENS: MapTokens = {
  bg: d.bg, card: d.surface, border: d.separator, text: d.text, muted: d.secondary,
  accent: d.accent, red: d.red, yellow: d.orange, green: d.green, parado: PARADO, dim: d.tertiary,
  tileUrl: "https://{s}.basemaps.cartocdn.com/dark_all/{z}/{x}/{y}{r}.png", tileSubdomains: "abcd",
};
export const LIGHT_TOKENS: MapTokens = {
  bg: l.bg, card: l.surface, border: l.separator, text: l.text, muted: l.secondary,
  accent: l.accent, red: l.red, yellow: l.orange, green: l.green, parado: PARADO, dim: l.tertiary,
  tileUrl: "https://{s}.basemaps.cartocdn.com/light_all/{z}/{x}/{y}{r}.png", tileSubdomains: "abcd",
};
```
Atualizar o comentário do topo ("Devem refletir exatamente os valores de globals.css") para "Derivam de design.ts (fonte unica)".

- [ ] **Step 5: `T` do MonitorV2 deriva de `design.ts`**

Em `MonitorV2.tsx`, trocar o `useMemo` de `T` (linhas ~899-955, incluindo o comentário longo sobre accentFg de 03/09 — resumir para 2 linhas mantendo o motivo) por:

```ts
  // ── Theme tokens ── (26/09: fonte unica em design.ts; ver comentario la)
  const T = useMemo(() => temaT(tema), [tema]);
```
com `import { temaT } from "./design";`. Nota: `accentFg` passa a ser branco nos dois temas — o bug de 03/09 (texto branco sobre accent pastel) deixa de existir porque o accent escuro agora é `#0a84ff` (saturado) e o segmented control passa a usar thumb neutro (Task 2).

- [ ] **Step 6: `globals.css`**

Trocar os valores dos blocos `:root` (6-27) e `[data-theme="light"]` (32-49) pela paleta: `--bg`=bg, `--card`=surface, `--card-hover`=surface2, `--border`=separator, `--border-subtle` (dark `#2c2c2e`, light `#e5e5ea`), `--text`=text, `--text-muted`=secondary, `--text-dim`=tertiary, `--accent`=accent, `--accent-dim` (dark `rgba(10,132,255,0.18)`, light `rgba(0,102,204,0.10)`), `--vermelho`=red, `--amarelo`=orange, `--verde`=green. Formato exato `--nome: #valor;` (o teste usa regex `--bg:\s*#000000;`). Trocar o comentário "Acento unico neutro — navy" por "Acento unico — azul do sistema (design.ts)".

- [ ] **Step 7: Rodar testes e tipos**

Run: `npx vitest run "src/app/(app)/central-v2/"` → PASS. Run: `npx tsc --noEmit -p tsconfig.json` → sem erros novos (comparar com `git stash`-free baseline: rodar antes da mudança e salvar a contagem em `/tmp/tsc-base.txt` se já houver erros pré-existentes).

- [ ] **Step 8: Commit**

```bash
git add "src/app/(app)/central-v2/design.ts" "src/app/(app)/central-v2/design.test.ts" "src/app/(app)/central-v2/tokens.ts" "src/app/(app)/central-v2/MonitorV2.tsx" src/app/globals.css
git commit -m "feat(design): tokens unicos estilo Apple (paleta, tipo, raio, material)"
```

---

### Task 2: Varredura de tipografia e raios + trava por teste de código-fonte

**Files:**
- Create: `src/app/(app)/central-v2/design-guard.test.ts`
- Modify: `src/app/(app)/central-v2/MonitorV2.tsx` (todos os `fontSize` < 12 e `borderRadius` fora do conjunto; helpers `BASE_BTN`, `tinyBtn`, `outlineBtn`, `rotuloPainelStyle`; `FONT_SANS`/`FONT_MONO` locais passam a vir de `design.ts`)
- Modify: `src/app/(app)/central-v2/EscopoMapaSwitcher.tsx` (thumb neutro `T.thumb` + `T.thumbShadow`, texto do ativo `T.text`, container cápsula, raios)
- Modify: `src/app/(app)/central-v2/AvisoDesvioTopo.tsx` (fontes ≥12, raios, `material(tema)` no painel da lista e na pílula)
- Modify: `src/app/(app)/components/MenuMotivoFalso.tsx`, `src/app/(app)/components/AlertaSonoro.tsx` (fontes ≥12, raios)

**Interfaces:**
- Consumes: `TIPO`, `RAIO`, `material`, `FONT_SANS`, `FONT_MONO`, `NUM`, `TemaT` de `./design` (Task 1). `EscopoMapaSwitcher` recebe cores via props existentes — se não recebe `thumb`, adicionar props opcionais `thumb?: string; thumbShadow?: string` e passar `T.thumb`/`T.thumbShadow` do MonitorV2.
- Produces: helpers de botão em MonitorV2 com raio `RAIO.control` e fonte ≥12, usados pelas Tasks 4-6.

- [ ] **Step 1: Escrever o teste guarda (falha)**

```ts
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";

// Trava do redesign de 26/09: nenhum texto abaixo de 12px e so os raios do
// sistema nos arquivos do monitor. Varre o codigo-fonte porque o repo nao tem
// RTL/jsdom pra medir o DOM.
const ARQUIVOS = [
  "src/app/(app)/central-v2/MonitorV2.tsx",
  "src/app/(app)/central-v2/EscopoMapaSwitcher.tsx",
  "src/app/(app)/central-v2/AvisoDesvioTopo.tsx",
  "src/app/(app)/components/MenuMotivoFalso.tsx",
  "src/app/(app)/components/AlertaSonoro.tsx",
];
const RAIOS_OK = new Set(["0", "8", "14", "999", "\"50%\"", "'50%'", "RAIO.control", "RAIO.panel", "RAIO.capsule"]);

describe("guarda do design", () => {
  for (const f of ARQUIVOS) {
    const src = readFileSync(f, "utf8");
    it(`${f}: fontSize numerico >= 12`, () => {
      const ruins = [...src.matchAll(/fontSize:\s*(\d+(?:\.\d+)?)\b/g)].map(m => Number(m[1])).filter(n => n < 12);
      expect(ruins).toEqual([]);
    });
    it(`${f}: fontSize clamp/string sem minimo < 12px`, () => {
      const ruins = [...src.matchAll(/fontSize:\s*["'`]([^"'`]+)["'`]/g)].map(m => m[1])
        .filter(v => [...v.matchAll(/(\d+(?:\.\d+)?)px/g)].some(x => Number(x[1]) < 12));
      expect(ruins).toEqual([]);
    });
    it(`${f}: borderRadius so 0/8/14/999/50%`, () => {
      const ruins = [...src.matchAll(/borderRadius:\s*([^,}\n]+)/g)].map(m => m[1].trim())
        .filter(v => !RAIOS_OK.has(v) && !/^(?:RAIO\.|`|["']\d+px \d+px)/.test(v));
      expect(ruins).toEqual([]);
    });
  }
});
```
(Raios compostos tipo `"14px 14px 0 0"` só com 0/8/14 são aceitos pela exceção `["']\d+px \d+px`; o revisor confere que os números usados são do conjunto.)

- [ ] **Step 2: Rodar e ver falhar**

Run: `npx vitest run "src/app/(app)/central-v2/design-guard.test.ts"` → FAIL listando os fontSize 9/10/10.5/11 e raios 2/5/6/7.

- [ ] **Step 3: Varredura**

Regras de mapeamento (aplicar em todos os arquivos da lista):
- `fontSize` 9, 10, 10.5, 11 → `12` (usar `...TIPO.caption` quando o texto é rótulo em CAIXA ALTA com letterSpacing; `...TIPO.footnote` quando é texto corrido). Em `clamp(...)`, o mínimo sobe para 12px.
- `fontSize` 12 e 13 ficam; 14 → 13 (body) salvo títulos; 16-18 → 15 (headline); ≥20 → 20 (title). Exceção: placa no drawer pode ficar `clamp(15px, ..., 20px)`.
- `letterSpacing` ≥ ".08em" em rótulos → ".04em".
- `borderRadius` 2/5/6/7 → `RAIO.control`; 10/12/16 em painéis/cards → `RAIO.panel`; pílulas → `RAIO.capsule`.
- `FONT_SANS`/`FONT_MONO` locais do MonitorV2 (linhas ~194-195) viram re-export de `design.ts` (apagar a definição local, importar).
- `tinyBtn`: altura 22 → 28, fontSize 12, raio `RAIO.capsule`, padding "0 12px", sem borda colorida pesada: `border: 0.5px solid ${color}40`, fundo `${color}14`.
- `outlineBtn`: altura 28, raio `RAIO.capsule`, fontSize 12, fontWeight 600, letterSpacing ".02em".
- `EscopoMapaSwitcher`: container cápsula (raio 999) com fundo `material(tema)`; thumb com `background: thumb`, `boxShadow: thumbShadow`, raio 999; texto ativo = cor de texto primária (não `accentFg`), inativo = secundária; manter o `pointerEvents: "none"` e a correção de stacking de 26/09 (58b8452) — não recolocar `zIndex` nos botões.
- `AvisoDesvioTopo`: pílula e aviso cápsula; painel da lista com `material(tema)` e raio 14; linhas com fontSize ≥12.

- [ ] **Step 4: Rodar testes e tipos**

Run: `npx vitest run "src/app/(app)/"` → PASS (inclui `aviso-desvio.test.ts`, `MonitorV2.test.ts`). Run: `npx tsc --noEmit -p tsconfig.json` → sem erros novos.

- [ ] **Step 5: Commit**

```bash
git add -A "src/app/(app)/central-v2" "src/app/(app)/components/MenuMotivoFalso.tsx" "src/app/(app)/components/AlertaSonoro.tsx"
git commit -m "feat(design): tipografia minima 12px, raios do sistema e segmented neutro"
```

---

### Task 3: Header global enxuto

**Files:**
- Modify: `src/app/(app)/layout.tsx:27-119`
- Modify: `src/app/(app)/components/NavPrincipal.tsx` (abas como segmented control cápsula), `src/app/(app)/components/RelogioAoVivo.tsx` (peso normal), `src/app/(app)/components/RomaneioStatusBadge.tsx` (cápsula discreta)

**Interfaces:**
- Consumes: classes Tailwind mapeadas para os tokens (`bg-bg`, `text-text`, `text-muted`, `border-border`, `bg-card`) — já atualizadas pela Task 1 via `globals.css`.
- Produces: header com altura 52px (`h-[52px]`). Nada consome.

- [ ] **Step 1: Editar `layout.tsx`**
  - Remover: badge "CENTRAL" (linhas ~45-50), tagline (linha ~53), texto "sistema operacional" (manter só ponto verde + "Ao vivo" em `text-[12px] font-medium text-verde`), os dois separadores verticais (linhas ~67 e ~81) e a linha de gradiente decorativa (~115-118).
  - Header: `h-[52px] px-4`, fundo `bg-bg/80 backdrop-blur-xl`, borda inferior `border-b border-border` (hairline).
  - Logo: ícone 28px com `rounded-[8px]`, "Transmonseg" em `text-[15px] font-semibold tracking-tight`.
  - Avatar 28px redondo; "Sair" como botão cápsula `rounded-full px-3 h-8 text-[13px]`.
  - Manter `z-[60]` e o comentário das linhas 20-26.
- [ ] **Step 2: `NavPrincipal.tsx`** — abas dentro de um container cápsula (`rounded-full bg-card p-[3px]`), aba ativa com thumb neutro (`bg-[#636366]` no escuro via `[data-theme=light]_&:bg-white` ou `style` lendo `var(--card-hover)`; escolher a forma já usada no arquivo), texto 13px, altura 30px. Engrenagem 30px `rounded-full`. Menu dropdown: `rounded-[14px]`, `backdrop-blur-xl`, fontes ≥12. Não reintroduzir `animate-fade-in` (comentário 109-113).
- [ ] **Step 3: `RelogioAoVivo.tsx`** — hora em 15px peso 500 com `tabular-nums` (Geist Mono ok), data 12px secundária; sem negrito 700+.
- [ ] **Step 4: `RomaneioStatusBadge.tsx`** — cápsula `rounded-full h-7 px-3 text-[12px]`, fundo `bg-card`, ponto de status 6px.
- [ ] **Step 5: Verificar** — `npx tsc --noEmit -p tsconfig.json` sem erros novos; `grep -n "text-\[9px\]\|text-\[10px\]\|text-\[11px\]" "src/app/(app)/layout.tsx" "src/app/(app)/components/NavPrincipal.tsx" "src/app/(app)/components/RelogioAoVivo.tsx" "src/app/(app)/components/RomaneioStatusBadge.tsx"` → vazio.
- [ ] **Step 6: Commit**

```bash
git add "src/app/(app)/layout.tsx" "src/app/(app)/components/NavPrincipal.tsx" "src/app/(app)/components/RelogioAoVivo.tsx" "src/app/(app)/components/RomaneioStatusBadge.tsx"
git commit -m "feat(header): header enxuto estilo Apple (sem tagline/badge, 52px)"
```

---

### Task 4: Toolbar enxuta — popover "Mapa" e COMM nos Filtros

**Files:**
- Create: `src/app/(app)/central-v2/PopoverMapa.tsx`
- Modify: `src/app/(app)/central-v2/MonitorV2.tsx` toolbar (~2042-2296) e bloco FILTROS da lateral (~2382-2481)

**Interfaces:**
- Consumes: `material`, `RAIO`, `TIPO`, `MOLA`, `TemaT` de `./design`.
- Produces:
```ts
export interface PopoverMapaProps {
  tema: "dark" | "light";
  T: TemaT;
  zoomLabels: [string, number][];          // ZOOM_LABELS do MonitorV2
  onZoom: (z: number) => void;              // mesma acao dos botoes RUA/QUADRA/... de hoje
  onEnquadrarFrota: () => void;             // mesma acao do antigo botao VEICULOS (setGatilhoFrota)
  satelite: boolean; onSatelite: (v: boolean) => void;       // setSateliteComPersistencia
  trafego: boolean; onTrafego: (v: boolean) => void;         // setCamTrafegoComPersistencia
}
export default function PopoverMapa(props: PopoverMapaProps): JSX.Element
```

- [ ] **Step 1: Criar `PopoverMapa.tsx`** — botão gatilho cápsula "Mapa" + chevron (altura 30, fontSize 13, peso 500). Ao abrir: painel `position:absolute; top: 36; right: 0; width: 260`, `...material(tema)`, raio 14, padding 8, `zIndex` acima do mapa (usar o mesmo valor `Z.settings` = 900 passado por prop ou literal 900 com comentário). Conteúdo:
  - Rótulo `TIPO.caption` "Zoom" + segmented cápsula com RUA/QUADRA/BAIRRO/CIDADE (thumb neutro não se aplica — são comandos, então botões cápsula lado a lado).
  - Linha "Enquadrar frota" (botão linha inteira, ícone opcional).
  - Separador hairline.
  - Linhas-toggle "Satélite" e "Trânsito" com switch estilo iOS (trilho 36×22 raio 999, bolinha 18px; ligado = `T.green`).
  - Fecha com Esc (listener `keydown` só enquanto aberto) e clique fora (`mousedown` no document checando `ref.contains`). Animação `motion.div` com `initial={{opacity:0, scale:.96, y:-4}}` e `transition={MOLA}`.
- [ ] **Step 2: MonitorV2 toolbar** — remover da toolbar: botões RUA/QUADRA/BAIRRO/CIDADE (~2084-2089), VEÍCULOS (~2090-2093), COMM + 10/30/60min (~2146-2154), SAT (~2159-2162), TRÂNSITO (~2163-2166). Inserir `<PopoverMapa .../>` antes da engrenagem, ligado às MESMAS funções que os botões removidos chamavam. Toolbar: altura 48, fundo `T.toolbarBg` + `backdropFilter: "blur(20px) saturate(180%)"`, borda inferior hairline. Busca de placa: cápsula (raio 999), altura 32, largura `clamp(220px, 28vw, 380px)`, fontSize 13, ícone de lupa à esquerda, placeholder "Buscar placa", fonte sans (não mono) — combo de sugestões com `material(tema)` e raio 14. Pills de cliente: segmented cápsula com thumb neutro.
- [ ] **Step 3: COMM nos Filtros** — dentro do bloco FILTROS (~2382-2481), adicionar seção com rótulo `TIPO.caption` "Sem comunicação há" e três chips cápsula "10 min" / "30 min" / "60 min" que chamam exatamente o mesmo setter de `filtroComm` usado pelos botões removidos (mesma regra de toggle: clicar no ativo desliga). Quando `filtroComm` está ativo e FILTROS fechado, mostrar no cabeçalho de FILTROS um contador/indicador (ex.: "FILTROS · 1") para o operador saber que há filtro ligado.
- [ ] **Step 4: Verificar** — `npx vitest run "src/app/(app)/"` PASS (guarda inclui MonitorV2; adicionar `"src/app/(app)/central-v2/PopoverMapa.tsx"` ao array `ARQUIVOS` do `design-guard.test.ts`); `npx tsc --noEmit -p tsconfig.json` sem erros novos; `grep -c "filtroComm" "src/app/(app)/central-v2/MonitorV2.tsx"` — conferir que continua existindo um único `useState` de `filtroComm`.
- [ ] **Step 5: Commit**

```bash
git add "src/app/(app)/central-v2/PopoverMapa.tsx" "src/app/(app)/central-v2/MonitorV2.tsx" "src/app/(app)/central-v2/design-guard.test.ts"
git commit -m "feat(toolbar): popover Mapa (zoom/frota/satelite/transito) e COMM nos Filtros"
```

---

### Task 5: Lateral e cards de alerta

**Files:**
- Create: `src/app/(app)/central-v2/card-acoes.ts`, `src/app/(app)/central-v2/card-acoes.test.ts`
- Modify: `src/app/(app)/central-v2/MonitorV2.tsx` — contadores (~2316-2335), abas TUDO/DESVIOS (~2358-2378), Resolver/Limpar (~2514-2572, só estilo), `renderCardAlerta` (~1522-1728); a lateral espelhada do split (~2836+) usa as mesmas funções.

**Interfaces:**
- Produces:
```ts
// card-acoes.ts
export function acoesVisiveis(p: { ativo: boolean; hover: boolean; menuFalsoAberto: boolean }): boolean
// true se ativo || hover || menuFalsoAberto (menu aberto nao pode sumir ao tirar o mouse)
export function corStatus(nivel: string, T: { red: string; yellow: string; muted: string }): string
// "critico" -> T.red, "atencao" -> T.yellow, outro -> T.muted
```

- [ ] **Step 1: Teste (falha)**

```ts
import { describe, it, expect } from "vitest";
import { acoesVisiveis, corStatus } from "./card-acoes";

describe("acoes do card", () => {
  it("card ativo mostra acoes sem hover (operador sem mouse)", () => {
    expect(acoesVisiveis({ ativo: true, hover: false, menuFalsoAberto: false })).toBe(true);
  });
  it("hover mostra acoes", () => {
    expect(acoesVisiveis({ ativo: false, hover: true, menuFalsoAberto: false })).toBe(true);
  });
  it("menu Falso aberto segura as acoes visiveis", () => {
    expect(acoesVisiveis({ ativo: false, hover: false, menuFalsoAberto: true })).toBe(true);
  });
  it("card parado sem hover esconde", () => {
    expect(acoesVisiveis({ ativo: false, hover: false, menuFalsoAberto: false })).toBe(false);
  });
  it("cor por nivel", () => {
    const T = { red: "R", yellow: "Y", muted: "M" };
    expect(corStatus("critico", T)).toBe("R");
    expect(corStatus("atencao", T)).toBe("Y");
    expect(corStatus("info", T)).toBe("M");
  });
});
```
Run: `npx vitest run "src/app/(app)/central-v2/card-acoes.test.ts"` → FAIL.

- [ ] **Step 2: Implementar `card-acoes.ts`** (as duas funções acima, com comentário de 26/09 explicando que Correto/Falso só aparecem no ativo/hover e por que o menu aberto segura). Run → PASS.

- [ ] **Step 3: `renderCardAlerta`**
  - Wrapper: fundo `T.card` (ativo: `T.surface2` + `boxShadow: 0 0 0 1px ${T.accent}`), raio `RAIO.panel`, padding "12px 14px", margem vertical 6, sem borda vermelha em volta. Faixa de 3px à esquerda via `boxShadow: inset 3px 0 0 ${corStatus(a.nivel, T)}` (ou pseudo-borda equivalente) — mantém sinal de nível sem pintar o card inteiro.
  - Cursor pointer e `onClick` do card inteiro = mesma ação do botão Focar atual (`painel.setAlertaAtivoId` + `painel.selecionarVeiculo`, copiar do onClick de Focar ~1701-1705). Os botões internos (Correto, Falso, "ver motivo completo") chamam `e.stopPropagation()`.
  - Remover o botão "Focar".
  - Linha 1: bolinha 8px `corStatus` + placa (`NUM`, 15/700) + à direita idade (`NUM`, 12, cor `corIdadeAlerta`). Linha 2: tipo `nomeT(a.tipo)` como texto `TIPO.footnote` na cor de status (sem caixa/fundo) + badges existentes (GPS +Nmin, reabertura, POSSÍVEL DESVIO) como texto cápsula discreto 12px fundo `${cor}14`.
  - Motivo em `T.muted` 13px, 2 linhas (`WebkitLineClamp: 2`) em vez de 1 linha cortada; mantém "ver motivo completo" quando `a.motivo.length > 110`.
  - Local, progresso ao destino, placar sombra, confiabilidade: 12px `T.dim` (sem mudança de conteúdo).
  - Barra "N/M entr.": trilho 4px raio 999, fundo `T.border`, preenchimento `T.accent`; texto 12px.
  - Correto/Falso: renderizar só se `acoesVisiveis({ ativo, hover, menuFalsoAberto })`; `hover` vem de um estado local por card — como `renderCardAlerta` não é componente, guardar `const [hoverCardId, setHoverCardId] = useState<string|null>(null)` no MonitorV2 e usar `onMouseEnter/onMouseLeave` do wrapper. `menuFalsoAberto` = o estado que já controla o `MenuMotivoFalso` daquele alerta (localizar no código; se for por id, comparar com `a.id`). Botões cápsula 28px: "Correto" (verde) e "Falso" (laranja), usando `tinyBtn`.
  - Animação de entrada/saída do `AnimatePresence` com `transition={MOLA}`.
- [ ] **Step 4: Contadores e abas**
  - Contadores: dois "stats" lado a lado, padding 14, número `...TIPO.title` + `NUM` (vermelho só se `nCriticos>0`, senão `T.text`), rótulo `...TIPO.caption` `T.muted` ("Críticos", "Veículos"). Remover o fundo vermelho do bloco.
  - TUDO/DESVIOS: container cápsula `T.surface2` padding 2, thumb `T.thumb` + `T.thumbShadow` raio 999 (manter `layoutId="pillVista"` com `transition={MOLA}`), texto 13/600 `T.text` ativo, `T.muted` inativo, rótulos "Tudo" / "Desvios" em caixa normal (a constante `LABEL_ABA_DESVIOS` e testes que dependem dela ficam — só muda a exibição via `textTransform` se o teste exigir o texto "DESVIOS"; conferir `MonitorV2.test.ts`).
  - Resolver todos / Limpar avisos: botões cápsula secundários (fundo `T.surface2`, texto `T.text` 12/600, altura 30); fluxo de confirmação intocado.
  - Lateral: fundo `T.sidebarBg`, borda direita hairline.
- [ ] **Step 5: Verificar** — `npx vitest run "src/app/(app)/"` PASS; `npx tsc --noEmit -p tsconfig.json` sem erros novos; `grep -n "\"Focar\"\|>Focar<" "src/app/(app)/central-v2/MonitorV2.tsx"` → vazio.
- [ ] **Step 6: Commit**

```bash
git add "src/app/(app)/central-v2/card-acoes.ts" "src/app/(app)/central-v2/card-acoes.test.ts" "src/app/(app)/central-v2/MonitorV2.tsx"
git commit -m "feat(lateral): cards calmos (clique foca, acoes no ativo/hover), stats e segmented"
```

---

### Task 6: Sobre o mapa — cartão flutuante do veículo, confirmação de Sirene/Bloqueio, overlays translúcidos

**Files:**
- Create: `src/app/(app)/central-v2/confirmacao-acao.ts`, `src/app/(app)/central-v2/confirmacao-acao.test.ts`
- Modify: `src/app/(app)/central-v2/MonitorV2.tsx` — `renderDrawer` (~1736-1989), overlays (~2690-2836: badge de veículos, Legenda)

**Interfaces:**
- Produces:
```ts
// confirmacao-acao.ts
export type AcaoCritica = "sirene" | "bloqueio";
export type EstadoConfirmacao = { pendente: AcaoCritica; cv: number | string; ate: number } | null;
export const JANELA_CONFIRMACAO_MS = 5000;
export function pedirConfirmacao(acao: AcaoCritica, cv: number | string, agora: number): EstadoConfirmacao
// -> { pendente: acao, cv, ate: agora + JANELA_CONFIRMACAO_MS }
export function podeExecutar(estado: EstadoConfirmacao, acao: AcaoCritica, cv: number | string, agora: number): boolean
// true so se estado.pendente === acao && estado.cv === cv && agora <= estado.ate
export function aoTrocarVeiculo(estado: EstadoConfirmacao, cvNovo: number | string | null): EstadoConfirmacao
// null se cvNovo !== estado?.cv, senao estado
```

- [ ] **Step 1: Teste (falha)**

```ts
import { describe, it, expect } from "vitest";
import { pedirConfirmacao, podeExecutar, aoTrocarVeiculo, JANELA_CONFIRMACAO_MS } from "./confirmacao-acao";

describe("confirmacao de sirene/bloqueio", () => {
  it("primeiro clique so pede confirmacao", () => {
    expect(podeExecutar(null, "bloqueio", 7, 0)).toBe(false);
  });
  it("confirmar dentro da janela executa", () => {
    const e = pedirConfirmacao("bloqueio", 7, 1000);
    expect(podeExecutar(e, "bloqueio", 7, 1000 + JANELA_CONFIRMACAO_MS)).toBe(true);
  });
  it("confirmar depois da janela nao executa", () => {
    const e = pedirConfirmacao("sirene", 7, 1000);
    expect(podeExecutar(e, "sirene", 7, 1001 + JANELA_CONFIRMACAO_MS)).toBe(false);
  });
  it("confirmacao de uma acao nao vale pra outra", () => {
    const e = pedirConfirmacao("sirene", 7, 0);
    expect(podeExecutar(e, "bloqueio", 7, 10)).toBe(false);
  });
  it("confirmacao de um veiculo nao vale pra outro", () => {
    const e = pedirConfirmacao("bloqueio", 7, 0);
    expect(podeExecutar(e, "bloqueio", 8, 10)).toBe(false);
  });
  it("trocar de veiculo cancela", () => {
    const e = pedirConfirmacao("bloqueio", 7, 0);
    expect(aoTrocarVeiculo(e, 8)).toBeNull();
    expect(aoTrocarVeiculo(e, null)).toBeNull();
    expect(aoTrocarVeiculo(e, 7)).toEqual(e);
  });
});
```
Run → FAIL. Implementar `confirmacao-acao.ts` (comentário 26/09: antes Sirene/Bloqueio disparavam no primeiro clique). Run → PASS.

- [ ] **Step 2: Cartão flutuante (`renderDrawer`)**
  - Container: `position:absolute; left:12; bottom:12; width:"min(760px, calc(100% - 24px))"`, `...material(tema)`, raio `RAIO.panel`, `overflow:hidden`. O `left/width` é relativo ao painel do mapa (o drawer já é renderizado dentro do container de cada painel no split — confirmar e manter; se hoje é relativo à área toda, passar `left`/`width` do painel como já é feito para `AvisoDesvioTopo` em split). Animação: `initial/animate y` com `transition={MOLA}` (substitui a atual).
  - Header: placa `NUM` 20/700, badge IGN como cápsula 12px (verde se ON, `T.muted` se OFF), "carregando…" 12px `T.dim`, período 1h…48h como segmented cápsula pequeno (thumb neutro), fechar = botão circular 28px `T.surface2` com "×".
  - Métricas: grade `repeat(auto-fit, minmax(120px, 1fr))`, cada métrica rótulo `TIPO.caption` `T.muted` + valor 15/600 (`NUM` para números). LOCAL ocupa 2 colunas com ellipsis. Esconder a métrica "ROTA DO DIA" quando `total === 0` (hoje mostra "--").
  - Ações: linha com botões cápsula 30px fundo `T.surface2` (Rastro, Paradas, Seguir, Centralizar, Maps, Atualizar; estado ativo = fundo `T.accentDim` texto `T.accent`). À direita, separados por `marginLeft:auto`: Sirene e Bloquear/Desbloquear motor.
  - Confirmação: estado `const [confirmacao, setConfirmacao] = useState<EstadoConfirmacao>(null)` por painel (um por `painel`, ex.: `Record<"p1"|"p2", EstadoConfirmacao>` ou dois states). Clique em Sirene/Bloquear: se `podeExecutar(...)` → chama `painel.acionar(...)` como hoje e zera; senão → `pedirConfirmacao(...)` e o botão vira "Confirmar sirene?" / "Confirmar bloqueio?" (fundo `T.red`, texto branco) + botão "Cancelar" ao lado. `useEffect` com `setTimeout(JANELA_CONFIRMACAO_MS)` zera sozinho; `useEffect` em `cvSelecionado` aplica `aoTrocarVeiculo`. Desbloquear motor também passa pela confirmação ("Confirmar desbloqueio?"). Estados idle/loading/ok/fallback e o link "Abrir portal Unitrac" continuam iguais.
- [ ] **Step 3: Overlays**
  - Badge "N veículos": cápsula `material(tema)`, texto 12/600 `T.text` com número `NUM` (hoje texto `T.dim` quase invisível), `bottom` sobe quando o cartão está aberto (ajustar o 224 atual para a altura real do cartão, ~ 180; medir no print).
  - Legenda: botão cápsula `material(tema)`; painel `material(tema)` raio 14, rótulos `TIPO.caption`, itens 12px.
- [ ] **Step 4: Verificar** — `npx vitest run "src/app/(app)/"` PASS; `npx tsc --noEmit -p tsconfig.json` sem erros novos.
- [ ] **Step 5: Commit**

```bash
git add "src/app/(app)/central-v2/confirmacao-acao.ts" "src/app/(app)/central-v2/confirmacao-acao.test.ts" "src/app/(app)/central-v2/MonitorV2.tsx"
git commit -m "feat(mapa): cartao flutuante do veiculo, confirmacao de sirene/bloqueio, overlays translucidos"
```

---

## Depois das tasks (controlador)

1. Revisão final do branch inteiro (modelo mais capaz).
2. Merge em main, push, deploy no VPS (procedimento padrão: `git reset --hard origin/main` + `npm run build` em background + `pm2 restart transmonseg-definitivo` só com `EXIT=0`).
3. Prints reais com a conta QA (`https://monitoramento.transmonseg.com.br/?cliente=4096`): escuro e claro; card ativo; popover Mapa aberto; cartão do veículo aberto com "Confirmar bloqueio?" visível (NÃO clicar Confirmar); AMBOS. Salvar em `~/ClaudeGerado/monitoramento/redesign-*.png` e mandar ao usuário.
4. Se algo quebrar em produção: `git revert` do merge + redeploy.
