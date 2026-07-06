# Desvio sem rota planejada (v2): plano de implementação

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Substituir a detecção de desvio baseada em rota inventada (corredor OSRM + "próximo cliente") pelo detector comportamental (afastamento de todos os destinos legítimos) + tapete histórico de células, marcar o início do desvio no mapa, remover a UI de rota falsa e consertar o rastro azul que não acompanha o veículo.

**Architecture:** Detectores são funções puras em `src/lib/detectores.ts` (sem I/O), alimentadas pelo motor (`src/app/api/motor/route.ts`, roda a cada 1min via pg_cron, timeout 60s). Estado entre ciclos vive em `posicoes_atuais`. Tapete = tabela agregada `corredor_celulas` (célula ~100m, upsert batch por ciclo, leitura só para candidatos). UI em `src/app/(app)/central-v2/` (MonitorV2 + MapaLeafletV2, Google Maps imperativo).

**Tech Stack:** Next.js 16 (App Router), TypeScript strict, Supabase (Postgres + PostGIS via pool `pg`), vitest.

**Regras do repo (valem para TODA tarefa):** português com acentos; NUNCA usar travessão; repo é PÚBLICO (nunca commitar segredo); detectores são funções puras; validar com `npx vitest run` e `npx tsc --noEmit` antes de cada commit; migrations são aplicadas MANUALMENTE no Supabase (avisar o usuário, não tentar aplicar).

**Design aprovado:** `docs/plans/2026-07-06-desvio-sem-rota-design.md` (ler antes de começar).

---

### Task 1: Migration 010

**Files:**
- Create: `scripts/migrations/010_desvio_sem_rota.sql`

**Step 1: Criar o arquivo da migration**

```sql
-- 010: desvio sem rota planejada (v2)
-- Remove a infra de corredor OSRM (rota sintética) e cria o estado do
-- detector comportamental + tapete histórico de células (~100m).

-- Estado do streak de desvio entre ciclos do motor
alter table posicoes_atuais drop column if exists fora_corredor;
alter table posicoes_atuais add column if not exists desvio_streak integer not null default 0;
alter table posicoes_atuais add column if not exists desvio_inicio jsonb;

-- Rota sintética OSRM: conceito removido (não existe rota planejada)
drop table if exists rotas_cache;

-- Tapete histórico: células (~111m x 102m no RJ) percorridas pela frota
-- nos últimos 30 dias. Agregado de propósito: nada de posição crua.
create table if not exists corredor_celulas (
  cliente_id   uuid not null references clientes(id) on delete cascade,
  celula       text not null,
  ultimo_visto date not null default current_date,
  primary key (cliente_id, celula)
);
create index if not exists idx_corredor_ultimo_visto on corredor_celulas(ultimo_visto);
alter table corredor_celulas enable row level security;
```

**Step 2: Commit**

```bash
git add scripts/migrations/010_desvio_sem_rota.sql
git commit -m "feat(db): migration 010 - estado de desvio v2 + tapete corredor_celulas"
```

**Step 3: Avisar o usuário** que a migration precisa ser aplicada manualmente no Supabase ANTES do deploy do motor novo (o código da Task 4 depende das colunas). Não aplicar sozinho.

---

### Task 2: lib de células (pura, TDD)

**Files:**
- Create: `src/lib/celulas.ts`
- Create: `src/lib/celulas.test.ts`

**Step 1: Escrever os testes que falham**

```typescript
import { describe, it, expect } from "vitest";
import { celulaDe, vizinhanca3x3, celulasDoSegmento } from "./celulas";

describe("celulaDe", () => {
  it("arredonda lat/lng a 3 casas (celula ~100m)", () => {
    expect(celulaDe(-22.9123, -43.2456)).toBe("-22912:-43246");
  });
  it("pontos a menos de ~50m caem na mesma celula", () => {
    expect(celulaDe(-22.91231, -43.24558)).toBe(celulaDe(-22.91234, -43.24561));
  });
});

describe("vizinhanca3x3", () => {
  it("retorna 9 celulas incluindo a central", () => {
    const viz = vizinhanca3x3(-22.9123, -43.2456);
    expect(viz).toHaveLength(9);
    expect(viz).toContain("-22912:-43246");
    expect(viz).toContain("-22911:-43245");
    expect(viz).toContain("-22913:-43247");
  });
});

describe("celulasDoSegmento", () => {
  it("interpola celulas contiguas ao longo do segmento (sem buracos)", () => {
    // ~1,1km na latitude: a 70km/h e amostra de 1min isso e um salto tipico
    const celulas = celulasDoSegmento(-22.9, -43.2, -22.91, -43.2);
    expect(celulas.length).toBeGreaterThanOrEqual(10);
    expect(celulas).toContain(celulaDe(-22.9, -43.2));
    expect(celulas).toContain(celulaDe(-22.91, -43.2));
    expect(celulas).toContain(celulaDe(-22.905, -43.2));
  });
  it("nao interpola teleporte (segmento > 2,5km): so a celula do destino", () => {
    const celulas = celulasDoSegmento(-22.9, -43.2, -22.95, -43.2); // ~5,5km
    expect(celulas).toEqual([celulaDe(-22.95, -43.2)]);
  });
  it("mesmo ponto retorna uma unica celula", () => {
    expect(celulasDoSegmento(-22.9, -43.2, -22.9, -43.2)).toEqual([celulaDe(-22.9, -43.2)]);
  });
});
```

**Step 2: Rodar e ver falhar**

Run: `npx vitest run src/lib/celulas.test.ts`
Expected: FAIL (módulo não existe)

