# Histerese + Verificação por Corredor Real — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Detectar desvio mais cedo (histerese no streak) e matar falso positivo de via sinuosa (verificação da estrada real via OSRM/Valhalla antes de alertar), + começar a coletar par origem-destino no tapete.

**Architecture:** (1) Função pura de avanço de streak com histerese em `detectores.ts`, chamada pelo motor. (2) Módulo novo `corredor-verificacao.ts` (geometria pura + fetch throttled 1 req/s com failover e cache em memória), consultado pelo motor SÓ quando `avaliar()` retorna desvio da Camada 1. (3) Migration 014 aditiva pra colunas de par O-D, preenchidas no upsert já existente do tapete.

**Tech Stack:** Next.js 16 (rota /api/motor), OSRM público + Valhalla FOSSGIS (failover), Vitest, pg.

## Global Constraints
- Migrations manuais: `node --env-file=.env.local scripts/aplicar-migration.mjs <arquivo.sql>`.
- OSRM público: máx **1 req/s global**, fail-open obrigatório (nunca segurar alerta esperando API); Valhalla FOSSGIS como failover com header `X-Client-Id: transmonseg-central`.
- Feature flag `CAMADA_CORREDOR_ATIVA` desligável na hora.
- Buffer adaptativo: 300m urbano / 600m rodovia (proxy: velocidade >= 60 km/h).
- Histerese: 1 leitura de aproximação CONGELA o streak; 2 consecutivas zeram.
- Português com acentos corretos; sem travessão em copy de UI.
- `npx tsc --noEmit` limpo + `npx vitest run` (333 hoje) verdes antes de cada commit.
- Nenhum alerta que dispara hoje pode sumir sem verificação explícita da estrada.

---

### Task 1: Função pura de streak com histerese (TDD)

**Files:**
- Modify: `src/lib/detectores.ts` (perto de `afastouDeTudo`, ~linha 440)
- Test: `src/lib/detectores.test.ts`

**Interfaces:**
- Consumes: nada novo.
- Produces: `avancarStreaksDesvio(afastando: boolean, atual: { desvioStreak: number; aproximandoStreak: number }): { desvioStreak: number; aproximandoStreak: number; zerou: boolean }` — usada pelo motor na Task 2.

- [ ] **Step 1: Teste que falha**

Adicionar em `src/lib/detectores.test.ts` (importar `avancarStreaksDesvio` no import de `./detectores`):

```typescript
describe("avancarStreaksDesvio (histerese: 1 aproximacao congela, 2 zeram)", () => {
  it("afastando: incrementa desvioStreak e zera aproximandoStreak", () => {
    expect(avancarStreaksDesvio(true, { desvioStreak: 2, aproximandoStreak: 1 }))
      .toEqual({ desvioStreak: 3, aproximandoStreak: 0, zerou: false });
  });

  it("1 leitura de aproximacao isolada: CONGELA o desvioStreak (nao zera, nao incrementa)", () => {
    expect(avancarStreaksDesvio(false, { desvioStreak: 3, aproximandoStreak: 0 }))
      .toEqual({ desvioStreak: 3, aproximandoStreak: 1, zerou: false });
  });

  it("2 leituras consecutivas de aproximacao: zera o desvioStreak", () => {
    expect(avancarStreaksDesvio(false, { desvioStreak: 3, aproximandoStreak: 1 }))
      .toEqual({ desvioStreak: 0, aproximandoStreak: 2, zerou: true });
  });

  it("cenario de serra (afasta, afasta, aproxima 1x por curva, afasta): acumula em vez de recomecar", () => {
    let s = { desvioStreak: 0, aproximandoStreak: 0 };
    s = avancarStreaksDesvio(true, s);   // 1
    s = avancarStreaksDesvio(true, s);   // 2
    s = avancarStreaksDesvio(false, s);  // curva: congela em 2
    s = avancarStreaksDesvio(true, s);   // 3 — antes da histerese seria 1
    expect(s.desvioStreak).toBe(3);
  });
});
```

- [ ] **Step 2: Rodar e ver falhar**

Run: `npx vitest run src/lib/detectores.test.ts`
Expected: FAIL — `avancarStreaksDesvio is not a function`

- [ ] **Step 3: Implementar**

Em `src/lib/detectores.ts`, logo após `afastouDeTudo`:

```typescript
// Avanço dos streaks do desvio com HISTERESE (achado real 09/07, vídeo da
// operação: desvio pra Xerém só pontuou lá em cima). Em estrada de serra a
// distância em linha reta a um destino oscila a cada curva — zerar o streak
// na primeira leitura de aproximação apagava a suspeita acumulada e o
// alerta saía km depois do desvio começar. Agora: 1 leitura de aproximação
// isolada CONGELA o streak (não zera, não incrementa); só 2 consecutivas
// zeram — mesma régua de persistência usada pra disparar e pra resolver.
export function avancarStreaksDesvio(
  afastando: boolean,
  atual: { desvioStreak: number; aproximandoStreak: number }
): { desvioStreak: number; aproximandoStreak: number; zerou: boolean } {
  if (afastando) {
    return { desvioStreak: atual.desvioStreak + 1, aproximandoStreak: 0, zerou: false };
  }
  const aproximandoStreak = atual.aproximandoStreak + 1;
  if (aproximandoStreak >= 2) {
    return { desvioStreak: 0, aproximandoStreak, zerou: true };
  }
  return { desvioStreak: atual.desvioStreak, aproximandoStreak, zerou: false };
}
```

- [ ] **Step 4: Rodar e ver passar**

Run: `npx vitest run src/lib/detectores.test.ts`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add src/lib/detectores.ts src/lib/detectores.test.ts
git commit -m "feat(desvio): avancarStreaksDesvio com histerese (1 aproximacao congela, 2 zeram)"
```

---

### Task 2: Motor usa a função de histerese

**Files:**
- Modify: `src/app/api/motor/route.ts` (bloco do streak, ~linha 850)

**Interfaces:**
- Consumes: `avancarStreaksDesvio` (Task 1).
- Produces: comportamento novo do streak persistido; `desvioInicio` só zera quando `zerou=true`.

- [ ] **Step 1: Substituir o bloco inline**

Localizar (buscar `let desvioStreak: number = anterior?.desvio_streak ?? 0;`) e substituir o bloco if/else inteiro por:

```typescript
          let desvioStreak: number = anterior?.desvio_streak ?? 0;
          let desvioInicio: DesvioInicio | null = anterior?.desvio_inicio ?? null;
          let aproximandoStreak: number = anterior?.aproximando_streak ?? 0;
          if (pos.fresco && !saltoImplausivel && pos.velocidade > 0 && temAnterior) {
            const r = avancarStreaksDesvio(
              afastouDeTudo(distDestinosM, distDestinosAnteriorM),
              { desvioStreak, aproximandoStreak }
            );
            if (r.desvioStreak === 1 && desvioStreak === 0) {
              desvioInicio = {
                lat: anterior!.lat!,
                lng: anterior!.lng!,
                ts: agora.toISOString(),
                menor_dist_m: distDestinosAnteriorM.length > 0 ? Math.min(...distDestinosAnteriorM) : 0,
              };
            }
            if (r.zerou) desvioInicio = null;
            desvioStreak = r.desvioStreak;
            aproximandoStreak = r.aproximandoStreak;
          }
```

Adicionar `avancarStreaksDesvio` ao import de `@/lib/detectores` no topo do arquivo.

- [ ] **Step 2: Tipos e testes**

Run: `npx tsc --noEmit && npx vitest run`
Expected: limpo, todos os testes passando

- [ ] **Step 3: Commit**

```bash
git add src/app/api/motor/route.ts
git commit -m "feat(motor): streak do desvio com histerese via avancarStreaksDesvio"
```

---

### Task 3: Geometria pura do corredor (TDD)

**Files:**
- Create: `src/lib/corredor-verificacao.ts`
- Test: `src/lib/corredor-verificacao.test.ts`

**Interfaces:**
- Consumes: `distanciaAoSegmentoM` de `./unitrac` (existe, linha 184).
- Produces: `bufferPorVelocidade(velKmH: number): number`; `dentroDoCorredor(pos: {lat,lng}, polilinha: {lat,lng}[], bufferM: number): boolean`; `decodePolyline6(encoded: string): {lat,lng}[]` — usados nas Tasks 4-5.

- [ ] **Step 1: Teste que falha**

```typescript
// src/lib/corredor-verificacao.test.ts
import { describe, it, expect } from "vitest";
import { bufferPorVelocidade, dentroDoCorredor, decodePolyline6 } from "./corredor-verificacao";

describe("bufferPorVelocidade (adaptativo: cidade estreito, rodovia largo)", () => {
  it("abaixo de 60 km/h: 300m (urbano)", () => {
    expect(bufferPorVelocidade(40)).toBe(300);
    expect(bufferPorVelocidade(0)).toBe(300);
  });
  it("60 km/h ou mais: 600m (rodovia/serra)", () => {
    expect(bufferPorVelocidade(60)).toBe(600);
    expect(bufferPorVelocidade(90)).toBe(600);
  });
});

