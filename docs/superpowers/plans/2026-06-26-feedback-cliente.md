# Feedback Cliente — Transmonseg Central: 5 correções

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Corrigir os 5 problemas reportados pela operadora da Transmonseg nos vídeos de 26/06/2026.

**Architecture:** Todos os bugs vivem no client (`PainelCentral`, `CardAlertaCritico`, `AcoesAlerta`, `MapaMonitor`). Nenhuma mudança de banco nem de API é necessária.

**Tech Stack:** Next.js 16 App Router, React, React-Leaflet 5, Supabase (auth + alertas), Unitrac datalayer REST

## Global Constraints

- Zero novas dependências npm
- `npx tsc --noEmit` deve passar sem erros antes de cada commit
- `npm test -- --run` (Vitest) deve passar (254 testes atualmente)
- Não mexer em `src/lib/detectores.ts` nem em rotas de API — bugs são todos no frontend
- Todos os arquivos editados ficam em `src/app/(app)/components/` ou `src/app/(app)/acoes-alertas.ts`

---

## Contexto dos bugs (testado visualmente com puppeteer 26/06/2026)

| # | Bug | Confirmação |
|---|---|---|
| 1 | Resolver alerta: grava no banco mas **fica na tela por até 15s** (próximo poll) | Código: `AcoesAlerta` não tem callback; PainelCentral não sabe que resolveu |
| 2 | Toast de crítico novo: **pequeno, fica no centro, some em 8s** | Screenshot 03: sobrepõe o toggle Operação/Alertas |
| 3 | Busca por placa no modo Operação: **filtra a lista mas mapa não move** | Screenshots 06/07: digita "AKZ", lista filtra, mapa fica parado |
| 4 | Alerta crítico novo: **operadora tem que clicar no carro para ver a rota** | Vídeo 09:27: "quando vem o alerta eu teria que clicar no carro" |
| 5 | Após resolver: **painel do veículo fica aberto, não volta para o mapa geral** | Vídeo 09:27: "ele viu que não é nada, ele resolve e voltaria para um mapa geral" |

---

## Mapa de arquivos

| Arquivo | O que muda |
|---|---|
| `src/app/(app)/components/AcoesAlerta.tsx` | Add prop `onSucesso?: (id: string) => void`; chamar no resolve e falso positivo |
| `src/app/(app)/components/CardAlertaCritico.tsx` | Add prop `onAlertaResolvido?: (id: string) => void`; repassar ao AcoesAlerta |
| `src/app/(app)/components/PainelCentral.tsx` | (1) callback remove alerta + fecha painel; (2) toast maior/canto/15s; (4) auto-abrir painel ao novo crítico |
| `src/app/(app)/components/MapaMonitor.tsx` | (3) flyTo quando busca retorna 1 veículo |

---

## Task 1: Resolver/Falso positivo → alerta some na hora + painel fecha

**Problema:** `AcoesAlerta` executa o server action mas não tem como avisar o pai. `PainelCentral` só descobre no próximo poll (15s). Após fechar, `veiculoPanel` permanece aberto.

**Files:**
- Modify: `src/app/(app)/components/AcoesAlerta.tsx`
- Modify: `src/app/(app)/components/CardAlertaCritico.tsx`
- Modify: `src/app/(app)/components/PainelCentral.tsx`

**Interfaces:**
- Produz: `AcoesAlerta` aceita `onSucesso?: (id: string) => void`; chama após resolve/falso positivo bem-sucedido
- Produz: `CardAlertaCritico` aceita `onAlertaResolvido?: (id: string) => void`; repassa ao `AcoesAlerta`
- Produz: `PainelCentral` passa callback que remove o id de `alertas` e fecha `veiculoPanel` se o cv bater

- [ ] **Step 1: Adicionar prop `onSucesso` ao AcoesAlerta**

Em `src/app/(app)/components/AcoesAlerta.tsx`, mudar a assinatura e o `exec`:

```tsx
export default function AcoesAlerta({
  id,
  status,
  desde,
  onSucesso,
}: {
  id: string;
  status: string;
  desde: string;
  onSucesso?: (id: string) => void;
}) {
  const [pending, start] = useTransition();
  const [erro, setErro] = useState<string | null>(null);
  const reconhecido = status === "reconhecido";

  const exec = (fn: Acao, chamarSucesso = false) =>
    start(async () => {
      setErro(null);
      const r = await fn(id);
      if (r?.erro) { setErro(r.erro); return; }
      if (chamarSucesso) onSucesso?.(id);
    });
```

Nos botões Resolver e Falso positivo, passar `true` como segundo arg:

```tsx
<Btn onClick={() => exec(resolverAlerta, true)} ...>Resolver</Btn>
<Btn onClick={() => exec(marcarFalsoPositivo, true)} ...>Falso positivo</Btn>
```

