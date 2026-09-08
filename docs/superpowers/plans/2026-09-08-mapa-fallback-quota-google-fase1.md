# Fallback de Mapa (Fase 1) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Quando a cota diária da chave do Google Maps estourar, a Central troca
automaticamente (sem F5, pra todos os operadores ao mesmo tempo) pro mapa de rua
OpenStreetMap self-hospedado, e volta sozinha pro Google quando a cota resetar. Além
disso, remove dois riscos de ToS achados durante a investigação: tile CARTO sem
registro e hotlink direto ao tile interno do Google (`mt1.google.com`) usados hoje em
`MapaMonitor.tsx`/`MapaFrota.tsx`.

**Architecture:** Detecção do erro só é possível no navegador (Google não emite evento
oficial pra "cota estourou", só pra falha de autenticação) — o cliente que detectar
avisa o backend via `POST /api/mapa-provider`; o backend guarda o estado numa tabela
singleton (`mapa_provider_estado`) que todas as telas já leem no mesmo polling de 30s
que já existe hoje. Retry pra voltar ao Google é feito por UM cliente por vez (não
todos em paralelo), coordenado pela mesma tabela. O mapa de rua no fallback usa tiles
vetoriais estáticos (PMTiles, gerados uma vez a partir de dado aberto OSM) servidos
como arquivo pelo Caddy já existente no Contabo — sem servidor de renderização vivo.

**Tech Stack:** Next.js (App Router) + TypeScript + Postgres (self-hospedado, Contabo)
+ `@react-google-maps/api` (mapa atual, intocado) + `maplibre-gl` (novo, mapa de
fallback) + PMTiles (Protomaps) + Docker (só pra rodar o `planetiler` uma vez, não como
serviço) + Caddy (já roda no Contabo, só ganha uma rota nova de arquivo estático).

**Spec:** `docs/superpowers/specs/2026-09-08-mapa-fallback-quota-google-design.md`

## Global Constraints

- Escopo desta Fase 1: só o mapa de RUA no fallback. Satélite fica indisponível
  durante o fallback (Fase 2, spec Decisão 5/8, fora deste plano).
- `MapaLeafletV2.tsx` (o componente Google atual) é modificado no MÍNIMO — só ganha um
  prop opcional novo, comportamento de hoje continua idêntico quando esse prop não é
  usado.
- O mapa de fallback (`MapaFallbackOSM.tsx`) em Fase 1 renderiza SÓ veículos
  (marcadores coloridos por `nivel`, clique) — não renderiza rastro, alvos de entrega,
  polígonos de favela/roubo de carga, nem tiroteios. Isso é decisão explícita de
  escopo (documentada aqui, não uma lacuna esquecida) — o objetivo da Fase 1 é o mapa
  nunca mais SUMIR por completo, não replicar 100% da funcionalidade visual do Google
  durante o período raro de fallback.
- Só o repo `MONITORAMENTO transmonseg` (definitivo) — `MONITORAMENTO TEMP` foi
  removido de produção em 27/08, não precisa replicar lá.
- Migração aplicada manualmente via `psql` no Contabo (padrão do projeto, sem migration
  runner automatizado) — próximo número disponível: `075`.
- Deploy é manual: `git pull && npm ci && npm run build && pm2 restart
  transmonseg-definitivo --update-env` no Contabo, depois de cada task que muda código
  em produção (não só no fim do plano inteiro) — mesmo padrão já usado nesta sessão.

---

## File Structure

| Arquivo | Ação | Responsabilidade |
|---|---|---|
| `scripts/migrations/contabo/075_mapa_provider_estado.sql` | Criar | Tabela singleton do estado do provider |
| `src/lib/mapa-provider.ts` | Criar | Tipos + reducer puro (`transicionar`) — testável sem DB/browser |
| `src/lib/mapa-provider.test.ts` | Criar | Testes do reducer |
| `src/app/api/mapa-provider/route.ts` | Criar | `GET` lê estado, `POST` aplica evento via reducer e grava |
| `src/lib/deteccao-cota-google.ts` | Criar | `matchErroCotaGoogle(texto): boolean` (pura, testada) + hook `useDetectorCotaGoogle` |
| `src/lib/deteccao-cota-google.test.ts` | Criar | Testes do matcher puro |
| `src/app/(app)/central-v2/MapaLeafletV2.tsx` | Modificar | Novo prop opcional `onQuotaExceeded?: () => void`, usa o hook |
| `src/app/(app)/central-v2/MapaFallbackOSM.tsx` | Criar | Mapa MapLibre+PMTiles, só veículos (Fase 1) |
| `src/app/(app)/central-v2/MapaComFallback.tsx` | Criar | Wrapper: polling do provider, escolhe qual mapa renderizar, orquestra retry |
| `src/app/(app)/central-v2/MonitorV2.tsx:20` | Modificar | 1 linha: import do dynamic aponta pro wrapper novo |
| `src/app/(app)/components/CamadaPMTiles.tsx` | Criar | Camada Leaflet reaproveitando `rj.pmtiles`, substitui CARTO |
| `src/app/(app)/components/MapaMonitor.tsx` | Modificar | Remove CARTO + hotlink Google, usa `CamadaPMTiles` |
| `src/app/(app)/components/MapaFrota.tsx` | Modificar | Remove CARTO + hotlink Google, usa `CamadaPMTiles` |
| `package.json` | Modificar | Adiciona `maplibre-gl`, `pmtiles`, `protomaps-leaflet` |
| (Contabo, fora do repo) `/etc/caddy/Caddyfile` | Modificar | Nova rota estática servindo o `.pmtiles` |
| (Contabo, fora do repo) `/srv/transmonseg/tiles/rj.pmtiles` | Criar (build) | Arquivo gerado pelo planetiler, servido pelo Caddy — reaproveitado por Central, MapaMonitor e MapaFrota |

---

### Task 1: Migração — tabela `mapa_provider_estado`

**Files:**
- Create: `scripts/migrations/contabo/075_mapa_provider_estado.sql`

**Interfaces:**
- Produces: tabela `mapa_provider_estado` com colunas `id smallint primary key
  default 1 check (id = 1)`, `provider text not null default 'google' check
  (provider in ('google','fallback'))`, `quota_excedida_em timestamptz`,
  `proxima_tentativa_em timestamptz`, `atualizado_em timestamptz not null default
  now()`. Uma única linha (`id=1`), inserida pela própria migração.

- [ ] **Step 1: Escrever a migração**

```sql
-- 075_mapa_provider_estado.sql
--
-- Estado singleton (1 linha só, id fixo em 1) de qual provedor de mapa a
-- Central deve usar: 'google' (padrao) ou 'fallback' (OSM self-hospedado),
-- quando a cota da chave do Google Maps estourar. Ver spec
-- docs/superpowers/specs/2026-09-08-mapa-fallback-quota-google-design.md.
--
-- Roda como app_service (mesmo usuario ja usado nas outras migracoes desta
-- sessao): psql "$DATABASE_URL" -f 075_mapa_provider_estado.sql

create table if not exists mapa_provider_estado (
  id smallint primary key default 1 check (id = 1),
  provider text not null default 'google' check (provider in ('google', 'fallback')),
  quota_excedida_em timestamptz,
  proxima_tentativa_em timestamptz,
  atualizado_em timestamptz not null default now()
);

insert into mapa_provider_estado (id, provider)
values (1, 'google')
on conflict (id) do nothing;

NOTIFY pgrst, 'reload schema';
```

- [ ] **Step 2: Aplicar no Contabo**