**Step 3: Implementar**

```typescript
// Tapete histórico de células: grade de ~100m usada pela camada 2 da
// detecção de desvio. Célula = lat/lng arredondados a 3 casas decimais
// (~111m x ~102m na latitude do RJ). Funções PURAS, sem I/O.

import { haversineM } from "./unitrac";

// Passo da interpolação ao longo de um segmento entre duas leituras de GPS.
const PASSO_M = 80;
// Acima disso o "segmento" é salto de GPS/reconexão, não trajeto real.
const SEGMENTO_MAX_M = 2500;

export function celulaDe(lat: number, lng: number): string {
  return `${Math.round(lat * 1000)}:${Math.round(lng * 1000)}`;
}

// As 9 células (3x3) em volta do ponto: tolerância a GPS na beirada da via.
export function vizinhanca3x3(lat: number, lng: number): string[] {
  const la = Math.round(lat * 1000);
  const lo = Math.round(lng * 1000);
  const out: string[] = [];
  for (let di = -1; di <= 1; di++) {
    for (let dj = -1; dj <= 1; dj++) {
      out.push(`${la + di}:${lo + dj}`);
    }
  }
  return out;
}

// Células cobertas pelo trajeto entre duas leituras consecutivas.
// A 70km/h com amostra de 1min o veículo cruza ~11 células: sem interpolar,
// o tapete fica esburacado e a checagem 3x3 dá falso "fora do tapete".
export function celulasDoSegmento(
  latA: number, lngA: number, latB: number, lngB: number
): string[] {
  const dist = haversineM(latA, lngA, latB, lngB);
  if (dist > SEGMENTO_MAX_M) return [celulaDe(latB, lngB)];
  const n = Math.max(1, Math.ceil(dist / PASSO_M));
  const set = new Set<string>();
  for (let i = 0; i <= n; i++) {
    const t = i / n;
    set.add(celulaDe(latA + (latB - latA) * t, lngA + (lngB - lngA) * t));
  }
  return [...set];
}
```

**Step 4: Rodar e ver passar**

Run: `npx vitest run src/lib/celulas.test.ts`
Expected: PASS

**Step 5: Commit**

```bash
git add src/lib/celulas.ts src/lib/celulas.test.ts
git commit -m "feat(celulas): grade de ~100m com vizinhanca 3x3 e interpolacao de segmento"
```

---

### Task 3: detector de desvio v2 (puro, TDD)

**Files:**
- Modify: `src/lib/detectores.ts` (funções `CtxDesvio`, `foraDeRota`, `detectarDesvio`, e os dois pontos que as chamam em `avaliar`/`avaliarTodos`)
- Modify: `src/lib/detectores.test.ts` (bloco de testes do desvio, ~linhas 229-296)

**Step 1: Reescrever os testes do desvio (falham contra o código atual)**

Substituir o bloco `describe` do desvio em `detectores.test.ts` por:

```typescript
describe("detectarDesvio (v2: afastamento de todos os destinos)", () => {
  // Destinos = alvos pendentes + bases. dist*: mesma ordem nos dois arrays.
  const base = {
    distDestinosM: [6000, 8000, 12000],
    distDestinosAnteriorM: [5000, 7000, 11000],
    temPendentes: true,
    emOperacao: true,
    foraDaBase: true,
    entregasFeitas: 2,
    streak: 2,
    afastamentoAcumuladoM: 900,
    dentroTapete: null as boolean | null,
  };
  const emMov = posicaoBase({ velocidade: 40 });

  it("streak 2 + acumulado 500m+ dentro de caminho conhecido: atencao", () => {
    const a = detectarDesvio(emMov, { ...base, dentroTapete: true });
    expect(a?.nivel).toBe("atencao");
    expect(a?.tipo).toBe("desvio");
  });

  it("streak 2 fora do tapete: critico direto", () => {
    const a = detectarDesvio(emMov, { ...base, dentroTapete: false });
    expect(a?.nivel).toBe("critico");
  });

  it("streak 4 + acumulado 1,5km+: critico mesmo dentro do tapete", () => {
    const a = detectarDesvio(emMov, {
      ...base, streak: 4, afastamentoAcumuladoM: 1600, dentroTapete: true,
    });
    expect(a?.nivel).toBe("critico");
  });

  it("streak 1 nao dispara (persistencia minima 2 ciclos)", () => {
    expect(detectarDesvio(emMov, { ...base, streak: 1 })).toBeNull();
  });

  it("acumulado abaixo de 500m nao dispara em tapete desconhecido/conhecido", () => {
    expect(detectarDesvio(emMov, { ...base, afastamentoAcumuladoM: 300 })).toBeNull();
  });

  it("parado nao dispara", () => {
    expect(detectarDesvio(posicaoBase({ velocidade: 0 }), base)).toBeNull();
  });

  it("indo para a primeira entrega (0 feitas com pendentes) nao dispara", () => {
    expect(detectarDesvio(emMov, { ...base, entregasFeitas: 0 })).toBeNull();
  });

  it("fora da faixa local nao dispara (menor dist < 2,5km ou > 25km)", () => {
    expect(detectarDesvio(emMov, {
      ...base, distDestinosM: [2000, 8000], distDestinosAnteriorM: [1500, 7000],
    })).toBeNull();
    expect(detectarDesvio(emMov, {
      ...base, distDestinosM: [30000, 40000], distDestinosAnteriorM: [29000, 39000],
    })).toBeNull();
  });

  it("0 pendentes (fim de rota): afastando da base 3 ciclos + 2km = atencao", () => {
    const a = detectarDesvio(emMov, {
      ...base, temPendentes: false, distDestinosM: [7000], distDestinosAnteriorM: [6000],
      streak: 3, afastamentoAcumuladoM: 2100,
    });
    expect(a?.nivel).toBe("atencao");
  });

  it("0 pendentes com streak 2 nao dispara (limiar maior no fim de rota)", () => {
    expect(detectarDesvio(emMov, {
      ...base, temPendentes: false, distDestinosM: [7000], distDestinosAnteriorM: [6000],
      streak: 2, afastamentoAcumuladoM: 2100,
    })).toBeNull();
  });

  it("fora de operacao ou dentro da base nao dispara", () => {
    expect(detectarDesvio(emMov, { ...base, emOperacao: false })).toBeNull();
    expect(detectarDesvio(emMov, { ...base, foraDaBase: false })).toBeNull();
  });
});

describe("afastouDeTudo", () => {
  it("true quando TODAS as distancias cresceram alem da margem de 50m", () => {
    expect(afastouDeTudo([6000, 8000], [5000, 7000])).toBe(true);
  });
  it("false quando aproxima de QUALQUER destino", () => {
    expect(afastouDeTudo([6000, 6900], [5000, 7000])).toBe(false);
  });
  it("false quando o crescimento fica dentro da margem de ruido", () => {
    expect(afastouDeTudo([5030, 7040], [5000, 7000])).toBe(false);
  });
  it("false sem destinos ou com arrays de tamanhos diferentes", () => {
    expect(afastouDeTudo([], [])).toBe(false);
    expect(afastouDeTudo([5000], [])).toBe(false);
  });
});

describe("foraDeRota (v2: menor distancia a qualquer destino)", () => {
  const p = posicaoBase();
  it("mantem alerta enquanto longe de todos os destinos", () => {
    expect(foraDeRota(p, { menorDistDestinoM: 3000, emOperacao: true, foraDaBase: true })).toBe(true);
  });
  it("resolve quando volta a menos de 2,5km de algum destino", () => {
    expect(foraDeRota(p, { menorDistDestinoM: 1000, emOperacao: true, foraDaBase: true })).toBe(false);
  });
  it("resolve dentro da base ou fora de operacao", () => {
    expect(foraDeRota(p, { menorDistDestinoM: 9000, emOperacao: true, foraDaBase: false })).toBe(false);
    expect(foraDeRota(p, { menorDistDestinoM: 9000, emOperacao: false, foraDaBase: true })).toBe(false);
  });
});
```