Reconhecer fica com `exec(reconhecerAlerta)` sem o flag (não remove — só muda status).

- [ ] **Step 2: Adicionar prop `onAlertaResolvido` ao CardAlertaCritico**

Em `src/app/(app)/components/CardAlertaCritico.tsx`, adicionar `onAlertaResolvido` à interface e repassar:

```tsx
// Na interface CardAlertaProps (linha ~134):
onAlertaResolvido?: (id: string) => void;

// No corpo do componente, onde renderiza AcoesAlerta:
<AcoesAlerta
  id={id}
  status={status}
  desde={desde}
  onSucesso={onAlertaResolvido}
/>
```

- [ ] **Step 3: Callback em PainelCentral — remove do estado e fecha painel**

Em `src/app/(app)/components/PainelCentral.tsx`, criar o callback e passar a todos os `CardAlertaCritico`:

```tsx
// Dentro do componente, próximo aos outros useCallback:
const onAlertaResolvido = useCallback((id: string) => {
  setAlertas((prev) => prev.filter((a) => a.id !== id));
  // Fechar painel do veículo se o alerta era desse veículo
  const alerta = alertas.find((a) => a.id === id);
  if (alerta && veiculoPanel?.cv === alerta.cv) {
    setVeiculoPanel(null);
  }
}, [alertas, veiculoPanel]);
```

Em cada `<CardAlertaCritico ... />` dentro do mapa de grupos, adicionar:

```tsx
<CardAlertaCritico
  ...
  onAlertaResolvido={onAlertaResolvido}
/>
```

- [ ] **Step 4: Verificar TypeScript**

```bash
cd transmonseg-central && npx tsc --noEmit
```

Esperado: 0 erros.

- [ ] **Step 5: Testar manualmente**

Rodar `npm run dev`, logar, clicar Resolver em qualquer alerta da sidebar → alerta deve desaparecer imediatamente sem aguardar 15s.

- [ ] **Step 6: Commit**

```bash
git add src/app/\(app\)/components/AcoesAlerta.tsx \
        src/app/\(app\)/components/CardAlertaCritico.tsx \
        src/app/\(app\)/components/PainelCentral.tsx
git commit -m "fix: resolver alerta some na hora (optimistic update + fecha painel)"
```

---

## Task 2: Toast de alerta crítico — maior, canto inferior direito, 15s, com botão fechar

**Problema:** O toast de novo crítico fica no centro do mapa em cima do toggle Operação/Alertas, é pequeno e some em 8s (rápido demais para a operadora ler).

**Files:**
- Modify: `src/app/(app)/components/PainelCentral.tsx`

- [ ] **Step 1: Aumentar duração para 15s**

```tsx
// Procurar o useEffect do toast (atualmente `setTimeout(..., 8000)`)
// Mudar para:
const id = setTimeout(() => setToast(null), 15000);
```

- [ ] **Step 2: Reposicionar para canto inferior direito e aumentar tamanho**

Localizar o JSX do toast (bloco com `position: "absolute"`, `top: 12`, `left: "50%"`).

Substituir por:

```tsx
{toast && (
  <div
    style={{
      position: "absolute",
      bottom: 20,
      right: 16,
      zIndex: 1002,
      display: "flex",
      alignItems: "flex-start",
      gap: 12,
      padding: "0.875rem 1.125rem",
      borderRadius: 12,
      cursor: "default",
      backgroundColor: "rgba(16,3,3,0.97)",
      border: "1px solid var(--vermelho, #ef4444)",
      boxShadow: "0 12px 40px rgba(0,0,0,0.8), 0 0 0 1px rgba(239,68,68,0.2)",
      backdropFilter: "blur(10px)",
      minWidth: 260,
      maxWidth: 340,
      animation: "pulse-live 1.5s ease-in-out infinite",
    }}
  >
    {/* Ponto piscante */}
    <span
      style={{
        width: 10,
        height: 10,
        borderRadius: "50%",
        backgroundColor: "var(--vermelho, #ef4444)",
        flexShrink: 0,
        marginTop: 3,
      }}
    />
    {/* Conteúdo */}
    <div style={{ flex: 1, minWidth: 0 }}>
      <p style={{ fontSize: 13, fontWeight: 800, color: "var(--vermelho, #ef4444)", letterSpacing: "0.05em" }}>
        NOVO CRÍTICO
      </p>
      <p style={{ fontSize: 15, fontWeight: 700, color: "var(--text)", marginTop: 2 }}>
        {toast.placa}
      </p>
      <p style={{ fontSize: 12, color: "var(--text-muted)", marginTop: 2 }}>
        {nomeTipo(chaveTipo(toast.tipo))}
      </p>
    </div>
    {/* Fechar */}
    <button
      onClick={() => setToast(null)}
      style={{
        background: "none",
        border: "none",
        cursor: "pointer",
        color: "var(--text-dim)",
        padding: 2,
        flexShrink: 0,
      }}
      title="Fechar"
    >
      <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round">
        <line x1="18" y1="6" x2="6" y2="18" /><line x1="6" y1="6" x2="18" y2="18" />
      </svg>
    </button>
  </div>
)}
```

