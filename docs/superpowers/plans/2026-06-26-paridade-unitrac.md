# Paridade Unitrac na tela unificada — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Trazer de volta a experiência operacional do Unitrac (barra de veículos/rota/período) na tela unificada, via um toggle Operação | Alertas, e enriquecer o painel do veículo e o popup do ponto de entrega.

**Architecture:** O `PainelCentral` ganha um estado `modoBarra`. No modo "operacao" ele esconde a coluna de alertas e religa a barra operacional que já existe no `MapaMonitor` (`mostrarSidebar={true}`); no modo "alertas" mantém o comportamento atual. Um toggle flutuante no mapa alterna os dois. O `MapaMonitor` não é reescrito. O popup do ponto de entrega e o painel do veículo recebem campos extras já disponíveis nas APIs do Unitrac.

**Tech Stack:** Next.js 16 App Router, React 19, React-Leaflet 5, Supabase (admin), Vitest. Sem dependências novas.

## Global Constraints

- Nunca usar travessão (--) em texto de interface.
- Português com acentos e cedilha corretos em todo texto de UI.
- Zero dependências novas ou pagas; free tier only.
- Nenhum secret no repo; `.env.local` nunca commitado.
- `npx vitest run` (255 testes) deve passar 100% antes e depois de cada task.
- `npx tsc --noEmit` deve sair limpo antes de qualquer commit.
- Validação visual via Chrome headless logado quando a mudança for de UI.

---

### Task 1: Toggle Operação | Alertas no PainelCentral

**Files:**
- Modify: `src/app/(app)/components/PainelCentral.tsx`

**Interfaces:**
- Consumes: `MapaMonitor` já aceita `mostrarSidebar?: boolean`.
- Produces: estado `modoBarra: "operacao" | "alertas"` interno ao `PainelCentral`.

- [ ] **Step 1: Adicionar o estado `modoBarra`**

No `PainelCentral`, logo após `const [vista, setVista] = useState<Vista>("tudo");`, adicionar:

```tsx
const [modoBarra, setModoBarra] = useState<"operacao" | "alertas">("alertas");
```

- [ ] **Step 2: Renderizar a coluna de alertas só no modo alertas**

A coluna de alertas é o primeiro filho do container flex (o `<div>` com `width: SIDEBAR_W`).
Envolver TODO esse `<div>` da sidebar de alertas com a condição. Trocar a abertura:

```tsx
{/* ======== SIDEBAR DE ALERTAS ======== */}
<div
  style={{
    width: SIDEBAR_W,
    flexShrink: 0,
    ...
```

por:

```tsx
{/* ======== SIDEBAR DE ALERTAS (só no modo alertas) ======== */}
{modoBarra === "alertas" && (
<div
  style={{
    width: SIDEBAR_W,
    flexShrink: 0,
    ...
```

e fechar a expressão: o `</div>` que fecha essa sidebar (logo antes de `{/* ======== MAPA ======== */}`) vira `</div>
)}`.

- [ ] **Step 3: Passar `mostrarSidebar` conforme o modo**

No `<MapaMonitor ... />`, trocar `mostrarSidebar={false}` por:

```tsx
mostrarSidebar={modoBarra === "operacao"}
```

- [ ] **Step 4: Adicionar o toggle flutuante no mapa**

Dentro do `<div style={{ flex: 1, position: "relative", overflow: "hidden" }}>` do mapa,
logo após a abertura (antes do `{toast && (`), inserir:

```tsx
{/* Toggle Operação | Alertas */}
<div
  style={{
    position: "absolute",
    top: 12,
    left: "50%",
    transform: "translateX(-50%)",
    zIndex: 1000,
    display: "flex",
    gap: 3,
    padding: 3,
    borderRadius: 10,
    backgroundColor: "rgba(9,9,13,0.92)",
    border: "1px solid var(--border)",
    backdropFilter: "blur(6px)",
  }}
>
  {(["operacao", "alertas"] as const).map((m) => {
    const ativo = modoBarra === m;
    return (
      <button
        key={m}
        onClick={() => setModoBarra(m)}
        style={{
          padding: "0.35rem 0.9rem",
          borderRadius: 8,
          border: "1px solid transparent",
          cursor: "pointer",
          fontSize: 12,
          fontWeight: 700,
          backgroundColor: ativo ? "var(--accent-dim)" : "transparent",
          color: ativo ? "var(--accent)" : "var(--text-dim)",
        }}
      >
        {m === "operacao" ? "Operação" : "Alertas"}
      </button>
    );
  })}
</div>
```