Run: `ssh transmonseg-vps "psql 'postgres://app_service:SENHA@localhost:5432/transmonseg' -f -" < scripts/migrations/contabo/075_mapa_provider_estado.sql`
(usar a mesma `DATABASE_URL` já presente em `/srv/transmonseg/definitivo/.env.production` no lugar de `SENHA`, não hardcodar em nenhum arquivo do repo)

Expected: `CREATE TABLE`, `INSERT 0 1` (ou `INSERT 0 0` se já rodou antes), `NOTIFY`.

- [ ] **Step 3: Verificar**

Run: `ssh transmonseg-vps "psql '...' -c 'select * from mapa_provider_estado;'"`
Expected: 1 linha, `provider='google'`.

- [ ] **Step 4: Commit**

```bash
git add scripts/migrations/contabo/075_mapa_provider_estado.sql
git commit -m "feat(mapa-provider): migração da tabela de estado do fallback de mapa"
```

---

### Task 2: Reducer puro — `src/lib/mapa-provider.ts`

**Files:**
- Create: `src/lib/mapa-provider.ts`
- Test: `src/lib/mapa-provider.test.ts`

**Interfaces:**
- Produces:
  - `type MapaProvider = "google" | "fallback"`
  - `type EventoMapaProvider = "quota_excedida" | "retry_sucesso" | "retry_falhou"`
  - `interface MapaProviderEstado { provider: MapaProvider; quotaExcedidaEm: string | null; proximaTentativaEm: string | null }`
  - `const RETRY_INTERVALO_MIN = 20`
  - `function transicionar(estado: MapaProviderEstado, evento: EventoMapaProvider, agoraIso: string): MapaProviderEstado`
  - `function deveTentarRetryAgora(estado: MapaProviderEstado, agoraIso: string): boolean`
- Consumes: nada (função pura, zero I/O)

- [ ] **Step 1: Escrever os testes (falhando)**

```typescript
// src/lib/mapa-provider.test.ts
import { describe, it, expect } from "vitest";
import { transicionar, deveTentarRetryAgora, RETRY_INTERVALO_MIN, type MapaProviderEstado } from "./mapa-provider";

const ESTADO_GOOGLE: MapaProviderEstado = {
  provider: "google",
  quotaExcedidaEm: null,
  proximaTentativaEm: null,
};

describe("transicionar", () => {
  it("quota_excedida a partir de 'google' -- vira fallback e agenda retry em RETRY_INTERVALO_MIN", () => {
    const agora = "2026-09-08T18:00:00.000Z";
    const r = transicionar(ESTADO_GOOGLE, "quota_excedida", agora);
    expect(r.provider).toBe("fallback");
    expect(r.quotaExcedidaEm).toBe(agora);
    expect(r.proximaTentativaEm).toBe("2026-09-08T18:20:00.000Z");
  });

  it("retry_sucesso a partir de 'fallback' -- volta pra google e limpa os timestamps", () => {
    const emFallback: MapaProviderEstado = {
      provider: "fallback",
      quotaExcedidaEm: "2026-09-08T18:00:00.000Z",
      proximaTentativaEm: "2026-09-08T18:20:00.000Z",
    };
    const r = transicionar(emFallback, "retry_sucesso", "2026-09-08T18:20:05.000Z");
    expect(r).toEqual({ provider: "google", quotaExcedidaEm: null, proximaTentativaEm: null });
  });

  it("retry_falhou a partir de 'fallback' -- continua fallback, empurra proximaTentativaEm mais RETRY_INTERVALO_MIN", () => {
    const emFallback: MapaProviderEstado = {
      provider: "fallback",
      quotaExcedidaEm: "2026-09-08T18:00:00.000Z",
      proximaTentativaEm: "2026-09-08T18:20:00.000Z",
    };
    const r = transicionar(emFallback, "retry_falhou", "2026-09-08T18:20:05.000Z");
    expect(r.provider).toBe("fallback");
    expect(r.quotaExcedidaEm).toBe("2026-09-08T18:00:00.000Z"); // preserva o original
    expect(r.proximaTentativaEm).toBe("2026-09-08T18:40:05.000Z");
  });

  it("quota_excedida de novo enquanto ja esta em fallback -- idempotente, so' reagenda o retry a partir de agora", () => {
    const emFallback: MapaProviderEstado = {
      provider: "fallback",
      quotaExcedidaEm: "2026-09-08T18:00:00.000Z",
      proximaTentativaEm: "2026-09-08T18:20:00.000Z",
    };
    const r = transicionar(emFallback, "quota_excedida", "2026-09-08T18:05:00.000Z");
    expect(r.provider).toBe("fallback");
    expect(r.proximaTentativaEm).toBe("2026-09-08T18:25:00.000Z");
  });
});

describe("deveTentarRetryAgora", () => {
  it("false quando provider e' google (nao ha' retry a fazer)", () => {
    expect(deveTentarRetryAgora(ESTADO_GOOGLE, "2026-09-08T18:00:00.000Z")).toBe(false);
  });

  it("false quando ainda nao chegou a proximaTentativaEm", () => {
    const emFallback: MapaProviderEstado = {
      provider: "fallback",
      quotaExcedidaEm: "2026-09-08T18:00:00.000Z",
      proximaTentativaEm: "2026-09-08T18:20:00.000Z",
    };
    expect(deveTentarRetryAgora(emFallback, "2026-09-08T18:19:59.000Z")).toBe(false);
  });

  it("true quando ja passou da proximaTentativaEm", () => {
    const emFallback: MapaProviderEstado = {
      provider: "fallback",
      quotaExcedidaEm: "2026-09-08T18:00:00.000Z",
      proximaTentativaEm: "2026-09-08T18:20:00.000Z",
    };
    expect(deveTentarRetryAgora(emFallback, "2026-09-08T18:20:01.000Z")).toBe(true);
  });
});
```

- [ ] **Step 2: Rodar e confirmar que falha**

Run: `npx vitest run src/lib/mapa-provider.test.ts`
Expected: FAIL — `Cannot find module './mapa-provider'`

- [ ] **Step 3: Implementar**

```typescript
// src/lib/mapa-provider.ts
export type MapaProvider = "google" | "fallback";
export type EventoMapaProvider = "quota_excedida" | "retry_sucesso" | "retry_falhou";

export interface MapaProviderEstado {
  provider: MapaProvider;
  quotaExcedidaEm: string | null;
  proximaTentativaEm: string | null;
}

// Ver spec 2026-09-08-mapa-fallback-quota-google-design.md, Decisao 7 --
// 20min escolhido dentro da janela 15-30min aprovada pelo usuario, equilibra
// "volta rapido quando o Google normaliza" com "nao gasta cota de novo
// tentando toda hora" (pior caso ~40-50 tentativas extras num dia inteiro
// de fallback).
export const RETRY_INTERVALO_MIN = 20;

function somarMinutos(iso: string, minutos: number): string {
  return new Date(new Date(iso).getTime() + minutos * 60_000).toISOString();
}

export function transicionar(
  estado: MapaProviderEstado,
  evento: EventoMapaProvider,
  agoraIso: string
): MapaProviderEstado {
  switch (evento) {
    case "quota_excedida":
      return {
        provider: "fallback",
        quotaExcedidaEm: estado.quotaExcedidaEm ?? agoraIso,
        proximaTentativaEm: somarMinutos(agoraIso, RETRY_INTERVALO_MIN),
      };
    case "retry_sucesso":
      return { provider: "google", quotaExcedidaEm: null, proximaTentativaEm: null };
    case "retry_falhou":
      return {
        provider: "fallback",
        quotaExcedidaEm: estado.quotaExcedidaEm,
        proximaTentativaEm: somarMinutos(agoraIso, RETRY_INTERVALO_MIN),
      };
  }
}

export function deveTentarRetryAgora(estado: MapaProviderEstado, agoraIso: string): boolean {
  if (estado.provider !== "fallback" || !estado.proximaTentativaEm) return false;
  return new Date(agoraIso).getTime() >= new Date(estado.proximaTentativaEm).getTime();
}
```