describe("dentroDoCorredor", () => {
  // Polilinha reta de ~1.1km na vertical (0.01 grau de lat)
  const polilinha = [
    { lat: -22.90, lng: -43.20 },
    { lat: -22.895, lng: -43.20 },
    { lat: -22.89, lng: -43.20 },
  ];
  it("ponto a ~100m da linha, buffer 300m: dentro", () => {
    // 0.001 grau de lng a -22.9 ~ 102m
    expect(dentroDoCorredor({ lat: -22.895, lng: -43.199 }, polilinha, 300)).toBe(true);
  });
  it("ponto a ~1km da linha, buffer 300m: fora", () => {
    expect(dentroDoCorredor({ lat: -22.895, lng: -43.19 }, polilinha, 300)).toBe(false);
  });
  it("mesmo ponto a ~1km, buffer 600m (rodovia): ainda fora", () => {
    expect(dentroDoCorredor({ lat: -22.895, lng: -43.19 }, polilinha, 600)).toBe(false);
  });
  it("polilinha vazia ou de 1 ponto: nunca dentro (defensivo)", () => {
    expect(dentroDoCorredor({ lat: -22.9, lng: -43.2 }, [], 300)).toBe(false);
    expect(dentroDoCorredor({ lat: -22.9, lng: -43.2 }, [{ lat: -22.9, lng: -43.2 }], 300)).toBe(false);
  });
});

describe("decodePolyline6 (formato do Valhalla)", () => {
  it("decodifica um shape simples de 2 pontos", () => {
    // Encoded de [(-22.9, -43.2), (-22.89, -43.19)] com precisao 1e6,
    // gerado com o algoritmo padrao de encoding do Google/Valhalla.
    const pts = decodePolyline6(encodePolyline6ParaTeste([[-22.9, -43.2], [-22.89, -43.19]]));
    expect(pts).toHaveLength(2);
    expect(pts[0].lat).toBeCloseTo(-22.9, 5);
    expect(pts[0].lng).toBeCloseTo(-43.2, 5);
    expect(pts[1].lat).toBeCloseTo(-22.89, 5);
  });
});

// Encoder minimo so pro teste (inverso do decoder) — nao vai pra producao.
function encodePolyline6ParaTeste(coords: [number, number][]): string {
  let out = "";
  let prevLat = 0, prevLng = 0;
  const enc = (v: number) => {
    let n = v < 0 ? ~(v << 1) : v << 1;
    let s = "";
    while (n >= 0x20) { s += String.fromCharCode((0x20 | (n & 0x1f)) + 63); n >>= 5; }
    s += String.fromCharCode(n + 63);
    return s;
  };
  for (const [lat, lng] of coords) {
    const iLat = Math.round(lat * 1e6), iLng = Math.round(lng * 1e6);
    out += enc(iLat - prevLat) + enc(iLng - prevLng);
    prevLat = iLat; prevLng = iLng;
  }
  return out;
}
```

- [ ] **Step 2: Rodar e ver falhar**

Run: `npx vitest run src/lib/corredor-verificacao.test.ts`
Expected: FAIL — `Cannot find module './corredor-verificacao'`

- [ ] **Step 3: Implementar a geometria**

```typescript
// src/lib/corredor-verificacao.ts
// Verificação do desvio contra a ESTRADA REAL (ver design
// docs/plans/2026-07-09-desvio-corredor-verificacao-design.md): quando a
// Camada 1 esta prestes a alertar, traça a rota da posição atual até os
// pendentes mais próximos (OSRM público, failover Valhalla) e só deixa o
// alerta passar se o veículo NÃO estiver em nenhuma estrada que leve a um
// destino legítimo. Restrições da pesquisa 09/07: OSRM público = 1 req/s
// GLOBAL, fail-open sempre (API fora = comporta como hoje, nunca segura
// alerta). Nunca importe nada de 'next' aqui — lib pura + fetch.
import { haversineM, distanciaAoSegmentoM } from "./unitrac";

type Ponto = { lat: number; lng: number };

// Buffer adaptativo (pesquisa: cidade alarga por trânsito/manobra, rodovia
// aperta porque sair dela é sinal forte — aqui INVERTIDO de propósito: na
// serra/rodovia a estrada real serpenteia longe da reta, então o buffer
// precisa ser MAIOR pra polilinha do OSRM cobrir o GPS com folga; 60 km/h
// como proxy de rodovia sem depender de mapa de vias).
export function bufferPorVelocidade(velKmH: number): number {
  return velKmH >= 60 ? 600 : 300;
}