- [ ] **Step 5: Compilar e rodar testes**

```bash
npx tsc --noEmit
npx vitest run
```
Esperado: tsc limpo, 255 testes passando.

- [ ] **Step 6: Validação visual**

Subir `npm run dev` (porta 3001), logar com o usuário QA, alternar o toggle e conferir:
no modo Operação aparece a barra Unitrac (árvore de veículos, período, rastro); no modo Alertas
aparece a coluna de alertas. Screenshot dos dois modos.

- [ ] **Step 7: Commit**

```bash
git add "src/app/(app)/components/PainelCentral.tsx"
git commit -m "feat: toggle Operacao | Alertas religa a barra do Unitrac na tela unificada"
```

---

### Task 2: Corrigir link de cliente da barra do Unitrac

**Files:**
- Modify: `src/app/(app)/components/MapaMonitor.tsx`

**Interfaces:**
- Consumes: nada novo.
- Produces: nada novo.

A barra do `MapaMonitor` tem um seletor de cliente que aponta para `/monitoramento?cliente=...`,
rota que agora redireciona para `/`. No modo Operação isso causaria um redirect desnecessário.
Apontar para a mesma rota (querystring relativa).

- [ ] **Step 1: Trocar o href do seletor de cliente**

Localizar no `MapaMonitor` (dentro da sidebar, no seletor de cliente):

```tsx
href={`/monitoramento?cliente=${c.cod}`}
```

Trocar por:

```tsx
href={`?cliente=${c.cod}`}
```

- [ ] **Step 2: Compilar**

```bash
npx tsc --noEmit
```
Esperado: limpo.

- [ ] **Step 3: Commit**

```bash
git add "src/app/(app)/components/MapaMonitor.tsx"
git commit -m "fix: seletor de cliente da barra de operacao usa a rota unificada"
```

---

### Task 3: Popup do ponto de entrega com dados completos

**Files:**
- Modify: `src/lib/unitrac.ts`
- Modify: `src/lib/unitrac.test.ts` (criar se não existir) — usar `src/lib/detectores.test.ts` como padrão de teste
- Modify: `src/app/(app)/components/MapaMonitor.tsx`

**Interfaces:**
- Produces: `PontoEntrega` estendido:
  ```ts
  type PontoEntrega = {
    lat: number; lng: number; raio: number; ordem: number; nome: string; feito: boolean;
    documento: string | null;      // alvodocumento
    identificador: string | null;  // pontoidentificador
    dataInicio: string | null;     // alvodatainicio
    dataRealizado: string | null;  // alvodatarealizado (ignora "0001-..." que = não realizado)
    observacoes: string | null;    // alvoobservacoes
    rota: string | null;           // alvorota
  };
  ```

Campos confirmados no retorno bruto de `/mapa_servicos/alvos`: `alvodocumento`, `pontoidentificador`,
`alvodatainicio`, `alvodatarealizado` ("0001-01-01T00:00:00" quando não realizado), `alvoobservacoes`,
`alvorota`, `pontonome`, `alvosituacaoservico` (0=pendente, 1=feito).

- [ ] **Step 1: Estender o tipo `AlvoUnitrac` em `src/lib/unitrac.ts`**

Adicionar os campos ao type `AlvoUnitrac` (que já tem `[key: string]: unknown`, então é só documentar):