Nota no Step 1, teste "quota_excedida de novo": `estado.quotaExcedidaEm ?? agoraIso` preserva o
timestamp ORIGINAL do primeiro evento (não reseta pra "agora" a cada redetecção) — no teste dado
o estado de entrada já tem `quotaExcedidaEm` setado, então o resultado mantém `"2026-09-08T18:00:00.000Z"`,
só `proximaTentativaEm` avança. Confirme isso ao rodar o teste antes de seguir pro Step 4.

- [ ] **Step 4: Rodar e confirmar que passa**

Run: `npx vitest run src/lib/mapa-provider.test.ts`
Expected: PASS (7 testes)

- [ ] **Step 5: Commit**

```bash
git add src/lib/mapa-provider.ts src/lib/mapa-provider.test.ts
git commit -m "feat(mapa-provider): reducer puro de transição de estado google/fallback"
```

---

### Task 3: API route — `src/app/api/mapa-provider/route.ts`

**Files:**
- Create: `src/app/api/mapa-provider/route.ts`

**Interfaces:**
- Consumes: `transicionar`, `type MapaProviderEstado`, `type EventoMapaProvider` de `@/lib/mapa-provider`; `createClient` de `@/lib/supabase/server` (auth); `configPoolContabo` de `@/lib/supabase/contabo-ca`.
- Produces: `GET` retorna `{ provider, quotaExcedidaEm, proximaTentativaEm }`. `POST` com body `{ evento: EventoMapaProvider }` aplica a transição e retorna o novo estado no mesmo formato.

Este projeto não mocka o `pg.Pool` em teste (confirmado: nenhuma rota com
acesso a banco tem `route.test.ts` mockando `pg` — só funções puras são
testadas com Vitest, rota em si é verificada manualmente contra o Postgres
real, mesmo padrão usado o dia inteiro nesta sessão). Este task não tem
step de teste automatizado — a verificação é manual no Step 3.

- [ ] **Step 1: Implementar a rota**

```typescript
// src/app/api/mapa-provider/route.ts
//
// Estado compartilhado de qual mapa a Central deve renderizar (Google ou
// fallback OSM self-hospedado), ver spec
// docs/superpowers/specs/2026-09-08-mapa-fallback-quota-google-design.md.
// GET e' lido por toda tela que monta o mapa, no mesmo polling de 30s que
// ja existe hoje (nao introduz intervalo novo). POST e' chamado pelo
// navegador quando detecta o erro de cota do Google (deteccao-cota-google.ts)
// ou quando termina uma tentativa de retry.

import pg from "pg";
import { createClient } from "@/lib/supabase/server";
import { configPoolContabo } from "@/lib/supabase/contabo-ca";
import { transicionar, type EventoMapaProvider, type MapaProviderEstado } from "@/lib/mapa-provider";

function linhaParaEstado(row: {
  provider: string;
  quota_excedida_em: string | null;
  proxima_tentativa_em: string | null;
}): MapaProviderEstado {
  return {
    provider: row.provider as MapaProviderEstado["provider"],
    quotaExcedidaEm: row.quota_excedida_em,
    proximaTentativaEm: row.proxima_tentativa_em,
  };
}

export async function GET() {
  const auth = await createClient();
  const { data: { user } } = await auth.auth.getUser();
  if (!user) return Response.json({ erro: "nao autorizado" }, { status: 401 });

  const pool = new pg.Pool({ ...configPoolContabo(process.env.DATABASE_URL), max: 2 });
  try {
    const { rows } = await pool.query(
      `SELECT provider, quota_excedida_em, proxima_tentativa_em FROM mapa_provider_estado WHERE id = 1`
    );
    if (rows.length === 0) {
      return Response.json({ erro: "estado do mapa nao inicializado (migracao 075 rodou?)" }, { status: 500 });
    }
    return Response.json(linhaParaEstado(rows[0]));
  } finally {
    await pool.end();
  }
}

const EVENTOS_VALIDOS: EventoMapaProvider[] = ["quota_excedida", "retry_sucesso", "retry_falhou"];

export async function POST(request: Request) {
  const auth = await createClient();
  const { data: { user } } = await auth.auth.getUser();
  if (!user) return Response.json({ erro: "nao autorizado" }, { status: 401 });

  const body = await request.json().catch(() => null);
  const evento = body?.evento as EventoMapaProvider | undefined;
  if (!evento || !EVENTOS_VALIDOS.includes(evento)) {
    return Response.json({ erro: `evento invalido, esperado um de: ${EVENTOS_VALIDOS.join(", ")}` }, { status: 400 });
  }

  const pool = new pg.Pool({ ...configPoolContabo(process.env.DATABASE_URL), max: 2 });
  try {
    const { rows } = await pool.query(
      `SELECT provider, quota_excedida_em, proxima_tentativa_em FROM mapa_provider_estado WHERE id = 1`
    );
    if (rows.length === 0) {
      return Response.json({ erro: "estado do mapa nao inicializado (migracao 075 rodou?)" }, { status: 500 });
    }
    const estadoAtual = linhaParaEstado(rows[0]);
    const agoraIso = new Date().toISOString();
    const novoEstado = transicionar(estadoAtual, evento, agoraIso);

    await pool.query(
      `UPDATE mapa_provider_estado
          SET provider = $1, quota_excedida_em = $2, proxima_tentativa_em = $3, atualizado_em = now()
        WHERE id = 1`,
      [novoEstado.provider, novoEstado.quotaExcedidaEm, novoEstado.proximaTentativaEm]
    );
    return Response.json(novoEstado);
  } finally {
    await pool.end();
  }
}
```

- [ ] **Step 2: Deploy no Contabo**

Run: `git add src/app/api/mapa-provider/route.ts && git commit -m "feat(mapa-provider): rota GET/POST do estado do fallback de mapa" && git push origin main`
Depois: `ssh transmonseg-vps "cd /srv/transmonseg/definitivo && git pull && npm ci && npm run build && pm2 restart transmonseg-definitivo --update-env"`

- [ ] **Step 3: Verificar manualmente contra produção real**

Run (dentro do Contabo, ou local com a mesma URL pública + cookie de sessão de um login real — mais simples direto no Contabo via `curl` local na porta do processo):
```
ssh transmonseg-vps "curl -s -X POST http://127.0.0.1:3010/api/mapa-provider -H 'Content-Type: application/json' -d '{\"evento\":\"quota_excedida\"}' -H 'Cookie: <cookie de sessao real>'"
```
Expected: `401` sem cookie válido (confirma que a autenticação está ativa); com cookie de uma sessão logada real, `{"provider":"fallback","quotaExcedidaEm":"...","proximaTentativaEm":"..."}`.

Run: `ssh transmonseg-vps "psql '...' -c 'select * from mapa_provider_estado;'"` — confirma que a linha no banco bateu com a resposta.

Depois de confirmar, reverter manualmente pro estado normal antes de seguir:
`ssh transmonseg-vps "psql '...' -c \"update mapa_provider_estado set provider='google', quota_excedida_em=null, proxima_tentativa_em=null where id=1;\""`

---

### Task 4: Detector de cota — `src/lib/deteccao-cota-google.ts`

**Files:**
- Create: `src/lib/deteccao-cota-google.ts`
- Test: `src/lib/deteccao-cota-google.test.ts`

