# Melhorias Transmonseg Central: Detectores, UX Operacional e Heatmap

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Adicionar 2 detectores novos no motor, SLA timer GR0/GR1/GR2, score badge nos alertas, filtro de turno e heatmap de incidentes no mapa.

**Architecture:** Fase 1 é pura lib (detectores.ts + testes). Fase 2 é frontend sem novo dado de banco, exceto `score` no SELECT existente. Fase 3 adiciona uma query a /api/mapa e um layer no mapa client.

**Tech Stack:** Next.js 16 App Router, Supabase (service_role), PostGIS, React-Leaflet, Vitest (testes: `npm test`), TypeScript (`npx tsc --noEmit`)

## Global Constraints

- Free tier only: nenhuma dependencia paga ou plano pago
- Repo publico: nenhum secret inline; nenhum `.env.local` commitado
- Nunca usar travessao (—) em texto de interface; so em roteiros
- Portugues com acentos e cedilha em todo texto de interface
- Commits assinados: `Co-Authored-By: Claude Sonnet 4.6 <noreply@anthropic.com>`
- TypeScript estrito: `npx tsc --noEmit` deve passar sem erros apos cada tarefa
- Testes: `npm test` deve passar apos cada tarefa que toca `detectores.ts`

---

## Mapa de Arquivos

| Arquivo | Tarefa | Acao |
|---|---|---|
| `src/lib/detectores.ts` | 1, 2 | Adicionar 2 funcoes + modificar `avaliar()` |
| `src/lib/detectores.test.ts` | 1, 2 | Adicionar testes Vitest |
| `src/app/(app)/components/FiltrosBar.tsx` | 2, 5 | 2 chips de tipo + chip de turno |
| `src/app/(app)/components/CronometroSLA.tsx` | 3 | CRIAR — client component |
| `src/app/(app)/components/AcoesAlerta.tsx` | 3 | Adicionar prop `desde` + injetar CronometroSLA |
| `src/app/(app)/page.tsx` | 3, 4, 5 | Passar `desde` ao AcoesAlerta; add `score`; filtro turno |
| `src/app/api/mapa/route.ts` | 6 | Adicionar query `alertas_geo` ao retorno |
| `src/app/(app)/components/MapaMonitor.tsx` | 6 | Layer heatmap via CircleMarker |

---

## Task 1: Detector de ignição fora da janela operacional

**Files:**
- Modify: `src/lib/detectores.ts` — nova funcao `detectarIgnicaoForaJanela` + chamada em `avaliar()`
- Modify: `src/lib/detectores.test.ts` — testes do novo detector

**Interfaces:**
- Produz: `detectarIgnicaoForaJanela(p: PosicaoNormalizada, emOperacao: boolean): Alerta | null`
- Exportado junto com os outros detectores; usado dentro de `avaliar()`

- [ ] **Step 1: Escrever os testes primeiro (TDD)**

Abrir `src/lib/detectores.test.ts`. Adicionar ao final do arquivo (antes do ultimo `}` se houver, ou simplesmente ao final):

```typescript
describe("detectarIgnicaoForaJanela", () => {
  it("ignicao ligada fora do horario de operacao retorna critico ignicao_noturna", () => {
    const a = detectarIgnicaoForaJanela(posicaoBase({ ignicao: true, fresco: true }), false);
    expect(a).not.toBeNull();
    expect(a?.nivel).toBe("critico");
    expect(a?.tipo).toBe("ignicao_noturna");
    expect(a?.score).toBe(85);
  });
  it("ignicao desligada fora do horario retorna null", () => {
    expect(detectarIgnicaoForaJanela(posicaoBase({ ignicao: false, fresco: true }), false)).toBeNull();
  });
  it("ignicao ligada DENTRO do horario retorna null", () => {
    expect(detectarIgnicaoForaJanela(posicaoBase({ ignicao: true, fresco: true }), true)).toBeNull();
  });
  it("posicao nao fresca retorna null (dado congelado nao e sinal de movimento)", () => {
    expect(detectarIgnicaoForaJanela(posicaoBase({ ignicao: true, fresco: false }), false)).toBeNull();
  });
});
```