```ts
export type AlvoUnitrac = {
  placa: string;
  alvosituacaoservico: number; // 1 = feito, 0 = pendente
  pontolatitude?: number;
  pontolongitude?: number;
  pontoraio?: number;
  pontonome?: string;
  alvoordem?: number;
  alvodocumento?: string;
  pontoidentificador?: string;
  alvodatainicio?: string;
  alvodatarealizado?: string;
  alvoobservacoes?: string | null;
  alvorota?: string;
  [key: string]: unknown;
};
```

- [ ] **Step 2: Estender o type `PontoEntrega` e `agruparPontosPorPlaca`**

Trocar o type `PontoEntrega`:

```ts
export type PontoEntrega = {
  lat: number;
  lng: number;
  raio: number;
  ordem: number;
  nome: string;
  feito: boolean;
  documento: string | null;
  identificador: string | null;
  dataInicio: string | null;
  dataRealizado: string | null;
  observacoes: string | null;
  rota: string | null;
};
```

No corpo de `agruparPontosPorPlaca`, no `lista.push({ ... })`, adicionar os campos
(uma data "0001-..." vira null):

```ts
    lista.push({
      lat,
      lng,
      raio: Number(a.pontoraio) || 50,
      ordem: Number(a.alvoordem) || 0,
      nome: String(a.pontonome ?? ""),
      feito: a.alvosituacaoservico === 1,
      documento: a.alvodocumento ? String(a.alvodocumento) : null,
      identificador: a.pontoidentificador ? String(a.pontoidentificador) : null,
      dataInicio: a.alvodatainicio && !String(a.alvodatainicio).startsWith("0001") ? String(a.alvodatainicio) : null,
      dataRealizado: a.alvodatarealizado && !String(a.alvodatarealizado).startsWith("0001") ? String(a.alvodatarealizado) : null,
      observacoes: a.alvoobservacoes != null ? String(a.alvoobservacoes) : null,
      rota: a.alvorota ? String(a.alvorota) : null,
    });
```

- [ ] **Step 3: Escrever o teste de `agruparPontosPorPlaca`**

Em `src/lib/unitrac.test.ts` (criar arquivo), seguindo o estilo de `detectores.test.ts`:

```ts
import { describe, it, expect } from "vitest";
import { agruparPontosPorPlaca, type AlvoUnitrac } from "./unitrac";

describe("agruparPontosPorPlaca", () => {
  it("mapeia os campos completos e trata data 0001 como null", () => {
    const alvos: AlvoUnitrac[] = [
      {
        placa: "ABC1D23",
        alvosituacaoservico: 0,
        pontolatitude: -22.9,
        pontolongitude: -43.2,
        pontoraio: 100,
        pontonome: "SENDAS",
        alvoordem: 1,
        alvodocumento: "279225",
        pontoidentificador: "560036",
        alvodatainicio: "2026-06-26T00:21:13",
        alvodatarealizado: "0001-01-01T00:00:00",
        alvoobservacoes: null,
        alvorota: "ROTA",
      },
    ];
    const mapa = agruparPontosPorPlaca(alvos);
    const p = mapa.get("ABC1D23")![0];
    expect(p.documento).toBe("279225");
    expect(p.identificador).toBe("560036");
    expect(p.dataInicio).toBe("2026-06-26T00:21:13");
    expect(p.dataRealizado).toBeNull();
    expect(p.observacoes).toBeNull();
    expect(p.rota).toBe("ROTA");
    expect(p.feito).toBe(false);
  });
});
```

- [ ] **Step 4: Rodar o teste**

```bash
npx vitest run src/lib/unitrac.test.ts
```
Esperado: PASS.

- [ ] **Step 5: Estender o tipo `PontoEntregaUI` e o popup no `MapaMonitor`**

No `MapaMonitor.tsx`, o type `PontoEntregaUI` deve ganhar os mesmos campos novos
(`documento`, `identificador`, `dataInicio`, `dataRealizado`, `observacoes`, `rota`),
todos `string | null`.

Adicionar um helper de formatação de data/hora perto dos outros helpers:

```tsx
function formatarHora(iso: string | null): string | null {
  if (!iso) return null;
  try {
    return new Date(iso).toLocaleString("pt-BR", {
      day: "2-digit", month: "2-digit", hour: "2-digit", minute: "2-digit",
    });
  } catch {
    return iso;
  }
}
```