**Interfaces:**
- Produces:
  - `function matchErroCotaGoogle(texto: string): boolean` (pura, testada)
  - `function instalarDetectorCotaGoogle(container: HTMLElement, onDetectado: () => void): () => void` — instala a interceptação de `console.error` + `MutationObserver` no `container`, chama `onDetectado()` no máximo 1 vez, retorna uma função de limpeza (remove o observer, restaura `console.error` original). Não testado automaticamente (ver nota abaixo) — verificado manualmente no Task 9.
- Consumes: nada de outro arquivo deste plano.

Nota: o projeto não tem ambiente jsdom configurado no Vitest (comentário em
`vitest.config.ts` é explícito: "nada de mexer em include/environment").
`matchErroCotaGoogle` é pura (string → boolean) e testável em qualquer
ambiente; `instalarDetectorCotaGoogle` usa `MutationObserver`/`console`
reais do navegador — fica de fora dos testes automatizados, igual a
qualquer outro código de integração com Google Maps neste projeto
(`MapaLeafletV2.tsx` inteiro também não tem teste automatizado hoje).

- [ ] **Step 1: Escrever o teste do matcher (falhando)**

```typescript
// src/lib/deteccao-cota-google.test.ts
import { describe, it, expect } from "vitest";
import { matchErroCotaGoogle } from "./deteccao-cota-google";

describe("matchErroCotaGoogle", () => {
  it("reconhece a mensagem real do incidente de 08/09", () => {
    expect(
      matchErroCotaGoogle(
        "Maps Demo Key limit reached: Your daily quota for Maps JavaScript 2D has been met. To continue without interruption and get higher limits, upgrade your account."
      )
    ).toBe(true);
  });

  it("reconhece BillingNotEnabledMapError", () => {
    expect(matchErroCotaGoogle("Google Maps JavaScript API error: BillingNotEnabledMapError")).toBe(true);
  });

  it("reconhece ApiNotActivatedMapError", () => {
    expect(matchErroCotaGoogle("Google Maps JavaScript API error: ApiNotActivatedMapError")).toBe(true);
  });

  it("reconhece qualquer mencao generica a 'quota' vinda do dominio googleapis", () => {
    expect(matchErroCotaGoogle("dadosRouboCarga: falha ao atualizar, servindo cache antigo se houver: quota exceeded")).toBe(true);
  });

  it("nao reconhece mensagem de erro nao relacionada", () => {
    expect(matchErroCotaGoogle("TypeError: Cannot read properties of undefined (reading 'foo')")).toBe(false);
  });

  it("nao reconhece string vazia", () => {
    expect(matchErroCotaGoogle("")).toBe(false);
  });
});
```

- [ ] **Step 2: Rodar e confirmar que falha**

Run: `npx vitest run src/lib/deteccao-cota-google.test.ts`
Expected: FAIL — `Cannot find module './deteccao-cota-google'`

- [ ] **Step 3: Implementar**

```typescript
// src/lib/deteccao-cota-google.ts
//
// Ver spec docs/superpowers/specs/2026-09-08-mapa-fallback-quota-google-design.md,
// Decisao 2. Google nao tem evento oficial pra "cota estourou" (gm_authFailure
// so' dispara pra falha de autenticacao) -- deteccao real via texto de erro
// conhecido, achado ao vivo no incidente de 08/09 (ver console do navegador
// em producao naquele dia): "Maps Demo Key limit reached...".

const PADRAO_ERRO_COTA = /demo key limit reached|billingnotenabledmaperror|apinotactivatedmaperror|quota/i;

export function matchErroCotaGoogle(texto: string): boolean {
  if (!texto) return false;
  return PADRAO_ERRO_COTA.test(texto);
}

export function instalarDetectorCotaGoogle(container: HTMLElement, onDetectado: () => void): () => void {
  let disparado = false;
  const disparar = () => {
    if (disparado) return;
    disparado = true;
    onDetectado();
  };

  const consoleErrorOriginal = console.error;
  console.error = (...args: unknown[]) => {
    const texto = args.map((a) => (typeof a === "string" ? a : "")).join(" ");
    if (matchErroCotaGoogle(texto)) disparar();
    consoleErrorOriginal(...args);
  };

  const observer = new MutationObserver(() => {
    if (matchErroCotaGoogle(container.textContent ?? "")) disparar();
  });
  observer.observe(container, { childList: true, subtree: true, characterData: true });

  return () => {
    console.error = consoleErrorOriginal;
    observer.disconnect();
  };
}
```

- [ ] **Step 4: Rodar e confirmar que passa**

Run: `npx vitest run src/lib/deteccao-cota-google.test.ts`
Expected: PASS (6 testes)

- [ ] **Step 5: Commit**

```bash
git add src/lib/deteccao-cota-google.ts src/lib/deteccao-cota-google.test.ts
git commit -m "feat(mapa-provider): detector de erro de cota do Google Maps"
```

---

### Task 5: Wire do detector em `MapaLeafletV2.tsx`

**Files:**
- Modify: `src/app/(app)/central-v2/MapaLeafletV2.tsx`

**Interfaces:**
- Consumes: `instalarDetectorCotaGoogle` de `@/lib/deteccao-cota-google`
- Produces: novo prop opcional em `Props`: `onQuotaExceeded?: () => void`

O componente já expõe uma ref do container do mapa via `onLoad` (linha ~493,
`const onLoad = useCallback((m: google.maps.Map) => {...})`) e mantém
`map` em estado (linha ~449). Vamos instalar o detector no elemento DOM do
mapa assim que ele existir.

- [ ] **Step 1: Adicionar o prop na interface `Props`**

Em `src/app/(app)/central-v2/MapaLeafletV2.tsx`, dentro de `export interface Props { ... }` (linha 77-113), adicionar:

```typescript
  onQuotaExceeded?: () => void;
  // Chamado quando o mapa termina de instanciar (mesmo momento do onLoad
  // interno). Task 9 (MapaComFallback) usa isso como ponto de partida pra
  // decidir, com um sinal real (nao silencio ambiguo), se o retry ao
  // Google teve sucesso -- ver nota na Decisao 7 da spec e Task 9 deste
  // plano.
  onMapLoaded?: () => void;
```

- [ ] **Step 2: Importar e instalar o detector**

No topo do arquivo, junto aos outros imports:

```typescript
import { instalarDetectorCotaGoogle } from "@/lib/deteccao-cota-google";
```

O `onLoad` do `<GoogleMap>` já existe em `src/app/(app)/central-v2/MapaLeafletV2.tsx:493`:

```typescript
  const onLoad = useCallback((m: google.maps.Map) => {
    setMap(m);
    // Injeta CSS para sobrescrever o fundo branco nativo do InfoWindow do Google Maps
    ...
```

Adicionar `onMapLoaded?.();` logo depois de `setMap(m);` nessa mesma função (não criar
um segundo `onLoad`) — resultado:

```typescript
  const onLoad = useCallback((m: google.maps.Map) => {
    setMap(m);
    onMapLoaded?.();
    // Injeta CSS para sobrescrever o fundo branco nativo do InfoWindow do Google Maps
    ...
```

Depois, adicionar um `useEffect` que instala o detector quando `map` existir:

```typescript
  useEffect(() => {
    if (!map || !onQuotaExceeded) return;
    const container = map.getDiv();
    return instalarDetectorCotaGoogle(container, onQuotaExceeded);
  }, [map, onQuotaExceeded]);
```

(`map.getDiv()` é API pública documentada do `google.maps.Map`, retorna o elemento DOM
onde o mapa é renderizado — é ali que o Google injeta o banner "Oops!" quando falha.)

- [ ] **Step 3: Verificar que nada quebrou (sem `onQuotaExceeded` passado)**

Run: `npx vitest run` (suíte completa)
Expected: mesma contagem de testes passando de antes desta mudança (este arquivo não
tinha testes próprios antes, então nenhum teste novo quebra — a suíte inteira do
projeto continua verde).