// Distância mínima do ponto a qualquer segmento da polilinha <= buffer?
export function dentroDoCorredor(pos: Ponto, polilinha: Ponto[], bufferM: number): boolean {
  if (polilinha.length < 2) return false;
  for (let i = 0; i < polilinha.length - 1; i++) {
    if (distanciaAoSegmentoM(pos, polilinha[i], polilinha[i + 1]) <= bufferM) return true;
  }
  return false;
}

// Decoder do formato polyline precisao 1e-6 (shape do Valhalla).
export function decodePolyline6(encoded: string): Ponto[] {
  const pontos: Ponto[] = [];
  let index = 0, lat = 0, lng = 0;
  while (index < encoded.length) {
    for (const alvo of ["lat", "lng"] as const) {
      let result = 0, shift = 0, b: number;
      do {
        b = encoded.charCodeAt(index++) - 63;
        result |= (b & 0x1f) << shift;
        shift += 5;
      } while (b >= 0x20);
      const delta = result & 1 ? ~(result >> 1) : result >> 1;
      if (alvo === "lat") lat += delta; else lng += delta;
    }
    pontos.push({ lat: lat / 1e6, lng: lng / 1e6 });
  }
  return pontos;
}
```

(`haversineM` fica importado pra Task 4 usar — se o lint reclamar de unused nesta task, remover e re-adicionar na Task 4.)

- [ ] **Step 4: Rodar e ver passar**

Run: `npx vitest run src/lib/corredor-verificacao.test.ts`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add src/lib/corredor-verificacao.ts src/lib/corredor-verificacao.test.ts
git commit -m "feat(corredor): geometria pura da verificacao (buffer adaptativo, ponto-na-polilinha, decoder valhalla)"
```

---

### Task 4: Fetch throttled com failover + verificação completa (TDD com fetch mockado)

**Files:**
- Modify: `src/lib/corredor-verificacao.ts`
- Test: `src/lib/corredor-verificacao.test.ts`

**Interfaces:**
- Consumes: geometria da Task 3.
- Produces: `verificarCorredor(pos: Ponto & { velocidade: number }, destinos: Ponto[]): Promise<{ veredito: "dentro" | "fora" | "indisponivel"; corredor: Ponto[] | null }>` — usada pelo motor na Task 5. `destinos` = até 3 mais próximos, o CHAMADOR corta.

- [ ] **Step 1: Testes que falham**

Adicionar ao test file (junto dos imports, `vi` e `afterEach` do vitest):

```typescript
function mockOsrmGeojson(coords: [number, number][]) {
  return {
    ok: true,
    json: async () => ({ code: "Ok", routes: [{ distance: 1000, geometry: { coordinates: coords } }] }),
  };
}

describe("verificarCorredor (fetch mockado)", () => {
  afterEach(() => { vi.unstubAllGlobals(); vi.useRealTimers(); });

  it("veiculo em cima da rota OSRM ate um destino: dentro + retorna o corredor", async () => {
    // rota passa exatamente pela posicao do veiculo
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(
      mockOsrmGeojson([[-43.20, -22.90], [-43.20, -22.895], [-43.20, -22.89]])
    ));
    const r = await verificarCorredor(
      { lat: -22.895, lng: -43.20, velocidade: 40 },
      [{ lat: -22.89, lng: -43.20 }]
    );
    expect(r.veredito).toBe("dentro");
    expect(r.corredor?.length).toBeGreaterThan(1);
  });

  it("veiculo longe de TODAS as rotas: fora", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(
      mockOsrmGeojson([[-43.20, -22.90], [-43.20, -22.89]])
    ));
    const r = await verificarCorredor(
      { lat: -22.895, lng: -43.15, velocidade: 40 }, // ~5km da rota
      [{ lat: -22.89, lng: -43.20 }]
    );
    expect(r.veredito).toBe("fora");
  });

  it("OSRM e Valhalla mortos: indisponivel (fail-open, quem chama dispara como hoje)", async () => {
    vi.stubGlobal("fetch", vi.fn().mockRejectedValue(new Error("down")));
    const r = await verificarCorredor(
      { lat: -22.895, lng: -43.20, velocidade: 40 },
      [{ lat: -22.89, lng: -43.20 }]
    );
    expect(r.veredito).toBe("indisponivel");
  });

  it("sem destinos: indisponivel (nada pra verificar)", async () => {
    const r = await verificarCorredor({ lat: -22.9, lng: -43.2, velocidade: 40 }, []);
    expect(r.veredito).toBe("indisponivel");
  });
});
```

