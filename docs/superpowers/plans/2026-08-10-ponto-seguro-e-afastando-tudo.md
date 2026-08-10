# Ponto seguro parado + harness/relaxamento do afastando-de-tudo — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Corrigir dois bugs reais e independentes no detector de desvio de
rota — (1) `suspensoPorChegada` suspende a checagem inteira quando o
veículo só passa (em movimento) perto de qualquer posto de gasolina do RJ,
sem exigir que esteja parado; (2) `afastouDeTudo` exige que TODOS os
destinos pendentes cresçam de distância simultaneamente, o que se torna
geometricamente quase impossível com muitos destinos dispersos (13-15),
deixando o detector cego para veículos com rota carregada.

**Architecture:** Bug 1 é uma mudança de uma linha em `route.ts` (guard de
velocidade no valor de `emPontoSeguro` antes de alimentar
`suspenderPorChegada`). Bug 2 precisa de um harness de backtest em
TypeScript (reaproveitando as funções reais de `detectores.ts`, não
reimplementando) para validar empiricamente qual regra substitui `afastouDeTudo`
sem reabrir o incidente de 06/07 (22 FPs em 20min ao usar só o destino mais
próximo) — o harness roda contra um corpus real de `casos_desvio_revisao`
(30 dias) e produz uma tabela candidato × recall × taxa de FP que decide a
implementação final.

**Tech Stack:** Next.js/TypeScript, Vitest, Postgres (Contabo,
`app_service` role), `pg` client (já em `package.json`).

## Global Constraints

- Specs de origem: `docs/superpowers/specs/2026-08-10-ponto-seguro-parado-design.md`
  e `docs/superpowers/specs/2026-08-10-afastando-tudo-harness-design.md` —
  ler os dois arquivos inteiros antes de qualquer task, contêm contexto
  histórico (incidentes reais de 06/07 e 03/08) que não deve ser
  reintroduzido.
- Ambos os repos recebem os MESMOS commits ao final: `MONITORAMENTO TEMP`
  (working dir principal) e `MONITORAMENTO transmonseg` (mirror). Nunca
  finalizar o dia com só um dos dois atualizado.
- Deploy real no Contabo é OBRIGATÓRIO ao final (não só commit local):
  `ssh transmonseg-vps`, `cd /srv/transmonseg/{temp,definitivo}`, `git pull`,
  `npm run build` (se `package.json`/`package-lock.json` mudou — não muda
  neste plano, pode pular), `pm2 restart transmonseg-{temp,definitivo}`,
  verificar via `pm2 logs`/query real que o comportamento mudou.
- `DATABASE_URL` de produção (Contabo, só leitura nas tasks do harness,
  escrita só no Task 1 de verificação manual pós-deploy):
  `postgres://app_service:5cf0fd1c8cfc0dfdf66a19196d5e6ebc691bbc628d7e637c@localhost:5432/transmonseg`,
  acessível via `ssh transmonseg-vps "psql '<url>' -c \"...\""`. Fora do
  Contabo (execução local/subagent), não há acesso direto ao Postgres —
  toda query desta plano roda via SSH.
- Vitest é o único framework de teste do projeto (`npm test` =
  `vitest run`). Nenhuma API route tem teste automatizado hoje — não
  introduzir um framework novo pra isso.
- `AFASTAMENTO_MARGEM_M = 50` (`detectores.ts:533`), `FORA_TAPETE_STREAK_MIN
  = 2` (`detectores.ts:542`), `POSICAO_CONGELADA_M = 10` (`detectores.ts:1480`)
  são constantes existentes, não redefinir.

---

### Task 1: Ponto seguro só suspende desvio se o veículo estiver parado

**Files:**
- Modify: `src/app/api/motor/route.ts:2085`
- Test: `src/lib/unitrac.test.ts` (confirmar suite existente continua verde,
  sem alteração — a função pura não muda)

**Interfaces:**
- Consumes: `pos.velocidade` (já disponível no escopo do loop, usado
  algumas linhas acima em `noCliente`, `route.ts:2060-2063`),
  `riscoPorVeiculo.get(veiculo_id)?.emPontoSeguro` (já existente).
- Produces: `emPontoSeguro` (variável local em `route.ts`, mesmo nome,
  agora exige parado) — consumida sem mudança por `suspensoPorChegada`
  (`route.ts:2086-2088`) e `chegouEmDestinoConhecido` (`route.ts:2104-2106`,
  já força `emPontoSeguro=false` incondicionalmente, não afetado por este
  Task).

- [ ] **Step 1: Ler o trecho atual pra confirmar a linha exata antes de editar**

Abrir `src/app/api/motor/route.ts` por volta da linha 2085. O trecho atual é:

```typescript
const emPontoSeguro = riscoPorVeiculo.get(veiculo_id)?.emPontoSeguro ?? false;
const suspensoPorChegada = idxMaisProximo >= 0
  ? suspenderPorChegada(distDestinosM[idxMaisProximo], raioDestinoMaisProximo, emPontoSeguro)
  : emPontoSeguro;
```

Se o número da linha tiver mudado (outras tasks deste plano não tocam
neste arquivo antes deste Task, mas confirme), localize pelo texto exato
acima via busca, não pelo número da linha.

- [ ] **Step 2: Editar pra exigir velocidade zero**

Trocar o trecho do Step 1 por:

```typescript
const emPontoSeguroBruto = riscoPorVeiculo.get(veiculo_id)?.emPontoSeguro ?? false;
// Achado real 10/08 (varredura completa de regras de desvio, motivada
// pelos relatos de TTM-7C13/TTH-0G95 no grupo "DESVIO DE ROTA"): sem o
// `pos.velocidade === 0`, um veiculo em desvio real que so PASSA (em
// movimento) perto de qualquer um dos ~1.115 postos de gasolina do RJ
// (geofence estatica, scripts/ingerir-pontos-seguros.mjs, sem relacao com
// a rota) tinha a checagem de desvio inteira suspensa naquele ciclo. A
// intencao original (achado 25/07, ver suspenderPorChegada em unitrac.ts)
// era so nao confundir motorista ABASTECENDO com desvio -- exigir parado
// preserva essa intencao sem a brecha. Mesmo criterio ja usado em
// `noCliente` poucas linhas acima. Achado critico da revisao independente
// 03/08 ja tinha corrigido isso so pro auto-resolve (chegouEmDestinoConhecido,
// abaixo) -- este e' o mesmo fix pro suspensoPorChegada bruto, que nunca
// tinha recebido.
const emPontoSeguro = emPontoSeguroBruto && pos.velocidade === 0;
const suspensoPorChegada = idxMaisProximo >= 0
  ? suspenderPorChegada(distDestinosM[idxMaisProximo], raioDestinoMaisProximo, emPontoSeguro)
  : emPontoSeguro;
```