Run: `npx tsc --noEmit` (ou `npm run build` local, mais lento mas mais completo)
Expected: sem erro de tipo novo.

- [ ] **Step 4: Commit**

```bash
git add "src/app/(app)/central-v2/MapaLeafletV2.tsx"
git commit -m "feat(mapa-provider): MapaLeafletV2 detecta e avisa erro de cota do Google"
```

---

### Task 6: Build do PMTiles (infra, uma vez)

**Files:**
- Nenhum arquivo do repo — trabalho de infraestrutura no Contabo, documentado aqui pra
  ser reproduzível.

**Interfaces:**
- Produces: arquivo `/srv/transmonseg/tiles/rj.pmtiles` no Contabo.

Bounding box real calculado a partir de `posicoes_historico` (14 dias, filtrado pra
excluir os pontos fantasmas (0,0) já documentados no projeto):
lat `-23.55` a `-20.86`, lng `-47.45` a `-40.96` — com margem de ~0.4 grau (~40km) pra
não cortar trajeto legítimo de trânsito longo (`LIMIAR_TRANSITO_LONGO_M` do detector já
permite até 300km): `-23.9,-47.9,-20.5,-40.5` (formato minLat,minLng,maxLat,maxLng).

- [ ] **Step 1: Baixar o extrato OSM da região Sudeste**

Geofabrik não corta por estado nessa região (só por região macro) — o extrato
"sudeste" cobre RJ+SP+MG+ES, maior que o necessário, mas o corte fino é feito no
Step 2 via `--bounds` do planetiler.

Run:
```bash
ssh transmonseg-vps "mkdir -p /srv/transmonseg/tiles-build && cd /srv/transmonseg/tiles-build && curl -L -o sudeste-latest.osm.pbf https://download.geofabrik.de/south-america/brazil/sudeste-latest.osm.pbf"
```
Expected: download completo (arquivo de alguns GB — checar `ls -lh` depois).

- [ ] **Step 2: Rodar o planetiler via Docker, recortando pra bounding box da frota**

Run:
```bash
ssh transmonseg-vps "docker run --rm -v /srv/transmonseg/tiles-build:/data ghcr.io/onthegomap/planetiler:latest \
  --download=false --osm-path=/data/sudeste-latest.osm.pbf \
  --bounds=-47.9,-23.9,-40.5,-20.5 \
  --output=/data/rj.pmtiles"
```
(formato do `--bounds` do planetiler é `minLng,minLat,maxLng,maxLat` — confirmar na
saída do comando/`--help` se a versão baixada usa essa ordem antes de rodar, planetiler
já teve mudança de ordem de argumento entre versões maiores)

Expected: processo roda (leva alguns minutos), termina com `rj.pmtiles` criado em
`/srv/transmonseg/tiles-build/`.

- [ ] **Step 3: Mover pro destino final servido pelo Caddy**

Run:
```bash
ssh transmonseg-vps "mkdir -p /srv/transmonseg/tiles && mv /srv/transmonseg/tiles-build/rj.pmtiles /srv/transmonseg/tiles/rj.pmtiles && ls -lh /srv/transmonseg/tiles/rj.pmtiles"
```
Expected: arquivo presente, tamanho razoável (dezenas a poucas centenas de MB — se vier
muito maior que ~500MB, o bounds provavelmente não foi aplicado corretamente, revisar
Step 2 antes de seguir).

- [ ] **Step 4: Limpar o extrato bruto (não precisa mais, já foi processado)**

Run: `ssh transmonseg-vps "rm -rf /srv/transmonseg/tiles-build"`

(Este task não tem "commit" — é infraestrutura fora do repo. Documentar no `ESTADO.md`
do projeto, ver Task 10, Step final.)

---

### Task 7: Caddy serve o PMTiles como arquivo estático

**Files:**
- Modify (Contabo, fora do repo): `/etc/caddy/Caddyfile`

**Interfaces:**
- Produces: `https://monitoramento.transmonseg.com.br/tiles/rj.pmtiles` acessível via
  HTTP range-request (obrigatório — PMTiles não baixa o arquivo inteiro, lê ranges de
  bytes sob demanda).

- [ ] **Step 1: Localizar o bloco do site principal no Caddyfile**

Run: `ssh transmonseg-vps "grep -n 'monitoramento.transmonseg.com.br' /etc/caddy/Caddyfile"`

- [ ] **Step 2: Adicionar a rota de arquivo estático dentro desse bloco**

Editar `/etc/caddy/Caddyfile` no Contabo (via `ssh` + editor, ou heredoc), adicionar
DENTRO do bloco `monitoramento.transmonseg.com.br { ... }` (Caddy já lida com
range-request nativamente pra `file_server`, não precisa de config extra pra isso):

```caddyfile
  handle_path /tiles/* {
    root * /srv/transmonseg/tiles
    file_server
  }
```

- [ ] **Step 3: Validar a config antes de recarregar**

Run: `ssh transmonseg-vps "caddy validate --config /etc/caddy/Caddyfile"`
Expected: sem erro.

- [ ] **Step 4: Recarregar o Caddy (sem downtime)**

Run: `ssh transmonseg-vps "systemctl reload caddy"`

- [ ] **Step 5: Verificar que o arquivo responde com range-request**

Run: `curl -sI -H "Range: bytes=0-1023" "https://monitoramento.transmonseg.com.br/tiles/rj.pmtiles"`
Expected: `HTTP/1.1 206 Partial Content` (ou `HTTP/2 206`), não `200` nem `404`.

---

### Task 8: `MapaFallbackOSM.tsx` — mapa MapLibre + PMTiles (só veículos)

**Files:**
- Modify: `package.json` (adiciona `maplibre-gl`)
- Create: `src/app/(app)/central-v2/MapaFallbackOSM.tsx`

**Interfaces:**
- Consumes: `VeiculoMapa`, `type MapTokens` (mesmos tipos já exportados por
  `MapaLeafletV2.tsx`/`./tokens`, reaproveitados sem duplicar)
- Produces: componente default export com props
  `{ veiculosMapa: VeiculoMapa[]; onVeiculoClick: (vm: VeiculoMapa) => void; mapTokens: MapTokens; tema: "dark" | "light" }`
  — subconjunto deliberado de `Props` (ver Global Constraints, escopo Fase 1).

- [ ] **Step 1: Instalar a dependência**

Run: `npm install maplibre-gl@^6.8.0`

- [ ] **Step 2: Implementar o componente**