- [ ] **Step 3: Verificar TypeScript**

```bash
npx tsc --noEmit
```

- [ ] **Step 4: Commit**

```bash
git add src/app/\(app\)/components/PainelCentral.tsx
git commit -m "fix: toast de critico maior, canto inferior direito, 15s, botao fechar"
```

---

## Task 3: Busca por placa centraliza no mapa

**Problema:** No modo Operação, o campo `busca` filtra os veículos na sidebar mas o mapa não se move. A operadora digita a placa e precisa achar o veículo na mão.

**Files:**
- Modify: `src/app/(app)/components/MapaMonitor.tsx`

**Contexto do código:**
- `busca` é um `useState<string>("")` no MapaMonitor
- `veiculosFiltrados` = grupos filtrados pelo `busca`; a lista da sidebar mostra esses
- `flyParaVeiculo` é o estado criado na Task anterior deste PR (já existe no arquivo)
- `veiculosMapa` tem `lat/lng` de cada veículo

- [ ] **Step 1: Adicionar efeito de flyTo quando busca filtra para 1 resultado**

Localizar o bloco de `veiculosFiltrados` (perto de onde `busca` é usado) e adicionar logo após:

```tsx
// Quando busca filtra exatamente 1 veiculo, voa para ele no mapa
useEffect(() => {
  if (!busca.trim()) return;
  // Juntar todos os veiculos de todos os grupos filtrados
  const todosFiltr = gruposFiltrados.flatMap((g) => g.veiculos);
  if (todosFiltr.length !== 1) return;
  const cv = todosFiltr[0].cv;
  const vm = veiculosMapa.find((v) => v.cv === cv);
  if (vm?.lat != null && vm?.lng != null) {
    setFlyParaVeiculo({ lat: vm.lat, lng: vm.lng, gatilho: Date.now() });
  }
}, [busca, gruposFiltrados, veiculosMapa]);
```

> **Nota:** `gruposFiltrados` é o nome da variável que filtra os grupos pela `busca`. Encontre o nome correto no arquivo antes de aplicar — pode ser `gruposFiltradosPorBusca` ou similar. Grep: `busca.toLowerCase()` no MapaMonitor.tsx.

- [ ] **Step 2: Verificar TypeScript**

```bash
npx tsc --noEmit
```

- [ ] **Step 3: Testar manualmente**

No modo Operação, digitar uma placa que existe (ex: "AKZ-2745") → mapa deve voar para o veículo.

- [ ] **Step 4: Commit**

```bash
git add src/app/\(app\)/components/MapaMonitor.tsx
git commit -m "fix: busca por placa centraliza mapa quando 1 resultado"
```

---

## Task 4: Alerta crítico novo → auto-abrir painel do veículo no mapa

**Problema:** Quando chega um alerta crítico novo, a operadora precisa clicar no carro para ver a rota e os pontos de entrega. O ideal: o painel do veículo abre sozinho com a rota já visível, para ela decidir se é falso positivo sem cliques extras. Após resolver, o painel fecha.

**Fluxo desejado (do vídeo da cliente):**
1. Novo crítico chega → mapa já voa para o veículo (já funciona via `flyParaAlerta`)
2. **Novo:** painel do veículo abre automaticamente mostrando rota + alvos
3. Operadora decide em segundos: se não é nada, clica "Falso positivo"
4. Alerta some + painel fecha + mapa volta à visão geral (Task 1 já cobre os últimos 2 pontos)

**Files:**
- Modify: `src/app/(app)/components/PainelCentral.tsx`

- [ ] **Step 1: Auto-abrir veiculoPanel quando novo crítico chega**

Em `PainelCentral.tsx`, dentro do `atualizarAlertas` useCallback, no bloco onde detecta alerta novo (`!vistosRef.current.has(a.id)`), adicionar abertura do painel:

```tsx
for (const a of novos) {
  if (a.nivel === "critico" && !vistosRef.current.has(a.id)) {
    if (a.lat != null && a.lng != null) {
      setFlyParaAlerta({ lat: a.lat, lng: a.lng, gatilho: Date.now() });
    }
    setToast({ placa: a.placa, tipo: a.tipo, id: a.id });
    // AUTO-ABRIR painel do veículo com alerta novo
    setVeiculoPanel({ cv: a.cv, placa: a.placa });
    if (typeof Notification !== "undefined" && Notification.permission === "granted") {
      new Notification(`Crítico: ${a.placa}`, {
        body: `${nomeTipo(chaveTipo(a.tipo))}${a.local ? " · " + a.local : ""}`,
        tag: a.id,
      });
    }
  }
  vistosRef.current.add(a.id);
}
```