Ajustar o import no topo do teste para incluir `afastouDeTudo`.

**Step 2: Rodar e ver falhar**

Run: `npx vitest run src/lib/detectores.test.ts`
Expected: FAIL (assinaturas antigas)

**Step 3: Implementar o detector v2**

Em `detectores.ts`, substituir o bloco inteiro de `CtxDesvio`, `foraDeRota` e `detectarDesvio` (hoje linhas ~276-392) por:

```typescript
// Faixa de distância (m) em que faz sentido falar de "desvio de rota local".
// Abaixo do mínimo o veículo está chegando num destino (normal). Acima do teto
// não é desvio: é DESLOCAMENTO interurbano (a frota atende o estado todo).
const DESVIO_MIN_M = 2500;
const DESVIO_GATILHO_TETO_M = 25000;
// Crescimento mínimo por destino para contar afastamento real (ruído de GPS).
const AFASTAMENTO_MARGEM_M = 50;

// A Unitrac NÃO fornece rota planejada nem ordem confiável de entregas.
// Desvio aqui é comportamento: o veículo agindo como quem não vai para
// NENHUM destino legítimo dele. Destinos legítimos = alvos pendentes + bases.
export type CtxDesvio = {
  // Distância atual e do ciclo anterior a CADA destino legítimo (mesma ordem).
  distDestinosM: number[];
  distDestinosAnteriorM: number[];
  temPendentes: boolean;
  emOperacao: boolean;
  foraDaBase: boolean;
  entregasFeitas?: number;
  // Ciclos consecutivos afastando-se de tudo (o motor incrementa e persiste).
  streak: number;
  // menorDist(agora) - menorDist(no início da sequência). Congela retorno curto.
  afastamentoAcumuladoM: number;
  // Camada 2: true = célula (3x3) no tapete histórico da frota; false = fora
  // de qualquer caminho conhecido; null = sem tapete na região (não modula).
  dentroTapete: boolean | null;
};

// O veículo se afastou de TODOS os destinos legítimos desde o ciclo anterior?
// Quem vai em direção a QUALQUER destino aproxima dele e quebra a condição;
// retornos e contornos quebram sozinhos em algum ciclo da curva.
export function afastouDeTudo(
  distDestinosM: number[],
  distDestinosAnteriorM: number[]
): boolean {
  if (distDestinosM.length === 0) return false;
  if (distDestinosM.length !== distDestinosAnteriorM.length) return false;
  return distDestinosM.every(
    (d, i) => d > distDestinosAnteriorM[i] + AFASTAMENTO_MARGEM_M
  );
}

// Condição FROUXA de permanência do alerta (anti-pisca): mantém enquanto o
// veículo segue longe (>=2,5km) de TODOS os destinos, incluindo as bases.
export function foraDeRota(
  p: PosicaoNormalizada,
  ctx: { menorDistDestinoM: number | null; emOperacao: boolean; foraDaBase: boolean }
): boolean {
  if (!ctx.emOperacao || !ctx.foraDaBase) return false;
  if (ctx.menorDistDestinoM === null) return false;
  return ctx.menorDistDestinoM >= DESVIO_MIN_M;
}

// Detector de DESVIO (gatilho de criação, estrito).
export function detectarDesvio(p: PosicaoNormalizada, ctx: CtxDesvio): Alerta | null {
  if (!ctx.emOperacao || !ctx.foraDaBase) return null;
  if (p.velocidade <= 0) return null;
  // Indo para a primeira entrega do dia: sem referência de comportamento ainda.
  if (ctx.temPendentes && (ctx.entregasFeitas ?? 1) === 0) return null;
  if (ctx.distDestinosM.length === 0) return null;

  const menorDistM = Math.min(...ctx.distDestinosM);
  if (menorDistM < DESVIO_MIN_M || menorDistM > DESVIO_GATILHO_TETO_M) return null;
  if (ctx.streak < 2) return null;

  const nDest = ctx.distDestinosM.length;
  const kmAcum = (Math.max(0, ctx.afastamentoAcumuladoM) / 1000).toFixed(1).replace(".", ",");

  // Fora de qualquer caminho já percorrido pela frota: crítico direto.
  if (ctx.dentroTapete === false) {
    return {
      nivel: "critico",
      tipo: "desvio",
      motivo: `Afastando-se de todos os ${nDest} destinos há ${ctx.streak} leituras, fora de caminho conhecido da frota`,
      score: 78,
    };
  }

  // Fim de rota (0 pendentes): o único destino legítimo é a base.
  if (!ctx.temPendentes) {
    if (ctx.streak >= 3 && ctx.afastamentoAcumuladoM >= 2000) {
      return {
        nivel: "atencao",
        tipo: "desvio",
        motivo: `Sem entregas pendentes e afastando-se da base há ${ctx.streak} leituras (+${kmAcum}km)`,
        score: 50,
      };
    }
    return null;
  }

  if (ctx.streak >= 4 && ctx.afastamentoAcumuladoM >= 1500) {
    return {
      nivel: "critico",
      tipo: "desvio",
      motivo: `Afastando-se de todas as entregas e da base há ${ctx.streak} leituras (+${kmAcum}km)`,
      score: 72,
    };
  }
  if (ctx.afastamentoAcumuladoM >= 500) {
    return {
      nivel: "atencao",
      tipo: "desvio",
      motivo: `Afastando-se de todas as entregas e da base há ${ctx.streak} leituras (+${kmAcum}km)`,
      score: 48,
    };
  }
  return null;
}
```