```typescript
// src/app/(app)/central-v2/MapaFallbackOSM.tsx
"use client";

// Mapa de fallback quando a cota do Google Maps estoura (ver spec
// docs/superpowers/specs/2026-09-08-mapa-fallback-quota-google-design.md).
// Fase 1, escopo deliberadamente reduzido: so' veiculos (marcador + clique).
// Sem rastro/alvos/favela/tiroteio/roubo-carga nesta fase -- ver
// Global Constraints do plano de implementacao.

import { useEffect, useRef } from "react";
import maplibregl from "maplibre-gl";
import "maplibre-gl/dist/maplibre-gl.css";
import type { VeiculoMapa } from "./MapaLeafletV2";
import type { MapTokens } from "./tokens";

export interface PropsFallback {
  veiculosMapa: VeiculoMapa[];
  onVeiculoClick: (vm: VeiculoMapa) => void;
  mapTokens: MapTokens;
  tema: "dark" | "light";
}

const CENTER_DEFAULT: [number, number] = [-43.2, -22.9];

// Estilo minimo apontando pro PMTiles self-hospedado -- fonte "rj" e' o
// arquivo gerado no Task 6/servido no Task 7. Paleta escura por padrao
// (ver mapTokens pra variar por tema no futuro, Fase 1 fixa em um so').
function estiloMapLibre(): maplibregl.StyleSpecification {
  return {
    version: 8,
    sources: {
      rj: { type: "vector", url: "pmtiles:///tiles/rj.pmtiles" },
    },
    layers: [
      { id: "fundo", type: "background", paint: { "background-color": "#1a1a1a" } },
      {
        id: "estradas",
        type: "line",
        source: "rj",
        "source-layer": "transportation",
        paint: { "line-color": "#555", "line-width": 1 },
      },
      {
        id: "agua",
        type: "fill",
        source: "rj",
        "source-layer": "water",
        paint: { "fill-color": "#0d2b3a" },
      },
    ],
  };
}

export default function MapaFallbackOSM({ veiculosMapa, onVeiculoClick, mapTokens }: PropsFallback) {
  const containerRef = useRef<HTMLDivElement>(null);
  const mapRef = useRef<maplibregl.Map | null>(null);
  const markersRef = useRef<maplibregl.Marker[]>([]);

  useEffect(() => {
    if (!containerRef.current) return;
    const map = new maplibregl.Map({
      container: containerRef.current,
      style: estiloMapLibre(),
      center: CENTER_DEFAULT,
      zoom: 9,
    });
    mapRef.current = map;
    return () => {
      map.remove();
      mapRef.current = null;
    };
  }, []);

  useEffect(() => {
    const map = mapRef.current;
    if (!map) return;
    markersRef.current.forEach((m) => m.remove());
    markersRef.current = veiculosMapa
      .filter((vm) => vm.lat != null && vm.lng != null)
      .map((vm) => {
        const cor = vm.nivel === "vermelho" ? "#e11" : vm.nivel === "amarelo" ? "#eb1" : "#3a3";
        const el = document.createElement("div");
        el.style.cssText = `width:14px;height:14px;border-radius:50%;background:${cor};border:2px solid #fff;cursor:pointer;`;
        el.addEventListener("click", () => onVeiculoClick(vm));
        return new maplibregl.Marker({ element: el }).setLngLat([vm.lng as number, vm.lat as number]).addTo(map);
      });
  }, [veiculosMapa, onVeiculoClick]);

  return (
    <div style={{ position: "relative", width: "100%", height: "100%" }}>
      <div
        style={{
          position: "absolute", top: 8, left: 8, zIndex: 10,
          background: mapTokens.corFundoPainel ?? "#222", color: "#fff",
          padding: "4px 10px", borderRadius: 6, fontSize: 12,
        }}
      >
        Mapa de reserva (Google indisponível) — satélite indisponível neste modo
      </div>
      <div ref={containerRef} style={{ width: "100%", height: "100%" }} />
    </div>
  );
}
```

Nota: `mapTokens.corFundoPainel` é um palpite de nome de campo — checar o `type
MapTokens` real em `src/app/(app)/central-v2/tokens.ts` antes de escrever este código
e ajustar pro nome de campo que existir de fato (se não existir nenhum campo de cor de
painel, usar um valor fixo tipo `"#222"` e remover a dependência de `mapTokens` nesse
badge — não é crítico, é só o aviso visual do modo fallback).

Nota 2: `pmtiles://` como protocolo de URL de source do MapLibre requer registrar o
protocol handler da lib `pmtiles` (pacote `pmtiles`, não confundir com o formato de
arquivo) — adicionar `npm install pmtiles` e, antes de criar o mapa no Step 2, uma vez
por app (ex. no topo do arquivo, fora do componente):
```typescript
import { Protocol } from "pmtiles";
const protocol = new Protocol();
maplibregl.addProtocol("pmtiles", protocol.tile);
```

- [ ] **Step 3: Verificar tipos**

Run: `npx tsc --noEmit`
Expected: sem erro novo (ajustar o nome de campo de `mapTokens` do Step 2/Nota se
necessário até isso passar).

- [ ] **Step 4: Commit**

```bash
git add package.json package-lock.json "src/app/(app)/central-v2/MapaFallbackOSM.tsx"
git commit -m "feat(mapa-provider): mapa de fallback MapLibre+PMTiles (Fase 1, so veiculos)"
```

---

### Task 9: `MapaComFallback.tsx` — wrapper de orquestração

**Files:**
- Create: `src/app/(app)/central-v2/MapaComFallback.tsx`

**Interfaces:**
- Consumes: `MapaLeafletV2` (default export) e `type Props` de `./MapaLeafletV2`,
  incluindo os dois props opcionais adicionados no Task 5
  (`onQuotaExceeded?: () => void`, `onMapLoaded?: () => void`); `MapaFallbackOSM` de
  `./MapaFallbackOSM`; `type MapaProviderEstado`, `deveTentarRetryAgora` de
  `@/lib/mapa-provider`.
- Produces: default export com a MESMA assinatura de `Props` de `MapaLeafletV2` —
  drop-in replacement pro `dynamic(() => import(...))` do `MonitorV2.tsx`.

- [ ] **Step 1: Implementar o wrapper**

