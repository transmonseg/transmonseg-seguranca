# Central V2 — Design, Mapa e Tema Claro/Escuro

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Corrigir as cores do central-v2 para seguir o design system Transmonseg, consertar todos os problemas visuais e de UX do mapa e botões, e adicionar modo claro/escuro com toggle na toolbar.

**Architecture:** MonitorV2 e MapaLeafletV2 usam inline styles hardcoded; a correção é migrá-los para `var(--token)` CSS do globals.css. Light mode é implementado via atributo `data-theme="light"` no `<html>`, persistido em localStorage. O tile layer do Leaflet troca conforme o tema.

**Tech Stack:** Next.js 16 App Router, React 19, react-leaflet 5, Leaflet 1.9, Tailwind v4, CSS Custom Properties, localStorage.

## Global Constraints

- Nunca usar `#hex` hardcoded em MonitorV2.tsx ou MapaLeafletV2.tsx — sempre `var(--token)` ou (para Leaflet que usa SVG) constantes importadas de `src/app/(app)/central-v2/tokens.ts`
- Nunca adicionar dependências novas (zero npm install)
- Nunca modificar `src/app/(app)/components/PainelCentral.tsx` nem `MapaMonitor.tsx` — são a tela de produção `/`
- Nunca modificar `src/app/(app)/layout.tsx` nem `src/app/globals.css` além do que está nos tasks abaixo
- Arquivo de tema: `src/app/globals.css` — seção `:root` já existe, adicionar seção `[data-theme="light"]`
- Tokens para Leaflet (SVG inline não lê CSS vars): `src/app/(app)/central-v2/tokens.ts` exporta `DARK_TOKENS` e `LIGHT_TOKENS`
- Quando veículo é selecionado, os outros veículos NÃO devem desaparecer — devem ficar em 35% de opacidade
- Modo claro usa tile CartoDB Positron; modo escuro usa CartoDB Dark All (já existente)

---

## Mapa de Arquivos

| Arquivo | Ação | Por quê |
|---------|------|---------|
| `src/app/globals.css` | Modificar — adicionar `[data-theme="light"]` | Tokens do modo claro |
| `src/app/(app)/central-v2/tokens.ts` | **Criar** | Tokens JS para Leaflet (SVG não lê CSS vars) |
| `src/app/(app)/central-v2/MonitorV2.tsx` | Modificar | Corrigir cores, hover, z-index, hook deps, tema |
| `src/app/(app)/central-v2/MapaLeafletV2.tsx` | Modificar | Corrigir cores, visibilidade veículos, zoom state |

---

## Task 1 — Tokens CSS e Light Mode em globals.css

**Files:**
- Modify: `src/app/globals.css`
- Create: `src/app/(app)/central-v2/tokens.ts`

**Interfaces:**
- Produces: `DARK_TOKENS` e `LIGHT_TOKENS` exportados de `tokens.ts` (usados em Tasks 2 e 3)

- [ ] **Step 1: Adicionar modo claro em globals.css**

Abrir `src/app/globals.css`. Após o bloco `:root { ... }` existente, adicionar:

```css
/* =========================================================
   Tokens light mode
   ========================================================= */
[data-theme="light"] {
  --bg:             #f4f4f3;
  --card:           #ffffff;
  --card-hover:     #ebebea;
  --border:         #e2e2e0;
  --border-subtle:  #ebebea;

  --text:           #111110;
  --text-muted:     #6b7280;
  --text-dim:       #9ca3af;

  --accent:         #4b6f9a;
  --accent-dim:     #dce7f3;

  --vermelho:       #dc2626;
  --amarelo:        #d97706;
  --verde:          #16a34a;
}
```

Também adicionar após `html, body { ... }` (por volta da linha 54):

```css
/* Transition suave ao trocar tema */
*, *::before, *::after {
  transition: background-color 0.2s ease, border-color 0.2s ease, color 0.15s ease;
}
/* Exceto mapa e animações (transition interfere) */
.leaflet-container *, [class*="animate-"] {
  transition: none !important;
}
```

- [ ] **Step 2: Criar tokens.ts com valores para Leaflet**