`suspenderPorChegada` em `src/lib/unitrac.ts:385-393` NÃO muda — continua
recebendo um `boolean` já pronto.

- [ ] **Step 3: Rodar a suíte de testes completa**

Run: `npm test`
Expected: PASS — nenhum teste existente depende do valor bruto de
`emPontoSeguro` dentro de `route.ts` (é um arquivo sem teste automatizado
de rota), e `unitrac.test.ts`/`detectores.test.ts` testam as funções puras
isoladas, que não mudaram de assinatura nem de comportamento interno.

- [ ] **Step 4: Commit**

```bash
git add src/app/api/motor/route.ts
git commit -m "fix(desvio): posto de gasolina so suspende checagem se veiculo estiver parado"
```

---

### Task 2: Candidatos de regra "afastamento suficiente" (funções puras)

**Files:**
- Create: `scripts/backtest-desvio/candidatos.ts`
- Test: `scripts/backtest-desvio/candidatos.test.ts`

**Interfaces:**
- Consumes: nada de outras tasks.
- Produces: `type CandidatoRegra = (distAtualM: number[], distAnteriorM: number[]) => boolean`,
  e um `Map<string, CandidatoRegra>` chamado `CANDIDATOS` exportado, com as
  chaves `"all"`, `"top3"`, `"top5"`, `"top8"`, `"pct60"`, `"pct80"`. Task 4
  consome `CANDIDATOS` pra rodar o replay uma vez por candidato.

- [ ] **Step 1: Escrever os testes primeiro**

Criar `scripts/backtest-desvio/candidatos.test.ts`:

```typescript
import { describe, it, expect } from "vitest";
import { CANDIDATOS } from "./candidatos";

describe("candidatos de regra de afastamento", () => {
  it("all: precisa que TODOS cresçam (comportamento identico ao afastouDeTudo atual)", () => {
    const all = CANDIDATOS.get("all")!;
    expect(all([6000, 8000], [5000, 7000])).toBe(true);
    expect(all([6300, 7200], [6000, 8000])).toBe(false);
  });

  it("topK com K >= N se comporta como ALL (N pequeno, protege contra o incidente de 06/07)", () => {
    for (const chave of ["top3", "top5", "top8"]) {
      const regra = CANDIDATOS.get(chave)!;
      // 2 destinos: 1 cresce, 1 encolhe -- ALL seria false, top-K com K>=2
      // tem que ser false tambem (K efetivo vira min(K, N) = N = ALL).
      expect(regra([6300, 7200], [6000, 8000])).toBe(false);
    }
  });

  it("percentual com N pequeno arredonda pra CIMA (Math.ceil), nao reintroduz o incidente de 06/07", () => {
    for (const chave of ["pct60", "pct80"]) {
      const regra = CANDIDATOS.get(chave)!;
      // 2 destinos, so 1 cresce (o mais proximo) -- se o percentual
      // arredondasse pra baixo (Math.floor(0.6*2)=1), isso dispararia
      // (exatamente o padrao do incidente de 06/07: entrega normal pro
      // cliente nao-mais-proximo). Com Math.ceil, precisa dos 2.
      expect(regra([6300, 7200], [6000, 8000])).toBe(false);
    }
  });

  it("topK: com N grande, so os K mais proximos (na leitura ANTERIOR) precisam crescer", () => {
    const top3 = CANDIDATOS.get("top3")!;
    // 5 destinos; os 3 mais proximos na leitura anterior sao os de indice
    // 0,1,2 (1000,2000,3000) -- todos crescem alem da margem de 50m. Os
    // outros dois (indice 3,4) encolhem, mas nao entram no top-3, entao
    // nao impedem o disparo.
    const anterior = [1000, 2000, 3000, 50000, 60000];
    const atual    = [1100, 2100, 3100, 40000, 55000];
    expect(top3(atual, anterior)).toBe(true);
  });

  it("percentual: >=60% de N grande precisa de maioria, nao de 1 so", () => {
    const pct60 = CANDIDATOS.get("pct60")!;
    // 5 destinos, so 2 crescem (40%) -- abaixo de 60%, nao dispara.
    const anterior = [1000, 2000, 3000, 4000, 5000];
    const atual    = [1100, 2100, 2900, 3900, 4900];
    expect(pct60(atual, anterior)).toBe(false);
  });

  it("todos os candidatos: false com arrays vazios ou de tamanhos diferentes", () => {
    for (const regra of CANDIDATOS.values()) {
      expect(regra([], [])).toBe(false);
      expect(regra([5000], [])).toBe(false);
    }
  });
});
```

- [ ] **Step 2: Rodar os testes pra confirmar que falham (arquivo nao existe ainda)**

Run: `npx vitest run scripts/backtest-desvio/candidatos.test.ts`
Expected: FAIL com "Cannot find module './candidatos'"

- [ ] **Step 3: Implementar `candidatos.ts`**