- [ ] **Step 2: Rodar e ver falhar**

Run: `npx vitest run src/lib/corredor-verificacao.test.ts`
Expected: FAIL — `verificarCorredor is not a function`

- [ ] **Step 3: Implementar**

Adicionar ao `corredor-verificacao.ts`:

```typescript
// ─── Throttle GLOBAL de 1 req/s (politica do OSRM publico e do Valhalla
// FOSSGIS). Fila implicita via promise encadeada; deadline total de 5s por
// verificacao — estourou = "indisponivel" (fail-open, quem chama dispara
// o alerta como hoje; NUNCA segura alerta esperando API).
let ultimaChamadaEm = 0;
let filaThrottle: Promise<void> = Promise.resolve();
const INTERVALO_MIN_MS = 1100;
const DEADLINE_VERIFICACAO_MS = 5000;

async function esperarVaga(): Promise<void> {
  const minhaVez = filaThrottle.then(async () => {
    const espera = ultimaChamadaEm + INTERVALO_MIN_MS - Date.now();
    if (espera > 0) await new Promise((r) => setTimeout(r, espera));
    ultimaChamadaEm = Date.now();
  });
  filaThrottle = minhaVez.catch(() => {});
  return minhaVez;
}

type OsrmRouteResponse = {
  code: string;
  routes?: { geometry?: { coordinates?: [number, number][] }; distance?: number }[];
};
type ValhallaResponse = { trip?: { legs?: { shape?: string }[] } };

async function rotaOSRM(a: Ponto, b: Ponto): Promise<Ponto[] | null> {
  const res = await fetch(
    `https://router.project-osrm.org/route/v1/driving/${a.lng},${a.lat};${b.lng},${b.lat}?geometries=geojson&overview=full`,
    { signal: AbortSignal.timeout(3500) }
  );
  if (!res.ok) return null;
  const data = (await res.json()) as OsrmRouteResponse;
  const coords = data.routes?.[0]?.geometry?.coordinates;
  if (data.code !== "Ok" || !coords || coords.length < 2) return null;
  return coords.map(([lng, lat]) => ({ lat, lng }));
}

async function rotaValhalla(a: Ponto, b: Ponto): Promise<Ponto[] | null> {
  const res = await fetch("https://valhalla1.openstreetmap.de/route", {
    method: "POST",
    headers: { "content-type": "application/json", "X-Client-Id": "transmonseg-central" },
    body: JSON.stringify({ locations: [{ lat: a.lat, lon: a.lng }, { lat: b.lat, lon: b.lng }], costing: "auto" }),
    signal: AbortSignal.timeout(3500),
  });
  if (!res.ok) return null;
  const data = (await res.json()) as ValhallaResponse;
  const shape = data.trip?.legs?.[0]?.shape;
  if (!shape) return null;
  const pontos = decodePolyline6(shape);
  return pontos.length >= 2 ? pontos : null;
}