Remover a função `difAnguloGraus` SE ela ficar sem uso (verificar com grep; outros detectores podem usar).

**Step 4: Atualizar `avaliar` e `avaliarTodos`**

Nos DOIS lugares (linhas ~569-582 e ~668-681), trocar o bloco do desvio por:

```typescript
    ctx.distDestinosM !== undefined
      ? detectarDesvio(p, {
          distDestinosM: ctx.distDestinosM ?? [],
          distDestinosAnteriorM: ctx.distDestinosAnteriorM ?? [],
          temPendentes: ctx.temPendentes ?? false,
          emOperacao: ctx.emOperacao,
          foraDaBase: ctx.foraDaBase,
          entregasFeitas: ctx.entregasFeitas,
          streak: ctx.desvioStreak ?? 0,
          afastamentoAcumuladoM: ctx.afastamentoAcumuladoM ?? 0,
          dentroTapete: ctx.dentroTapete ?? null,
        })
      : null,
```

E no tipo do `ctx` de `avaliar` (linha ~595): remover `distAlvoM`, `distAlvoAnteriorM`, `rumoAlvo`, `distCorredorM`, `jaForaCorretor`; adicionar:

```typescript
    distDestinosM?: number[];
    distDestinosAnteriorM?: number[];
    desvioStreak?: number;
    afastamentoAcumuladoM?: number;
    dentroTapete?: boolean | null;
```

(`rumoMovimento`, `rumoBase`, `distBaseM` FICAM: são usados por `detectarSaidaNaoAutorizada`.)

**Step 5: Rodar testes e tsc**

Run: `npx vitest run src/lib/detectores.test.ts` até PASS.
Run: `npx tsc --noEmit`
Expected: erros APENAS em `motor/route.ts` (chamadas antigas, consertadas na Task 4). Se houver erro em outro arquivo, consertar agora.

**Step 6: Commit**

```bash
git add src/lib/detectores.ts src/lib/detectores.test.ts
git commit -m "feat(detectores): desvio v2 por afastamento de todos os destinos, sem rota sintetica"
```

---

### Task 4: motor (fiação do detector v2 + tapete + remoção OSRM)

**Files:**
- Modify: `src/app/api/motor/route.ts`
- Modify: `src/lib/unitrac.ts` (receber `centroideGeo`)
- Delete: `src/lib/osrm.ts`

Sem teste unitário próprio (o motor é I/O); validação = `npx tsc --noEmit` + `npx vitest run` completos.

**Step 1: Mover `centroideGeo` de `osrm.ts` para `unitrac.ts`**

Copiar a função `centroideGeo` e o tipo `GeoJSONGeomSimple` de `src/lib/osrm.ts:76-95` para o fim de `src/lib/unitrac.ts` (export igual). Atualizar o import no motor (`from "@/lib/osrm"` vira `from "@/lib/unitrac"`). Deletar `src/lib/osrm.ts`.

**Step 2: Remover a infra de corredor OSRM do motor**