```typescript
// src/app/(app)/central-v2/MapaComFallback.tsx
"use client";

// Escolhe entre o mapa real (Google) e o de fallback (OSM) com base no
// estado compartilhado em mapa_provider_estado, e orquestra o retry
// automatico pra voltar ao Google. Ver spec
// docs/superpowers/specs/2026-09-08-mapa-fallback-quota-google-design.md.
//
// Drop-in: mesma assinatura de Props que MapaLeafletV2 -- so' este arquivo
// precisa trocar no import dynamic() de MonitorV2.tsx.

import { useEffect, useState, useCallback } from "react";
import MapaLeafletV2, { type Props } from "./MapaLeafletV2";
import MapaFallbackOSM from "./MapaFallbackOSM";
import { deveTentarRetryAgora, type MapaProviderEstado } from "@/lib/mapa-provider";

const POLL_MS = 30_000; // mesmo intervalo ja usado pelo resto da Central

async function buscarEstado(): Promise<MapaProviderEstado | null> {
  const r = await fetch("/api/mapa-provider");
  if (!r.ok) return null;
  return r.json();
}

async function postarEvento(evento: "quota_excedida" | "retry_sucesso" | "retry_falhou") {
  await fetch("/api/mapa-provider", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ evento }),
  }).catch(() => {});
}

export default function MapaComFallback(props: Props) {
  const [estado, setEstado] = useState<MapaProviderEstado | null>(null);
  const [tentandoRetry, setTentandoRetry] = useState(false);
  // Timestamp de quando o probe oculto do Google confirmou onMapLoaded
  // nesta tentativa de retry -- null enquanto nao carregou ainda (ou antes
  // de iniciar). Ver ProbeRetry mais abaixo pra como isso decide
  // sucesso/falha do retry com um sinal real.
  const [mapaCarregouEm, setMapaCarregouEm] = useState<number | null>(null);

  useEffect(() => {
    let ativo = true;
    const ciclo = async () => {
      const novoEstado = await buscarEstado();
      if (ativo && novoEstado) setEstado(novoEstado);
    };
    ciclo();
    const t = setInterval(ciclo, POLL_MS);
    return () => { ativo = false; clearInterval(t); };
  }, []);

  const onQuotaExceeded = useCallback(() => {
    postarEvento("quota_excedida").then(async () => setEstado(await buscarEstado()));
  }, []);

  const iniciarRetry = useCallback(() => {
    setMapaCarregouEm(null);
    setTentandoRetry(true);
  }, []);

  const onRetrySucesso = useCallback(() => {
    setTentandoRetry(false);
    postarEvento("retry_sucesso").then(async () => setEstado(await buscarEstado()));
  }, []);

  const onRetryFalhou = useCallback(() => {
    setTentandoRetry(false);
    postarEvento("retry_falhou").then(async () => setEstado(await buscarEstado()));
  }, []);

  useEffect(() => {
    if (!estado || tentandoRetry) return;
    if (deveTentarRetryAgora(estado, new Date().toISOString())) iniciarRetry();
  }, [estado, tentandoRetry, iniciarRetry]);

  if (!estado || estado.provider === "google") {
    return <MapaLeafletV2 {...props} onQuotaExceeded={onQuotaExceeded} />;
  }

  return (
    <>
      <MapaFallbackOSM
        veiculosMapa={props.veiculosMapa}
        onVeiculoClick={props.onVeiculoClick}
        mapTokens={props.mapTokens}
        tema={props.tema}
      />
      {tentandoRetry && (
        // Instancia oculta do mapa real, so' pra testar se o Google voltou --
        // nao aparece pro operador (position fixed fora da tela, nao display:none
        // -- alguns navegadores pausam render/JS de elementos display:none, o
        // que impediria o SDK do Google de sequer tentar carregar).
        <div style={{ position: "fixed", top: -9999, left: -9999, width: 400, height: 300 }}>
          <MapaLeafletV2
            {...props}
            onQuotaExceeded={onRetryFalhou}
            onMapLoaded={() => setMapaCarregouEm(Date.now())}
          />
          <ProbeRetry
            mapaCarregouEm={mapaCarregouEm}
            onFalhaConfirmada={onRetryFalhou}
            onSucessoConfirmado={onRetrySucesso}
          />
        </div>
      )}
    </>
  );
}

// Decide se o retry teve sucesso usando um sinal REAL (onMapLoaded do
// MapaLeafletV2), nao silencio ambiguo -- correcao de um defeito achado na
// varredura pre-execucao deste plano (ver ledger): uma versao anterior
// deste componente tratava "nenhum erro em 8s" como sucesso a partir do
// MOUNT do probe, o que e' ambiguo (o Google pode so' nao ter tentado
// renderizar ainda). Design corrigido, ancorado no incidente real de 08/09
// (o erro de cota apareceu ~1s depois do mapa instanciar, nao depois de
// segundos incertos):
//   - so' comeca a contar depois que mapaCarregouEm (via onMapLoaded) tem
//     um valor -- ou seja, depois que o SDK do Google de fato instanciou
//     o mapa, no' so' carregou o script;
//   - 5s depois disso (5x a margem sobre o ~1s observado no incidente
//     real) sem erro de cota = sucesso CONFIRMADO, nao assumido;
//   - se onMapLoaded nunca disparar dentro de 15s do mount (rede lenta,
//     script travado por outro motivo), trata como falha -- nao da' pra
//     confirmar nada, e o padrao seguro deste projeto (mesma filosofia do
//     detector de desvio, recall > precisao) e' ficar no fallback que já
//     funciona em vez de arriscar voltar pro que pode continuar quebrado.
function ProbeRetry({
  mapaCarregouEm,
  onFalhaConfirmada,
  onSucessoConfirmado,
}: {
  mapaCarregouEm: number | null;
  onFalhaConfirmada: () => void;
  onSucessoConfirmado: () => void;
}) {
  useEffect(() => {
    if (mapaCarregouEm == null) {
      const tOuter = setTimeout(onFalhaConfirmada, 15_000);
      return () => clearTimeout(tOuter);
    }
    const tInner = setTimeout(onSucessoConfirmado, 5_000);
    return () => clearTimeout(tInner);
  }, [mapaCarregouEm, onFalhaConfirmada, onSucessoConfirmado]);
  return null;
}
```

(`mapaCarregouEm` e o reset em `iniciarRetry` já estão declarados mais acima, junto
com `estado`/`tentandoRetry` — não duplicar essas declarações aqui.)

- [ ] **Step 2: Verificar tipos**

Run: `npx tsc --noEmit`
Expected: sem erro novo.

- [ ] **Step 3: Commit**

```bash
git add "src/app/(app)/central-v2/MapaComFallback.tsx"
git commit -m "feat(mapa-provider): wrapper de orquestracao google/fallback com retry"
```

---

### Task 10: Ligar no `MonitorV2.tsx` e deploy final

**Files:**
- Modify: `src/app/(app)/central-v2/MonitorV2.tsx:20`
- Modify: `ESTADO.md` (documentar a infra nova, Task 6/7, que não vive no git)

**Interfaces:** nenhuma nova — só religa o import existente.

- [ ] **Step 1: Trocar o import dynamic**

Em `src/app/(app)/central-v2/MonitorV2.tsx`, linha 20:

```typescript
// antes:
const MapaLeafletV2 = dynamic(() => import("./MapaLeafletV2"), { ssr: false });
// depois:
const MapaLeafletV2 = dynamic(() => import("./MapaComFallback"), { ssr: false });
```

(Mantém o nome local `MapaLeafletV2` de propósito — os 3 pontos de uso mais abaixo no
arquivo, linhas 2757/2777/2782, não precisam mudar; o import type de
`VeiculoMapa`/`Parada`/etc na linha 11 continua vindo de `"./MapaLeafletV2"` direto,
que não mudou.)

- [ ] **Step 2: Rodar a suíte completa**

Run: `npx vitest run`
Expected: mesma contagem de antes + os 13 testes novos dos Tasks 2 e 4 (7 + 6).

- [ ] **Step 3: Build local**

Run: `npm run build`
Expected: build passa sem erro.

- [ ] **Step 4: Commit**

```bash
git add "src/app/(app)/central-v2/MonitorV2.tsx"
git commit -m "feat(mapa-provider): Central usa o wrapper com fallback automatico"
```

- [ ] **Step 5: Deploy no Contabo**

Run: `git push origin main`
Run: `ssh transmonseg-vps "cd /srv/transmonseg/definitivo && git pull && npm ci && npm run build && pm2 restart transmonseg-definitivo --update-env"`

- [ ] **Step 6: QA manual end-to-end em produção (crítico — este é o teste real)**

1. Simular a cota estourada direto no banco (sem esperar acontecer de verdade):
   `ssh transmonseg-vps "psql '...' -c \"update mapa_provider_estado set provider='fallback', quota_excedida_em=now(), proxima_tentativa_em=now()+interval '20 minutes' where id=1;\""`
2. Abrir `https://monitoramento.transmonseg.com.br` num navegador, esperar até 30s
   (ciclo de polling) — confirmar que o mapa troca sozinho pro OSM/MapLibre, sem F5,
   mostrando os veículos como pontos coloridos.
3. Confirmar que o badge "Mapa de reserva (Google indisponível)" aparece.
4. Forçar o retry manualmente:
   `ssh transmonseg-vps "psql '...' -c \"update mapa_provider_estado set proxima_tentativa_em=now() where id=1;\""`
5. Esperar até 30s — confirmar nos logs do navegador (F12) que uma instância oculta do
   Google tentou carregar, e que o mapa visível voltou pro Google automaticamente
   (assumindo que a cota real não está de fato estourada nesse teste — só simulamos o
   estado no banco, a chave real do Google deve carregar normalmente).
6. Confirmar no banco: `select * from mapa_provider_estado;` → `provider='google'`,
   timestamps nulos de novo.

Expected: os 4 pontos acima confirmados. Se qualquer um falhar, voltar pro task
correspondente antes de considerar a Fase 1 concluída (não prosseguir pra Fase 2 com
isso quebrado).

- [ ] **Step 7: Documentar a infra fora do git**