Adicionar `detectarIgnicaoForaJanela` no import no topo do arquivo de teste:
```typescript
import {
  detectarPanico,
  detectarBau,
  detectarJammer,
  detectarExcessoVelocidade,
  detectarParadaCliente,
  detectarParadaLonga,
  detectarDesvio,
  detectarTiroteioProximo,
  detectarIgnicaoForaJanela,   // <- adicionar
  detectarSaidaNaoAutorizada,   // <- adicionar (para Task 2, ja deixa aqui)
  foraDeRota,
  avaliar,
  formataDuracao,
  emHorarioOperacao,
} from "./detectores";
```

- [ ] **Step 2: Rodar os testes para confirmar que falham**

```
npm test
```

Esperado: FAIL em `detectarIgnicaoForaJanela is not a function` (e tambem em detectarSaidaNaoAutorizada — normal, vira na Task 2).

- [ ] **Step 3: Implementar a funcao em detectores.ts**

Abrir `src/lib/detectores.ts`. Adicionar a funcao logo apos `detectarJammer` (linha ~63):

```typescript
export function detectarIgnicaoForaJanela(
  p: PosicaoNormalizada,
  emOperacao: boolean
): Alerta | null {
  if (!p.fresco || !p.ignicao || emOperacao) return null;
  return {
    nivel: "critico",
    tipo: "ignicao_noturna",
    motivo: "Motor ligado fora do horario de operacao (possivel movimentacao nao autorizada)",
    score: 85,
  };
}
```

Adicionar a chamada dentro de `avaliar()`, no array `candidatos` (logo apos `detectarJammer(p),`):

```typescript
detectarIgnicaoForaJanela(p, ctx.emOperacao),
```

A linha de `detectarJammer(p)` esta por volta de linha 345 em `avaliar()`. Inserir logo depois.

- [ ] **Step 4: Rodar os testes e confirmar que passam (exceto detectarSaidaNaoAutorizada)**

```
npm test
```

Esperado: todos os testes de `detectarIgnicaoForaJanela` passam. Testes de `detectarSaidaNaoAutorizada` falham (normal — vem na Task 2).

- [ ] **Step 5: Checar TypeScript**

```
npx tsc --noEmit
```

Esperado: zero erros.

- [ ] **Step 6: Commit**

```bash
git add src/lib/detectores.ts src/lib/detectores.test.ts
git commit -m "$(cat <<'EOF'
feat(motor): detector de ignicao fora da janela operacional

Co-Authored-By: Claude Sonnet 4.6 <noreply@anthropic.com>
EOF
)"
```

---

## Task 2: Detector de saída não autorizada da base + chips na FiltrosBar

**Files:**
- Modify: `src/lib/detectores.ts` — nova funcao `detectarSaidaNaoAutorizada` + chamada em `avaliar()`
- Modify: `src/lib/detectores.test.ts` — testes
- Modify: `src/app/(app)/components/FiltrosBar.tsx` — 2 novos chips em `CHIPS_TIPO`

**Interfaces:**
- Produz: `detectarSaidaNaoAutorizada(p: PosicaoNormalizada, ctx: { foraDaBase: boolean; temPendentes: boolean; emOperacao: boolean }): Alerta | null`

- [ ] **Step 1: Adicionar testes ao arquivo de teste**

No `src/lib/detectores.test.ts`, adicionar antes do `describe("detectarDesvio"`:

```typescript
describe("detectarSaidaNaoAutorizada", () => {
  it("fora da base, sem pendentes, ignicao ligada, em operacao retorna critico", () => {
    const a = detectarSaidaNaoAutorizada(
      posicaoBase({ ignicao: true, fresco: true }),
      { foraDaBase: true, temPendentes: false, emOperacao: true }
    );
    expect(a).not.toBeNull();
    expect(a?.nivel).toBe("critico");
    expect(a?.tipo).toBe("saida_nao_autorizada");
    expect(a?.score).toBe(78);
  });
  it("com pendentes (tem rota) retorna null — nao e saida nao autorizada", () => {
    expect(
      detectarSaidaNaoAutorizada(
        posicaoBase({ ignicao: true, fresco: true }),
        { foraDaBase: true, temPendentes: true, emOperacao: true }
      )
    ).toBeNull();
  });
  it("dentro da base retorna null", () => {
    expect(
      detectarSaidaNaoAutorizada(
        posicaoBase({ ignicao: true, fresco: true }),
        { foraDaBase: false, temPendentes: false, emOperacao: true }
      )
    ).toBeNull();
  });
  it("ignicao desligada retorna null", () => {
    expect(
      detectarSaidaNaoAutorizada(
        posicaoBase({ ignicao: false, fresco: true }),
        { foraDaBase: true, temPendentes: false, emOperacao: true }
      )
    ).toBeNull();
  });
  it("fora de operacao retorna null", () => {
    expect(
      detectarSaidaNaoAutorizada(
        posicaoBase({ ignicao: true, fresco: true }),
        { foraDaBase: true, temPendentes: false, emOperacao: false }
      )
    ).toBeNull();
  });
  it("posicao nao fresca retorna null", () => {
    expect(
      detectarSaidaNaoAutorizada(
        posicaoBase({ ignicao: true, fresco: false }),
        { foraDaBase: true, temPendentes: false, emOperacao: true }
      )
    ).toBeNull();
  });
});
```

- [ ] **Step 2: Implementar a funcao em detectores.ts**

Adicionar apos `detectarIgnicaoForaJanela`:

```typescript
export function detectarSaidaNaoAutorizada(
  p: PosicaoNormalizada,
  ctx: { foraDaBase: boolean; temPendentes: boolean; emOperacao: boolean }
): Alerta | null {
  if (!p.fresco || !p.ignicao) return null;
  if (!ctx.foraDaBase || ctx.temPendentes || !ctx.emOperacao) return null;
  return {
    nivel: "critico",
    tipo: "saida_nao_autorizada",
    motivo: "Veiculo saiu da base sem entregas programadas",
    score: 78,
  };
}
```

Adicionar no array `candidatos` dentro de `avaliar()`, logo apos a linha de `detectarIgnicaoForaJanela`:

```typescript
detectarSaidaNaoAutorizada(p, {
  foraDaBase: ctx.foraDaBase,
  temPendentes: ctx.temPendentes ?? false,
  emOperacao: ctx.emOperacao,
}),
```

- [ ] **Step 3: Rodar os testes e confirmar que todos passam**

```
npm test
```

Esperado: todos os testes passam incluindo os dois novos detectores.

- [ ] **Step 4: Adicionar os 2 chips em FiltrosBar.tsx**

Abrir `src/app/(app)/components/FiltrosBar.tsx`. Encontrar o array `CHIPS_TIPO` (linha ~28). Adicionar as duas entradas ao final do array (antes do `];`):

```typescript
  { label: "Ignicao fora", tipos: ["ignicao_noturna"],      cor: "#7c3aed" },
  { label: "Saida base",   tipos: ["saida_nao_autorizada"],  cor: "#0891b2" },
```

O array completo ficara:
```typescript
const CHIPS_TIPO: ChipTipo[] = [
  { label: "Panico",         tipos: ["panico"],                        cor: "#ef4444" },
  { label: "Bau",            tipos: ["bau"],                           cor: "#f97316" },
  { label: "Favela",         tipos: ["favela"],                        cor: "#dc2626" },
  { label: "Tiroteio",       tipos: ["tiroteio"],                      cor: "#b91c1c" },
  { label: "Desvio",         tipos: ["desvio"],                        cor: "#f59e0b" },
  { label: "Parada cliente", tipos: ["parada_cliente"],                 cor: "#3b82f6" },
  { label: "Parada anomala", tipos: ["parada_anomala"],                 cor: "#f97316" },
  { label: "Parada longa",   tipos: ["parada_longa"],                   cor: "#64748b" },
  { label: "Jammer/Sinal",   tipos: ["jammer", "sinal", "bloqueio"],   cor: "#a855f7" },
  { label: "Excesso",        tipos: ["excesso"],                        cor: "#ea580c" },
  { label: "Ignicao fora",   tipos: ["ignicao_noturna"],                cor: "#7c3aed" },
  { label: "Saida base",     tipos: ["saida_nao_autorizada"],           cor: "#0891b2" },
];
```