Em `motor/route.ts`:
- Import (linhas ~29-30): remover `hashAlvos, buscarRotaOSRM, distanciaAoCorredorM, RAIO_CORREDOR_M`; manter `centroideGeo` vindo de `@/lib/unitrac`.
- Remover `osrmChamadasNoCiclo`, `OSRM_MAX_POR_CICLO` (~432-433), `rotasParaUpsert` (~430-431), o SELECT/carga de `mapaRotasCache` (~403-429), o bloco "Corredor OSRM" inteiro (~630-672, inclui `jaForaCorretor`/`foraCorretor`/`CORREDor_TOLERANCIA_M`), e o upsert de `rotas_cache` no fim do ciclo (~1035-1049).
- No SELECT de `posicoes_atuais` (~354): trocar `fora_corredor` por `desvio_streak, desvio_inicio`. Atualizar o tipo da linha logo abaixo (~358) e o objeto montado (~367).
- Remover `rumoAlvo` (~624-626); manter `rumoMovimento`, `rumoBase`, `distBaseM` (usados por saída não autorizada) e `alvoPendenteMaisProximo`/`maisProximoQualquer` (usados por `noCliente`). `distAlvoM`/`distAlvoAnteriorM` saem se ficarem sem uso.

**Step 3: Calcular destinos, streak e acumulado (substitui o bloco ~595-628)**

```typescript
          // ─── Desvio v2: destinos legítimos = alvos pendentes + bases ────
          // Sem rota planejada, desvio é comportamento: afastar-se de TODOS
          // os destinos ao mesmo tempo, sustentado por ciclos consecutivos.
          const pontosVeiculo = pontosPorPlaca.get(pos.placa);
          veiculoIdToAlvos.set(veiculo_id, pontosVeiculo ?? []);
          const pendentes = (pontosVeiculo ?? []).filter((pt) => !pt.feito);
          const temPendentes = pendentes.length > 0;
          const centroidesBases = basesCliente
            .map((b) => centroideGeo(b.geom))
            .filter((c): c is { lat: number; lng: number } => c !== null);
          const destinos = [
            ...pendentes.map((pt) => ({ lat: pt.lat, lng: pt.lng })),
            ...centroidesBases,
          ];
          const distDestinosM = destinos.map((d) => haversineM(pos.lat, pos.lng, d.lat, d.lng));
          const temAnterior = anterior && anterior.lat != null && anterior.lng != null;
          const distDestinosAnteriorM = temAnterior
            ? destinos.map((d) => haversineM(anterior.lat!, anterior.lng!, d.lat, d.lng))
            : [];
          const menorDistDestinoM = distDestinosM.length > 0 ? Math.min(...distDestinosM) : null;

          // Guarda anti-teleporte: salto implausível entre ciclos (>150km/h
          // implícitos) congela o streak (não incrementa nem reseta).
          const saltoImplausivel =
            !!temAnterior && haversineM(anterior.lat!, anterior.lng!, pos.lat, pos.lng) > 2500;

          type DesvioInicio = { lat: number; lng: number; ts: string; menor_dist_m: number };
          let desvioStreak: number = anterior?.desvio_streak ?? 0;
          let desvioInicio: DesvioInicio | null =
            (anterior?.desvio_inicio as DesvioInicio | null) ?? null;
          if (pos.fresco && !saltoImplausivel && pos.velocidade > 0 && temAnterior) {
            if (afastouDeTudo(distDestinosM, distDestinosAnteriorM)) {
              desvioStreak += 1;
              if (desvioStreak === 1) {
                desvioInicio = {
                  lat: anterior.lat!,
                  lng: anterior.lng!,
                  ts: agora.toISOString(),
                  menor_dist_m: Math.min(...distDestinosAnteriorM),
                };
              }
            } else {
              desvioStreak = 0;
              desvioInicio = null;
            }
          }
          const afastamentoAcumuladoM =
            desvioInicio && menorDistDestinoM !== null
              ? menorDistDestinoM - desvioInicio.menor_dist_m
              : 0;

          // Camada 2 (tapete): consulta APENAS candidatos reais (streak >= 2).
          let dentroTapete: boolean | null = null;
          if (desvioStreak >= 2 && pos.fresco) {
            const tapeteTotal = await contarTapeteCliente(cliente_id);
            if (tapeteTotal > 0) {
              const { data: hits } = await supabase
                .from("corredor_celulas")
                .select("celula")
                .eq("cliente_id", cliente_id)
                .in("celula", vizinhanca3x3(pos.lat, pos.lng))
                .limit(1);
              dentroTapete = (hits ?? []).length > 0;
            }
          }

          // Parada no cliente (Benassi): inalterado.
          const maisProximoQualquer = alvoMaisProximoQualquer(pos.lat, pos.lng, pontosVeiculo);
          const noCliente =
            pos.velocidade === 0 &&
            maisProximoQualquer !== null &&
            maisProximoQualquer.distM <= Math.max(maisProximoQualquer.ponto.raio, 150);

          const rumoMovimento =
            temAnterior && (anterior.lat !== pos.lat || anterior.lng !== pos.lng)
              ? rumoGraus(anterior.lat!, anterior.lng!, pos.lat, pos.lng)
              : null;

          // Condição FROUXA de permanência (anti-pisca), agora incluindo bases.
          const estaForaDeRota =
            pos.fresco && foraDeRota(pos, { menorDistDestinoM, emOperacao, foraDaBase });
```

Adicionar imports: `afastouDeTudo` de `@/lib/detectores`; `vizinhanca3x3, celulasDoSegmento` de `@/lib/celulas`.

