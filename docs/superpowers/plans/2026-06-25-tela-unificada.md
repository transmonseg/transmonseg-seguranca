# Tela Unificada (Central + Monitoramento) — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Unificar Central e Monitoramento em uma única tela em `/`: mapa como foco principal, painel lateral com alertas em cards, clicar num marcador de veículo com alerta abre painel flutuante com telemetria + ações de tratativa, auto-fly ao novo alerta crítico.

**Architecture:** Client component `PainelCentral` substitui o layout 2-colunas atual de `page.tsx`. O server component `page.tsx` carrega dados iniciais (alertas enriquecidos + veículos) e passa como props. O cliente atualiza alertas via polling a `/api/alertas` a cada 15s. `MapaMonitor` recebe dois props novos: `flyParaAlerta` (auto-fly ao crítico) e `onVeiculoComAlertaClicado` (callback ao clicar marcador). A sidebar de veículos do MapaMonitor é ocultada via `mostrarSidebar={false}`; no lugar dela, a sidebar de alertas fica no PainelCentral.

**Tech Stack:** Next.js 16 App Router, React 18, Supabase (service_role via `createAdminClient`), React-Leaflet 4 (`useMap`, `MapContainer`), `dynamic` import para SSR-safe, server actions existentes (`acoes-alertas.ts`), Vitest (255+ testes)

## Global Constraints

- Nunca usar travessão (--) em texto de interface (só em roteiros)
- Português com acentos e cedilha corretos em todo texto de UI
- Zero dependências pagas ou novas; free tier only
- Repo público: nenhum secret inline; `.env.local` nunca commitado
- `AcoesAlerta` segue padrão existente (reconhecer/resolver/falso positivo via server actions)
- `npx vitest run` deve passar 100% antes e depois de cada task
- `npx tsc --noEmit` deve sair limpo antes de qualquer commit

---

### Task 1: API `/api/alertas` — endpoint de polling client-side

**Files:**
- Create: `src/app/api/alertas/route.ts`

**Interfaces:**
- Produces: `GET /api/alertas?cliente=<cod_user_unitrac>`
  ```ts
  interface AlertaEnriquecido {
    id: string;
    veiculo_id: string;
    cv: string;
    placa: string;
    nivel: "critico" | "atencao";
    tipo: string;
    motivo: string | null;
    desde: string;
    status: string;
    score: number | null;
    lat: number | null;
    lng: number | null;
    velocidade: number | null;
    ignicao: boolean | null;
    atraso_min: number | null;
    local: string | null;
  }
  // Resposta: { alertas: AlertaEnriquecido[] }
  ```

- [ ] **Step 1: Criar `src/app/api/alertas/route.ts`**

```typescript
import { createAdminClient } from "@/lib/supabase/admin";
import { createClient } from "@/lib/supabase/server";

export const dynamic = "force-dynamic";

export async function GET(request: Request) {
  const auth = await createClient();
  const {
    data: { user },
  } = await auth.auth.getUser();
  if (!user) return Response.json({ erro: "nao autorizado" }, { status: 401 });

  const { searchParams } = new URL(request.url);
  const cod = searchParams.get("cliente");
  if (!cod) return Response.json({ alertas: [] });

  const supabase = createAdminClient();

  const { data: clienteData } = await supabase
    .from("clientes")
    .select("id")
    .eq("cod_user_unitrac", cod)
    .single();
  if (!clienteData) return Response.json({ alertas: [] });

  const clienteId = clienteData.id;

  const { data: veiculosRaw } = await supabase
    .from("veiculos")
    .select("id, cv, placa")
    .eq("cliente_id", clienteId);

  const veiculoIds = (veiculosRaw ?? []).map(
    (v: { id: string }) => v.id
  );

  const [{ data: alertasRaw }, { data: posicoesRaw }] = await Promise.all([
    supabase
      .from("alertas")
      .select("id, veiculo_id, nivel, tipo, motivo, desde, status, score")
      .eq("cliente_id", clienteId)
      .in("status", ["ativo", "reconhecido"]),
    supabase
      .from("posicoes_atuais")
      .select("veiculo_id, lat, lng, velocidade, ignicao, atraso_min, local")
      .in("veiculo_id", veiculoIds),
  ]);

  const veiculoMap = new Map(
    (veiculosRaw ?? []).map(
      (v: { id: string; cv: string; placa: string }) => [v.id, v]
    )
  );
  const posicaoMap = new Map(
    (posicoesRaw ?? []).map(
      (p: {
        veiculo_id: string;
        lat: number | null;
        lng: number | null;
        velocidade: number | null;
        ignicao: boolean | null;
        atraso_min: number | null;
        local: string | null;
      }) => [p.veiculo_id, p]
    )
  );

  const alertas = (alertasRaw ?? []).map(
    (a: {
      id: string;
      veiculo_id: string;
      nivel: string;
      tipo: string;
      motivo: string | null;
      desde: string;
      status: string;
      score: number | null;
    }) => {
      const veiculo = veiculoMap.get(a.veiculo_id) as
        | { id: string; cv: string; placa: string }
        | undefined;
      const pos = posicaoMap.get(a.veiculo_id) as
        | {
            lat: number | null;
            lng: number | null;
            velocidade: number | null;
            ignicao: boolean | null;
            atraso_min: number | null;
            local: string | null;
          }
        | undefined;
      return {
        ...a,
        cv: veiculo?.cv ?? "",
        placa: veiculo?.placa ?? "?????",
        lat: pos?.lat ?? null,
        lng: pos?.lng ?? null,
        velocidade: pos?.velocidade ?? null,
        ignicao: pos?.ignicao ?? null,
        atraso_min: pos?.atraso_min ?? null,
        local: pos?.local ?? null,
      };
    }
  );

  return Response.json({ alertas });
}
```

- [ ] **Step 2: Compilar**

```bash
npx tsc --noEmit
```
Esperado: zero erros.

- [ ] **Step 3: Testar endpoint**

Com a aplicação rodando (`npm run dev`), abrir:
`http://localhost:3000/api/alertas?cliente=4096`

Esperado: JSON `{ "alertas": [...] }` com campos `placa`, `lat`, `lng` presentes.

- [ ] **Step 4: Commit**

```bash
git add src/app/api/alertas/route.ts
git commit -m "feat: endpoint GET /api/alertas para polling client-side"
```

---

### Task 2: Extrair `CardAlertaCritico` para arquivo próprio

**Files:**
- Create: `src/app/(app)/components/CardAlertaCritico.tsx`
- Modify: `src/app/(app)/page.tsx` (remover definição inline, importar do novo arquivo)

**Interfaces:**
- Produces: componente exportado `CardAlertaCritico` com prop extra `onFocarMapa?`
  ```ts
  export interface CardAlertaProps {
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
    score?: number | null;
    onFocarMapa?: (lat: number, lng: number) => void; // NOVO — botão "Focar" no mapa
  }
  export default function CardAlertaCritico(props: CardAlertaProps): JSX.Element
  ```
- Exports: `CardAlertaProps`, `IconTipoAlerta` (para reuso)

- [ ] **Step 1: Criar `src/app/(app)/components/CardAlertaCritico.tsx`**