- [ ] **Step 5: Checar TypeScript**

```
npx tsc --noEmit
```

Esperado: zero erros.

- [ ] **Step 6: Commit**

```bash
git add src/lib/detectores.ts src/lib/detectores.test.ts src/app/\(app\)/components/FiltrosBar.tsx
git commit -m "$(cat <<'EOF'
feat(motor): detector de saida nao autorizada da base + chips na FiltrosBar

Co-Authored-By: Claude Sonnet 4.6 <noreply@anthropic.com>
EOF
)"
```

---

## Task 3: Cronômetro SLA GR0/GR1/GR2 nos cards de alerta

**Files:**
- Create: `src/app/(app)/components/CronometroSLA.tsx`
- Modify: `src/app/(app)/components/AcoesAlerta.tsx` — adicionar prop `desde` + injetar componente
- Modify: `src/app/(app)/page.tsx` — passar `desde` para `AcoesAlerta` em `CardAlertaCritico`

**Interfaces:**
- `CronometroSLA({ desde: string }): JSX.Element` — client component
- `AcoesAlerta({ id: string; status: string; desde: string })` — adiciona `desde` a props existentes

- [ ] **Step 1: Criar CronometroSLA.tsx**

Criar arquivo `src/app/(app)/components/CronometroSLA.tsx`:

```typescript
"use client";

import { useEffect, useState } from "react";

function minutosDecorridos(desde: string): number {
  return Math.floor((Date.now() - new Date(desde).getTime()) / 60000);
}

export default function CronometroSLA({ desde }: { desde: string }) {
  const [minutos, setMinutos] = useState(() => minutosDecorridos(desde));

  useEffect(() => {
    const id = setInterval(() => setMinutos(minutosDecorridos(desde)), 30_000);
    return () => clearInterval(id);
  }, [desde]);

  let label: string;
  let cor: string;
  let pulsar = false;

  if (minutos < 5) {
    label = `GR0 · ${minutos}min`;
    cor = "#64748b";
  } else if (minutos < 15) {
    label = `GR1 · ${minutos}min · Escalar supervisor`;
    cor = "#f97316";
  } else {
    label = `GR2 · ${minutos}min · Escalar cliente`;
    cor = "#ef4444";
    pulsar = true;
  }

  return (
    <span
      className={pulsar ? "animate-pulse" : ""}
      style={{
        display: "inline-flex",
        alignItems: "center",
        gap: 4,
        fontSize: 10,
        fontWeight: 700,
        padding: "2px 7px",
        borderRadius: 6,
        backgroundColor: cor + "18",
        border: `1px solid ${cor}44`,
        color: cor,
        fontFamily: "var(--font-geist-mono, monospace)",
        letterSpacing: "0.04em",
      }}
    >
      {label}
    </span>
  );
}
```

- [ ] **Step 2: Modificar AcoesAlerta.tsx para receber `desde` e injetar CronometroSLA**

Abrir `src/app/(app)/components/AcoesAlerta.tsx`.

Adicionar import no topo (apos o import existente):
```typescript
import CronometroSLA from "./CronometroSLA";
```

Alterar a assinatura do componente de:
```typescript
export default function AcoesAlerta({ id, status }: { id: string; status: string }) {
```
Para:
```typescript
export default function AcoesAlerta({ id, status, desde }: { id: string; status: string; desde: string }) {
```

Adicionar `<CronometroSLA desde={desde} />` logo antes do `<div className="mt-4 pt-3.5"...>`, ou seja, logo apos a abertura do return:

```typescript
  return (
    <div className="mt-4 pt-3.5" style={{ borderTop: "1px solid var(--border-subtle)" }}>
      <div className="mb-2.5">
        <CronometroSLA desde={desde} />
      </div>
      {reconhecido && (
```

- [ ] **Step 3: Atualizar a chamada de AcoesAlerta em page.tsx**