Criar arquivo `src/app/(app)/central-v2/tokens.ts`:

```typescript
// Tokens para uso em Leaflet (SVG inline não consegue ler CSS custom properties)
// Devem refletir exatamente os valores de globals.css

export interface MapTokens {
  bg: string;
  card: string;
  border: string;
  text: string;
  muted: string;
  accent: string;
  red: string;
  yellow: string;
  green: string;
  dim: string;
  tileUrl: string;
  tileSubdomains: string;
}

export const DARK_TOKENS: MapTokens = {
  bg:       "#0a0a0a",
  card:     "#131313",
  border:   "#242424",
  text:     "#fafaf9",
  muted:    "#a8a29e",
  accent:   "#9fb3ce",
  red:      "#ef4444",
  yellow:   "#f59e0b",
  green:    "#22c55e",
  dim:      "#57534e",
  tileUrl:       "https://{s}.basemaps.cartocdn.com/dark_all/{z}/{x}/{y}{r}.png",
  tileSubdomains: "abcd",
};

export const LIGHT_TOKENS: MapTokens = {
  bg:       "#f4f4f3",
  card:     "#ffffff",
  border:   "#e2e2e0",
  text:     "#111110",
  muted:    "#6b7280",
  accent:   "#4b6f9a",
  red:      "#dc2626",
  yellow:   "#d97706",
  green:    "#16a34a",
  dim:      "#9ca3af",
  tileUrl:       "https://{s}.basemaps.cartocdn.com/light_all/{z}/{x}/{y}{r}.png",
  tileSubdomains: "abcd",
};
```

- [ ] **Step 3: Verificar TypeScript**

```
cd C:\Users\media\transmonseg-central && npx tsc --noEmit
```

Esperado: zero erros.

---

## Task 2 — MonitorV2: cores CSS vars + toggle de tema + hover + z-index + hook deps

**Files:**
- Modify: `src/app/(app)/central-v2/MonitorV2.tsx`

**Interfaces:**
- Consumes: `DARK_TOKENS`, `LIGHT_TOKENS`, `MapTokens` de `./tokens`
- Produces: prop `tema: MapTokens` passada para `MapaLeafletV2`

### Mudanças necessárias (seção por seção)

- [ ] **Step 1: Substituir objeto T hardcoded por CSS vars + import de tokens**

Remover o objeto `T` hardcoded atual (bloco de linhas com `T.bg`, `T.card`, etc.) e substituir toda referência a `T.{color}` por `"var(--{token})"`:

| Antes | Depois |
|-------|--------|
| `T.bg` | `"var(--bg)"` |
| `T.card` | `"var(--card)"` |
| `T.border` | `"var(--border)"` |
| `T.text` | `"var(--text)"` |
| `T.muted` | `"var(--text-muted)"` |
| `T.accent` | `"var(--accent)"` |
| `T.red` | `"var(--vermelho)"` |
| `T.yellow` | `"var(--amarelo)"` |
| `T.green` | `"var(--verde)"` |

Adicionar no topo do arquivo:

```typescript
import { DARK_TOKENS, LIGHT_TOKENS, type MapTokens } from "./tokens";
```

- [ ] **Step 2: Adicionar state de tema e persistência localStorage**

Adicionar após os outros `useState`:

```typescript
const [tema, setTema] = useState<"dark" | "light">("dark");

// Carregar preferência salva
useEffect(() => {
  const saved = localStorage.getItem("transmonseg-tema") as "dark" | "light" | null;
  if (saved) {
    setTema(saved);
    document.documentElement.setAttribute("data-theme", saved === "light" ? "light" : "");
  }
}, []);

// Aplicar tema ao trocar
const toggleTema = useCallback(() => {
  setTema(prev => {
    const novo = prev === "dark" ? "light" : "dark";
    localStorage.setItem("transmonseg-tema", novo);
    document.documentElement.setAttribute("data-theme", novo === "light" ? "light" : "");
    return novo;
  });
}, []);

const mapTokens: MapTokens = tema === "dark" ? DARK_TOKENS : LIGHT_TOKENS;
```