```typescript
// scripts/backtest-desvio/candidatos.ts
//
// Candidatos de regra "afastamento suficiente" pra substituir o
// afastouDeTudo atual (exige TODOS os destinos crescerem, ver
// docs/superpowers/specs/2026-08-10-afastando-tudo-harness-design.md).
// Cada candidato precisa se comportar EXATAMENTE como ALL quando N e'
// pequeno (2-3 destinos) -- senao reabre o incidente de 06/07 (motorista
// entregando pro cliente nao-mais-proximo disparando falso desvio).

const AFASTAMENTO_MARGEM_M = 50;

export type CandidatoRegra = (distAtualM: number[], distAnteriorM: number[]) => boolean;

function cresceuAlemDaMargem(atual: number, anterior: number): boolean {
  return atual > anterior + AFASTAMENTO_MARGEM_M;
}

function validarEntrada(distAtualM: number[], distAnteriorM: number[]): boolean {
  return distAtualM.length > 0 && distAtualM.length === distAnteriorM.length;
}

export function all(distAtualM: number[], distAnteriorM: number[]): boolean {
  if (!validarEntrada(distAtualM, distAnteriorM)) return false;
  return distAtualM.every((d, i) => cresceuAlemDaMargem(d, distAnteriorM[i]));
}

function topK(k: number): CandidatoRegra {
  return (distAtualM, distAnteriorM) => {
    if (!validarEntrada(distAtualM, distAnteriorM)) return false;
    const kEfetivo = Math.min(k, distAnteriorM.length);
    const indicesMaisProximos = distAnteriorM
      .map((d, i) => [d, i] as const)
      .sort((a, b) => a[0] - b[0])
      .slice(0, kEfetivo)
      .map(([, i]) => i);
    return indicesMaisProximos.every((i) => cresceuAlemDaMargem(distAtualM[i], distAnteriorM[i]));
  };
}

function percentual(pct: number): CandidatoRegra {
  return (distAtualM, distAnteriorM) => {
    if (!validarEntrada(distAtualM, distAnteriorM)) return false;
    const cresceram = distAtualM.filter((d, i) => cresceuAlemDaMargem(d, distAnteriorM[i])).length;
    const minimoNecessario = Math.ceil(pct * distAtualM.length);
    return cresceram >= minimoNecessario;
  };
}

export const CANDIDATOS: Map<string, CandidatoRegra> = new Map([
  ["all", all],
  ["top3", topK(3)],
  ["top5", topK(5)],
  ["top8", topK(8)],
  ["pct60", percentual(0.6)],
  ["pct80", percentual(0.8)],
]);
```

- [ ] **Step 4: Rodar os testes de novo, confirmar que passam**

Run: `npx vitest run scripts/backtest-desvio/candidatos.test.ts`
Expected: PASS (7 testes)

- [ ] **Step 5: Commit**

```bash
git add scripts/backtest-desvio/candidatos.ts scripts/backtest-desvio/candidatos.test.ts
git commit -m "test(backtest): candidatos de regra de afastamento pro harness de desvio"
```

---

### Task 3: Motor de replay (máquina de estado real)

**Files:**
- Create: `scripts/backtest-desvio/replay.ts`
- Test: `scripts/backtest-desvio/replay.test.ts`

**Interfaces:**
- Consumes: `CandidatoRegra` (Task 2), e as funções reais
  `avancarStreaksDesvio`/`devAvancarStreaksDesvio` importadas de
  `src/lib/detectores.ts` (paths relativos: de
  `scripts/backtest-desvio/replay.ts` para `src/lib/detectores.ts` é
  `../../src/lib/detectores`).
- Produces:
  ```typescript
  type PontoTrilha = { lat: number; lng: number; velocidade: number; criado_em: string };
  type Destino = { lat: number; lng: number };
  type ResultadoReplay = { streakMaximo: number; disparou: boolean; cicloDoDisparo: number | null };
  function replay(
    regra: CandidatoRegra,
    pontos: PontoTrilha[],
    destinosPorPonto: Destino[][], // mesmo tamanho de `pontos`, destinos vigentes em cada ponto
  ): ResultadoReplay;
  ```
  Consumido por Task 5 (execução do harness).

- [ ] **Step 1: Escrever o teste primeiro**

Criar `scripts/backtest-desvio/replay.test.ts`:

```typescript
import { describe, it, expect } from "vitest";
import { replay } from "./replay";
import { all } from "./candidatos";

const BASE_TS = new Date("2026-08-10T12:00:00Z").getTime();
function ts(minutos: number): string {
  return new Date(BASE_TS + minutos * 60_000).toISOString();
}

describe("replay", () => {
  it("dispara quando a regra e o streak real cruzam o limiar (2 leituras seguidas)", () => {
    const destino = { lat: -22.9, lng: -43.2 };
    // 3 pontos se afastando em linha reta do destino, velocidade > 0.
    const pontos = [
      { lat: -22.9, lng: -43.21, velocidade: 40, criado_em: ts(0) },
      { lat: -22.9, lng: -43.22, velocidade: 40, criado_em: ts(1) },
      { lat: -22.9, lng: -43.23, velocidade: 40, criado_em: ts(2) },
    ];
    const destinosPorPonto = pontos.map(() => [destino]);
    const r = replay(all, pontos, destinosPorPonto);
    expect(r.disparou).toBe(true);
    expect(r.streakMaximo).toBeGreaterThanOrEqual(2);
    expect(r.cicloDoDisparo).not.toBeNull();
  });

  it("nao dispara quando o veiculo se aproxima (mesmo com N=1)", () => {
    const destino = { lat: -22.9, lng: -43.2 };
    const pontos = [
      { lat: -22.9, lng: -43.23, velocidade: 40, criado_em: ts(0) },
      { lat: -22.9, lng: -43.22, velocidade: 40, criado_em: ts(1) },
      { lat: -22.9, lng: -43.21, velocidade: 40, criado_em: ts(2) },
    ];
    const destinosPorPonto = pontos.map(() => [destino]);
    const r = replay(all, pontos, destinosPorPonto);
    expect(r.disparou).toBe(false);
  });

  it("veiculo parado (velocidade=0) congela o streak, nao zera nem avanca", () => {
    const destino = { lat: -22.9, lng: -43.2 };
    const pontos = [
      { lat: -22.9, lng: -43.21, velocidade: 40, criado_em: ts(0) },
      { lat: -22.9, lng: -43.22, velocidade: 40, criado_em: ts(1) }, // afasta, streak=1
      { lat: -22.9, lng: -43.22, velocidade: 0, criado_em: ts(2) },  // parado, congela
      { lat: -22.9, lng: -43.23, velocidade: 40, criado_em: ts(3) }, // afasta, streak=2 -> dispara
    ];
    const destinosPorPonto = pontos.map(() => [destino]);
    const r = replay(all, pontos, destinosPorPonto);
    expect(r.disparou).toBe(true);
  });

  it("salto implausivel (>2500m entre ciclos) congela o streak", () => {
    const destino = { lat: -22.9, lng: -43.2 };
    const pontos = [
      { lat: -22.9, lng: -43.21, velocidade: 40, criado_em: ts(0) },
      { lat: -22.9, lng: -43.22, velocidade: 40, criado_em: ts(1) }, // afasta, streak=1
      { lat: -21.0, lng: -41.0, velocidade: 40, criado_em: ts(2) },  // teleporte, congela
    ];
    const destinosPorPonto = pontos.map(() => [destino]);
    const r = replay(all, pontos, destinosPorPonto);
    expect(r.streakMaximo).toBe(1);
    expect(r.disparou).toBe(false);
  });
});
```