Adicionar uma seção no `ESTADO.md` do repo (ou criar se não existir) descrevendo: onde
vive o `.pmtiles` no Contabo (`/srv/transmonseg/tiles/rj.pmtiles`), como foi gerado
(Task 6, planetiler+Docker, comando exato), e o bloco do Caddyfile adicionado (Task 7)
— pra quem mexer nisso depois não precisar arqueologar esta sessão pra entender de
onde veio o arquivo.

```bash
git add ESTADO.md
git commit -m "docs: documenta a infra do fallback de mapa (pmtiles, caddy) no ESTADO.md"
git push origin main
```

---

---

### Task 11: Remover CARTO + hotlink direto do Google em `MapaMonitor.tsx`/`MapaFrota.tsx`

**Contexto (achado durante este plano, fora do incidente original):** essas duas telas
(`react-leaflet`, não Google Maps JS) usam hoje: (a) `https://{s}.basemaps.cartocdn.com/dark_all/...`
como tile de rua sem chave/registro — mesmo problema de ToS que os outros provedores
pesquisados (CARTO proíbe uso comercial/asset-tracking no tier grátis); (b)
`https://mt1.google.com/vt/lyrs=y&x={x}&y={y}&z={z}` como satélite — **hotlink direto
ao tile interno do Google, sem API key nem SDK oficial nenhum**, ativo em produção hoje
porque `NEXT_PUBLIC_GOOGLE_MAPS_API_KEY` está setada (usada só como flag booleana pra
escolher esse branch, nunca de fato enviada na URL). Mais arriscado que a Demo Key: sem
aviso de erro claro, pode ser bloqueado silenciosamente pelo Google a qualquer momento.

**Decisão explícita deste plano:** trocar o tile de rua pelo MESMO `rj.pmtiles` já
construído no Task 6 (reaproveita a infra, zero trabalho novo de dado). Satélite:
**removido nessas 2 telas por enquanto, sem substituto** — trocar por outro provedor
"grátis" (Esri, etc.) só trocaria um risco de ToS por outro, exatamente o problema que
motivou esta investigação inteira. Satélite volta quando a Fase 2 (Sentinel/Landsat
self-hospedado) existir, spec Decisão 5.

**Files:**
- Create: `src/app/(app)/components/CamadaPMTiles.tsx`
- Modify: `src/app/(app)/components/MapaMonitor.tsx`
- Modify: `src/app/(app)/components/MapaFrota.tsx`
- Modify: `package.json` (adiciona `protomaps-leaflet`)

**Interfaces:**
- Produces: `CamadaPMTiles({ tema: "dark" | "light" })` — componente `useMap()`-based,
  mesmo padrão já usado neste arquivo por `ClicarMapaVazio`/`CapturadorZoom` etc,
  adiciona a camada vetorial do `rj.pmtiles` (Task 6/7) ao mapa Leaflet existente.

- [ ] **Step 1: Instalar a dependência**

Run: `npm install protomaps-leaflet`

- [ ] **Step 2: Criar o componente compartilhado**

```typescript
// src/app/(app)/components/CamadaPMTiles.tsx
"use client";

// Substitui o tile CARTO (sem chave/registro, ToS proibe uso comercial) por
// tile vetorial self-hospedado (mesmo arquivo rj.pmtiles do Task 6/7 do
// plano de fallback de mapa). Ver
// docs/superpowers/specs/2026-09-08-mapa-fallback-quota-google-design.md.

import { useEffect } from "react";
import { useMap } from "react-leaflet";
import * as protomapsL from "protomaps-leaflet";

export default function CamadaPMTiles({ tema }: { tema: "dark" | "light" }) {
  const map = useMap();
  useEffect(() => {
    const layer = protomapsL.leafletLayer({
      url: "/tiles/rj.pmtiles",
      flavor: tema === "dark" ? "dark" : "light",
      lang: "pt",
    });
    layer.addTo(map);
    return () => {
      map.removeLayer(layer);
    };
  }, [map, tema]);
  return null;
}
```

- [ ] **Step 3: Trocar em `MapaMonitor.tsx`**

Localizar (linha ~1882-1893):

```typescript
            {googleApiKey ? (
              <TileLayer
                url="https://mt1.google.com/vt/lyrs=y&x={x}&y={y}&z={z}"
                attribution="&copy; Google Maps"
                maxNativeZoom={20}
                maxZoom={21}
              />
            ) : (
              <TileLayer
                url="https://{s}.basemaps.cartocdn.com/dark_all/{z}/{x}/{y}{r}.png"
                attribution="&copy; OpenStreetMap &copy; CARTO"
              />
            )}
```

Substituir por:

```typescript
            <CamadaPMTiles tema="dark" />
```

Adicionar o import no topo: `import CamadaPMTiles from "./CamadaPMTiles";`

Remover a declaração de `googleApiKey` (linhas ~979-982) SE, depois desta troca, ela não
for mais referenciada em nenhum outro lugar do arquivo — confirmar com
`grep -n "googleApiKey" src/app/(app)/components/MapaMonitor.tsx` antes de apagar (só
deve sobrar a própria declaração se nada mais usa).

- [ ] **Step 4: Trocar em `MapaFrota.tsx`**

Mesmo padrão, localizar (linha ~207-218):

```typescript
        {googleApiKey ? (
          <TileLayer
            url="https://mt1.google.com/vt/lyrs=y&x={x}&y={y}&z={z}"
            attribution="&copy; Google Maps"
            maxNativeZoom={20}
            maxZoom={21}
          />
        ) : (
          <TileLayer
            url="https://{s}.basemaps.cartocdn.com/dark_all/{z}/{x}/{y}{r}.png"
            attribution="&copy; OpenStreetMap &copy; CARTO"
          />
        )}
```

Substituir por `<CamadaPMTiles tema="dark" />` (mesmo import), remover a declaração de
`googleApiKey` (linha 132) já que nesse arquivo ela só é lida nessa única linha 207
(confirmar com o mesmo grep antes de apagar).

- [ ] **Step 5: Verificar tipos e build**

Run: `npx tsc --noEmit && npm run build`
Expected: sem erro novo.

- [ ] **Step 6: Commit**

```bash
git add package.json package-lock.json \
  "src/app/(app)/components/CamadaPMTiles.tsx" \
  "src/app/(app)/components/MapaMonitor.tsx" \
  "src/app/(app)/components/MapaFrota.tsx"
git commit -m "fix(mapa): remove hotlink direto do Google e CARTO sem registro em MapaMonitor/MapaFrota"
```

- [ ] **Step 7: Deploy e QA visual manual**

Run: `git push origin main`
Run: `ssh transmonseg-vps "cd /srv/transmonseg/definitivo && git pull && npm ci && npm run build && pm2 restart transmonseg-definitivo --update-env"`

Abrir as telas que usam `MapaMonitor`/`MapaFrota` em produção, confirmar visualmente:
mapa de rua carrega (tema escuro, via `rj.pmtiles`), sem mais opção de satélite
disponível nessas telas (removida de propósito nesta task).

---

## Fim da Fase 1

Com os 11 tasks acima: a Central nunca mais fica sem mapa de rua por cota do Google
estourada, a troca é automática e sincronizada entre todos os operadores, e o sistema
volta sozinho pro Google sem intervenção manual (Tasks 1-10). Além disso, dois riscos
de ToS ativos achados durante a investigação (CARTO sem registro e hotlink direto ao
tile interno do Google em `MapaMonitor.tsx`/`MapaFrota.tsx`) são eliminados,
reaproveitando o mesmo `rj.pmtiles` self-hospedado (Task 11). Satélite continua
dependendo 100% do Google na Central (sem fallback) e foi REMOVIDO das outras duas
telas até ter substituto próprio — isso é a Fase 2 (Sentinel/Landsat self-hospedado),
fora deste plano, ver spec Decisão 5/8.