// Traça rota da posição atual até cada destino candidato (com throttle e
// failover OSRM->Valhalla) e responde se o veículo está em cima de alguma
// estrada que leva a um destino legítimo.
export async function verificarCorredor(
  pos: Ponto & { velocidade: number },
  destinos: Ponto[]
): Promise<{ veredito: "dentro" | "fora" | "indisponivel"; corredor: Ponto[] | null }> {
  if (destinos.length === 0) return { veredito: "indisponivel", corredor: null };
  const buffer = bufferPorVelocidade(pos.velocidade);
  const inicio = Date.now();
  let alguma = false;

  for (const destino of destinos) {
    if (Date.now() - inicio > DEADLINE_VERIFICACAO_MS) break;
    await esperarVaga();
    let rota: Ponto[] | null = null;
    try { rota = await rotaOSRM(pos, destino); } catch { /* failover abaixo */ }
    if (!rota) {
      try { rota = await rotaValhalla(pos, destino); } catch { /* segue */ }
    }
    if (!rota) continue;
    alguma = true;
    if (dentroDoCorredor(pos, rota, buffer)) {
      return { veredito: "dentro", corredor: rota };
    }
  }
  // Nenhuma rota calculada com sucesso = nao da pra afirmar nada (fail-open).
  if (!alguma) return { veredito: "indisponivel", corredor: null };
  return { veredito: "fora", corredor: null };
}
```

- [ ] **Step 4: Rodar e ver passar**

Run: `npx vitest run src/lib/corredor-verificacao.test.ts`
Expected: PASS (todos, incluindo os da Task 3)

- [ ] **Step 5: Commit**

```bash
git add src/lib/corredor-verificacao.ts src/lib/corredor-verificacao.test.ts
git commit -m "feat(corredor): verificarCorredor com throttle 1 req/s, failover valhalla e fail-open"
```

---

### Task 5: Integração no motor (flag + cache + supressão + desvio_inicio real)

**Files:**
- Modify: `src/app/api/motor/route.ts`

**Interfaces:**
- Consumes: `verificarCorredor`, `dentroDoCorredor`, `bufferPorVelocidade` (Tasks 3-4).
- Produces: alerta de desvio Camada 1 só passa se a verificação NÃO confirmar que o veículo está em estrada legítima; `desvio_inicio` vira o ponto de saída do corredor quando conhecido.

- [ ] **Step 1: Flag + cache de corredor no topo do arquivo**

Junto dos outros caches de módulo (perto de `cacheContagemTapetePorCliente`):

```typescript
// ─── Verificação por corredor real (ver lib/corredor-verificacao.ts) ────
// Desligável na hora, mesmo padrão do CAMADA3_TAPETE_ATIVA: pesquisa 09/07
// não achou caso documentado de corredor multi-destino sem ordem conhecida
// em produção — somos pioneiros, então flag + validação com dado real.
const CAMADA_CORREDOR_ATIVA = true;
// Corredor "vencedor" por veículo: enquanto o veículo seguir dentro dele,
// suprime o desvio SEM novas chamadas de API. ultimoDentro = último ponto
// confirmado dentro (vira o desvio_inicio REAL se ele sair e o alerta
// confirmar — conserta o marcador de início errado reportado pela operação).
type CorredorCache = {
  polilinha: { lat: number; lng: number }[];
  ultimoDentro: { lat: number; lng: number };
  pendentesChave: string;
  expiraEm: number;
};
const CORREDOR_CACHE_MS = 15 * 60_000;
const cacheCorredorPorVeiculo = new Map<string, CorredorCache>();
// Orçamento por CICLO: no máx 3 verificações com API (cada uma <= 5s).
// Acima disso, os demais veículos disparam sem verificação (fail-open) e
// tentam de novo no ciclo seguinte.
const MAX_VERIFICACOES_POR_CICLO = 3;
```

Adicionar import no topo: `import { verificarCorredor, dentroDoCorredor, bufferPorVelocidade } from "@/lib/corredor-verificacao";`

- [ ] **Step 2: Contador do ciclo**

Dentro do `POST`, junto das outras variáveis de ciclo (perto de `const celulasCiclo`):

```typescript
    let verificacoesCorredorNoCiclo = 0;