- [ ] **Step 2: Rodar o teste, confirmar que falha**

Run: `npx vitest run scripts/backtest-desvio/replay.test.ts`
Expected: FAIL com "Cannot find module './replay'"

- [ ] **Step 3: Implementar `replay.ts`**

```typescript
// scripts/backtest-desvio/replay.ts
//
// Maquina de estado FIEL ao motor real (avancarStreaksDesvio,
// devAvancarStreaksDesvio, ambas importadas de src/lib/detectores.ts, zero
// reimplementacao) -- rodada sobre uma trilha real de posicoes_historico
// (via casos_desvio_revisao.trilha, ver corpus.ts) com o delta de tempo
// REAL entre pontos, nao cadencia fixa. Ver
// docs/superpowers/specs/2026-08-10-afastando-tudo-harness-design.md pro
// porque disso (uma tentativa anterior em Python nao reproduziu 3 casos
// reais conhecidos por assumir cadencia fixa e zerar o streak no primeiro
// sinal contrario, em vez da histerese real).
import { avancarStreaksDesvio, devAvancarStreaksDesvio } from "../../src/lib/detectores";
import type { CandidatoRegra } from "./candidatos";

const SALTO_IMPLAUSIVEL_M = 2500;
const FORA_TAPETE_STREAK_MIN = 2; // detectores.ts:542, limiar real de disparo

export type PontoTrilha = { lat: number; lng: number; velocidade: number; criado_em: string };
export type Destino = { lat: number; lng: number };
export type ResultadoReplay = { streakMaximo: number; disparou: boolean; cicloDoDisparo: number | null };

function haversineM(lat1: number, lng1: number, lat2: number, lng2: number): number {
  const R = 6371000;
  const p1 = (lat1 * Math.PI) / 180;
  const p2 = (lat2 * Math.PI) / 180;
  const dp = ((lat2 - lat1) * Math.PI) / 180;
  const dl = ((lng2 - lng1) * Math.PI) / 180;
  const a = Math.sin(dp / 2) ** 2 + Math.cos(p1) * Math.cos(p2) * Math.sin(dl / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(a));
}

export function replay(
  regra: CandidatoRegra,
  pontos: PontoTrilha[],
  destinosPorPonto: Destino[][]
): ResultadoReplay {
  let desvioStreak = 0;
  let aproximandoStreak = 0;
  let anterior: PontoTrilha | null = null;
  let streakMaximo = 0;
  let cicloDoDisparo: number | null = null;

  for (let i = 0; i < pontos.length; i++) {
    const p = pontos[i];
    const destinos = destinosPorPonto[i];
    const distAtualM = destinos.map((d) => haversineM(p.lat, p.lng, d.lat, d.lng));

    if (anterior && destinos.length > 0) {
      const distAnteriorM = destinos.map((d) => haversineM(anterior!.lat, anterior!.lng, d.lat, d.lng));
      const distanciaAoAnteriorM = haversineM(anterior.lat, anterior.lng, p.lat, p.lng);
      const saltoImplausivel = distanciaAoAnteriorM > SALTO_IMPLAUSIVEL_M;
      const podeAvancar = devAvancarStreaksDesvio({
        fresco: true, // trilha ja filtrada por fresco no carregamento (ver corpus.ts)
        saltoImplausivel,
        distanciaAoAnteriorM,
        velocidade: p.velocidade,
      });

      if (podeAvancar) {
        const afastando = regra(distAtualM, distAnteriorM);
        const r = avancarStreaksDesvio(afastando, { desvioStreak, aproximandoStreak });
        desvioStreak = r.desvioStreak;
        aproximandoStreak = r.aproximandoStreak;
      }
    }

    streakMaximo = Math.max(streakMaximo, desvioStreak);
    if (cicloDoDisparo === null && desvioStreak >= FORA_TAPETE_STREAK_MIN) {
      cicloDoDisparo = i;
    }
    anterior = p;
  }

  return { streakMaximo, disparou: cicloDoDisparo !== null, cicloDoDisparo };
}
```

- [ ] **Step 4: Rodar os testes, confirmar que passam**

Run: `npx vitest run scripts/backtest-desvio/replay.test.ts`
Expected: PASS (4 testes)

- [ ] **Step 5: Commit**

```bash
git add scripts/backtest-desvio/replay.ts scripts/backtest-desvio/replay.test.ts
git commit -m "feat(backtest): motor de replay fiel (histerese real, delta de tempo real) pro harness de desvio"
```

---

### Task 4: Carregar corpus real do Postgres (script standalone, não faz parte da suíte vitest)

**Files:**
- Create: `scripts/backtest-desvio/carregar-corpus.mjs`

**Interfaces:**
- Consumes: nada de outras tasks (script standalone, roda com `node`, usa
  o pacote `pg` já em `package.json`).
- Produces: arquivo `scripts/backtest-desvio/corpus.json` no formato:
  ```typescript
  type CasoCorpus = {
    id: string; // "casos_desvio_revisao:<id>" ou "extra:7C13"/"extra:0G95"
    rotulo: "tem_que_disparar" | "nao_pode_disparar";
    pontos: PontoTrilha[]; // mesmo tipo de replay.ts
    destinosPorPonto: Destino[][];
  }[];
  ```
  Consumido por Task 5.

Este script NÃO roda em CI nem em teste automatizado — é uma ferramenta
utilitária, executada manualmente uma vez (ou quando o corpus precisar ser
atualizado). Roda via SSH porque o Postgres de produção só é acessível de
dentro do Contabo (`DATABASE_URL` não é alcançável do ambiente local do
implementador).

- [ ] **Step 1: Confirmar que o ambiente do implementador tem acesso SSH ao Contabo**

Run: `ssh transmonseg-vps "echo ok"`
Expected: `ok`

Se este comando falhar (ambiente sem acesso SSH configurado — ex: subagent
rodando fora da máquina do usuário), pare e reporte NEEDS_CONTEXT — este
script precisa rodar DE DENTRO do Contabo ou via um túnel que dê acesso ao
Postgres. Não invente uma alternativa (ex: mockar dados) sem perguntar.

- [ ] **Step 2: Escrever o script de extração**

Criar `scripts/backtest-desvio/carregar-corpus.mjs`:

```javascript
// scripts/backtest-desvio/carregar-corpus.mjs
//
// Roda DENTRO do Contabo (via ssh transmonseg-vps) ou com DATABASE_URL
// setado no ambiente local se houver tunel pro Postgres de producao.
// Extrai o corpus de casos_desvio_revisao (30 dias, ver
// docs/superpowers/specs/2026-08-10-afastando-tudo-harness-design.md) +
// os 2 casos extras TTM-7C13/TTH-0G95 (nunca dispararam, nao existem em
// casos_desvio_revisao) e escreve scripts/backtest-desvio/corpus.json.
//
// Uso: node scripts/backtest-desvio/carregar-corpus.mjs
import pg from "pg";
import { writeFileSync } from "node:fs";

const DATABASE_URL =
  process.env.DATABASE_URL ??
  "postgres://app_service:5cf0fd1c8cfc0dfdf66a19196d5e6ebc691bbc628d7e637c@localhost:5432/transmonseg";

const client = new pg.Client({ connectionString: DATABASE_URL });
await client.connect();

// Casos rotulados de casos_desvio_revisao, filtrados aos que tiveram
// desvio_streak/fora_tapete relevantes (exclui casos puros de
// classe_viaria, que nao usam afastouDeTudo) -- origem_acao exclui acoes
// em massa (mesmo filtro ja usado em recalibrar-desvio/route.ts).
const { rows: casos } = await client.query(`
  select id, veiculo_id, status_final, motivo_falso_positivo, trilha,
         contexto_detector->>'desvio_streak' as desvio_streak,
         contexto_detector->>'fora_tapete' as fora_tapete
  from casos_desvio_revisao
  where (origem_acao is null or origem_acao <> 'resolver_massa')
    and (
      (contexto_detector->>'desvio_streak')::int > 0
      or (contexto_detector->>'fora_tapete')::boolean = true
    )
`);

function rotulo(c) {
  if (c.status_final === "resolvido") return "tem_que_disparar";
  if (c.status_final === "falso_positivo" && (c.motivo_falso_positivo === null || c.motivo_falso_positivo === "detector_errado")) {
    return "nao_pode_disparar";
  }
  return null; // dado_entrada_errado ou status desconhecido -- fora do corpus
}

async function destinosParaVeiculo(veiculoId, timestampIso) {
  const { rows } = await client.query(
    `select pendentes from pendentes_snapshot_log
     where veiculo_id = $1 and criado_em <= $2
     order by criado_em desc limit 1`,
    [veiculoId, timestampIso]
  );
  const pendentes = (rows[0]?.pendentes ?? []).map((p) => ({ lat: p.lat, lng: p.lng }));

  const { rows: basesRows } = await client.query(
    `select ST_Y(b.geom::geometry) as lat, ST_X(b.geom::geometry) as lng
     from bases b join veiculos v on v.cliente_id = b.cliente_id
     where v.id = $1`,
    [veiculoId]
  );

  // Simplificacao documentada (ver spec): omite pontos de escala de rota
  // (feature recente, 09/08 em diante) -- a maioria do corpus de 30 dias e'
  // anterior a ela, e o comentario em route.ts confirma que escala so
  // afeta o calculo de afastamento v4, nao chegada/corredor -- omitir
  // subestima N em casos recentes, nao inventa destino que nao existia.
  return [...pendentes, ...basesRows];
}

const corpus = [];

for (const c of casos) {
  const r = rotulo(c);
  if (!r) continue;
  const pontos = c.trilha.map((p) => ({
    lat: p.lat, lng: p.lng, velocidade: p.velocidade, criado_em: p.criado_em,
  }));
  const destinosPorPonto = [];
  for (const p of pontos) {
    destinosPorPonto.push(await destinosParaVeiculo(c.veiculo_id, p.criado_em));
  }
  corpus.push({ id: `casos_desvio_revisao:${c.id}`, rotulo: r, pontos, destinosPorPonto });
}

// Casos extras: TTM-7C13 e TTH-0G95, motivadores da investigacao de hoje.
// Nunca dispararam (por isso nao existem em casos_desvio_revisao) -- ver
// spec pra IDs e janela de tempo exatos.
const CASOS_EXTRAS = [
  { placa: "7C13", veiculoId: "85052a19-ab73-4919-98a2-b2308a5ad7c9" },
  { placa: "0G95", veiculoId: "2c8c32f7-e7af-450d-ab89-ffd0e17766d9" },
];

for (const { placa, veiculoId } of CASOS_EXTRAS) {
  const { rows: pos } = await client.query(
    `select lat, lng, velocidade, criado_em from posicoes_historico
     where veiculo_id = $1 and criado_em >= now() - interval '4 hours'
     order by criado_em asc`,
    [veiculoId]
  );
  const pontos = pos.map((p) => ({ lat: p.lat, lng: p.lng, velocidade: p.velocidade, criado_em: p.criado_em }));
  const destinosPorPonto = [];
  for (const p of pontos) {
    destinosPorPonto.push(await destinosParaVeiculo(veiculoId, p.criado_em));
  }
  corpus.push({ id: `extra:${placa}`, rotulo: "tem_que_disparar", pontos, destinosPorPonto });
}

await client.end();

writeFileSync(new URL("./corpus.json", import.meta.url), JSON.stringify(corpus, null, 2));
console.log(`corpus.json escrito: ${corpus.length} casos (${corpus.filter((c) => c.rotulo === "tem_que_disparar").length} tem_que_disparar, ${corpus.filter((c) => c.rotulo === "nao_pode_disparar").length} nao_pode_disparar)`);
```

- [ ] **Step 3: Rodar o script contra produção**

Run:
```bash
ssh transmonseg-vps "cd /srv/transmonseg/temp && node scripts/backtest-desvio/carregar-corpus.mjs" 2>&1
```

Se `scripts/backtest-desvio/` ainda não existe no VPS (branch local não
foi push/pull ainda), copie o script antes:
```bash
scp scripts/backtest-desvio/carregar-corpus.mjs transmonseg-vps:/srv/transmonseg/temp/scripts/backtest-desvio/carregar-corpus.mjs
```
(NÃO faça deploy completo aqui — só copiar este script utilitário pra
rodar a extração. O deploy real acontece no Task 7, no final do plano.)

Depois traga o `corpus.json` gerado de volta pro ambiente local:
```bash
scp transmonseg-vps:/srv/transmonseg/temp/scripts/backtest-desvio/corpus.json scripts/backtest-desvio/corpus.json
```