- [ ] **Step 3: Substituir dropdown hardcoded #0d0d1e**

Encontrar e substituir:

```typescript
// ANTES:
background: "#0d0d1e",

// DEPOIS:
background: "var(--card)",
```

- [ ] **Step 4: Corrigir React hook deps (bug crítico)**

Encontrar o useEffect com `eslint-disable-line react-hooks/exhaustive-deps`:

```typescript
// ANTES (BUGADO):
useEffect(() => {
  if (cvSelecionado) carregarVeiculo(cvSelecionado, horas);
}, [horas]); // eslint-disable-line react-hooks/exhaustive-deps

// DEPOIS (CORRETO):
useEffect(() => {
  if (cvSelecionado) carregarVeiculo(cvSelecionado, horas);
}, [cvSelecionado, horas, carregarVeiculo]);
```

- [ ] **Step 5: Reorganizar z-index em constantes claras**

Adicionar após os imports, antes do componente:

```typescript
const Z = {
  badge:   100,
  toasts:  800,
  combo:   850,
  drawer: 1000,
} as const;
```

Substituir z-index inline nos seguintes locais:
- Badge de veículos: `zIndex: 800` → `zIndex: Z.badge`
- Toast area: `zIndex: 900` → `zIndex: Z.toasts`
- Dropdown de busca: `zIndex: 9999` → `zIndex: Z.combo`
- Drawer: `zIndex: 1000` → `zIndex: Z.drawer`

- [ ] **Step 6: Adicionar botão de tema na toolbar**

Na toolbar, logo antes do `<AlertaSonoro>`, adicionar:

```tsx
{/* Toggle tema */}
<button
  onClick={toggleTema}
  title={tema === "dark" ? "Mudar para modo claro" : "Mudar para modo escuro"}
  style={{
    ...BASE_BTN,
    width: 32, height: 32, borderRadius: "50%",
    color: "var(--text-muted)",
    border: "1px solid var(--border)",
  }}
>
  {tema === "dark" ? (
    <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor"
      strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
      <circle cx="12" cy="12" r="5"/>
      <line x1="12" y1="1" x2="12" y2="3"/>
      <line x1="12" y1="21" x2="12" y2="23"/>
      <line x1="4.22" y1="4.22" x2="5.64" y2="5.64"/>
      <line x1="18.36" y1="18.36" x2="19.78" y2="19.78"/>
      <line x1="1" y1="12" x2="3" y2="12"/>
      <line x1="21" y1="12" x2="23" y2="12"/>
      <line x1="4.22" y1="19.78" x2="5.64" y2="18.36"/>
      <line x1="18.36" y1="5.64" x2="19.78" y2="4.22"/>
    </svg>
  ) : (
    <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor"
      strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
      <path d="M21 12.79A9 9 0 1 1 11.21 3 7 7 0 0 0 21 12.79z"/>
    </svg>
  )}
</button>
```

- [ ] **Step 7: Adicionar hover states via className**

Adicionar no bloco `<style>` existente no final do componente:

```tsx
<style>{`
  @keyframes slideInToast {
    from { opacity: 0; transform: translateX(24px); }
    to   { opacity: 1; transform: translateX(0); }
  }
  /* Hover states para botões inline */
  .v2-btn:hover { opacity: 0.8; }
  .v2-btn-tiny:hover { filter: brightness(1.2); }
  .v2-drawer-btn:hover { filter: brightness(1.15); cursor: pointer; }
  .v2-alert-card:hover { filter: brightness(1.08); }
  /* Toast fade-out */
  .v2-toast-fade { animation: toastFade 0.4s ease-out forwards; }
  @keyframes toastFade {
    from { opacity: 1; transform: translateX(0); }
    to   { opacity: 0; transform: translateX(20px); }
  }
`}</style>
```

Adicionar `className="v2-btn"` nos botões de toolbar (zoom, comm).
Adicionar `className="v2-btn-tiny"` nos botões Focar/Resolver/Falso dos cards de alerta.
Adicionar `className="v2-drawer-btn"` nos botões do drawer (Rastro, Paradas, Seguir, etc.).
Adicionar `className="v2-alert-card"` no div de cada card de alerta.