Trocar o `<Popup>` dos alvos (hoje só "Entregue/Pendente — #N" + nome) por:

```tsx
<Popup>
  <div style={{ fontWeight: 700, fontSize: 13, color: p.feito ? "#6b7280" : "#f97316" }}>
    {p.feito ? "Realizado" : "Pendente"} — #{i + 1}
  </div>
  {p.nome && <div style={{ fontSize: 12, marginTop: 2 }}>{p.nome}</div>}
  {p.identificador && (
    <div style={{ fontSize: 11, color: "#666", marginTop: 2 }}>ID: {p.identificador}</div>
  )}
  {p.documento && (
    <div style={{ fontSize: 11, color: "#666", marginTop: 1 }}>Documento: {p.documento}</div>
  )}
  {formatarHora(p.dataInicio) && (
    <div style={{ fontSize: 11, color: "#666", marginTop: 1 }}>Prevista: {formatarHora(p.dataInicio)}</div>
  )}
  {formatarHora(p.dataRealizado) && (
    <div style={{ fontSize: 11, color: "#15803d", marginTop: 1 }}>Realizada: {formatarHora(p.dataRealizado)}</div>
  )}
  {p.observacoes && (
    <div style={{ fontSize: 11, color: "#666", marginTop: 1 }}>Obs: {p.observacoes}</div>
  )}
</Popup>
```

- [ ] **Step 6: Compilar e rodar a suíte**

```bash
npx tsc --noEmit
npx vitest run
```
Esperado: limpo, 256 testes passando (255 + 1 novo).

- [ ] **Step 7: Commit**

```bash
git add src/lib/unitrac.ts src/lib/unitrac.test.ts "src/app/(app)/components/MapaMonitor.tsx"
git commit -m "feat: popup do ponto de entrega com documento, ID, hora prevista/realizada e situacao"
```

---

### Task 4: Painel do veículo com localização e empresa

**Files:**
- Modify: `src/app/(app)/components/PainelVeiculoAlerta.tsx`
- Modify: `src/app/(app)/components/PainelCentral.tsx`

**Interfaces:**
- Consumes: `Telemetria` já traz `posiclatitude`, `posiclongitude`, `datagps`.
- Produces: `PainelVeiculoAlerta` ganha a prop opcional `empresa?: string`.

Campos do Unitrac que dá para mostrar com o que já temos: Coordenadas (`posiclatitude`/`posiclongitude`),
Data GPS (`datagps`), "Offline por" (`atraso`, já mostrado como comunicação) e Empresa (nome do cliente).
Modelo/Cor/Grupo não têm fonte confiável na API atual e ficam de fora (não inventar).

- [ ] **Step 1: Adicionar a prop `empresa` em `PainelVeiculoAlerta`**

Na interface `Props`:

```tsx
interface Props {
  cv: string;
  placa: string;
  alertas: AlertaSimples[];
  onFechar: () => void;
  empresa?: string;
}
```

E na assinatura do componente:

```tsx
export default function PainelVeiculoAlerta({ cv, placa, alertas, onFechar, empresa }: Props) {
```

- [ ] **Step 2: Adicionar um helper de data e o bloco de localização**

Perto do `formatarDuracao`, adicionar:

```tsx
function formatarDataHora(iso: string | null | undefined): string | null {
  if (!iso) return null;
  try {
    return new Date(iso).toLocaleString("pt-BR", {
      day: "2-digit", month: "2-digit", hour: "2-digit", minute: "2-digit", second: "2-digit",
    });
  } catch {
    return iso;
  }
}
```

No corpo, calcular os valores (já existem `lat`, `lng`, `posValida`):

```tsx
const dataGps = formatarDataHora(telemetria?.datagps as string | undefined);
```

Logo após o bloco de telemetria (o `<div>` com a grade de 3 colunas veloc/ignicao/comm),
inserir um novo bloco:

```tsx
{/* Localizacao / empresa */}
<div style={blocoStyle}>
  {empresa && (
    <div style={{ marginBottom: 6 }}>
      <p style={rotuloStyle}>empresa</p>
      <p style={{ fontSize: 12, color: "var(--text-muted)", fontWeight: 600 }}>{empresa}</p>
    </div>
  )}
  <p style={rotuloStyle}>localizacao</p>
  {posValida ? (
    <>
      <p style={{ fontFamily: "var(--font-geist-mono, monospace)", fontSize: 11, color: "var(--text-muted)" }}>
        {lat.toFixed(5)}, {lng.toFixed(5)}
      </p>
      <a
        href={`https://www.google.com/maps?q=${lat},${lng}`}
        target="_blank"
        rel="noreferrer"
        style={{ fontSize: 11, color: "var(--accent)" }}
      >
        abrir no Google Maps
      </a>
    </>
  ) : (
    <p style={{ fontSize: 11, color: "var(--text-dim)" }}>sem posicao</p>
  )}
  {dataGps && (
    <p style={{ fontSize: 10, color: "var(--text-dim)", marginTop: 4 }}>GPS: {dataGps}</p>
  )}
</div>
```

- [ ] **Step 3: Passar `empresa` no `PainelCentral`**

No `PainelCentral`, calcular o nome do cliente ativo antes do return:

```tsx
const empresaNome = clientes.find((c) => c.id === clienteAtivoId)?.nome;
```

E no `<PainelVeiculoAlerta ... />`, adicionar a prop:

```tsx
empresa={empresaNome}
```

- [ ] **Step 4: Compilar e rodar testes**

```bash
npx tsc --noEmit
npx vitest run
```
Esperado: limpo, 256 testes.

- [ ] **Step 5: Validação visual**

Logar via QA, clicar num veículo e conferir o bloco de localização (coordenadas + link + Data GPS)
e a empresa.

- [ ] **Step 6: Commit**

```bash
git add "src/app/(app)/components/PainelVeiculoAlerta.tsx" "src/app/(app)/components/PainelCentral.tsx"
git commit -m "feat: painel do veiculo mostra empresa, coordenadas e data do GPS"
```

---

### Task 5: Validação final e push

**Files:** nenhum novo.

- [ ] **Step 1: Suíte completa**

```bash
npx vitest run
npx tsc --noEmit
npx next build
```
Esperado: 256 testes, tsc limpo, build limpo.

- [ ] **Step 2: Checklist visual (Chrome headless logado)**

1. Toggle Operação mostra a barra do Unitrac (árvore de veículos com checkbox, período, rastro).
2. Marcar/desmarcar veículo na árvore liga/desliga o marcador no mapa.
3. Selecionar veículo desenha rastro (linha ciano) e pontos de entrega numerados.
4. Toggle Alertas volta para a coluna de alertas (segmented + grupos por tipo).
5. Clicar num ponto de entrega mostra o popup com situação, ID, documento, hora prevista/realizada.
6. Clicar num veículo abre o painel com empresa, coordenadas e Data GPS.

- [ ] **Step 3: Push**

```bash
git push origin main
```

- [ ] **Step 4: Limpeza do QA**

Remover o usuário QA temporário do Supabase e parar o dev server local.

---

## Self-Review

**Cobertura do spec:**
- Toggle Operação | Alertas → Task 1. ✓
- Barra do Unitrac religada via `mostrarSidebar` → Task 1. ✓
- Link de cliente corrigido → Task 2. ✓
- Popup do ponto de entrega enriquecido → Task 3. ✓
- Painel do veículo enriquecido → Task 4. ✓
- Validação visual + push → Task 5. ✓
- Fora de escopo (áreas/pontos editáveis, pânico/mensagem, detector) → não há task, correto.

**Placeholders:** nenhum; todo passo tem código real e campos confirmados na API.

**Consistência de tipos:** `PontoEntrega` (lib) e `PontoEntregaUI` (MapaMonitor) recebem os mesmos
seis campos novos; o popup só lê esses campos. `empresa?: string` é opcional e passado de `PainelCentral`.