Expected: log final tipo `corpus.json escrito: N casos (X tem_que_disparar,
Y nao_pode_disparar)`, com X >= 100 e Y >= 100 (corpus real confirmado
nesta sessão em ~220 resolvidos + ~200 FPs de detector, mas o filtro de
`desvio_streak>0 or fora_tapete=true` vai reduzir esse número — se X ou Y
vier muito menor que ~50, PARE e reporte DONE_WITH_CONCERNS explicando o
número real encontrado antes de prosseguir pro Task 5, o critério de
decisão precisa de amostra suficiente pra ser confiável).

- [ ] **Step 4: Commit (só o script, `corpus.json` fica fora do git — dado de produção, não código)**

Adicionar `scripts/backtest-desvio/corpus.json` ao `.gitignore`:

```bash
echo "scripts/backtest-desvio/corpus.json" >> .gitignore
git add scripts/backtest-desvio/carregar-corpus.mjs .gitignore
git commit -m "feat(backtest): script de extracao do corpus real de casos_desvio_revisao"
```

---

### Task 5: Rodar o harness e produzir a tabela de decisão

**Files:**
- Create: `scripts/backtest-desvio/index.mjs`
- Create: `scripts/backtest-desvio/relatorio.md` (output, não é código —
  não precisa ser lido de volta por nenhuma task futura, é pro controller
  ler e decidir)

**Interfaces:**
- Consumes: `corpus.json` (Task 4), `CANDIDATOS` (Task 2), `replay` (Task 3).
- Produces: `relatorio.md` com uma tabela markdown — consumido pelo
  controller (não por outra task) pra decidir o candidato vencedor antes
  do Task 6.

Este script roda com `node --loader tsx` ou compilando via `tsx` (checar
se `tsx` já está instalado — `npx tsx --version`; se não estiver,
`npm install --save-dev tsx` como parte deste Task, é uma dependência de
desenvolvimento só pra rodar scripts `.ts` fora do Next.js).

- [ ] **Step 1: Implementar `index.mjs`**

```javascript
// scripts/backtest-desvio/index.mjs
//
// Roda cada candidato (Task 2) contra o corpus inteiro (Task 4) usando o
// replay fiel (Task 3), e escreve relatorio.md com recall/taxa de FP por
// candidato. NAO decide sozinho o vencedor -- ver
// docs/superpowers/specs/2026-08-10-afastando-tudo-harness-design.md,
// secao "Criterio de decisao": se nenhum candidato bater a regra ALL em
// recall SEM piorar a taxa de disparo espurio, o relatorio so reporta a
// tabela -- a escolha final e' do controller/usuario, nao deste script.
import { readFileSync, writeFileSync } from "node:fs";
import { CANDIDATOS } from "./candidatos.ts";
import { replay } from "./replay.ts";

const corpus = JSON.parse(readFileSync(new URL("./corpus.json", import.meta.url), "utf-8"));

const temQueDisparar = corpus.filter((c) => c.rotulo === "tem_que_disparar");
const naoPodeDisparar = corpus.filter((c) => c.rotulo === "nao_pode_disparar");

const linhas = [];
linhas.push("| Candidato | Recall (tem que disparar) | Taxa de disparo espurio (nao pode disparar) | Latencia media ate disparo (ciclos) |");
linhas.push("|---|---|---|---|");

for (const [chave, regra] of CANDIDATOS) {
  const resultadosPositivos = temQueDisparar.map((c) => replay(regra, c.pontos, c.destinosPorPonto));
  const resultadosNegativos = naoPodeDisparar.map((c) => replay(regra, c.pontos, c.destinosPorPonto));

  const disparou = resultadosPositivos.filter((r) => r.disparou).length;
  const recall = temQueDisparar.length > 0 ? disparou / temQueDisparar.length : 0;

  const espurios = resultadosNegativos.filter((r) => r.disparou).length;
  const taxaEspuria = naoPodeDisparar.length > 0 ? espurios / naoPodeDisparar.length : 0;

  const latencias = resultadosPositivos.filter((r) => r.disparou).map((r) => r.cicloDoDisparo);
  const latenciaMedia = latencias.length > 0 ? latencias.reduce((a, b) => a + b, 0) / latencias.length : null;

  linhas.push(
    `| ${chave} | ${(recall * 100).toFixed(1)}% (${disparou}/${temQueDisparar.length}) | ${(taxaEspuria * 100).toFixed(1)}% (${espurios}/${naoPodeDisparar.length}) | ${latenciaMedia !== null ? latenciaMedia.toFixed(1) : "n/a"} |`
  );
}

const relatorio = `# Relatório do harness de backtest — afastando-de-tudo

Corpus: ${corpus.length} casos (${temQueDisparar.length} tem_que_disparar, ${naoPodeDisparar.length} nao_pode_disparar).

${linhas.join("\n")}

Critério de decisão (ver spec): candidato vencedor maximiza recall sem
piorar a taxa de disparo espúrio em relação a \`all\` (baseline, regra
atual em produção). Se nenhum candidato atender aos dois critérios ao
mesmo tempo, decisão fica para o controller/usuário — não decidido
automaticamente por este script.
`;