Helper `contarTapeteCliente` (cache por ciclo, declarar junto dos outros caches no início do handler):

```typescript
    // Tapete: contagem por cliente cacheada no ciclo (distingue "fora do
    // tapete" de "tapete ainda não semeado", que não pode modular severidade).
    const tapeteContagem = new Map<string, number>();
    const contarTapeteCliente = async (clienteId: string): Promise<number> => {
      const cacheado = tapeteContagem.get(clienteId);
      if (cacheado !== undefined) return cacheado;
      const { count } = await supabase
        .from("corredor_celulas")
        .select("celula", { count: "exact", head: true })
        .eq("cliente_id", clienteId);
      const n = count ?? 0;
      tapeteContagem.set(clienteId, n);
      return n;
    };
```

**Step 4: Alimentar o tapete (células do ciclo)**

Declarar junto dos acumuladores do ciclo: `const celulasCiclo: { cliente_id: string; celula: string }[] = [];`

Dentro do loop do veículo (logo após o bloco do Step 3):

```typescript
          // Alimentar o tapete: células do trajeto desde o ciclo anterior.
          if (pos.fresco && temAnterior && (anterior.lat !== pos.lat || anterior.lng !== pos.lng)) {
            for (const c of celulasDoSegmento(anterior.lat!, anterior.lng!, pos.lat, pos.lng)) {
              celulasCiclo.push({ cliente_id, celula: c });
            }
          }
```

No fim do ciclo (onde ficava o upsert de rotas_cache, ~1035), o batch:

```typescript
    // Upsert batch do tapete (1 statement por ciclo). O WHERE evita churn de
    // dead tuples: cada célula só é reescrita uma vez por dia.
    if (celulasCiclo.length > 0) {
      const pgc = await pool.connect();
      try {
        await pgc.query(
          `INSERT INTO corredor_celulas (cliente_id, celula, ultimo_visto)
           SELECT DISTINCT c.cid::uuid, c.cel, current_date
           FROM unnest($1::uuid[], $2::text[]) AS c(cid, cel)
           ON CONFLICT (cliente_id, celula) DO UPDATE
             SET ultimo_visto = EXCLUDED.ultimo_visto
             WHERE corredor_celulas.ultimo_visto < EXCLUDED.ultimo_visto`,
          [celulasCiclo.map((c) => c.cliente_id), celulasCiclo.map((c) => c.celula)]
        );
      } finally {
        pgc.release();
      }
    }
```

**Step 5: Atualizar a chamada de `avaliar` e o UPSERT de posicoes_atuais**

Na chamada de `avaliar` (procurar `distAlvoM:` no objeto ctx): remover `distAlvoM`, `distAlvoAnteriorM`, `rumoAlvo`, `distCorredorM`, `jaForaCorretor`; adicionar `distDestinosM`, `distDestinosAnteriorM`, `desvioStreak`, `afastamentoAcumuladoM`, `dentroTapete`.

No UPSERT (~873-927): trocar a coluna `fora_corredor` por `desvio_streak` e adicionar `desvio_inicio` (novo parâmetro `$21`, tipo `::jsonb`, valor `desvioInicio ? JSON.stringify(desvioInicio) : null`; no DO UPDATE: `desvio_streak = EXCLUDED.desvio_streak, desvio_inicio = EXCLUDED.desvio_inicio`). Conferir a numeração dos parâmetros.

**Step 6: Alerta de desvio nasce no ponto de início**

No INSERT do alerta (~967-978), trocar por:

```typescript
              if (!jaExiste) {
                const ehDesvio = alerta.tipo === "desvio" && desvioInicio !== null;
                await supabase.from("alertas").insert({
                  cliente_id,
                  veiculo_id,
                  nivel: alerta.nivel,
                  tipo: alerta.tipo,
                  motivo: alerta.motivo,
                  score: alerta.score,
                  status: "ativo",
                  // Desvio: lat/lng do PONTO DE INÍCIO da sequência (onde
                  // começou a se afastar), não da posição do disparo.
                  lat: ehDesvio ? desvioInicio!.lat : pos.lat,
                  lng: ehDesvio ? desvioInicio!.lng : pos.lng,
                  contexto: ehDesvio
                    ? { inicio_ts: desvioInicio!.ts, fora_tapete: dentroTapete === false }
                    : {},
                  desde: agora.toISOString(),
                });
              }
```

**Step 7: Expiração do tapete na limpeza horária**

No bloco de limpeza (~1228-1244), adicionar junto dos outros DELETEs:

```typescript
      // Tapete: células sem visita há mais de 30 dias saem do corredor.
      await supabase.from("corredor_celulas").delete().lt(
        "ultimo_visto",
        new Date(agora.getTime() - 30 * 86400_000).toISOString().slice(0, 10)
      );
```

**Step 8: Validar**

Run: `npx tsc --noEmit` até zero erros.
Run: `npx vitest run`
Expected: PASS. Grep final de segurança: `grep -rn "fora_corredor\|rotas_cache\|distCorredorM\|jaForaCorretor\|buscarRotaOSRM\|hashAlvos\|distanciaAoCorredorM" src/` deve retornar vazio.

**Step 9: Commit**

```bash
git add -A src/
git commit -m "feat(motor): desvio v2 (destinos legitimos + tapete de celulas), remove corredor OSRM"
```

---

### Task 5: script de bootstrap do tapete (rastro de 96h)

**Files:**
- Create: `scripts/bootstrap-corredor.ts`

**Step 1: Escrever o script**