**Cuidado:** se houver múltiplos alertas novos no mesmo ciclo de poll, apenas o último abriria o painel (cada iteração sobrescreve `veiculoPanel`). Para evitar isso, abrir somente o primeiro novo crítico:

```tsx
let painelAberto = false;
for (const a of novos) {
  if (a.nivel === "critico" && !vistosRef.current.has(a.id)) {
    if (a.lat != null && a.lng != null) {
      setFlyParaAlerta({ lat: a.lat, lng: a.lng, gatilho: Date.now() });
    }
    setToast({ placa: a.placa, tipo: a.tipo, id: a.id });
    if (!painelAberto) {
      setVeiculoPanel({ cv: a.cv, placa: a.placa });
      painelAberto = true;
    }
    if (typeof Notification !== "undefined" && Notification.permission === "granted") {
      new Notification(`Crítico: ${a.placa}`, {
        body: `${nomeTipo(chaveTipo(a.tipo))}${a.local ? " · " + a.local : ""}`,
        tag: a.id,
      });
    }
  }
  vistosRef.current.add(a.id);
}
```

- [ ] **Step 2: Verificar TypeScript**

```bash
npx tsc --noEmit
```

- [ ] **Step 3: Verificar testes**

```bash
npm test -- --run
```

Esperado: 254 testes passando.

- [ ] **Step 4: Commit**

```bash
git add src/app/\(app\)/components/PainelCentral.tsx
git commit -m "feat: alerta critico auto-abre painel do veiculo"
```

---

## Task 5: Push e verificação visual final

- [ ] **Step 1: Push**

```bash
git push origin main
```

- [ ] **Step 2: Verificação visual (puppeteer)**

Criar `_qa_check.mjs` na raiz (deletar após verificar — não commitar):

```js
import puppeteer from "puppeteer-core";
const CHROME = "C:/Program Files/Google/Chrome/Application/chrome.exe";
const browser = await puppeteer.launch({
  executablePath: CHROME, headless: true,
  args: ["--no-sandbox"], defaultViewport: { width: 1400, height: 900 },
});
const page = await browser.newPage();
// 1. Login
await page.goto("http://localhost:3000/login", { waitUntil: "domcontentloaded", timeout: 30000 });
await page.waitForSelector("#email");
await page.type("#email", "qa-claude@transmonseg.local");
await page.type("#senha", "Qa2026!Transmonseg");
await page.evaluate(() => document.querySelector("form").requestSubmit());
await page.waitForNavigation({ waitUntil: "domcontentloaded", timeout: 20000 });
await new Promise(r => setTimeout(r, 4000));
// 2. Verificar toast no canto inferior direito (não no centro)
const toastPos = await page.evaluate(() => {
  const t = document.querySelector('[style*="bottom: 20"]');
  return t ? t.getBoundingClientRect() : null;
});
console.log("Toast no canto?", toastPos ? `bottom=${toastPos.bottom}, right=${window.innerWidth - toastPos.right}` : "sem toast visivel");
// 3. Screenshot
await page.screenshot({ path: "C:/Users/media/AppData/Local/Temp/claude/C--Users-media/1444cb8b-fbd9-4e42-bc57-e45b177a599c/scratchpad/qa_final.png" });
await browser.close();
console.log("DONE");
```

Criar o QA user antes de rodar:
```bash
# Criar user QA (mesmo comando usado anteriormente com curl + service_role JWT)
node _qa_check.mjs
```

Verificar no screenshot:
- Toast de crítico no **canto inferior direito**, não no centro
- Sidebar de alertas com cards e botões Resolver
- Toggle Operação/Alertas visível e sem sobreposição

Deletar `_qa_check.mjs` após verificar.

- [ ] **Step 3: Fechar server**

```bash
# Matar processo do dev server se rodando:
kill $(lsof -ti:3000) 2>/dev/null || true
```

---

## Self-review

| Requisito | Coberto? |
|---|---|
| Resolver some imediatamente | Task 1 — optimistic update via `onSucesso` |
| Após resolver, painel fecha | Task 1 — callback verifica `veiculoPanel.cv === alerta.cv` |
| Toast maior, canto, 15s, fechar | Task 2 — JSX substituído completo |
| Busca por placa centraliza | Task 3 — `useEffect` em `MapaMonitor` |
| Alerta crítico abre painel sozinho | Task 4 — dentro do loop de `atualizarAlertas` |
| tsc limpo | Verificado em cada task |
| Testes passando | Task 4 Step 3 |
| Nenhuma nova dep | Nenhuma adicionada |