```

- [ ] **Step 3: Interceptar o alerta de desvio da Camada 1**

Localizar onde `avaliar` retorna (buscar `let alerta: Alerta | null = alertaJammer`). LOGO DEPOIS do bloco que calcula `alerta` (depois do fechamento `: null;`), adicionar:

```typescript
          // ─── Verificação por corredor real (Camada 1 do desvio) ─────────
          // Só intercepta desvio comportamental ("Afastando-se..."), nunca
          // pânico/jammer/etc. Fluxo: cache primeiro (zero API); sem cache
          // ou fora dele, verifica com OSRM/Valhalla (throttled, orçamento
          // por ciclo). "dentro" = veículo está numa estrada que leva a um
          // destino legítimo: suprime e zera o streak. "fora" = confirma, e
          // o início real do desvio é onde saiu do corredor. "indisponivel"
          // = comporta exatamente como hoje (fail-open).
          if (
            CAMADA_CORREDOR_ATIVA &&
            alerta?.tipo === "desvio" &&
            alerta.motivo.startsWith("Afastando-se") &&
            pos.fresco
          ) {
            const pendentesChave = pendentes.map((pt) => pt.codigo ?? `${pt.lat},${pt.lng}`).sort().join(",");
            const cache = cacheCorredorPorVeiculo.get(veiculo_id);
            const cacheValido = cache && cache.expiraEm > Date.now() && cache.pendentesChave === pendentesChave;

            if (cacheValido && dentroDoCorredor(pos, cache.polilinha, bufferPorVelocidade(pos.velocidade))) {
              // Continua na estrada já confirmada: suprime sem API.
              cache.ultimoDentro = { lat: pos.lat, lng: pos.lng };
              alerta = null;
              desvioStreak = 0;
              desvioInicio = null;
            } else if (verificacoesCorredorNoCiclo < MAX_VERIFICACOES_POR_CICLO) {
              verificacoesCorredorNoCiclo++;
              const candidatos = [...destinos]
                .map((d) => ({ d, dist: haversineM(pos.lat, pos.lng, d.lat, d.lng) }))
                .sort((a, b) => a.dist - b.dist)
                .slice(0, 3)
                .map((x) => x.d);
              const r = await verificarCorredor({ lat: pos.lat, lng: pos.lng, velocidade: pos.velocidade }, candidatos);
              if (r.veredito === "dentro" && r.corredor) {
                cacheCorredorPorVeiculo.set(veiculo_id, {
                  polilinha: r.corredor,
                  ultimoDentro: { lat: pos.lat, lng: pos.lng },
                  pendentesChave,
                  expiraEm: Date.now() + CORREDOR_CACHE_MS,
                });
                alerta = null;
                desvioStreak = 0;
                desvioInicio = null;
              } else if (r.veredito === "fora") {
                // Confirma o desvio. Início REAL: onde saiu do corredor.
                if (cacheValido && cache) {
                  desvioInicio = {
                    lat: cache.ultimoDentro.lat,
                    lng: cache.ultimoDentro.lng,
                    ts: agora.toISOString(),
                    menor_dist_m: desvioInicio?.menor_dist_m ?? 0,
                  };
                }
                cacheCorredorPorVeiculo.delete(veiculo_id);
              }
              // "indisponivel": deixa o alerta seguir como hoje (fail-open).
            }
            // Orçamento estourado: deixa o alerta seguir como hoje.
          }
```

NOTA: esse bloco precisa vir ANTES do push em `posicoesCiclo` (que grava `desvio_streak`/`desvio_inicio`) — verificar a ordem no arquivo; se o `posicoesCiclo.push` vier antes do cálculo de `alerta`, mover o push pra depois deste bloco (conferir que nada entre eles usa `posicoesCiclo`).

- [ ] **Step 4: Tipos, testes, ordem do push**

Run: `npx tsc --noEmit && npx vitest run`
Expected: limpo. Conferir manualmente (Read no arquivo) que `posicoesCiclo.push` acontece DEPOIS do bloco novo e que `desvio_streak: desvioStreak` gravado reflete a supressão.

- [ ] **Step 5: Commit**

```bash
git add src/app/api/motor/route.ts
git commit -m "feat(motor): verificacao por corredor real antes de alertar desvio (flag, cache, fail-open)"
```

---

### Task 6: Migration 014 — par origem-destino no tapete (só coleta)

**Files:**
- Create: `scripts/migrations/014_tapete_origem_destino.sql`
- Modify: `src/app/api/motor/route.ts`

**Interfaces:**
- Produces: colunas `corredor_celulas.origem_celula/destino_celula` e `posicoes_atuais.origem_celula` preenchidas; NENHUMA detecção muda.

- [ ] **Step 1: Migration**

```sql
-- 014: par origem-destino no tapete (SO COLETA, nenhuma deteccao usa ainda).
-- Pesquisa 09/07 (iBOAT): tapete correto e por par O-D, nao global por
-- cliente — comecar a acumular o dado agora pra poder religar a Camada 3
-- no formato certo depois. origem = celula da ultima parada de 5+ min do
-- veiculo; destino = celula do pendente mais proximo no momento.
alter table corredor_celulas add column if not exists origem_celula text;
alter table corredor_celulas add column if not exists destino_celula text;
alter table posicoes_atuais add column if not exists origem_celula text;
```

Run: `node --env-file=.env.local scripts/aplicar-migration.mjs 014_tapete_origem_destino.sql`
Expected: `OK — migration aplicada.`

- [ ] **Step 2: Motor rastreia a origem (última parada 5+ min)**

No bloco onde `parado_desde`/`paradoMin` são calculados (buscar `paradoMin = Math.round`), adicionar depois do fechamento do `if (pos.velocidade === 0)`:

```typescript
          // Origem pro par O-D do tapete (migration 014): celula da ultima
          // parada de 5+ min. Persistida em posicoes_atuais.origem_celula;
          // carrega a anterior enquanto nao houver parada nova.
          let origemCelula: string | null = anterior?.origem_celula ?? null;
          if (pos.velocidade === 0 && paradoMin >= 5) {
            origemCelula = celulaDe(pos.lat, pos.lng);
          }