```typescript
"use client";

import AcoesAlerta from "./AcoesAlerta";

function IconMapPin({ size = 14 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none"
      stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
      <path d="M21 10c0 7-9 13-9 13s-9-6-9-13a9 9 0 0 1 18 0z" />
      <circle cx="12" cy="10" r="3" />
    </svg>
  );
}

function IconClock({ size = 13 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none"
      stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
      <circle cx="12" cy="12" r="10" />
      <polyline points="12 6 12 12 16 14" />
    </svg>
  );
}

function IconAlertCircle({ size = 16 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none"
      stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
      <circle cx="12" cy="12" r="10" />
      <line x1="12" y1="8" x2="12" y2="12" />
      <line x1="12" y1="16" x2="12.01" y2="16" />
    </svg>
  );
}

function IconExternal({ size = 12 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none"
      stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
      <path d="M18 13v6a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h6" />
      <polyline points="15 3 21 3 21 9" />
      <line x1="10" y1="14" x2="21" y2="3" />
    </svg>
  );
}

function IconPause({ size = 16 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none"
      stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
      <rect x="6" y="4" width="4" height="16" />
      <rect x="14" y="4" width="4" height="16" />
    </svg>
  );
}

function IconDesvio({ size = 16 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none"
      stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
      <path d="M12 22V12" />
      <path d="M12 12C12 8 12 6 6 4" />
      <path d="M12 12c0-3 1-5 6-7" />
      <polyline points="16 3 18 5 16 7" />
    </svg>
  );
}

function IconLoja({ size = 16 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none"
      stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
      <path d="M3 9l9-7 9 7v11a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z" />
      <polyline points="9 22 9 12 15 12 15 22" />
    </svg>
  );
}

function IconTiroteio({ size = 16 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none"
      stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
      <circle cx="12" cy="12" r="9" />
      <circle cx="12" cy="12" r="3" />
      <line x1="12" y1="1" x2="12" y2="5" />
      <line x1="12" y1="19" x2="12" y2="23" />
      <line x1="1" y1="12" x2="5" y2="12" />
      <line x1="19" y1="12" x2="23" y2="12" />
    </svg>
  );
}

function IconJammer({ size = 16 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none"
      stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
      <line x1="1" y1="1" x2="23" y2="23" />
      <path d="M16.72 11.06A10.94 10.94 0 0 1 19 12.55" />
      <path d="M5 12.55a10.94 10.94 0 0 1 5.17-2.39" />
      <path d="M10.71 5.05A16 16 0 0 1 22.56 9" />
      <path d="M1.42 9a15.91 15.91 0 0 1 4.7-2.88" />
      <path d="M8.53 16.11a6 6 0 0 1 6.95 0" />
      <circle cx="12" cy="20" r="1" fill="currentColor" />
    </svg>
  );
}

export function IconTipoAlerta({ tipo, size = 16 }: { tipo: string; size?: number }) {
  const t = tipo?.toLowerCase() ?? "";
  if (t.includes("tiroteio")) return <IconTiroteio size={size} />;
  if (t.includes("jammer") || t.includes("sinal") || t.includes("bloqueio"))
    return <IconJammer size={size} />;
  if (t.includes("favela") || t.includes("area") || t.includes("risco"))
    return <IconMapPin size={size} />;
  if (t.includes("cliente") || t.includes("loja")) return <IconLoja size={size} />;
  if (t.includes("parada") || t.includes("parado") || t.includes("longa"))
    return <IconPause size={size} />;
  if (t.includes("desvio") || t.includes("rota") || t.includes("fora"))
    return <IconDesvio size={size} />;
  return <IconAlertCircle size={size} />;
}

function formatarTempoRelativo(iso: string): string {
  const data = new Date(iso);
  const agora = new Date();
  const diffMin = Math.floor((agora.getTime() - data.getTime()) / 60000);
  if (diffMin < 1) return "agora";
  if (diffMin < 60) return `${diffMin} min`;
  const diffH = Math.floor(diffMin / 60);
  if (diffH < 24) return `${diffH}h`;
  return `${Math.floor(diffH / 24)}d`;
}

export interface CardAlertaProps {
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
  score?: number | null;
  onFocarMapa?: (lat: number, lng: number) => void;
}

export default function CardAlertaCritico({
  id, status, nivel, tipo, placa, motivo, local, desde,
  lat, lng, velocidade, ignicao, atraso_min, score, onFocarMapa,
}: CardAlertaProps) {
  const corNivel = nivel === "critico" ? "var(--vermelho)" : "var(--amarelo)";
  const bgNivel = nivel === "critico" ? "#160c0c" : "#16120a";
  const temCoordenadas = lat != null && lng != null;
  const urlMapa = temCoordenadas ? `https://www.google.com/maps?q=${lat},${lng}` : null;

  return (
    <div
      className="relative rounded-xl border overflow-hidden"
      style={{
        backgroundColor: bgNivel,
        borderColor: `color-mix(in srgb, ${corNivel} 30%, var(--border))`,
      }}
    >
      <div
        className="absolute top-0 bottom-0 left-0"
        style={{ width: "3px", backgroundColor: corNivel, opacity: 0.8 }}
      />

      <div style={{ padding: "1rem 1rem 1rem 1.25rem" }}>
        {/* Cabecalho */}
        <div className="flex items-start justify-between gap-2 mb-2.5">
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
          <div className="flex items-center gap-1 flex-shrink-0" style={{ color: "var(--text-dim)" }}>
            <IconClock size={11} />
            <span className="num-mono text-xs" style={{ fontFamily: "var(--font-geist-mono, monospace)" }}>
              {formatarTempoRelativo(desde)}
            </span>
          </div>
        </div>

        {/* Placa + badge nivel */}
        <div className="flex items-center justify-between gap-2 mb-2">
          <p
            className="num-mono font-bold leading-none"
            style={{
              color: "var(--text)",
              fontFamily: "var(--font-geist-mono, monospace)",
              fontSize: "1.2rem",
              letterSpacing: "0.12em",
            }}
          >
            {placa}
          </p>
          <span
            className="text-xs font-semibold px-2 py-0.5 rounded-full flex-shrink-0"
            style={{
              backgroundColor: `color-mix(in srgb, ${corNivel} 10%, transparent)`,
              color: corNivel,
              border: `1px solid color-mix(in srgb, ${corNivel} 20%, transparent)`,
              fontSize: "9px",
              letterSpacing: "0.06em",
            }}
          >
            {nivel === "critico" ? "CRÍTICO" : "ATENÇÃO"}
          </span>
        </div>

        {/* Motivo */}
        {motivo && (
          <div
            className="rounded-lg px-2.5 py-2 mb-2.5"
            style={{
              backgroundColor: `color-mix(in srgb, ${corNivel} 7%, transparent)`,
              border: `1px solid color-mix(in srgb, ${corNivel} 16%, transparent)`,
            }}
          >
            <p className="text-xs leading-relaxed" style={{ color: corNivel, opacity: 0.9 }}>
              {motivo}
            </p>
          </div>
        )}

        <div style={{ height: "1px", backgroundColor: "var(--border-subtle)", marginBottom: "0.625rem" }} />

        {/* Localizacao */}
        <div className="mb-2.5">
          <div className="flex items-start justify-between gap-2">
            <div className="flex items-start gap-1.5 min-w-0">
              <span className="flex-shrink-0 mt-0.5" style={{ color: "var(--text-dim)" }}>
                <IconMapPin size={11} />
              </span>
              <p className="text-xs leading-relaxed" style={{ color: "var(--text-muted)" }}>
                {local ?? "Sem endereço disponível"}
              </p>
            </div>
            <div className="flex items-center gap-1 flex-shrink-0">
              {temCoordenadas && onFocarMapa && (
                <button
                  type="button"
                  onClick={() => onFocarMapa(lat!, lng!)}
                  className="flex items-center gap-1 text-xs font-medium px-2 py-1 rounded-lg transition-colors"
                  style={{
                    backgroundColor: "var(--card)",
                    border: "1px solid var(--border)",
                    color: "var(--text-muted)",
                    fontSize: "10px",
                    whiteSpace: "nowrap",
                    cursor: "pointer",
                  }}
                  title="Centralizar no mapa"
                >
                  <IconMapPin size={10} />
                  Focar
                </button>
              )}
              {urlMapa && (
                <a
                  href={urlMapa}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="flex items-center gap-1 text-xs font-medium px-2 py-1 rounded-lg transition-colors"
                  style={{
                    backgroundColor: "var(--accent-dim)",
                    border: "1px solid color-mix(in srgb, var(--accent) 30%, transparent)",
                    color: "var(--accent)",
                    textDecoration: "none",
                    fontSize: "10px",
                    whiteSpace: "nowrap",
                  }}
                >
                  <IconMapPin size={10} />
                  Ver
                  <IconExternal size={9} />
                </a>
              )}
            </div>
          </div>
        </div>

        {/* Telemetria */}
        {(velocidade != null || ignicao != null || (atraso_min != null && atraso_min > 0)) && (
          <>
            <div style={{ height: "1px", backgroundColor: "var(--border-subtle)", marginBottom: "0.625rem" }} />
            <div className="grid grid-cols-2" style={{ gap: "0.375rem" }}>
              {velocidade != null && (
                <div>
                  <span className="text-xs" style={{ color: "var(--text-dim)", fontSize: "10px" }}>
                    velocidade
                  </span>
                  <p
                    className="num-mono text-xs font-semibold mt-0.5"
                    style={{
                      fontFamily: "var(--font-geist-mono, monospace)",
                      color: velocidade > 0 ? "var(--accent)" : "var(--text-muted)",
                    }}
                  >
                    {velocidade} km/h
                  </p>
                </div>
              )}
              {ignicao != null && (
                <div>
                  <span className="text-xs" style={{ color: "var(--text-dim)", fontSize: "10px" }}>
                    ignicao
                  </span>
                  <p
                    className="text-xs font-semibold mt-0.5"
                    style={{ color: ignicao ? "var(--verde)" : "var(--text-dim)" }}
                  >
                    {ignicao ? "ligada" : "desligada"}
                  </p>
                </div>
              )}
              {atraso_min != null && atraso_min > 0 && (
                <div>
                  <span className="text-xs" style={{ color: "var(--text-dim)", fontSize: "10px" }}>
                    sem comunicacao
                  </span>
                  <p
                    className="num-mono text-xs font-semibold mt-0.5"
                    style={{ fontFamily: "var(--font-geist-mono, monospace)", color: "var(--text-muted)" }}
                  >
                    {atraso_min < 60
                      ? `${atraso_min}min`
                      : `${Math.floor(atraso_min / 60)}h${atraso_min % 60 > 0 ? `${atraso_min % 60}min` : ""}`}
                  </p>
                </div>
              )}
            </div>
          </>
        )}

        {/* Acoes do operador */}
        <AcoesAlerta id={id} status={status} desde={desde} />
      </div>
    </div>
  );
}
```

- [ ] **Step 2: Atualizar `page.tsx` — importar CardAlertaCritico do novo arquivo**

No topo de `src/app/(app)/page.tsx`, adicionar:
```typescript
import CardAlertaCritico from "./components/CardAlertaCritico";
```

Remover as definições inline em `page.tsx` (tudo entre linha ~135 e ~660):
- Funções: `IconMapPin`, `IconClock`, `IconAlertCircle`, `IconExternal`, `IconPause`, `IconDesvio`, `IconLoja`, `IconTiroteio`, `IconJammer`, `IconTipoAlerta`, `formatarTempoRelativo`
- Componente: `CardAlertaCritico` (e sua interface de props)

Manter os demais ícones que ainda são usados em `page.tsx`: `IconShield`, `IconTruck`, `IconCheck`, `IconNoSignal`, `IconPackage`, `IconChevronRight`, `IconAlertCircle` (se usado em `SectionDivider`).

- [ ] **Step 3: Verificar compilação e render**

```bash
npx tsc --noEmit
npx vitest run
```
Abrir `/` no browser. Tela deve aparecer igual à versão anterior.

- [ ] **Step 4: Commit**

```bash
git add src/app/(app)/components/CardAlertaCritico.tsx src/app/(app)/page.tsx
git commit -m "refactor: extrai CardAlertaCritico para componente proprio reutilizavel"
```

---

### Task 3: Estender MapaMonitor com `flyParaAlerta` e `onVeiculoComAlertaClicado`

**Files:**
- Modify: `src/app/(app)/components/MapaMonitor.tsx`

**Interfaces:**
- Consumes (props novas):
  ```ts
  mostrarSidebar?: boolean;           // default: true; false oculta sidebar de veículos
  flyParaAlerta?: { lat: number; lng: number; gatilho: number } | null;
  onVeiculoComAlertaClicado?: (cv: string, placa: string) => void;
  ```
- Produces: sub-componente interno `AutoFlyAlerta` (nao exportado)

- [ ] **Step 1: Adicionar sub-componente `AutoFlyAlerta` em MapaMonitor.tsx**

Logo após a definição de `AjustarBoundsRastro` (por volta da linha 353), inserir:

```typescript
function AutoFlyAlerta({
  flyPara,
}: {
  flyPara: { lat: number; lng: number; gatilho: number } | null;
}) {
  const map = useMap();
  const ultimoGatilho = useRef(-1);

  useEffect(() => {
    if (!flyPara || flyPara.gatilho === ultimoGatilho.current) return;
    ultimoGatilho.current = flyPara.gatilho;
    map.flyTo([flyPara.lat, flyPara.lng], 16, { animate: true, duration: 1.2 });
  }, [flyPara, map]);

  return null;
}
```

- [ ] **Step 2: Atualizar interface `Props` em MapaMonitor.tsx**

```typescript
interface Props {
  cliente: string;
  veiculos: VeiculoOpcao[];
  clientes: { id: string; nome: string; cod: string }[];
  clienteAtivoId: string;
  mostrarSidebar?: boolean;
  flyParaAlerta?: { lat: number; lng: number; gatilho: number } | null;
  onVeiculoComAlertaClicado?: (cv: string, placa: string) => void;
}
```

- [ ] **Step 3: Atualizar assinatura do componente**

```typescript
export default function MapaMonitor({
  veiculos,
  cliente,
  clientes,
  clienteAtivoId,
  mostrarSidebar = true,
  flyParaAlerta = null,
  onVeiculoComAlertaClicado,
}: Props) {
```

- [ ] **Step 4: Condicionar sidebar ao prop `mostrarSidebar`**

Na div raiz do render (que tem `display: "flex"`), envolver o bloco da sidebar:

```tsx
{mostrarSidebar && (
  <div
    style={{
      width: SIDEBAR_W,
      flexShrink: 0,
      display: "flex",
      flexDirection: "column",
      backgroundColor: "var(--card)",
      borderRight: "1px solid var(--border)",
      overflowY: "auto",
      overflowX: "hidden",
    }}
  >
    {/* ... todo conteúdo existente da sidebar ... */}
  </div>
)}
```

- [ ] **Step 5: Adicionar `<AutoFlyAlerta>` dentro do `<MapContainer>`**

Imediatamente após `<AjustarBoundsRastro ...>`:

```tsx
{flyParaAlerta && <AutoFlyAlerta flyPara={flyParaAlerta} />}
```

- [ ] **Step 6: Disparar `onVeiculoComAlertaClicado` ao clicar marcador com alerta**

No handler `eventHandlers` dos `<Marker>` dos veículos visíveis (aproximadamente linha 1628):

```typescript
eventHandlers={{
  click: () => {
    selecionarVeiculo({ placa: vm.placa, cv: vm.cv });
    if (vm.tipo !== null && onVeiculoComAlertaClicado) {
      onVeiculoComAlertaClicado(vm.cv, vm.placa);
    }
  },
}}
```

- [ ] **Step 7: Compilar e testar `/monitoramento`**

```bash
npx tsc --noEmit
```

Abrir `/monitoramento` — deve aparecer igual (props novos não passados = comportamento default mantido).

- [ ] **Step 8: Commit**

```bash
git add src/app/(app)/components/MapaMonitor.tsx
git commit -m "feat: MapaMonitor aceita flyParaAlerta, onVeiculoComAlertaClicado e mostrarSidebar"
```

---

### Task 4: `PainelVeiculoAlerta.tsx` — painel flutuante com telemetria + ações

**Files:**
- Create: `src/app/(app)/components/PainelVeiculoAlerta.tsx`

**Interfaces:**
- Consumes:
  ```ts
  interface AlertaSimples {
    id: string;
    status: string;
    nivel: "critico" | "atencao";
    tipo: string;
    motivo: string | null;
    desde: string;
    score: number | null;
  }
  interface Props {
    cv: string;
    placa: string;
    alertas: AlertaSimples[];
    onFechar: () => void;
  }
  ```
- Produces: painel posicionado `absolute top:12 right:12 zIndex:1001` dentro da div relativa do mapa

- [ ] **Step 1: Criar `src/app/(app)/components/PainelVeiculoAlerta.tsx`**

```typescript
"use client";

import { useEffect, useState } from "react";
import AcoesAlerta from "./AcoesAlerta";
import CronometroSLA from "./CronometroSLA";

interface AlertaSimples {
  id: string;
  status: string;
  nivel: "critico" | "atencao";
  tipo: string;
  motivo: string | null;
  desde: string;
  score: number | null;
}

interface Props {
  cv: string;
  placa: string;
  alertas: AlertaSimples[];
  onFechar: () => void;
}

interface Telemetria {
  posicvelocidade?: string;
  posicignicao?: string;
  tipevnome?: string;
  atraso?: string;
}

function formatarDuracao(min: number): string {
  if (min < 1) return "menos de 1 min";
  if (min < 60) return `${min} min`;
  const h = Math.floor(min / 60);
  const m = min % 60;
  return m > 0 ? `${h}h ${m}min` : `${h}h`;
}

export default function PainelVeiculoAlerta({ cv, placa, alertas, onFechar }: Props) {
  const [telemetria, setTelemetria] = useState<Telemetria | null>(null);

  useEffect(() => {
    if (!cv) return;
    let ativo = true;
    const carregar = () =>
      fetch(`/api/veiculo?cv=${encodeURIComponent(cv)}`)
        .then((r) => r.json())
        .then((d) => {
          if (ativo && d?.posicao) setTelemetria(d.posicao as Telemetria);
        })
        .catch(() => {});
    carregar();
    const id = setInterval(carregar, 15000);
    return () => {
      ativo = false;
      clearInterval(id);
    };
  }, [cv]);

  const velocidade = telemetria ? parseInt(telemetria.posicvelocidade ?? "0") || 0 : null;
  const ignicao = telemetria ? telemetria.posicignicao === "1" : null;
  const atraso = telemetria ? parseInt(telemetria.atraso ?? "0") || 0 : null;
  const temCritico = alertas.some((a) => a.nivel === "critico");
  const corNivel = temCritico ? "var(--vermelho)" : "var(--amarelo)";

  return (
    <div
      style={{
        position: "absolute",
        top: 12,
        right: 12,
        zIndex: 1001,
        width: 300,
        maxHeight: "calc(100% - 24px)",
        overflowY: "auto",
        backgroundColor: "rgba(8,8,12,0.97)",
        border: `1px solid color-mix(in srgb, ${corNivel} 40%, var(--border))`,
        borderRadius: "0.875rem",
        boxShadow: "0 8px 32px rgba(0,0,0,0.7)",
        backdropFilter: "blur(10px)",
      }}
    >
      {/* Cabecalho */}
      <div
        style={{
          padding: "0.75rem 1rem",
          borderBottom: "1px solid var(--border-subtle)",
          display: "flex",
          alignItems: "center",
          justifyContent: "space-between",
          backgroundColor: `color-mix(in srgb, ${corNivel} 8%, transparent)`,
          flexShrink: 0,
        }}
      >
        <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
          <span
            style={{
              display: "inline-block",
              width: 8,
              height: 8,
              borderRadius: "50%",
              backgroundColor: ignicao ? "var(--verde)" : corNivel,
            }}
          />
          <span
            style={{
              fontFamily: "var(--font-geist-mono, monospace)",
              color: "var(--text)",
              fontSize: "1rem",
              letterSpacing: "0.1em",
              fontWeight: 700,
            }}
          >
            {placa}
          </span>
        </div>
        <button
          onClick={onFechar}
          style={{
            background: "none",
            border: "none",
            cursor: "pointer",
            color: "var(--text-dim)",
            padding: "2px 6px",
            fontSize: 18,
            lineHeight: 1,
          }}
          title="Fechar"
        >
          &times;
        </button>
      </div>

      {/* Telemetria */}
      <div style={{ padding: "0.75rem 1rem", borderBottom: "1px solid var(--border-subtle)" }}>
        <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 8 }}>
          <div>
            <p
              style={{
                color: "var(--text-dim)",
                fontSize: 10,
                textTransform: "uppercase",
                letterSpacing: "0.1em",
                marginBottom: 3,
              }}
            >
              velocidade
            </p>
            <p
              style={{
                fontFamily: "var(--font-geist-mono, monospace)",
                fontSize: "1.1rem",
                color: (velocidade ?? 0) > 0 ? "var(--accent)" : "var(--text-muted)",
                lineHeight: 1,
                fontWeight: 700,
              }}
            >
              {velocidade ?? "--"}
              <span style={{ fontSize: 10, fontWeight: 400, marginLeft: 3, color: "var(--text-dim)" }}>
                km/h
              </span>
            </p>
          </div>
          <div>
            <p
              style={{
                color: "var(--text-dim)",
                fontSize: 10,
                textTransform: "uppercase",
                letterSpacing: "0.1em",
                marginBottom: 3,
              }}
            >
              ignicao
            </p>
            <p
              style={{
                fontSize: "0.875rem",
                color: ignicao ? "var(--verde)" : "var(--text-dim)",
                fontWeight: 600,
              }}
            >
              {ignicao === null ? "--" : ignicao ? "ligada" : "desligada"}
            </p>
          </div>
        </div>
        {atraso !== null && atraso > 0 && (
          <div style={{ display: "flex", alignItems: "center", gap: 6, marginTop: 8 }}>
            <span
              style={{
                display: "inline-block",
                width: 6,
                height: 6,
                borderRadius: "50%",
                backgroundColor: "var(--amarelo)",
              }}
            />
            <p style={{ color: "var(--text-muted)", fontSize: 11 }}>
              sem comunicacao ha {formatarDuracao(atraso)}
            </p>
          </div>
        )}
      </div>

      {/* Alertas e acoes */}
      <div style={{ padding: "0.75rem 1rem", display: "flex", flexDirection: "column", gap: 16 }}>
        {alertas.map((a) => (
          <div key={a.id}>
            <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: 8, marginBottom: 6 }}>
              <span
                style={{
                  fontSize: 10,
                  fontWeight: 700,
                  textTransform: "uppercase",
                  letterSpacing: "0.1em",
                  padding: "2px 7px",
                  borderRadius: 5,
                  backgroundColor: a.nivel === "critico" ? "#ef444418" : "#f59e0b18",
                  border: `1px solid ${a.nivel === "critico" ? "#ef444444" : "#f59e0b44"}`,
                  color: a.nivel === "critico" ? "#ef4444" : "#f59e0b",
                }}
              >
                {a.tipo}
              </span>
              {a.score != null && (
                <span
                  style={{
                    fontFamily: "var(--font-geist-mono, monospace)",
                    fontSize: 10,
                    fontWeight: 700,
                    padding: "2px 6px",
                    borderRadius: 4,
                    backgroundColor: a.score >= 80 ? "#ef444418" : "#f59e0b18",
                    color: a.score >= 80 ? "#ef4444" : "#f59e0b",
                  }}
                >
                  {a.score}
                </span>
              )}
            </div>
            {a.motivo && (
              <p style={{ color: "var(--text-muted)", fontSize: 12, marginBottom: 6, lineHeight: 1.4 }}>
                {a.motivo}
              </p>
            )}
            <div style={{ marginBottom: 6 }}>
              <CronometroSLA desde={a.desde} />
            </div>
            <AcoesAlerta id={a.id} status={a.status} desde={a.desde} />
          </div>
        ))}
      </div>
    </div>
  );
}
```

- [ ] **Step 2: Compilar**

```bash
npx tsc --noEmit
```

- [ ] **Step 3: Commit**

```bash
git add src/app/(app)/components/PainelVeiculoAlerta.tsx
git commit -m "feat: PainelVeiculoAlerta com telemetria ao vivo e acoes de alerta"
```

---

### Task 5: `PainelCentral.tsx` — componente unificado client-side

**Files:**
- Create: `src/app/(app)/components/PainelCentral.tsx`

**Interfaces:**
- Consumes (props do servidor):
  ```ts
  interface AlertaEnriquecido {
    id: string; veiculo_id: string; cv: string; placa: string;
    nivel: "critico" | "atencao"; tipo: string; motivo: string | null;
    desde: string; status: string; score: number | null;
    lat: number | null; lng: number | null; velocidade: number | null;
    ignicao: boolean | null; atraso_min: number | null; local: string | null;
  }
  interface Props {
    cliente: string;
    clientes: { id: string; nome: string; cod: string }[];
    clienteAtivoId: string;
    veiculos: { placa: string; cv: string }[];
    alertasIniciais: AlertaEnriquecido[];
  }
  ```
- Produces: layout full-height com sidebar de alertas (380px) + MapaMonitor (flex-1)

- [ ] **Step 1: Criar `src/app/(app)/components/PainelCentral.tsx`**

```typescript
"use client";