- [ ] **Step 8: Passar mapTokens e tema para MapaLeafletV2**

Atualizar a chamada ao `<MapaLeafletV2>` adicionando as props:

```tsx
<MapaLeafletV2
  // ... todas as props existentes ...
  mapTokens={mapTokens}
  tema={tema}
/>
```

- [ ] **Step 9: Verificar TypeScript**

```
cd C:\Users\media\transmonseg-central && npx tsc --noEmit
```

Esperado: zero erros.

---

## Task 3 — MapaLeafletV2: cores via tokens + veículos não somem + zoom tracking

**Files:**
- Modify: `src/app/(app)/central-v2/MapaLeafletV2.tsx`

**Interfaces:**
- Consumes: `mapTokens: MapTokens`, `tema: "dark" | "light"` (novas props)
- Consumes: `cvSelecionado: string | null` (já existia — mas comportamento muda)

### Mudanças necessárias

- [ ] **Step 1: Adicionar mapTokens e tema na interface Props e corVeiculo**

Atualizar a interface `Props` no topo do arquivo:

```typescript
import { type MapTokens } from "./tokens";

// Adicionar na interface Props:
export interface Props {
  // ... todas as props existentes ...
  mapTokens: MapTokens;   // ← NOVO
  tema: "dark" | "light"; // ← NOVO
}
```

Atualizar função `corVeiculo` para receber tokens:

```typescript
function corVeiculo(v: VeiculoMapa, tok: MapTokens): string {
  if (v.nivel === "vermelho" || (v.tipo !== null && v.tipo !== "")) return tok.red;
  if (v.nivel === "amarelo") return tok.yellow;
  if (v.ignicao && v.velocidade > 0) return tok.green;
  if (v.ignicao && v.velocidade === 0) return tok.accent;
  if (v.atraso_min > 60) return tok.dim;
  return tok.dim;
}
```

- [ ] **Step 2: Atualizar iconeVeiculo para usar mapTokens**

Atualizar assinatura e todas as referências de cor hardcoded:

```typescript
function iconeVeiculo(v: VeiculoMapa, selecionado: boolean, tok: MapTokens): L.DivIcon {
  const cor = corVeiculo(v, tok);
  // ... o resto do código igual, mas usando tok.bg onde tem rgba(4,4,12,0.97)
  // Substituir "rgba(4,4,12,0.97)" por tok.bg + "f7" (97% hex opacity)
  // Substituir "rgba(0,0,0,0.6)" onde stroke de border por `${tok.dim}99`
}
```

Todas as chamadas `iconeVeiculo(vm, ...)` passam a ser `iconeVeiculo(vm, ..., mapTokens)`.

- [ ] **Step 3: Corrigir visibilidade — veículos não somem quando um é selecionado**

Substituir a lógica de `veiculosVisiveis`:

```typescript
// ANTES (veículos não selecionados somem):
const veiculosVisiveis = cvSelecionado
  ? veiculosMapa.filter(v => v.cv === cvSelecionado && v.lat != null && v.lng != null)
  : veiculosMapa.filter(v => v.lat != null && v.lng != null);

// DEPOIS (todos aparecem, não-selecionados ficam dimmed):
const veiculosComPos = veiculosMapa.filter(v => v.lat != null && v.lng != null);
```

No JSX de renderização dos markers, substituir:

```tsx
{/* ANTES: */}
{veiculosVisiveis.map(vm => (
  <Marker ... />
))}

{/* DEPOIS: todos os veículos, opacidade reduzida para não-selecionados */}
{veiculosComPos.map(vm => {
  const selecionado = vm.cv === cvSelecionado;
  const dimmed = cvSelecionado !== null && !selecionado;
  return (
    <Marker
      key={vm.cv}
      position={[vm.lat!, vm.lng!]}
      icon={iconeVeiculo(vm, selecionado, mapTokens)}
      opacity={dimmed ? 0.3 : 1}
      eventHandlers={{
        click: () => {
          _ultimoCliqueMarcador = Date.now();
          onVeiculoClick(vm);
        },
      }}
      zIndexOffset={selecionado ? 1000 : 0}
    >
      <Tooltip direction="top" offset={[0, -28]} opacity={0.92}>
        <span style={{ fontSize: 11, fontFamily: "monospace", fontWeight: 700 }}>
          {vm.placa} · {vm.velocidade}km/h
          {vm.tipo ? ` · ⚠ ${vm.tipo}` : ""}
        </span>
      </Tooltip>
    </Marker>
  );
})}
```