Abrir `src/app/(app)/page.tsx`. Encontrar a linha (dentro de `CardAlertaCritico`, por volta da linha 632):
```typescript
        <AcoesAlerta id={id} status={status} />
```
Alterar para:
```typescript
        <AcoesAlerta id={id} status={status} desde={desde} />
```

- [ ] **Step 4: Checar TypeScript**

```
npx tsc --noEmit
```

Esperado: zero erros.

- [ ] **Step 5: Verificar visualmente**

Iniciar o dev server (`npm run dev`), abrir `/` com um alerta ativo. O badge GR0/GR1/GR2 deve aparecer acima dos botoes de acao no card de alerta.

- [ ] **Step 6: Commit**

```bash
git add src/app/\(app\)/components/CronometroSLA.tsx \
        src/app/\(app\)/components/AcoesAlerta.tsx \
        src/app/\(app\)/page.tsx
git commit -m "$(cat <<'EOF'
feat(ux): cronometro SLA GR0/GR1/GR2 nos cards de alerta

Co-Authored-By: Claude Sonnet 4.6 <noreply@anthropic.com>
EOF
)"
```

---

## Task 4: Score badge nos cards de alerta

**Files:**
- Modify: `src/app/(app)/page.tsx` — adicionar `score` ao SELECT + interface + prop + render

**Interfaces:**
- `Alerta.score: number | null` — campo adicionado a interface existente
- `CardAlertaCritico` ganha prop `score?: number | null`

- [ ] **Step 1: Adicionar `score` ao SELECT de alertas**

Abrir `src/app/(app)/page.tsx`. Encontrar a query de alertas (linha ~804):
```typescript
      .select("id, cliente_id, veiculo_id, nivel, tipo, motivo, desde, status")
```
Alterar para:
```typescript
      .select("id, cliente_id, veiculo_id, nivel, tipo, motivo, desde, status, score")
```

- [ ] **Step 2: Adicionar `score` a interface Alerta**

Ainda em `page.tsx`, encontrar a interface `Alerta` (linha ~62):
```typescript
interface Alerta {
  id: string;
  cliente_id: string;
  veiculo_id: string;
  nivel: "critico" | "atencao";
  tipo: string;
  motivo: string | null;
  desde: string;
  status: string;
}
```
Adicionar `score: number | null;` antes do fechamento:
```typescript
interface Alerta {
  id: string;
  cliente_id: string;
  veiculo_id: string;
  nivel: "critico" | "atencao";
  tipo: string;
  motivo: string | null;
  desde: string;
  status: string;
  score: number | null;
}
```

- [ ] **Step 3: Adicionar `score` as props de CardAlertaCritico**

Encontrar a assinatura de `CardAlertaCritico` (linha ~442). Adicionar `score?: number | null` a lista de props desestruturadas e ao bloco de tipos:

```typescript
function CardAlertaCritico({
  id,
  status,
  nivel,
  tipo,
  placa,
  motivo,
  local,
  desde,
  lat,
  lng,
  velocidade,
  ignicao,
  atraso_min,
  score,          // <- adicionar
}: {
  id: string;
  status: string;
  nivel: "critico" | "atencao";
  tipo: string;
  placa: string;
  motivo: string | null;
  local: string | null;
  desde: string;
  lat?: number | null;
  lng?: number | null;
  velocidade?: number | null;
  ignicao?: boolean | null;
  atraso_min?: number | null;
  score?: number | null;     // <- adicionar
}) {
```

- [ ] **Step 4: Renderizar o badge de score no cabecalho do card**

No corpo de `CardAlertaCritico`, encontrar o cabecalho (a `<div className="flex items-start justify-between...">` que contem o badge de tipo e o tempo). Adicionar o badge de score ao lado do badge de tipo:

```typescript
          <div className="flex items-center gap-2">
            <span
              className="inline-flex items-center gap-1.5 text-xs font-bold uppercase tracking-widest px-2 py-1 rounded-md"
              style={{
                backgroundColor: `color-mix(in srgb, ${corNivel} 12%, transparent)`,
                border: `1px solid color-mix(in srgb, ${corNivel} 25%, transparent)`,
                color: corNivel,
                letterSpacing: "0.09em",
                fontSize: "10px",
              }}
            >
              <span style={{ color: corNivel, opacity: 0.9 }}>
                <IconTipoAlerta tipo={tipo} size={10} />
              </span>
              {tipo}
            </span>
            {/* Badge de score */}
            {score != null && (
              <span
                style={{
                  fontSize: 10,
                  fontWeight: 700,
                  padding: "2px 6px",
                  borderRadius: 5,
                  backgroundColor:
                    score >= 80 ? "#ef444418" : score >= 50 ? "#f9731618" : "#f59e0b18",
                  border: `1px solid ${score >= 80 ? "#ef444444" : score >= 50 ? "#f9731644" : "#f59e0b44"}`,
                  color:
                    score >= 80 ? "#ef4444" : score >= 50 ? "#f97316" : "#f59e0b",
                  fontFamily: "var(--font-geist-mono, monospace)",
                }}
              >
                {score}
              </span>
            )}
          </div>
```

- [ ] **Step 5: Passar `score` nos dois callsites de CardAlertaCritico**

Procurar as duas ocorrencias de `<CardAlertaCritico` no arquivo (uma para criticos, outra para atencao). Adicionar `score={a.score}` em cada uma.

Primeiro callsite (alertasCriticos, linha ~1056):
```typescript
                  {alertasCriticos.map((a) => (
                    <CardAlertaCritico
                      key={a.id}
                      id={a.id}
                      status={a.status}
                      nivel={a.nivel}
                      tipo={a.tipo}
                      placa={a.placa ?? ""}
                      motivo={a.motivo}
                      local={a.local ?? null}
                      desde={a.desde}
                      lat={a.lat}
                      lng={a.lng}
                      velocidade={a.velocidade}
                      ignicao={a.ignicao}
                      atraso_min={a.atraso_min}
                      score={a.score}          // <- adicionar
                    />
                  ))}
```

Segundo callsite (alertasAtencao, linha ~1106): idem, adicionar `score={a.score}`.

Nota: `alertasCriticos` e `alertasAtencao` sao arrays de `Alerta & { placa, local, lat, lng, velocidade, ignicao, atraso_min }` — o campo `score` ja estara disponivel apos o Step 1-2.

- [ ] **Step 6: Checar TypeScript**

```
npx tsc --noEmit
```

Esperado: zero erros.

- [ ] **Step 7: Commit**

```bash
git add src/app/\(app\)/page.tsx
git commit -m "$(cat <<'EOF'
feat(ux): badge de score de risco nos cards de alerta

Co-Authored-By: Claude Sonnet 4.6 <noreply@anthropic.com>
EOF
)"
```

---

## Task 5: Filtro de turno (últimas 8h) na Central

**Files:**
- Modify: `src/app/(app)/components/FiltrosBar.tsx` — chip "Turno (8h)"
- Modify: `src/app/(app)/page.tsx` — ler `?turno=1` e filtrar query de alertas

**Interfaces:**
- URL param `turno=1` → filtra alertas com `desde >= agora - 8h`
- FiltrosBar: chip no grupo Visao (sem contagem, e toggle de perspectiva)

- [ ] **Step 1: Adicionar chip "Turno (8h)" em FiltrosBar.tsx**

Abrir `src/app/(app)/components/FiltrosBar.tsx`.

Adicionar `turno` ao estado lido da URL e ao `buildUrl`. Encontrar:
```typescript
  const tiposAtivos  = (params.get("tipos") ?? "").split(",").filter(Boolean);
  const niveisAtivos = (params.get("nivel") ?? "").split(",").filter(Boolean);
  const soProblema   = params.get("problema") === "1";
  const temFiltro    = tiposAtivos.length > 0 || niveisAtivos.length > 0 || soProblema;
```
Alterar para:
```typescript
  const tiposAtivos  = (params.get("tipos") ?? "").split(",").filter(Boolean);
  const niveisAtivos = (params.get("nivel") ?? "").split(",").filter(Boolean);
  const soProblema   = params.get("problema") === "1";
  const soTurno      = params.get("turno") === "1";
  const temFiltro    = tiposAtivos.length > 0 || niveisAtivos.length > 0 || soProblema || soTurno;
```