```

Adicionar `celulaDe` ao import de `@/lib/celulas`. Adicionar `origem_celula` ao SELECT de `posicoes_atuais` (linha do `.select(...)` com `aproximando_streak`), ao tipo do `mapaPosAtual`, ao objeto montado no `for` do mapa, ao tipo `LinhaPosicaoCiclo`, ao `posicoesCiclo.push` (`origem_celula: origemCelula`) e ao SQL do INSERT batch (coluna + `$23::text[]` + SET) — mesmo padrão mecânico do `aproximando_streak` (Task da migration 013, commit 1c068d3, serve de referência de diff).

- [ ] **Step 3: Gravar o par no push do tapete**

Localizar `celulasCiclo.push({ cliente_id, celula: c });` e o tipo `const celulasCiclo: { cliente_id: string; celula: string }[]`. Trocar por:

```typescript
    const celulasCiclo: { cliente_id: string; celula: string; origem: string | null; destino: string | null }[] = [];
```

e no push (dentro do loop de `celulasDoSegmento`):

```typescript
            const destinoCelula = pendentes.length > 0
              ? celulaDe(pendentes[0].lat, pendentes[0].lng)
              : null;
            for (const c of celulasDoSegmento(anterior!.lat!, anterior!.lng!, pos.lat, pos.lng)) {
              celulasCiclo.push({ cliente_id, celula: c, origem: origemCelula, destino: destinoCelula });
            }
```

(usar o pendente mais próximo: antes do loop, ordenar `pendentes` por `haversineM` até `pos` e pegar o [0] — 3 linhas; se preferir, reutilizar o array `candidatos` se já calculado no escopo.)

E no INSERT do tapete (buscar `INSERT INTO corredor_celulas`):

```typescript
          `INSERT INTO corredor_celulas (cliente_id, celula, ultimo_visto, origem_celula, destino_celula)
           SELECT DISTINCT c.cid::uuid, c.cel, current_date, c.ori, c.des
           FROM unnest($1::uuid[], $2::text[], $3::text[], $4::text[]) AS c(cid, cel, ori, des)
           ON CONFLICT (cliente_id, celula) DO UPDATE
             SET ultimo_visto = EXCLUDED.ultimo_visto,
                 origem_celula = COALESCE(EXCLUDED.origem_celula, corredor_celulas.origem_celula),
                 destino_celula = COALESCE(EXCLUDED.destino_celula, corredor_celulas.destino_celula)
             WHERE corredor_celulas.ultimo_visto < EXCLUDED.ultimo_visto`,
          [
            celulasCiclo.map((c) => c.cliente_id),
            celulasCiclo.map((c) => c.celula),
            celulasCiclo.map((c) => c.origem),
            celulasCiclo.map((c) => c.destino),
          ]
```

- [ ] **Step 4: Tipos e testes**

Run: `npx tsc --noEmit && npx vitest run`
Expected: limpo

- [ ] **Step 5: Commit**

```bash
git add scripts/migrations/014_tapete_origem_destino.sql src/app/api/motor/route.ts
git commit -m "feat(tapete): coleta par origem-destino por celula (migration 014, so coleta)"
```

---

### Task 7: Validação final e deploy

**Files:** nenhum (validação) + `ESTADO.md`

- [ ] **Step 1: Suíte completa + build**

Run: `npx tsc --noEmit && npx vitest run && npm run build`
Expected: tudo limpo. `npx eslint` nos arquivos tocados = baseline igual (comparar com `git stash` se surgir finding novo).

- [ ] **Step 2: Push e observação em produção**

`git push origin main`. Após o deploy: observar 20-30min os alertas de desvio (`select v.placa, a.motivo, a.desde from alertas a join veiculos v on v.id=a.veiculo_id where a.tipo='desvio' and a.created_at > now() - interval '1 hour' order by a.created_at desc`) e as posições (`select count(*) from posicoes_atuais where updated_at > now() - interval '2 minutes'` — motor vivo). Conferir no log da Vercel que não há erro novo e que as chamadas de corredor aparecem em volume baixo (dezenas/hora no máximo).

- [ ] **Step 3: ESTADO.md + docs**

Adicionar bullet no `## Pronto` do `ESTADO.md` (histerese + verificação por corredor + coleta O-D, com data e link pro design) e atualizar a seção 5 de `docs/analise-deteccao.md` (mover "corredor" de "não implementado" pra "no ar"). Commit + push.