```typescript
// Semeia o tapete (corredor_celulas) com o rastro de 96h de cada veículo da
// frota, uma única vez no deploy. Depois disso o motor acumula sozinho.
// Uso: npx tsx scripts/bootstrap-corredor.ts
// Requer .env.local com NEXT_PUBLIC_SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY
// e as credenciais Unitrac que src/lib/unitrac.ts já usa.

import { createClient } from "@supabase/supabase-js";
import { buscarRastro } from "../src/lib/unitrac";
import { celulasDoSegmento, celulaDe } from "../src/lib/celulas";
import { config } from "dotenv";

config({ path: ".env.local" });

const supabase = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL!,
  process.env.SUPABASE_SERVICE_ROLE_KEY!
);

async function main() {
  const { data: veiculos, error } = await supabase
    .from("veiculos")
    .select("id, cv, cliente_id")
    .eq("ativo", true);
  if (error) throw error;

  let totalCelulas = 0;
  for (const [i, v] of (veiculos ?? []).entries()) {
    const pontos = await buscarRastro(v.cv, 96);
    const celulas = new Set<string>();
    for (let j = 0; j < pontos.length; j++) {
      if (j === 0) {
        celulas.add(celulaDe(pontos[j].lat, pontos[j].lng));
      } else {
        for (const c of celulasDoSegmento(
          pontos[j - 1].lat, pontos[j - 1].lng, pontos[j].lat, pontos[j].lng
        )) celulas.add(c);
      }
    }
    if (celulas.size > 0) {
      const linhas = [...celulas].map((celula) => ({
        cliente_id: v.cliente_id,
        celula,
        ultimo_visto: new Date().toISOString().slice(0, 10),
      }));
      // Lotes de 2000 para não estourar payload
      for (let k = 0; k < linhas.length; k += 2000) {
        const { error: e2 } = await supabase
          .from("corredor_celulas")
          .upsert(linhas.slice(k, k + 2000), { onConflict: "cliente_id,celula" });
        if (e2) console.error(`  upsert falhou (${v.cv}):`, e2.message);
      }
      totalCelulas += celulas.size;
    }
    console.log(`[${i + 1}/${veiculos!.length}] cv=${v.cv}: ${pontos.length} pontos, ${celulas.size} celulas`);
    await new Promise((r) => setTimeout(r, 300)); // educado com a API
  }
  console.log(`Concluído: ~${totalCelulas} células semeadas.`);
}

main().catch((e) => { console.error(e); process.exit(1); });
```

Nota para o executor: conferir a assinatura real de `buscarRastro` e o nome da coluna de veículo ativo (`ativo`) antes de rodar; ajustar se diferir. Se o repo não tiver `dotenv`/`tsx` como devDependency, instalar (`npm i -D dotenv tsx`).

**Step 2: Validar tipos**

Run: `npx tsc --noEmit`
Expected: zero erros (o script está fora de src/, incluir só se o tsconfig cobrir scripts/; senão validar com `npx tsx --check` ou rodar dry).

**Step 3: Commit**

```bash
git add scripts/bootstrap-corredor.ts package.json package-lock.json
git commit -m "feat(scripts): bootstrap do tapete com rastro de 96h da frota"
```

**Step 4: Avisar o usuário** que o script deve ser rodado manualmente 1x APÓS aplicar a migration 010: `npx tsx scripts/bootstrap-corredor.ts`.

---

### Task 6: UI MapaLeafletV2 (remover listra laranja, marcar início do desvio)

Antes de mexer: ler `node_modules/next/dist/docs/` sobre client components se houver dúvida (regra do repo).

**Files:**
- Modify: `src/app/(app)/central-v2/MapaLeafletV2.tsx`
- Modify: `src/app/(app)/central-v2/MonitorV2.tsx` (só as props que somem/entram)

**Step 1: Remover a rota falsa**

Em `MapaLeafletV2.tsx`:
- Remover `routeLinesRef` (~401), o memo `routeWaypoints` (~499-510), o useEffect inteiro da linha pontilhada + OSRM + ETA (~512-573), o estado `etaMinutos` e a prop/callback `onEtaChange` (declaração e uso), `dashSeq` (~636) se só a rota usava, e qualquer exibição "~Xmin" ligada ao ETA.
- Grep local: `grep -n "routeWaypoints\|routeLinesRef\|etaMinutos\|onEtaChange\|dashSeq" src/app/\(app\)/central-v2/MapaLeafletV2.tsx` deve retornar vazio ao final.

**Step 2: Marcador do início do desvio**

Adicionar prop nova ao componente:

```typescript
  // Ponto onde o desvio ativo do veículo selecionado começou (lat/lng do
  // alerta) — desenha marcador de aviso + linha fina até a posição atual.
  desvioInicio?: { lat: number; lng: number } | null;
```

E um useEffect imperativo (mesmo padrão dos outros marcadores do arquivo):