Atualizar `buildUrl` para incluir `turno`:
```typescript
  function buildUrl({
    tipos = tiposAtivos,
    niveis = niveisAtivos,
    problema = soProblema,
    turno = soTurno,
  }: { tipos?: string[]; niveis?: string[]; problema?: boolean; turno?: boolean } = {}) {
    const p = baseParams();
    if (tipos.length > 0)  p.set("tipos",    tipos.join(","));
    if (niveis.length > 0) p.set("nivel",    niveis.join(","));
    if (problema)          p.set("problema", "1");
    if (turno)             p.set("turno",    "1");
    return p;
  }
```

Adicionar handler:
```typescript
  function alternarTurno() {
    ir(buildUrl({ turno: !soTurno }));
  }
```

Adicionar o chip no grupo Visao (junto ao chip "So alertas", antes do bloco de Limpar):
```typescript
      <Chip
        base={base}
        style={
          soTurno
            ? {
                backgroundColor: "color-mix(in srgb, var(--accent) 12%, transparent)",
                border: "1px solid var(--accent)",
                color: "var(--accent)",
              }
            : inativo
        }
        pressed={soTurno}
        onClick={alternarTurno}
      >
        Turno (8h)
      </Chip>
```

Inserir logo antes do chip "So alertas" existente.

- [ ] **Step 2: Ler `?turno=1` em page.tsx e aplicar filtro**

Abrir `src/app/(app)/page.tsx`. Encontrar a linha de destructure de searchParams (linha ~773):
```typescript
  const { cliente: clienteParam, tipos: tiposParam, problema: problemaParam, nivel: nivelParam } = await searchParams;
```
Alterar para:
```typescript
  const { cliente: clienteParam, tipos: tiposParam, problema: problemaParam, nivel: nivelParam, turno: turnoParam } = await searchParams;
```

Logo apos a linha `const niveisAtivos = ...`, adicionar:
```typescript
  const soTurno = turnoParam === "1";
  const cutoffTurno = new Date(Date.now() - 8 * 60 * 60 * 1000).toISOString();
```

Encontrar a query de alertas (linha ~802). Alterar:
```typescript
    supabase
      .from("alertas")
      .select("id, cliente_id, veiculo_id, nivel, tipo, motivo, desde, status, score")
      .in("status", ["ativo", "reconhecido"]),
```
Para:
```typescript
    (() => {
      let q = supabase
        .from("alertas")
        .select("id, cliente_id, veiculo_id, nivel, tipo, motivo, desde, status, score")
        .in("status", ["ativo", "reconhecido"]);
      if (soTurno) q = q.gte("desde", cutoffTurno);
      return q;
    })(),
```

- [ ] **Step 3: Checar TypeScript**

```
npx tsc --noEmit
```

Esperado: zero erros.

- [ ] **Step 4: Testar manualmente**

Iniciar dev server, abrir `/`, ativar chip "Turno (8h)". A URL deve mostrar `?turno=1` e os alertas ficam restritos as ultimas 8h.

- [ ] **Step 5: Commit**

```bash
git add src/app/\(app\)/components/FiltrosBar.tsx src/app/\(app\)/page.tsx
git commit -m "$(cat <<'EOF'
feat(ux): filtro de turno (ultimas 8h) na Central

Co-Authored-By: Claude Sonnet 4.6 <noreply@anthropic.com>
EOF
)"
```

---

## Task 6: Heatmap de incidentes no mapa (30 dias)

**Files:**
- Modify: `src/app/api/mapa/route.ts` — adicionar `alertas_geo` ao retorno
- Modify: `src/app/(app)/components/MapaMonitor.tsx` — layer heatmap com CircleMarker

**Interfaces:**
- `/api/mapa` passa a retornar `alertas_geo: { lat: number; lng: number }[]`
- `MapaMonitor` le `d?.alertas_geo` do fetch e renderiza como overlay