writeFileSync(new URL("./relatorio.md", import.meta.url), relatorio);
console.log(relatorio);
```

- [ ] **Step 2: Rodar o harness**

Run: `npx tsx scripts/backtest-desvio/index.mjs`
Expected: imprime a tabela no terminal E escreve
`scripts/backtest-desvio/relatorio.md`.

- [ ] **Step 3: Reportar o conteúdo de `relatorio.md` verbatim no relatório da task (não resumir os números)**

Isso é o deliverable central deste Task — o controller precisa dos números
exatos, não de uma interpretação. Se `tsx` não estiver disponível e a
instalação falhar, reporte BLOCKED com o erro exato em vez de tentar
contornar rodando via `ts-node` ou outra ferramenta não mencionada aqui.

- [ ] **Step 4: Commit**

```bash
git add scripts/backtest-desvio/index.mjs scripts/backtest-desvio/relatorio.md package.json package-lock.json
git commit -m "feat(backtest): roda o harness contra o corpus real, produz tabela de decisao"
```

**PONTO DE PARADA:** não prosseguir para o Task 6 sem o controller ter
lido `relatorio.md` e confirmado explicitamente qual candidato (`all`,
`top3`, `top5`, `top8`, `pct60`, ou `pct80`) vira a implementação final.
Se o relatório mostrar um vencedor claro (recall estritamente maior que
`all` e taxa de disparo espúrio menor ou igual à de `all`), o controller
pode decidir sozinho sem levar de volta ao usuário — mas precisa registrar
a decisão e o motivo no ledger antes de dispachar o Task 6.

---

### Task 6: Implementar o candidato vencedor em `afastouDeTudo`

**Files:**
- Modify: `src/lib/detectores.ts:1383` (corpo de `afastouDeTudo`, mantém
  assinatura e nome — `route.ts:1895` e `detectores.ts:1589` continuam
  chamando a mesma função sem precisar de nenhuma mudança neles)
- Modify: `src/lib/detectores.test.ts:1203-1217` (describe "afastouDeTudo" —
  os 4 testes existentes devem continuar passando SEM alteração se o
  candidato vencedor respeita o comportamento ALL para N pequeno,
  conforme validado no Task 2; adicionar novos casos, não substituir os
  existentes)

**Interfaces:**
- Consumes: o candidato vencedor decidido no Task 5 (código já escrito e
  testado em `scripts/backtest-desvio/candidatos.ts`).
- Produces: `afastouDeTudo(distDestinosM: number[], distDestinosAnteriorM: number[]): boolean`
  — mesma assinatura de hoje, usada por `route.ts:1895` e
  `detectores.ts:1589`, nenhum dos dois muda.

Este Task só pode começar depois do PONTO DE PARADA do Task 5 ter sido
resolvido — o controller informa ao implementador qual candidato foi
escolhido (ex: "pct60") como parte do dispatch deste Task, junto com o
`relatorio.md` como evidência.

- [ ] **Step 1: Confirmar via grep que `afastouDeTudo` só é usado nesses 2 pontos de produção**

Run: `grep -rn "afastouDeTudo" src/`
Expected: as mesmas 3 ocorrências de produção já confirmadas no plano
(`route.ts:28` import, `route.ts:1895` chamada, `detectores.ts:1383`
definição, `detectores.ts:1589` chamada, `detectores.ts:739` comentário) +
usos em teste (`detectores.test.ts`, `desvio-cenarios.test.ts`). Se
aparecer um uso novo não coberto por este plano, PARE e reporte
NEEDS_CONTEXT antes de prosseguir.

- [ ] **Step 2: Adicionar teste novo pro caso N grande disperso (shape TTM-7C13/TTH-0G95)**

Adicionar ao final do describe existente em `detectores.test.ts`
(`describe("afastouDeTudo", ...)`, depois do teste de arrays vazios,
`detectores.test.ts:1213-1216`):

```typescript
  it("N grande e disperso (achado real 10/08, TTM-7C13/TTH-0G95): dispara mesmo sem TODOS crescerem", () => {
    // 15 destinos espalhados -- o mais proximo (indice 0) cresce
    // consistentemente (veiculo se afastando dele de verdade), mas alguns
    // dos outros 14 encolhem por acaso da geometria (padrao real
    // confirmado nesta sessao: com N=13-15 dispersos, e' quase impossivel
    // TODOS crescerem ao mesmo tempo -- streak maximo medido foi 0 em ~100
    // leituras reais pros 2 veiculos que motivaram esta mudanca).
    const anterior = [1000, 5000, 8000, 12000, 15000, 18000, 20000, 22000, 25000, 28000, 30000, 32000, 35000, 38000, 40000];
    const atual    = [1200, 4900, 8100, 11950, 15100, 17980, 20200, 21900, 25200, 27950, 30150, 31900, 35200, 37950, 40200];
    // ALL seria false aqui (varios encolheram, ex indice 1: 5000->4900).
    expect(afastouDeTudo(anterior, anterior)).toBe(false); // sanity: identico nao dispara
    expect(afastouDeTudo(atual, anterior)).toBe(true); // regra vencedora: dispara
  });