```typescript
  const desvioRefs = useRef<{ marker: google.maps.Marker | null; linha: google.maps.Polyline | null }>({ marker: null, linha: null });
  useEffect(() => {
    desvioRefs.current.marker?.setMap(null);
    desvioRefs.current.linha?.setMap(null);
    desvioRefs.current = { marker: null, linha: null };
    if (!map || !desvioInicio || !vmSelecionado?.lat || !vmSelecionado?.lng) return;
    const marker = new google.maps.Marker({
      map,
      position: { lat: desvioInicio.lat, lng: desvioInicio.lng },
      title: "Início do desvio",
      icon: {
        path: google.maps.SymbolPath.CIRCLE,
        scale: 8,
        fillColor: "#ef4444",
        fillOpacity: 0.9,
        strokeColor: "#7f1d1d",
        strokeWeight: 2,
      },
      zIndex: 30,
    });
    const linha = new google.maps.Polyline({
      map,
      path: [
        { lat: desvioInicio.lat, lng: desvioInicio.lng },
        { lat: vmSelecionado.lat, lng: vmSelecionado.lng },
      ],
      strokeColor: "#ef4444",
      strokeOpacity: 0.7,
      strokeWeight: 2,
      zIndex: 29,
    });
    desvioRefs.current = { marker, linha };
    return () => {
      desvioRefs.current.marker?.setMap(null);
      desvioRefs.current.linha?.setMap(null);
      desvioRefs.current = { marker: null, linha: null };
    };
  }, [map, desvioInicio?.lat, desvioInicio?.lng, vmSelecionado?.lat, vmSelecionado?.lng]);
```

(Ajustar nomes ao padrão do arquivo; se o mapa usa `AdvancedMarkerElement` em vez de `Marker`, seguir o padrão local.)

**Step 3: Passar a prop pelo MonitorV2**

Em `MonitorV2.tsx`, onde o mapa é renderizado (~1305): verificar se a lista `alertas` do poll traz `lat`/`lng` e o veículo do alerta (cv ou veiculo_id). Se `/api/alertas` não retornar lat/lng, adicionar os campos ao select da rota. Então:

```typescript
  const desvioSelecionado = useMemo(() => {
    if (!cvSelecionado) return null;
    const a = alertas.find(
      (x) => x.tipo === "desvio" && x.cv === cvSelecionado && x.lat != null && x.lng != null
    );
    return a ? { lat: a.lat as number, lng: a.lng as number } : null;
  }, [alertas, cvSelecionado]);
```

E passar `desvioInicio={desvioSelecionado}` ao mapa. Remover `onEtaChange={setEtaProxima}` (~1326).

**Step 4: Validar e commitar**

Run: `npx tsc --noEmit && npx vitest run && npm run build`
Expected: tudo verde.

```bash
git add -A src/
git commit -m "feat(mapa): marcador do inicio do desvio; remove listra de rota falsa e ETA"
```

---

### Task 7: UI MonitorV2 (remover "próxima entrega", fix do rastro azul)

**Files:**
- Modify: `src/app/(app)/central-v2/MonitorV2.tsx`

**Step 1: Remover a UI de "próxima entrega"**

- Estado `etaProxima`/`setEtaProxima` (~202-203, ~570, ~588 e usos).
- Bloco "só a próxima entrega" do drawer (~1625-1650, inclui o "~Xmin").
- Manter o progresso de entregas (X de Y) e os pontos de entrega no mapa.
- Grep: `grep -n "etaProxima\|proximaEntrega\|próxima entrega" src/app/\(app\)/central-v2/MonitorV2.tsx` vazio ao final.

**Step 2: Fix do rastro azul (anexar posição do poll)**

Perto dos outros refs (~130), adicionar e sincronizar um ref do selecionado:

```typescript
  const cvSelecionadoRef = useRef<string | null>(null);
  useEffect(() => { cvSelecionadoRef.current = cvSelecionado; }, [cvSelecionado]);
```

No poll do mapa (useEffect ~417-429), depois de `setVeiculosMapa(data.veiculos ?? [])`:

```typescript
        // Rastro vivo: anexa a posição nova do veículo focado ao rastro em
        // memória (a mais de 10m do último ponto). Zero chamadas extras.
        const cvFoco = cvSelecionadoRef.current;
        if (cvFoco) {
          const v = (data.veiculos ?? []).find((x) => x.cv === cvFoco);
          if (v?.lat && v?.lng) {
            setRastro((r) => {
              if (r.length === 0) return r; // fetch inicial ainda em voo
              const [la, lo] = r[r.length - 1];
              const dLat = (v.lat - la) * 111_320;
              const dLng = (v.lng - lo) * 111_320 * Math.cos((la * Math.PI) / 180);
              const distM = Math.sqrt(dLat * dLat + dLng * dLng);
              return distM > 10 ? [...r, [v.lat, v.lng] as [number, number]] : r;
            });
          }
        }
```

**Step 3: Validar e commitar**

Run: `npx tsc --noEmit && npx vitest run && npm run build`

```bash
git add src/app/\(app\)/central-v2/MonitorV2.tsx
git commit -m "fix(monitor): rastro acompanha o veiculo focado; remove bloco proxima entrega"
```

---

### Task 8: verificação final e entrega

**Step 1: Suite completa**

Run: `npx tsc --noEmit && npx vitest run && npm run lint && npm run build`
Expected: tudo verde, zero warnings novos.

**Step 2: Grep de resíduos**

`grep -rn "fora_corredor\|rotas_cache\|osrm\|routeWaypoints\|etaProxima\|distCorredorM" src/` retorna vazio (exceto menções em comentários históricos de docs/, que podem ficar).

**Step 3: Checklist de deploy (informar ao usuário, NÃO executar)**

1. Aplicar `scripts/migrations/010_desvio_sem_rota.sql` no Supabase (manual).
2. Merge/push para main (auto-deploy Vercel).
3. Rodar `npx tsx scripts/bootstrap-corredor.ts` 1x para semear o tapete.
4. Acompanhar 1-2 dias de operação: conferir taxa de alertas de desvio
   (atenção vs crítico) e ajustar limiares (500m/1,5km/2 ciclos) se houver
   fadiga de alarme ou silêncio demais.