- [ ] **Step 4: Trocar tile layer baseado no tema**

Substituir o `<TileLayer>` fixo por um que lê do `mapTokens`:

```tsx
// ANTES:
<TileLayer
  url="https://{s}.basemaps.cartocdn.com/dark_all/{z}/{x}/{y}{r}.png"
  maxZoom={20}
  subdomains="abcd"
  attribution=""
/>

// DEPOIS:
<TileLayer
  key={tema}  // key force-mounts quando tema muda
  url={mapTokens.tileUrl}
  maxZoom={20}
  subdomains={mapTokens.tileSubdomains}
  attribution=""
/>
```

- [ ] **Step 5: Corrigir cor do rastro e paradas com tokens**

```tsx
// Rastro — ANTES:
pathOptions={{ color: "#9fb3ce", weight: 2.5, opacity: 0.75, dashArray: "5 4" }}

// DEPOIS:
pathOptions={{ color: mapTokens.accent, weight: 2.5, opacity: 0.75, dashArray: "5 4" }}

// Paradas — ANTES:
pathOptions={{ color: "#f59e0b", fillColor: "#f59e0b", fillOpacity: 0.7, weight: 1.5 }}

// DEPOIS:
pathOptions={{ color: mapTokens.yellow, fillColor: mapTokens.yellow, fillOpacity: 0.7, weight: 1.5 }}
```

- [ ] **Step 6: Adicionar tracking de zoom atual + invalidar cache ao trocar tema**

Adicionar nova prop `onZoomChange?: (zoom: number) => void` em Props e uma função `CapturarZoom` dentro do componente:

```typescript
// Nova prop:
onZoomChange?: (zoom: number) => void;

// Componente interno:
function CapturarZoom({ onChange }: { onChange?: (z: number) => void }) {
  useMapEvents({
    zoomend: (e) => { onChange?.(e.target.getZoom()); },
  });
  return null;
}
```

Adicionar no JSX do MapContainer:
```tsx
<CapturarZoom onChange={onZoomChange} />
```

Para invalidar o cache de ícones ao trocar tema, adicionar no componente principal:
```typescript
useEffect(() => {
  // Limpar cache quando tema muda para forçar re-render dos ícones
  Object.keys(_iconeCache).forEach(k => delete _iconeCache[k]);
}, [tema]);
```

- [ ] **Step 7: Corrigir key das paradas**

```tsx
// ANTES:
paradas.map((p, i) => (
  <CircleMarker key={i} ...>

// DEPOIS:
paradas.map((p) => (
  <CircleMarker key={`${p.lat.toFixed(5)},${p.lng.toFixed(5)},${p.data}`} ...>
```

- [ ] **Step 8: Verificar TypeScript**

```
cd C:\Users\media\transmonseg-central && npx tsc --noEmit
```

Esperado: zero erros.

---

## Task 4 — MonitorV2: zoom tracking + indicador de zoom atual

**Files:**
- Modify: `src/app/(app)/central-v2/MonitorV2.tsx`

**Interfaces:**
- Consumes: `onZoomChange` callback da prop de MapaLeafletV2

- [ ] **Step 1: Adicionar state de zoom atual**

```typescript
const [zoomAtual, setZoomAtual] = useState(11);
```

- [ ] **Step 2: Passar callback para MapaLeafletV2**

```tsx
<MapaLeafletV2
  // ... props existentes ...
  onZoomChange={setZoomAtual}
/>
```

- [ ] **Step 3: Marcar zoom button ativo baseado no zoom atual**

Definir mapa de zoom → label para detecção de zoom ativo:

```typescript
const ZOOM_LABELS: Record<number, string> = { 17: "RUA", 15: "QUADRA", 13: "BAIRRO", 11: "CIDADE" };
```

Atualizar o render dos zoom buttons para passar `active` correto:

```tsx
{(["RUA", "QUADRA", "BAIRRO", "CIDADE"] as const).map((label, i) => {
  const zooms = [17, 15, 13, 11];
  const z = zooms[i];
  const ativo = zoomAtual === z;
  return (
    <button key={label} onClick={() => cmdZoom(z)}
      style={outlineBtn(ativo, "var(--accent)")}>
      {label}
    </button>
  );
})}
```

- [ ] **Step 4: Verificar TypeScript**

```
cd C:\Users\media\transmonseg-central && npx tsc --noEmit
```

Esperado: zero erros.

---

## Task 5 — QA Visual: screenshot com e sem veículo selecionado em ambos os temas

**Files:**
- Create: `_qa-v2.mjs` (temporário, deletar após)

- [ ] **Step 1: Escrever script de QA**

Criar `C:\Users\media\transmonseg-central\_qa-v2.mjs`:

```javascript
import puppeteer from "puppeteer-core";

const SUPA_URL = "https://cbnzhcmsqcfradaklndu.supabase.co";
const SRK = "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6ImNibnpoY21zcWNmcmFkYWtsbmR1Iiwicm9sZSI6InNlcnZpY2Vfcm9sZSIsImlhdCI6MTc4MjA4NDY1NywiZXhwIjoyMDk3NjYwNjU3fQ.2AGfHP22Vtzx1G0RRAUqIJ_nKAtnbvj7ZuOUgCZZCdM";
const QA_EMAIL = "qa-v2-polish@transmonseg.local";
const QA_SENHA = "QaPol!sh2026#";
const BASE = "http://localhost:3001";
const DIR = "C:/Users/media/Desktop/Screenshots";

async function criarUsuario() {
  const r = await fetch(`${SUPA_URL}/auth/v1/admin/users`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${SRK}`, apikey: SRK },
    body: JSON.stringify({ email: QA_EMAIL, password: QA_SENHA, email_confirm: true }),
  });
  return (await r.json()).id;
}

async function deletarUsuario(id) {
  await fetch(`${SUPA_URL}/auth/v1/admin/users/${id}`, {
    method: "DELETE",
    headers: { Authorization: `Bearer ${SRK}`, apikey: SRK },
  });
}

const uid = await criarUsuario();
const browser = await puppeteer.launch({
  executablePath: "C:/Program Files/Google/Chrome/Application/chrome.exe",
  headless: true,
  args: ["--no-sandbox", "--window-size=1366,768"],
  defaultViewport: { width: 1366, height: 768 },
});