```

**Nota pro implementador:** o array `atual`/`anterior` acima é ilustrativo
— ajuste os valores concretos conforme o candidato vencedor realmente
escolhido no Task 5 (ex: se o vencedor for `top5`, garanta que os 5 mais
próximos da leitura anterior cresçam consistentemente no `atual`; se for
`pct60`, garanta que ≥60% cresçam). O objetivo do teste é provar que o
padrão real de TTM-7C13/TTH-0G95 (poucos destinos próximos crescendo de
verdade, muitos distantes oscilando por ruído geométrico) passa a
disparar — não copiar os números cegamente.

- [ ] **Step 3: Rodar os testes, confirmar que o novo caso falha (implementação ainda é ALL)**

Run: `npx vitest run src/lib/detectores.test.ts -t afastouDeTudo`
Expected: FAIL no teste novo do Step 2 (os 4 testes antigos continuam
passando).

- [ ] **Step 4: Substituir o corpo de `afastouDeTudo`**

Em `src/lib/detectores.ts`, localizar a função (por volta da linha 1383) e
seu comentário de contexto acima. Adicionar um novo bloco de comentário
"achado real 10/08" ANTES do comentário existente (não apagar o
comentário de 06/07 — ele continua explicando por que ALL existia, e o
novo bloco explica por que deixou de ser suficiente):

```typescript
// Achado real 10/08 (varredura completa de regras de desvio, motivada
// pelos relatos de TTM-7C13/TTH-0G95 no grupo "DESVIO DE ROTA"): com
// muitos destinos dispersos (13-15), a regra ALL abaixo nunca disparava --
// streak maximo medido = 0 em ~100 leituras reais consecutivas pros 2
// veiculos, confirmado por replay fiel ao motor real (ver
// scripts/backtest-desvio/, harness que reusa avancarStreaksDesvio e
// devAvancarStreaksDesvio de verdade, nao uma reimplementacao). Validado
// contra um corpus real de ~30 dias de casos_desvio_revisao (ver
// docs/superpowers/specs/2026-08-10-afastando-tudo-harness-design.md) que
// [CANDIDATO_VENCEDOR] mantem o mesmo comportamento de ALL pra N pequeno
// (protege contra o incidente original de 06/07 abaixo) mas passa a
// disparar pro padrao de N grande e disperso.
export function afastouDeTudo(
  distDestinosM: number[],
  distDestinosAnteriorM: number[]
): boolean {
  // [SUBSTITUIR PELO CORPO DO CANDIDATO VENCEDOR, copiado de
  // scripts/backtest-desvio/candidatos.ts com AFASTAMENTO_MARGEM_M
  // trocado pela constante ja existente neste arquivo, linha 533 --
  // nao duplicar a constante]
}
```

O implementador deve substituir `[CANDIDATO_VENCEDOR]` no comentário pelo
nome real (ex: "top5" ou "≥60% dos destinos") e colar o corpo real da
função escolhida (de `scripts/backtest-desvio/candidatos.ts`, já testado
no Task 2), adaptando só a referência à constante de margem para usar
`AFASTAMENTO_MARGEM_M` já existente em `detectores.ts:533` (não
`scripts/backtest-desvio/candidatos.ts` tem sua própria cópia da
constante — está duplicada de propósito ali, porque o script roda fora do
build do Next.js; dentro de `detectores.ts` usar a constante local).

- [ ] **Step 5: Rodar a suíte inteira**

Run: `npm test`
Expected: PASS — os 4 testes antigos de `afastouDeTudo` continuam verdes
(prova que N pequeno não mudou de comportamento), o teste novo do Step 2
passa, `desvio-cenarios.test.ts` continua verde (usa N=1 nos cenários,
onde todo candidato se comporta como ALL).

- [ ] **Step 6: Commit**

```bash
git add src/lib/detectores.ts src/lib/detectores.test.ts
git commit -m "fix(desvio): afastouDeTudo usa [CANDIDATO_VENCEDOR] em vez de exigir TODOS os destinos"
```

(Substituir `[CANDIDATO_VENCEDOR]` na mensagem de commit pelo nome real
também.)

---

### Task 7: Sincronizar mirror, deploy real e verificação em produção

**Files:** nenhum arquivo novo — task de integração/deploy.

**Interfaces:**
- Consumes: todos os commits das Tasks 1-6, já no repo
  `MONITORAMENTO TEMP`.

- [ ] **Step 1: Rodar a suíte completa mais uma vez, do zero**

Run: `npm test`
Expected: PASS, 100% (nenhum teste pulado/skip).

- [ ] **Step 2: Sincronizar o mirror `MONITORAMENTO transmonseg`**

```bash
cd "/Users/joaquimsalles/Projects/Transmonseg/monitoramento/MONITORAMENTO transmonseg"
git remote -v  # confirmar que aponta pro mesmo par de repos/branches usado o resto da sessao
git fetch origin
git log --oneline -5  # conferir onde esta antes de aplicar
```

Aplicar os mesmos commits das Tasks 1, 2, 3, 4 (só o `.gitignore` +
`carregar-corpus.mjs`, sem o `corpus.json`), 5, 6 — usar `git cherry-pick`
dos hashes reais gerados nas tasks anteriores (anotar os hashes no ledger
de progresso ao longo da execução, não confiar em `HEAD~N` depois de
várias tasks).

- [ ] **Step 3: Push dos dois repos**

```bash
cd "/Users/joaquimsalles/Projects/Transmonseg/monitoramento/MONITORAMENTO TEMP"
git push origin <branch>
cd "/Users/joaquimsalles/Projects/Transmonseg/monitoramento/MONITORAMENTO transmonseg"
git push origin <branch>
```

- [ ] **Step 4: Deploy real no Contabo, os dois processos**

```bash
ssh transmonseg-vps "cd /srv/transmonseg/temp && git stash -u 2>&1; git pull origin <branch> && npm run build && pm2 restart transmonseg-temp"
ssh transmonseg-vps "cd /srv/transmonseg/definitivo && git stash -u 2>&1; git pull origin <branch> && npm run build && pm2 restart transmonseg-definitivo"
```

(`git stash -u` primeiro porque o Task 4 já deixou `carregar-corpus.mjs`
copiado manualmente no `/srv/transmonseg/temp` — o `git pull` vai
reconciliar contra o que já está commitado; se o stash tiver conteúdo
igual ao que acabou de chegar via pull, `git stash drop`, senão investigar
antes de descartar.)

- [ ] **Step 5: Verificar via `pm2` que os dois processos subiram sem erro fatal**

```bash
ssh transmonseg-vps "pm2 describe transmonseg-temp | grep -E 'status|restart'; pm2 logs transmonseg-temp --lines 30 --nostream"
ssh transmonseg-vps "pm2 describe transmonseg-definitivo | grep -E 'status|restart'; pm2 logs transmonseg-definitivo --lines 30 --nostream"
```

Expected: `status: online`, sem stack trace/erro fatal nos últimos logs.

- [ ] **Step 6: Verificação real do Bug 1 (ponto seguro) — não só ausência de erro**

```bash
ssh transmonseg-vps "psql 'postgres://app_service:5cf0fd1c8cfc0dfdf66a19196d5e6ebc691bbc628d7e637c@localhost:5432/transmonseg' -c \"select count(*) from placar_desvio_log where criado_em >= now() - interval '10 minutes' and componentes->>'zeradoPorChegada'='true';\""
```

Não é uma comparação antes/depois automática (o número normal inclui
chegada real legítima, que não deveria cair a zero) — é só uma leitura de
sanidade pra confirmar que o motor está processando ciclos normalmente
pós-deploy, sem travar. Reporte o número visto.

- [ ] **Step 7: Verificação real do Bug 2 (afastando de tudo) — aguardar próximo ciclo real de TTM-7C13/TTH-0G95 se ainda estiverem em rota**

```bash
ssh transmonseg-vps "psql 'postgres://app_service:5cf0fd1c8cfc0dfdf66a19196d5e6ebc691bbc628d7e637c@localhost:5432/transmonseg' -c \"select v.placa, p.desvio_streak, p.fora_tapete_streak, p.criado_em from posicoes_atuais p join veiculos v on v.id=p.veiculo_id where v.placa in ('TTM-7C13','TTH-0G95');\""
```

Se os veículos ainda estiverem em operação, reportar o `desvio_streak`
atual — não é garantia de que vá disparar imediatamente (depende do
comportamento real do veículo neste momento, não do histórico já
analisado), mas confirma que o motor está calculando com a nova regra sem
erro.

- [ ] **Step 8: Atualizar o ledger do plano com o resumo final**

Documentar no ledger (`.superpowers/sdd/2026-08-10-ponto-seguro-e-afastando-tudo/progress.md`):
qual candidato foi escolhido no Task 5 e por quê (colar a tabela do
`relatorio.md`), hashes de commit finais nos dois repos, resultado das
verificações dos Steps 6-7.