import { useEffect, useRef, useState, useCallback } from "react";
import dynamic from "next/dynamic";
import Link from "next/link";
import { useSearchParams } from "next/navigation";
import AlertaSonoro from "./AlertaSonoro";
import FiltrosBar, { type Contagens } from "./FiltrosBar";
import CardAlertaCritico from "./CardAlertaCritico";
import PainelVeiculoAlerta from "./PainelVeiculoAlerta";

const MapaMonitor = dynamic(() => import("./MapaMonitor"), { ssr: false });

interface AlertaEnriquecido {
  id: string;
  veiculo_id: string;
  cv: string;
  placa: string;
  nivel: "critico" | "atencao";
  tipo: string;
  motivo: string | null;
  desde: string;
  status: string;
  score: number | null;
  lat: number | null;
  lng: number | null;
  velocidade: number | null;
  ignicao: boolean | null;
  atraso_min: number | null;
  local: string | null;
}

interface Props {
  cliente: string;
  clientes: { id: string; nome: string; cod: string }[];
  clienteAtivoId: string;
  veiculos: { placa: string; cv: string }[];
  alertasIniciais: AlertaEnriquecido[];
}

function ordemSeveridade(tipo: string): number {
  const t = tipo?.toLowerCase() ?? "";
  if (t === "panico") return 0;
  if (t === "bau") return 1;
  if (t === "favela") return 2;
  if (t === "tiroteio") return 3;
  if (t === "ignicao_noturna") return 4;
  if (t === "saida_nao_autorizada") return 5;
  if (t === "parada_cliente") return 6;
  if (t === "parada_anomala") return 7;
  if (t === "parada_longa") return 8;
  if (t === "desvio" || t === "excesso") return 9;
  if (t === "jammer" || t.includes("sinal") || t.includes("bloqueio")) return 11;
  return 10;
}