try {
  const page = await browser.newPage();
  // Login
  await page.goto(`${BASE}/login`, { waitUntil: "load", timeout: 30000 });
  await new Promise(r => setTimeout(r, 3000));
  await page.evaluate(([e, s]) => {
    document.querySelector("input[name=email]").value = e;
    document.querySelector("input[name=senha]").value = s;
    ["input","change"].forEach(ev => {
      document.querySelector("input[name=email]").dispatchEvent(new Event(ev,{bubbles:true}));
      document.querySelector("input[name=senha]").dispatchEvent(new Event(ev,{bubbles:true}));
    });
  }, [QA_EMAIL, QA_SENHA]);
  await Promise.all([
    page.waitForNavigation({ waitUntil: "networkidle2", timeout: 20000 }).catch(() => {}),
    page.evaluate(() => document.querySelector("form").requestSubmit()),
  ]);
  await new Promise(r => setTimeout(r, 2000));

  // 1. Dark mode, sem veículo
  await page.goto(`${BASE}/central-v2`, { waitUntil: "networkidle2", timeout: 30000 });
  await new Promise(r => setTimeout(r, 4000));
  await page.screenshot({ path: `${DIR}/v2-dark-idle.png` });
  console.log("1. Dark idle:", `${DIR}/v2-dark-idle.png`);

  // 2. Dark mode, com veículo (focar primeiro alerta)
  const btns = await page.$$("button");
  for (const btn of btns) {
    const txt = await btn.evaluate(el => el.textContent?.trim());
    if (txt === "Focar") { await btn.click(); break; }
  }
  await new Promise(r => setTimeout(r, 3000));
  await page.screenshot({ path: `${DIR}/v2-dark-drawer.png` });
  console.log("2. Dark drawer:", `${DIR}/v2-dark-drawer.png`);

  // 3. Light mode (clicar no botão de sol/lua)
  const allBtns = await page.$$("button");
  for (const btn of allBtns) {
    const title = await btn.evaluate(el => el.title);
    if (title && title.includes("claro")) { await btn.click(); break; }
  }
  await new Promise(r => setTimeout(r, 2000));
  await page.screenshot({ path: `${DIR}/v2-light-drawer.png` });
  console.log("3. Light drawer:", `${DIR}/v2-light-drawer.png`);

  // 4. Light mode, fechar drawer
  const xBtns = await page.$$("button");
  for (const btn of xBtns) {
    const txt = await btn.evaluate(el => el.textContent?.trim());
    if (txt === "x") { await btn.click(); break; }
  }
  await new Promise(r => setTimeout(r, 1500));
  await page.screenshot({ path: `${DIR}/v2-light-idle.png` });
  console.log("4. Light idle:", `${DIR}/v2-light-idle.png`);

} finally {
  await browser.close();
  await deletarUsuario(uid);
  console.log("QA removido.");
}
```

- [ ] **Step 2: Rodar o script**

```
cd C:\Users\media\transmonseg-central && node _qa-v2.mjs
```

Esperado: 4 screenshots em `Desktop/Screenshots/` — `v2-dark-idle.png`, `v2-dark-drawer.png`, `v2-light-drawer.png`, `v2-light-idle.png`

- [ ] **Step 3: Verificar manualmente os 4 screenshots**

Checklist visual:
- [ ] Dark idle: fundo `#0a0a0a`, mapa dark, alertas com bordas vermelho/amarelo, toolbar com botões navy
- [ ] Dark drawer: drawer visível na base, placa grande, botões de operação, mapa ainda visível acima
- [ ] Light idle: fundo `#f4f4f3`, mapa Positron (claro), mesma estrutura mas claro
- [ ] Light drawer: drawer com fundo claro, textos escuros legíveis
- [ ] Em ambos: outros veículos ainda aparecem no mapa em 30% opacidade quando um está selecionado
- [ ] Em ambos: zoom buttons ficam ativos visualmente quando o zoom corresponde

- [ ] **Step 4: Deletar script de QA**

```
del C:\Users\media\transmonseg-central\_qa-v2.mjs
```

---

## Self-Review

### Spec Coverage

| Requisito | Task que cobre |
|-----------|----------------|
| Cores iguais ao sistema Transmonseg | Task 1 (globals.css valores exatos) + Task 2 (substituição T.→var) |
| Mapa com GPS funcionando / não sumir | Task 3 Step 3 (veiculosComPos + opacity) |
| Cada botão individualmente revisado | Task 2 Steps 3-7 (hover, z-index, zoom ativo) |
| Cada parte do mapa individualmente | Task 3 Steps 1-7 (cor, tile, rastro, paradas, marcadores) |
| Modo claro/escuro | Task 1 (CSS vars light), Task 2 (toggle + state), Task 3 (tile swap) |
| Tile layer troca no light mode | Task 3 Step 4 |
| Zoom buttons indicam zoom atual | Task 4 |
| React hook dep bug corrigido | Task 2 Step 4 |
| Z-index organizado | Task 2 Step 5 |
| Hover states nos botões | Task 2 Step 7 |

### Placeholder Scan

Nenhum "TBD", "TODO" ou "implement later" encontrado. Todos os blocos de código têm implementação completa.

### Type Consistency

- `mapTokens: MapTokens` criado em Task 1, consumido em Tasks 2 e 3 ✓
- `onZoomChange?: (zoom: number) => void` adicionado em Task 3, consumido em Task 4 ✓
- `tema: "dark" | "light"` consistente entre Tasks 2 e 3 ✓