- [ ] **Step 1: Adicionar query de alertas_geo em /api/mapa/route.ts**

Abrir `src/app/api/mapa/route.ts`. Logo apos a query de `basesRes` (antes do `return Response.json`), adicionar:

```typescript
    // Posicoes de alertas dos ultimos 30 dias — usado para o layer de calor.
    let alertasGeo: { lat: number; lng: number }[] = [];
    try {
      const alertasRes = await client.query<{ lat: number; lng: number }>(
        `SELECT lat, lng
         FROM alertas
         WHERE cliente_id = $1
           AND lat IS NOT NULL
           AND lng IS NOT NULL
           AND desde >= now() - interval '30 days'
         LIMIT 2000`,
        [clienteId]
      );
      alertasGeo = alertasRes.rows;
    } catch {
      alertasGeo = [];
    }
```

Alterar a linha de retorno de:
```typescript
    return Response.json({ veiculos, bases: basesRes.rows[0].gj, pontos: pontosEntrega });
```
Para:
```typescript
    return Response.json({ veiculos, bases: basesRes.rows[0].gj, pontos: pontosEntrega, alertas_geo: alertasGeo });
```

- [ ] **Step 2: Adicionar estado e layer de calor em MapaMonitor.tsx**

Abrir `src/app/(app)/components/MapaMonitor.tsx`.

Adicionar estado apos `const [basesGeo, setBasesGeo] = useState...` (linha ~621):
```typescript
  const [alertasGeo, setAlertasGeo] = useState<{ lat: number; lng: number }[]>([]);
```

No callback `carregarMapa` (funcao existente que chama `/api/mapa`), adicionar apos `setBasesGeo`:
```typescript
        if (Array.isArray(d?.alertas_geo)) {
          setAlertasGeo(d.alertas_geo as { lat: number; lng: number }[]);
        }
```

Dentro do `<MapContainer>`, adicionar o overlay no `<LayersControl>`, logo apos o overlay de tiroteios (antes do `{rouboCarga &&`):

```typescript
              <LayersControl.Overlay name="Calor de incidentes (30d)">
                <LayerGroup>
                  {alertasGeo.map((pt, i) => (
                    <CircleMarker
                      key={`heat${i}`}
                      center={[pt.lat, pt.lng]}
                      radius={18}
                      pathOptions={{
                        color: "transparent",
                        fillColor: "#ef4444",
                        fillOpacity: 0.07,
                      }}
                    />
                  ))}
                </LayerGroup>
              </LayersControl.Overlay>
```

Cada ponto e um circulo vermelho com 7% de opacidade e raio 18 — onde incidentes se acumulam, os circulos se sobrepoem e ficam mais intensos, criando o efeito visual de "area quente" sem nenhuma lib extra.

- [ ] **Step 3: Checar TypeScript**

```
npx tsc --noEmit
```

Esperado: zero erros.

- [ ] **Step 4: Verificar visualmente**

Abrir `/monitoramento`, abrir o controle de layers (canto superior direito), ativar "Calor de incidentes (30d)". Areas com historico de alertas devem aparecer avermelhadas.

- [ ] **Step 5: Commit e push**

```bash
git add src/app/api/mapa/route.ts src/app/\(app\)/components/MapaMonitor.tsx
git commit -m "$(cat <<'EOF'
feat(mapa): heatmap de incidentes dos ultimos 30 dias

Co-Authored-By: Claude Sonnet 4.6 <noreply@anthropic.com>
EOF
)"
git push
```

---

## Verificacao Final

Apos todas as tasks:

```
npm test
```
Esperado: todos os testes passam.

```
npx tsc --noEmit
```
Esperado: zero erros.

Checklist visual:
- [ ] Chips "Ignicao fora" e "Saida base" aparecem na FiltrosBar
- [ ] Badge GR0/GR1/GR2 aparece acima dos botoes nos cards de alerta
- [ ] Badge de score (numero) aparece no cabecalho dos cards de alerta
- [ ] Chip "Turno (8h)" filtra alertas para as ultimas 8 horas
- [ ] Layer "Calor de incidentes (30d)" aparece no controle do mapa