const SIDEBAR_W = 380;

export default function PainelCentral({
  cliente,
  clientes,
  clienteAtivoId,
  veiculos,
  alertasIniciais,
}: Props) {
  const searchParams = useSearchParams();

  const [alertas, setAlertas] = useState<AlertaEnriquecido[]>(alertasIniciais);
  const [flyParaAlerta, setFlyParaAlerta] = useState<{
    lat: number;
    lng: number;
    gatilho: number;
  } | null>(null);
  const vistosRef = useRef<Set<string>>(new Set(alertasIniciais.map((a) => a.id)));

  const [veiculoPanel, setVeiculoPanel] = useState<{ cv: string; placa: string } | null>(null);

  // Polling de alertas a cada 15s
  const atualizarAlertas = useCallback(() => {
    fetch(`/api/alertas?cliente=${encodeURIComponent(cliente)}`)
      .then((r) => r.json())
      .then((d) => {
        if (!Array.isArray(d?.alertas)) return;
        const novos = d.alertas as AlertaEnriquecido[];
        setAlertas(novos);
        for (const a of novos) {
          if (
            a.nivel === "critico" &&
            !vistosRef.current.has(a.id) &&
            a.lat != null &&
            a.lng != null
          ) {
            setFlyParaAlerta({ lat: a.lat, lng: a.lng, gatilho: Date.now() });
          }
          vistosRef.current.add(a.id);
        }
      })
      .catch(() => {});
  }, [cliente]);

  useEffect(() => {
    const id = setInterval(atualizarAlertas, 15000);
    return () => clearInterval(id);
  }, [atualizarAlertas]);

  // Filtros da URL
  const tiposParam = searchParams.get("tipos") ?? "";
  const nivelParam = searchParams.get("nivel") ?? "";
  const soProblema = searchParams.get("problema") === "1";
  const soTurno = searchParams.get("turno") === "1";

  const tiposChips = tiposParam ? tiposParam.split(",").filter(Boolean) : [];
  const GRUPO_JAMMER = ["jammer", "sinal", "bloqueio"];
  const tiposSel = [
    ...new Set(
      tiposChips.flatMap((t) => (GRUPO_JAMMER.includes(t) ? GRUPO_JAMMER : [t]))
    ),
  ];
  const niveisAtivos = nivelParam ? nivelParam.split(",").filter(Boolean) : [];
  const cutoffTurno = new Date(Date.now() - 8 * 60 * 60 * 1000).toISOString();

  const alertasFiltrados = alertas.filter((a) => {
    if (soTurno && a.status !== "ativo" && a.desde < cutoffTurno) return false;
    if (tiposSel.length > 0 && !tiposSel.includes(a.tipo?.toLowerCase() ?? "")) return false;
    return true;
  });

  const mostrarCriticos = niveisAtivos.length === 0 || niveisAtivos.includes("critico");
  const mostrarAtencao = niveisAtivos.length === 0 || niveisAtivos.includes("atencao");

  const criticos = alertasFiltrados
    .filter((a) => a.nivel === "critico")
    .sort((a, b) => ordemSeveridade(a.tipo) - ordemSeveridade(b.tipo));

  const atencao = alertasFiltrados
    .filter((a) => a.nivel === "atencao")
    .sort((a, b) => ordemSeveridade(a.tipo) - ordemSeveridade(b.tipo));

  const idsParaApitar = [
    ...alertas.filter((a) => a.nivel === "critico").map((a) => a.id),
    ...alertas
      .filter((a) => a.nivel === "atencao" && a.tipo === "parada_cliente")
      .map((a) => a.id),
  ];

  // Contagens para FiltrosBar
  const contagensTipos: Record<string, number> = {};
  for (const a of alertas) {
    const t = a.tipo ?? "outro";
    contagensTipos[t] = (contagensTipos[t] ?? 0) + 1;
  }
  const jammerTotal =
    (contagensTipos["jammer"] ?? 0) +
    (contagensTipos["sinal"] ?? 0) +
    (contagensTipos["bloqueio"] ?? 0);
  if (jammerTotal > 0) contagensTipos["jammer"] = jammerTotal;

  const contagens: Contagens = {
    tipos: contagensTipos,
    nivel: {
      critico: alertas.filter((a) => a.nivel === "critico").length,
      atencao: alertas.filter((a) => a.nivel === "atencao").length,
    },
  };

  const alertasVeiculoPanel = veiculoPanel
    ? alertas.filter((a) => a.cv === veiculoPanel.cv)
    : [];

  const focarMapa = useCallback((lat: number, lng: number) => {
    setFlyParaAlerta({ lat, lng, gatilho: Date.now() });
  }, []);

  return (
    <div
      style={{
        display: "flex",
        height: "calc(100vh - var(--header-h, 64px))",
        overflow: "hidden",
      }}
    >
      {/* ======== SIDEBAR DE ALERTAS ======== */}
      <div
        style={{
          width: SIDEBAR_W,
          flexShrink: 0,
          display: "flex",
          flexDirection: "column",
          backgroundColor: "var(--bg)",
          borderRight: "1px solid var(--border)",
          overflow: "hidden",
        }}
      >
        {/* Cabecalho fixo da sidebar */}
        <div
          style={{
            flexShrink: 0,
            padding: "0.875rem 1rem",
            borderBottom: "1px solid var(--border)",
            display: "flex",
            flexDirection: "column",
            gap: 10,
          }}
        >
          {/* Seletor de cliente */}
          <div style={{ display: "flex", gap: 4, flexWrap: "wrap" }}>
            {clientes.map((c) => (
              <Link
                key={c.id}
                href={`?cliente=${c.cod}`}
                style={{
                  padding: "0.25rem 0.625rem",
                  borderRadius: 6,
                  fontSize: 11,
                  fontWeight: 700,
                  backgroundColor:
                    c.id === clienteAtivoId ? "var(--accent-dim)" : "transparent",
                  border: `1px solid ${
                    c.id === clienteAtivoId ? "var(--accent)" : "var(--border)"
                  }`,
                  color:
                    c.id === clienteAtivoId ? "var(--accent)" : "var(--text-dim)",
                  textDecoration: "none",
                }}
              >
                {c.nome}
              </Link>
            ))}
          </div>

          {/* Apito + metricas */}
          <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between" }}>
            <AlertaSonoro idsParaApitar={idsParaApitar} />
            <div style={{ display: "flex", gap: 14 }}>
              <div style={{ textAlign: "center" }}>
                <p
                  style={{
                    fontFamily: "var(--font-geist-mono, monospace)",
                    fontWeight: 700,
                    fontSize: "1.1rem",
                    color: criticos.length > 0 ? "var(--vermelho)" : "var(--text-dim)",
                    lineHeight: 1,
                  }}
                >
                  {criticos.length}
                </p>
                <p
                  style={{
                    fontSize: 9,
                    color: "var(--text-dim)",
                    textTransform: "uppercase",
                    letterSpacing: "0.1em",
                    marginTop: 2,
                  }}
                >
                  críticos
                </p>
              </div>
              <div style={{ textAlign: "center" }}>
                <p
                  style={{
                    fontFamily: "var(--font-geist-mono, monospace)",
                    fontWeight: 700,
                    fontSize: "1.1rem",
                    color: atencao.length > 0 ? "var(--amarelo)" : "var(--text-dim)",
                    lineHeight: 1,
                  }}
                >
                  {atencao.length}
                </p>
                <p
                  style={{
                    fontSize: 9,
                    color: "var(--text-dim)",
                    textTransform: "uppercase",
                    letterSpacing: "0.1em",
                    marginTop: 2,
                  }}
                >
                  atenção
                </p>
              </div>
            </div>
          </div>

          {/* Filtros */}
          <FiltrosBar contagens={contagens} />
        </div>

        {/* Lista scrollavel de alertas */}
        <div style={{ flex: 1, overflowY: "auto", padding: "0.875rem 1rem" }}>
          {mostrarCriticos && (
            <section style={{ marginBottom: "1.25rem" }}>
              <div style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: "0.75rem" }}>
                <span
                  style={{
                    width: 8,
                    height: 8,
                    borderRadius: "50%",
                    backgroundColor: criticos.length > 0 ? "var(--vermelho)" : "var(--border)",
                    display: "inline-block",
                    flexShrink: 0,
                  }}
                />
                <h2
                  style={{
                    fontSize: 10,
                    fontWeight: 700,
                    textTransform: "uppercase",
                    letterSpacing: "0.14em",
                    color: "var(--text-muted)",
                    margin: 0,
                  }}
                >
                  Crítico
                  <span
                    style={{
                      marginLeft: 8,
                      fontFamily: "var(--font-geist-mono, monospace)",
                      color: criticos.length > 0 ? "var(--vermelho)" : "var(--text-dim)",
                    }}
                  >
                    {criticos.length}
                  </span>
                </h2>
                <div style={{ flex: 1, height: 1, backgroundColor: "var(--border)" }} />
              </div>
              {criticos.length === 0 ? (
                <p
                  style={{
                    fontSize: 12,
                    color: "var(--text-dim)",
                    padding: "0.75rem",
                    backgroundColor: "var(--card)",
                    borderRadius: 8,
                    border: "1px solid var(--border)",
                  }}
                >
                  Nenhuma ocorrência crítica.
                </p>
              ) : (
                <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
                  {criticos.map((a) => (
                    <CardAlertaCritico
                      key={a.id}
                      id={a.id}
                      status={a.status}
                      nivel={a.nivel}
                      tipo={a.tipo}
                      placa={a.placa}
                      motivo={a.motivo}
                      local={a.local}
                      desde={a.desde}
                      lat={a.lat}
                      lng={a.lng}
                      velocidade={a.velocidade}
                      ignicao={a.ignicao}
                      atraso_min={a.atraso_min}
                      score={a.score}
                      onFocarMapa={focarMapa}
                    />
                  ))}
                </div>
              )}
            </section>
          )}

          {mostrarAtencao && !soProblema && (
            <section>
              <div style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: "0.75rem" }}>
                <span
                  style={{
                    width: 8,
                    height: 8,
                    borderRadius: "50%",
                    backgroundColor: atencao.length > 0 ? "var(--amarelo)" : "var(--border)",
                    display: "inline-block",
                    flexShrink: 0,
                  }}
                />
                <h2
                  style={{
                    fontSize: 10,
                    fontWeight: 700,
                    textTransform: "uppercase",
                    letterSpacing: "0.14em",
                    color: "var(--text-muted)",
                    margin: 0,
                  }}
                >
                  Atenção
                  <span
                    style={{
                      marginLeft: 8,
                      fontFamily: "var(--font-geist-mono, monospace)",
                      color: atencao.length > 0 ? "var(--amarelo)" : "var(--text-dim)",
                    }}
                  >
                    {atencao.length}
                  </span>
                </h2>
                <div style={{ flex: 1, height: 1, backgroundColor: "var(--border)" }} />
              </div>
              {atencao.length === 0 ? (
                <p
                  style={{
                    fontSize: 12,
                    color: "var(--text-dim)",
                    padding: "0.75rem",
                    backgroundColor: "var(--card)",
                    borderRadius: 8,
                    border: "1px solid var(--border)",
                  }}
                >
                  Nada em atenção.
                </p>
              ) : (
                <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
                  {atencao.map((a) => (
                    <CardAlertaCritico
                      key={a.id}
                      id={a.id}
                      status={a.status}
                      nivel={a.nivel}
                      tipo={a.tipo}
                      placa={a.placa}
                      motivo={a.motivo}
                      local={a.local}
                      desde={a.desde}
                      lat={a.lat}
                      lng={a.lng}
                      velocidade={a.velocidade}
                      ignicao={a.ignicao}
                      atraso_min={a.atraso_min}
                      score={a.score}
                      onFocarMapa={focarMapa}
                    />
                  ))}
                </div>
              )}
            </section>
          )}
        </div>
      </div>

      {/* ======== MAPA (ocupar restante) ======== */}
      <div style={{ flex: 1, position: "relative", overflow: "hidden" }}>
        <MapaMonitor
          cliente={cliente}
          veiculos={veiculos}
          clientes={clientes}
          clienteAtivoId={clienteAtivoId}
          mostrarSidebar={false}
          flyParaAlerta={flyParaAlerta}
          onVeiculoComAlertaClicado={(cv, placa) => setVeiculoPanel({ cv, placa })}
        />

        {/* Painel flutuante do veiculo com alerta */}
        {veiculoPanel && alertasVeiculoPanel.length > 0 && (
          <div
            style={{
              position: "absolute",
              inset: 0,
              pointerEvents: "none",
              zIndex: 1001,
            }}
          >
            <div style={{ position: "absolute", top: 0, right: 0, bottom: 0, pointerEvents: "auto" }}>
              <PainelVeiculoAlerta
                cv={veiculoPanel.cv}
                placa={veiculoPanel.placa}
                alertas={alertasVeiculoPanel.map((a) => ({
                  id: a.id,
                  status: a.status,
                  nivel: a.nivel,
                  tipo: a.tipo,
                  motivo: a.motivo,
                  desde: a.desde,
                  score: a.score,
                }))}
                onFechar={() => setVeiculoPanel(null)}
              />
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
```

- [ ] **Step 2: Compilar**

```bash
npx tsc --noEmit
```

- [ ] **Step 3: Commit**

```bash
git add src/app/(app)/components/PainelCentral.tsx
git commit -m "feat: PainelCentral unifica alertas e mapa em tela unica"
```

---

### Task 6: Substituir layout de `page.tsx` pelo `PainelCentral`

**Files:**
- Modify: `src/app/(app)/page.tsx`

**Interfaces:**
- Consumes: dados existentes do Supabase (sem mudanca nas queries)
- Produces: retorna `<PainelCentral>` com dados iniciais

- [ ] **Step 1: Adicionar import no topo de `page.tsx`**

```typescript
import PainelCentral from "./components/PainelCentral";
```

Remover imports que não são mais usados diretamente em `page.tsx`:
```typescript
// Remover:
import CardVeiculoOperacao from "./components/CardVeiculoOperacao";
import FaixaColapsavel from "./components/FaixaColapsavel";
import VerTodosBtn from "./components/VerTodosBtn";
import MapaWrapper from "./components/MapaWrapper";
import AcoesAlerta from "./components/AcoesAlerta";
import PainelRoubo from "./components/PainelRoubo";
import AlertaSonoro from "./components/AlertaSonoro";
import FiltrosBar from "./components/FiltrosBar";
// Manter:
import { createAdminClient } from "@/lib/supabase/admin";
import PainelCentral from "./components/PainelCentral";
```

- [ ] **Step 2: Substituir o bloco `return` (~linha 1000 em diante)**

Manter todas as queries e processamento de alertas. Substituir apenas o JSX de retorno:

```typescript
  // Montar alertas iniciais enriquecidos
  const alertasIniciais = [
    ...alertasCriticos.map((a) => ({
      id: a.id,
      veiculo_id: a.veiculo_id,
      cv: veiculoById.get(a.veiculo_id)?.cv ?? "",
      placa: a.placa,
      nivel: a.nivel as "critico" | "atencao",
      tipo: a.tipo,
      motivo: a.motivo,
      desde: a.desde,
      status: a.status,
      score: a.score ?? null,
      lat: a.lat ?? null,
      lng: a.lng ?? null,
      velocidade: a.velocidade ?? null,
      ignicao: a.ignicao ?? null,
      atraso_min: a.atraso_min ?? null,
      local: a.local ?? null,
    })),
    ...alertasAtencao.map((a) => ({
      id: a.id,
      veiculo_id: a.veiculo_id,
      cv: veiculoById.get(a.veiculo_id)?.cv ?? "",
      placa: a.placa,
      nivel: a.nivel as "critico" | "atencao",
      tipo: a.tipo,
      motivo: a.motivo,
      desde: a.desde,
      status: a.status,
      score: a.score ?? null,
      lat: a.lat ?? null,
      lng: a.lng ?? null,
      velocidade: a.velocidade ?? null,
      ignicao: a.ignicao ?? null,
      atraso_min: a.atraso_min ?? null,
      local: a.local ?? null,
    })),
  ];

  return (
    <PainelCentral
      cliente={clienteAtivo.cod_user_unitrac}
      clientes={clientes.map((c) => ({
        id: c.id,
        nome: c.nome,
        cod: c.cod_user_unitrac,
      }))}
      clienteAtivoId={clienteAtivo.id}
      veiculos={veiculos.map((v) => ({ placa: v.placa, cv: v.cv }))}
      alertasIniciais={alertasIniciais}
    />
  );
```

- [ ] **Step 3: Remover codigo morto de `page.tsx`**

Remover as definicoes que ficam orfas apos a mudanca do return:
- `BlocoMetricas`, `MetricaGrande`, `SeletorCliente`, `SectionDivider`
- Ícones SVG (agora em CardAlertaCritico.tsx): `IconShield`, `IconTruck`, `IconMapPin`, etc.
- Componente `CardAlertaCritico` (movido para proprio arquivo)
- Funcao `ordemSeveridade` (agora em PainelCentral.tsx)
- Constante `LIMITE_CARDS_OPERACAO`
- Computacoes de `emOperacaoRaw`, `concluidos`, `semComunicacao`, etc.

Manter em `page.tsx`:
- Import `createAdminClient`
- Tipos `Cliente`, `Veiculo`, `PosicaoAtual`, `Alerta`
- As 4 queries Supabase (`clientes`, `veiculos`, `posicoes_atuais`, `alertas`)
- Processamento de `alertasCriticos`, `alertasAtencao` (necessarios para `alertasIniciais`)
- `veiculoById`, `posicaoPorVeiculo` (necessarios para enriquecer alertas)

- [ ] **Step 4: Compilar e rodar testes**

```bash
npx tsc --noEmit
npx vitest run
```
Esperado: zero erros, todos os testes passam.

- [ ] **Step 5: Testar visualmente**

Abrir `http://localhost:3000` logado. Verificar:
1. Sidebar de alertas visível à esquerda (380px)
2. Mapa ocupa o restante (full height)
3. AlertaSonoro presente na sidebar
4. FiltrosBar presente e reativo
5. Seletor de cliente funciona
6. Clicar "Focar" num card de alerta voa o mapa para a posição

- [ ] **Step 6: Commit**

```bash
git add src/app/(app)/page.tsx
git commit -m "feat: pagina central usa PainelCentral unificado"
```

---

### Task 7: Atualizar nav e redirecionar `/monitoramento`

**Files:**
- Modify: `src/app/(app)/layout.tsx`
- Modify: `src/app/(app)/monitoramento/page.tsx`

- [ ] **Step 1: Atualizar nav em `layout.tsx`**

Remover o link "Monitoramento" da nav. Manter "Central" e "Análise":

```tsx
<nav className="hidden sm:flex items-center gap-1" aria-label="Navegação principal">
  <Link
    href="/"
    className="px-3 py-1.5 rounded-md text-xs font-medium transition-colors"
    style={{ color: "var(--text-muted)", border: "1px solid transparent" }}
  >
    Central
  </Link>
  <Link
    href="/analise"
    className="px-3 py-1.5 rounded-md text-xs font-medium transition-colors"
    style={{ color: "var(--text-muted)", border: "1px solid transparent" }}
  >
    Análise
  </Link>
</nav>
```

- [ ] **Step 2: Redirecionar `/monitoramento` para `/`**

Substituir todo o conteúdo de `src/app/(app)/monitoramento/page.tsx`:

```typescript
import { redirect } from "next/navigation";

export default function MonitoramentoPage() {
  redirect("/");
}
```

- [ ] **Step 3: Compilar e testar**

```bash
npx tsc --noEmit
```

Verificar:
- Acessar `/monitoramento` redireciona imediatamente para `/`
- Nav mostra apenas "Central" e "Análise"

- [ ] **Step 4: Commit**

```bash
git add src/app/(app)/layout.tsx src/app/(app)/monitoramento/page.tsx
git commit -m "feat: nav unificada, /monitoramento redireciona para /"
```

---

### Task 9: Botoes de sirene e bloqueio no PainelVeiculoAlerta

**Contexto:** O datalayer do Unitrac (`datalayer.portalunitrac.com`) e somente leitura -- todos os endpoints de comando retornam 404. Comandos de saidas digitais (sirene, bloqueio de motor) sao enviados pelo portal PHP autenticado em `www2.portalunitrac.com/unitrac/`. Implementacao: server action autentica via portal com credenciais de env, retorna cookie de sessao e envia o comando. O campo `posicsaida1..4` na posicao confirma que saidas digitais existem no hardware.

**Files:**
- Create: `src/lib/unitrac-comandos.ts`
- Modify: `src/app/(app)/components/PainelVeiculoAlerta.tsx`
- Modify: `.env.local` (documentado, nunca commitado)

**Interfaces:**
- Consumes:
  ```ts
  // env vars necessarias (adicionar em .env.local):
  // UNITRAC_USUARIO=<usuario>
  // UNITRAC_SENHA=<senha>
  // UNITRAC_PORTAL_URL=https://www2.portalunitrac.com/unitrac
  ```
- Produces:
  ```ts
  // server action:
  async function enviarComandoVeiculo(
    cv: string,
    comando: "sirene" | "bloqueio"
  ): Promise<{ ok: boolean; erro?: string }>
  ```

- [ ] **Step 1: Documentar env vars em `.env.local`**

Adicionar ao `.env.local` (nunca commitar):
```
UNITRAC_USUARIO=
UNITRAC_SENHA=
UNITRAC_PORTAL_URL=https://www2.portalunitrac.com/unitrac
```

- [ ] **Step 2: Criar `src/lib/unitrac-comandos.ts`**

```typescript
"use server";

const PORTAL = process.env.UNITRAC_PORTAL_URL ?? "https://www2.portalunitrac.com/unitrac";
const USUARIO = process.env.UNITRAC_USUARIO ?? "";
const SENHA = process.env.UNITRAC_SENHA ?? "";

async function obterSessaoUnitrac(): Promise<string | null> {
  if (!USUARIO || !SENHA) return null;
  try {
    const res = await fetch(`${PORTAL}/unitrac_login/unitrac_login.php`, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ nm_usuario: USUARIO, nm_senha: SENHA }),
      redirect: "manual",
    });
    // Portal retorna 302 com Set-Cookie em login bem-sucedido
    const cookie = res.headers.get("set-cookie");
    if (!cookie) return null;
    // Extrair PHPSESSID (ou SESSAO_UNITRAC -- pode variar)
    const match = cookie.match(/(?:PHPSESSID|UNITRAC_SID)=([^;]+)/);
    return match ? `${match[0].split("=")[0]}=${match[1]}` : null;
  } catch {
    return null;
  }
}

// Envia comando de saida digital para um veiculo via portal Unitrac.
// saida: 1 = sirene, 2 = bloqueio (numeros conforme config do dispositivo).
// NOTA: o endpoint exato (/ajax/comando.php ou similar) precisa ser confirmado
// interceptando trafego de rede no portal Unitrac autenticado.
// Enquanto nao confirmado, retorna { ok: false, erro: "endpoint_a_confirmar" }
// e o cliente exibe link de fallback para o portal.
export async function enviarComandoVeiculo(
  cv: string,
  comando: "sirene" | "bloqueio"
): Promise<{ ok: boolean; erro?: string; portalUrl?: string }> {
  const portalUrl = `${PORTAL}/#veiculo/${cv}`;

  if (!USUARIO || !SENHA) {
    return { ok: false, erro: "credenciais_nao_configuradas", portalUrl };
  }

  const sessao = await obterSessaoUnitrac();
  if (!sessao) {
    return { ok: false, erro: "login_falhou", portalUrl };
  }

  const saida = comando === "sirene" ? "1" : "2";

  // Tenta os endpoints mais provaveis de comando do portal Unitrac.
  // Se todos retornarem erro, o cliente mostra o link de fallback.
  const candidatos = [
    `/ajax/comando.php`,
    `/mapa/comando.php`,
    `/controle/enviar_comando.php`,
    `/ajax/saida.php`,
  ];

  for (const path of candidatos) {
    try {
      const res = await fetch(`${PORTAL}${path}`, {
        method: "POST",
        headers: {
          "content-type": "application/x-www-form-urlencoded",
          cookie: sessao,
        },
        body: new URLSearchParams({ cv, saida, acao: comando }),
      });
      if (res.ok || res.status === 200) {
        const texto = await res.text().catch(() => "");
        if (texto.includes("sucesso") || texto.includes("ok") || texto === "1") {
          return { ok: true };
        }
      }
    } catch {
      // proxima candidata
    }
  }

  // Nenhum endpoint confirmado -- retornar link do portal como fallback
  return { ok: false, erro: "endpoint_a_confirmar", portalUrl };
}
```

- [ ] **Step 3: Adicionar botoes em `PainelVeiculoAlerta.tsx`**

Ao final das importacoes do componente, adicionar:
```typescript
import { enviarComandoVeiculo } from "@/lib/unitrac-comandos";
```

Adicionar estado logo apos os `useState` existentes:
```typescript
const [cmdSirene, setCmdSirene] = useState<"idle" | "loading" | "ok" | "fallback">("idle");
const [cmdBloqueio, setCmdBloqueio] = useState<"idle" | "loading" | "ok" | "fallback">("idle");
const [fallbackUrl, setFallbackUrl] = useState<string | null>(null);
```

Adicionar handler apos os estados:
```typescript
async function acionar(tipo: "sirene" | "bloqueio") {
  const setter = tipo === "sirene" ? setCmdSirene : setCmdBloqueio;
  setter("loading");
  const resultado = await enviarComandoVeiculo(cv, tipo);
  if (resultado.ok) {
    setter("ok");
    setTimeout(() => setter("idle"), 3000);
  } else {
    setter("fallback");
    if (resultado.portalUrl) setFallbackUrl(resultado.portalUrl);
  }
}
```

Adicionar secao de botoes logo antes do `<AcoesAlerta>` no return:
```tsx
{/* Saidas digitais: sirene e bloqueio */}
<div
  style={{
    display: "flex",
    gap: 8,
    padding: "0.75rem 1rem",
    borderTop: "1px solid var(--border)",
    borderBottom: "1px solid var(--border)",
  }}
>
  <button
    onClick={() => acionar("sirene")}
    disabled={cmdSirene === "loading"}
    style={{
      flex: 1,
      padding: "0.5rem",
      borderRadius: 6,
      fontSize: 12,
      fontWeight: 600,
      border: "1px solid var(--border)",
      backgroundColor:
        cmdSirene === "ok"
          ? "var(--verde-dim, #14532d22)"
          : cmdSirene === "fallback"
          ? "var(--amarelo-dim, #92400e22)"
          : "var(--card)",
      color:
        cmdSirene === "ok"
          ? "var(--verde, #22c55e)"
          : cmdSirene === "fallback"
          ? "var(--amarelo, #f59e0b)"
          : "var(--text)",
      cursor: cmdSirene === "loading" ? "wait" : "pointer",
    }}
  >
    {cmdSirene === "loading"
      ? "Acionando..."
      : cmdSirene === "ok"
      ? "Sirene acionada"
      : cmdSirene === "fallback"
      ? "Ver no portal"
      : "Acionar sirene"}
  </button>

  <button
    onClick={() => acionar("bloqueio")}
    disabled={cmdBloqueio === "loading"}
    style={{
      flex: 1,
      padding: "0.5rem",
      borderRadius: 6,
      fontSize: 12,
      fontWeight: 600,
      border: `1px solid ${cmdBloqueio === "idle" ? "var(--vermelho, #ef4444)" : "var(--border)"}`,
      backgroundColor:
        cmdBloqueio === "ok"
          ? "var(--verde-dim, #14532d22)"
          : cmdBloqueio === "fallback"
          ? "var(--amarelo-dim, #92400e22)"
          : "var(--vermelho-dim, #7f1d1d22)",
      color:
        cmdBloqueio === "ok"
          ? "var(--verde, #22c55e)"
          : cmdBloqueio === "fallback"
          ? "var(--amarelo, #f59e0b)"
          : "var(--vermelho, #ef4444)",
      cursor: cmdBloqueio === "loading" ? "wait" : "pointer",
    }}
  >
    {cmdBloqueio === "loading"
      ? "Bloqueando..."
      : cmdBloqueio === "ok"
      ? "Motor bloqueado"
      : cmdBloqueio === "fallback"
      ? "Ver no portal"
      : "Bloquear motor"}
  </button>
</div>

{/* Fallback: link direto para o portal Unitrac quando endpoint nao confirmado */}
{(cmdSirene === "fallback" || cmdBloqueio === "fallback") && fallbackUrl && (
  <div
    style={{
      padding: "0.5rem 1rem",
      fontSize: 11,
      color: "var(--text-dim)",
      borderBottom: "1px solid var(--border)",
    }}
  >
    Acao nao confirmada.{" "}
    <a href={fallbackUrl} target="_blank" rel="noreferrer" style={{ color: "var(--accent)" }}>
      Abrir portal Unitrac
    </a>{" "}
    para acionar manualmente.
  </div>
)}
```

- [ ] **Step 4: Compilar e verificar**

```bash
npx tsc --noEmit
```

- [ ] **Step 5: Testar manualmente**

Com `UNITRAC_USUARIO` e `UNITRAC_SENHA` preenchidos em `.env.local`:
1. Abrir painel de um veiculo com alerta
2. Clicar "Acionar sirene" -- deve mostrar "Acionando..." e depois "Sirene acionada" OU "Ver no portal" (fallback)
3. Clicar "Bloquear motor" -- idem
4. Se fallback: link "Abrir portal Unitrac" deve abrir portal no veiculo correto

Sem credenciais configuradas:
- Botao deve retornar fallback imediatamente com link para o portal

- [ ] **Step 6: Commit**

```bash
git add src/lib/unitrac-comandos.ts src/app/(app)/components/PainelVeiculoAlerta.tsx
git commit -m "feat: botoes sirene e bloqueio no PainelVeiculoAlerta com fallback para portal"
```

> **Nota pos-producao:** Quando as credenciais forem testadas e o endpoint confirmado (interceptar rede no portal Unitrac logado e checar qual URL recebe o POST de comando), atualizar `candidatos` em `unitrac-comandos.ts` colocando o endpoint correto primeiro. O endpoint provavel e `/ajax/comando.php` ou similar no mesmo dominio.

---

### Task 8: Validacao final e push

**Files:**
- Nenhum novo arquivo

- [ ] **Step 1: Suite completa**

```bash
npx vitest run
npx tsc --noEmit
```
Esperado: tudo limpo.

- [ ] **Step 2: Checklist visual completo**

Abrir `http://localhost:3000` logado e verificar cada ponto:

1. Sidebar de alertas (380px) com cards críticos e atenção
2. Mapa full-height à direita (sem a sidebar de veículos do MapaMonitor)
3. Clicar marcador de veículo COM alerta (marcador vermelho) → `PainelVeiculoAlerta` abre no canto direito do mapa
4. Painel mostra velocidade, ignição, motivo do alerta e SLA
5. Botões Reconhecer/Resolver/Falso positivo funcionam (persistem no Supabase)
6. Fechar painel (x) fecha corretamente
7. AlertaSonoro: ativar → beep de confirmação; novo crítico → beepa automaticamente
8. FiltrosBar: "Crítico" filtra apenas críticos; "Limpar" volta ao total
9. Botão "Focar" num card de alerta → mapa voa para a posição do veículo
10. Seletor de cliente: trocar → alertas e mapa atualizam
11. `/monitoramento` redireciona para `/`
12. Nav exibe apenas "Central" e "Análise"

- [ ] **Step 3: Push**

```bash
git push
```

---

## Checklist pos-implementacao

- [ ] `npx vitest run` — zero falhas
- [ ] `npx tsc --noEmit` — zero erros TypeScript
- [ ] `/` exibe sidebar de alertas (380px) + mapa full-height
- [ ] Clicar marcador com alerta → PainelVeiculoAlerta com AcoesAlerta
- [ ] Auto-fly ao novo crítico funciona (map.flyTo)
- [ ] AlertaSonoro beep ao novo crítico
- [ ] Botão "Focar" num card → centraliza mapa no veículo
- [ ] FiltrosBar filtra corretamente alertas na sidebar
- [ ] Seletor de cliente funciona
- [ ] `/monitoramento` redireciona para `/`
- [ ] Nav: apenas "Central" e "Análise"
- [ ] Botoes sirene e bloqueio aparecem no PainelVeiculoAlerta
- [ ] Sem credenciais: retorna fallback com link para o portal
- [ ] Com credenciais: tenta acionar via portal autenticado
