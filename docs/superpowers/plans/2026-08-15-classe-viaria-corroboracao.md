# Classe viária como corroboração do desvio — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Trazer de volta o detector de "queda de classe viária" (via principal/intermediária → rua estreita) como sinal de **corroboração** do desvio — soma score a um alerta que já vai disparar, nunca decide se dispara.

**Architecture:** Novo módulo puro `src/lib/classe-viaria-confirmacao.ts` (mesma forma do `src/lib/corredor-confirmacao.ts` de ontem: função de avaliação + função de aplicação testável isoladamente). Diferente do corredor (que usa um lookback pontual em `posicoes_historico` só quando um alerta já existe), a classe viária precisa de **duas janelas de tempo que decaem** (última vez em via principal, última saída de parada confirmada) — refinamento em relação ao spec original: em vez de reconstruir essas janelas via lookback histórico a cada disparo, usa o MESMO padrão de estado decaindo já usado no projeto (`ultima_via_principal_em`/`JANELA_QUEDA_CLASSE_MIN` no sistema antigo, `desvio_estado.afastando_streak` hoje) — 2 colunas novas em `desvio_estado`, atualizadas todo ciclo pra todo veículo fresco (barato: 1 lookup indexado de até 9 células, não uma chamada de rede como o corredor), lidas só quando `alertaDesvioV2` já existe.

**Tech Stack:** TypeScript, Next.js (App Router, ver `AGENTS.md`), Vitest, Postgres self-hosted no Contabo.

## Global Constraints

- Spec de referência: `docs/superpowers/specs/2026-08-15-classe-viaria-corroboracao-design.md`.
- **Corroboração, nunca supressão**: nenhuma mudança pode impedir um alerta de desvio de disparar. Toda falha (sem classificação de célula, sem histórico) cai em fail-open silencioso — sem ajuste de score, sem exceção propagada.
- Trabalho feito e testado no repo TEMP primeiro; repo definitivo mantido byte-idêntico — Task 5 espelha e faz o deploy real dos dois.
- Deploy real: SSH `transmonseg-vps`, `/srv/transmonseg/temp` (PM2 `transmonseg-temp`, motor de produção) e `/srv/transmonseg/definitivo` (PM2 `transmonseg-definitivo`, UI real). `git pull && npm run build && pm2 restart <nome>` — sem CI/CD automático. Depois de QUALQUER `git push`, confirmar com `git fetch origin -q && git status -sb` que não ficou "ahead"/"behind" antes de prosseguir (lição de 13/08: push pode falhar silenciosamente).
- `tsc --noEmit`, `eslint`, e a suíte `vitest` completa precisam passar limpos antes de cada commit.
- Validação obrigatória contra dado real de produção (grupos de controle: `falso_positivo` vs `resolvido`, e amostra sem streak formado) antes de considerar a feature pronta — mesma disciplina exigida ontem pro corredor, porque a medição de ontem revelou que "parece razoável" não é o mesmo que "discrimina de verdade".

---

### Task 1: Migrations — 2 colunas em `desvio_estado`, 1 coluna em `desvio_disparo_log`

**Files:**
- Create: `scripts/migrations/048_desvio_estado_classe_viaria.sql`
- Create: `scripts/migrations/contabo/050_desvio_estado_classe_viaria.sql`

**Interfaces:**
- Produces: `desvio_estado.ultima_via_principal_em timestamptz NULL`, `desvio_estado.saiu_parada_confirmada_em timestamptz NULL`, `desvio_disparo_log.classe_viaria_confirmou boolean NOT NULL DEFAULT false` — consumidos pela Task 3.

- [ ] **Step 1: Escrever a migration local**

Arquivo `scripts/migrations/048_desvio_estado_classe_viaria.sql`:

```sql
-- 048_desvio_estado_classe_viaria.sql
--
-- Ver docs/superpowers/specs/2026-08-15-classe-viaria-corroboracao-design.md.
-- Duas colunas de estado que DECAEM sozinhas (sem job de limpeza, mesmo
-- espirito de ultima_via_principal_em/JANELA_QUEDA_CLASSE_MIN do sistema
-- antigo, removido em 12/08): so' sao atualizadas quando o evento
-- acontece, nunca resetadas explicitamente -- quem le aplica a janela de
-- tempo (10min pra via principal, 5min pra saida de parada confirmada) na
-- hora da leitura. NULL = nunca aconteceu (ou aconteceu ha' tempo demais
-- pra qualquer janela razoavel, tanto faz pra quem le).
ALTER TABLE desvio_estado ADD COLUMN IF NOT EXISTS ultima_via_principal_em timestamptz NULL;
ALTER TABLE desvio_estado ADD COLUMN IF NOT EXISTS saiu_parada_confirmada_em timestamptz NULL;
ALTER TABLE desvio_disparo_log ADD COLUMN IF NOT EXISTS classe_viaria_confirmou boolean NOT NULL DEFAULT false;
NOTIFY pgrst, 'reload schema';
```

- [ ] **Step 2: Copiar pra versão Contabo**

Arquivo `scripts/migrations/contabo/050_desvio_estado_classe_viaria.sql` — mesmo conteúdo do Step 1, trocando o cabeçalho:

```sql
-- 050_desvio_estado_classe_viaria.sql
--
-- Ver docs/superpowers/specs/2026-08-15-classe-viaria-corroboracao-design.md.
-- Duas colunas de estado que DECAEM sozinhas (sem job de limpeza, mesmo
-- espirito de ultima_via_principal_em/JANELA_QUEDA_CLASSE_MIN do sistema
-- antigo, removido em 12/08): so' sao atualizadas quando o evento
-- acontece, nunca resetadas explicitamente -- quem le aplica a janela de
-- tempo (10min pra via principal, 5min pra saida de parada confirmada) na
-- hora da leitura. NULL = nunca aconteceu (ou aconteceu ha' tempo demais
-- pra qualquer janela razoavel, tanto faz pra quem le).
ALTER TABLE desvio_estado ADD COLUMN IF NOT EXISTS ultima_via_principal_em timestamptz NULL;
ALTER TABLE desvio_estado ADD COLUMN IF NOT EXISTS saiu_parada_confirmada_em timestamptz NULL;
ALTER TABLE desvio_disparo_log ADD COLUMN IF NOT EXISTS classe_viaria_confirmou boolean NOT NULL DEFAULT false;
NOTIFY pgrst, 'reload schema';
```

- [ ] **Step 3: Aplicar a migration local**

Run: `node --env-file=.env.local scripts/aplicar-migration.mjs 048_desvio_estado_classe_viaria.sql`
Expected: `OK — migration aplicada.`

- [ ] **Step 4: Confirmar as 3 colunas**

Run:
```bash
node --env-file=.env.local -e "
import('pg').then(async ({default: pg}) => {
  const c = new pg.Client({connectionString: process.env.DATABASE_URL, ssl: {rejectUnauthorized: false}});
  await c.connect();
  const r1 = await c.query(\"select column_name, data_type from information_schema.columns where table_name='desvio_estado' and column_name in ('ultima_via_principal_em','saiu_parada_confirmada_em')\");
  const r2 = await c.query(\"select column_name, data_type, column_default from information_schema.columns where table_name='desvio_disparo_log' and column_name='classe_viaria_confirmou'\");
  console.log(r1.rows, r2.rows);
  await c.end();
});
"
```
Expected: 2 linhas em `desvio_estado` (ambas `timestamptz`), 1 linha em `desvio_disparo_log` (`boolean`, default `false`).

- [ ] **Step 5: Commit**

```bash
git add scripts/migrations/048_desvio_estado_classe_viaria.sql scripts/migrations/contabo/050_desvio_estado_classe_viaria.sql
git commit -m "migration: adiciona estado de classe viaria em desvio_estado + classe_viaria_confirmou em desvio_disparo_log"
```

(Aplicação no Contabo acontece na Task 5, junto com o deploy — mesmo padrão de ontem.)

---

### Task 2: Módulo puro `src/lib/classe-viaria-confirmacao.ts`

**Files:**
- Create: `src/lib/classe-viaria-confirmacao.ts`
- Test: `src/lib/classe-viaria-confirmacao.test.ts`

**Interfaces:**
- Produces:
  - `type ClasseViaria = "principal" | "intermediaria" | "estreita"`
  - `melhorClasse(a: ClasseViaria | null, b: ClasseViaria | null): ClasseViaria | null`
  - `avaliarQuedaClasseViaria(classeAtual: ClasseViaria | null, ultimaViaPrincipalEm: Date | null, agora: Date): { quedaDetectada: boolean }`
  - `avaliarSaiuParadaConfirmadaRecentemente(saiuParadaConfirmadaEm: Date | null, agora: Date): boolean`
  - `aplicarCorroboracaoClasseViaria<T extends { score: number; motivo: string }>(alerta: T, quedaDetectada: boolean, saiuParadaConfirmadaRecentemente: boolean, bonus: number): T` — consumida pela Task 3.

- [ ] **Step 1: Escrever os testes (falhando)**

Arquivo `src/lib/classe-viaria-confirmacao.test.ts`:

```typescript
import { describe, it, expect } from "vitest";
import {
  melhorClasse,
  avaliarQuedaClasseViaria,
  avaliarSaiuParadaConfirmadaRecentemente,
  aplicarCorroboracaoClasseViaria,
} from "./classe-viaria-confirmacao";

describe("melhorClasse", () => {
  it("principal vence intermediaria", () => {
    expect(melhorClasse("principal", "intermediaria")).toBe("principal");
    expect(melhorClasse("intermediaria", "principal")).toBe("principal");
  });
  it("intermediaria vence estreita", () => {
    expect(melhorClasse("intermediaria", "estreita")).toBe("intermediaria");
  });
  it("null de um lado retorna o outro", () => {
    expect(melhorClasse(null, "estreita")).toBe("estreita");
    expect(melhorClasse("estreita", null)).toBe("estreita");
  });
  it("null dos dois lados retorna null", () => {
    expect(melhorClasse(null, null)).toBeNull();
  });
});

describe("avaliarQuedaClasseViaria", () => {
  const AGORA = new Date("2026-08-15T12:00:00Z");

  it("celula atual estreita + esteve em principal ha 5min: queda detectada", () => {
    const ultimaViaPrincipal = new Date("2026-08-15T11:55:00Z");
    expect(avaliarQuedaClasseViaria("estreita", ultimaViaPrincipal, AGORA)).toEqual({ quedaDetectada: true });
  });
  it("celula atual estreita + esteve em principal ha exatamente 10min: ainda detectada (limite inclusivo)", () => {
    const ultimaViaPrincipal = new Date("2026-08-15T11:50:00Z");
    expect(avaliarQuedaClasseViaria("estreita", ultimaViaPrincipal, AGORA)).toEqual({ quedaDetectada: true });
  });
  it("celula atual estreita + esteve em principal ha 11min: janela expirou, sem queda", () => {
    const ultimaViaPrincipal = new Date("2026-08-15T11:49:00Z");
    expect(avaliarQuedaClasseViaria("estreita", ultimaViaPrincipal, AGORA)).toEqual({ quedaDetectada: false });
  });
  it("nunca esteve em via principal (null): sem queda", () => {
    expect(avaliarQuedaClasseViaria("estreita", null, AGORA)).toEqual({ quedaDetectada: false });
  });
  it("celula atual intermediaria (nao estreita): sem queda, mesmo com historico de principal", () => {
    const ultimaViaPrincipal = new Date("2026-08-15T11:58:00Z");
    expect(avaliarQuedaClasseViaria("intermediaria", ultimaViaPrincipal, AGORA)).toEqual({ quedaDetectada: false });
  });
  it("celula atual null (sem classificacao): sem queda", () => {
    const ultimaViaPrincipal = new Date("2026-08-15T11:58:00Z");
    expect(avaliarQuedaClasseViaria(null, ultimaViaPrincipal, AGORA)).toEqual({ quedaDetectada: false });
  });
});

describe("avaliarSaiuParadaConfirmadaRecentemente", () => {
  const AGORA = new Date("2026-08-15T12:00:00Z");

  it("saiu ha 2min: recente", () => {
    expect(avaliarSaiuParadaConfirmadaRecentemente(new Date("2026-08-15T11:58:00Z"), AGORA)).toBe(true);
  });
  it("saiu ha exatamente 5min: ainda recente (limite inclusivo)", () => {
    expect(avaliarSaiuParadaConfirmadaRecentemente(new Date("2026-08-15T11:55:00Z"), AGORA)).toBe(true);
  });
  it("saiu ha 6min: expirou", () => {
    expect(avaliarSaiuParadaConfirmadaRecentemente(new Date("2026-08-15T11:54:00Z"), AGORA)).toBe(false);
  });
  it("nunca saiu de parada confirmada (null): false", () => {
    expect(avaliarSaiuParadaConfirmadaRecentemente(null, AGORA)).toBe(false);
  });
});

describe("aplicarCorroboracaoClasseViaria", () => {
  const BASE = { score: 60, motivo: "Afastando-se de todos os destinos", outraCoisa: "preservada" };

  it("queda nao detectada: retorna o MESMO objeto, sem mutacao", () => {
    const r = aplicarCorroboracaoClasseViaria(BASE, false, false, 15);
    expect(r).toBe(BASE);
  });
  it("saiu de parada confirmada recentemente SUPRIME mesmo com queda detectada: sem bonus", () => {
    const r = aplicarCorroboracaoClasseViaria(BASE, true, true, 15);
    expect(r).toBe(BASE);
  });
  it("queda detectada e sem saida de parada recente: soma bonus e sufixo no motivo", () => {
    const r = aplicarCorroboracaoClasseViaria(BASE, true, false, 15);
    expect(r.score).toBe(75);
    expect(r.motivo).toBe("Afastando-se de todos os destinos (corroborado por: saiu de via principal para rua estreita)");
    expect(r.outraCoisa).toBe("preservada");
  });
  it("nunca passa de 100 mesmo com score inicial alto", () => {
    const r = aplicarCorroboracaoClasseViaria({ score: 95, motivo: "x" }, true, false, 15);
    expect(r.score).toBe(100);
  });
});
```

- [ ] **Step 2: Rodar e confirmar que falha**

Run: `npx vitest run src/lib/classe-viaria-confirmacao.test.ts`
Expected: FAIL — módulo não existe.

- [ ] **Step 3: Implementar o módulo**

Arquivo `src/lib/classe-viaria-confirmacao.ts`:

```typescript
// Confirmacao de classe viaria (queda de via principal/intermediaria pra
// rua estreita) como sinal de CORROBORACAO do desvio -- nunca supressao.
// Ver docs/superpowers/specs/2026-08-15-classe-viaria-corroboracao-design.md.
// So aplica bonus/sufixo a um alerta que JA existe -- nunca decide se um
// alerta dispara. Taxonomia e regra de queda portadas do sistema antigo
// (src/lib/classificacao-viaria.ts, removido no commit 6643bee/
// f695308..492f140, 12/08) -- o gate de "prova de entrega" (D1/D3 do
// antigo placar de desvio) foi deliberadamente descartado, decisao
// documentada no spec: a corroboracao ja roda atras do gate de chegada do
// afastando_geral, que cobre o caso mais comum que aquele gate evitava.

export type ClasseViaria = "principal" | "intermediaria" | "estreita";

const PRIORIDADE_CLASSE: Record<ClasseViaria, number> = {
  principal: 3,
  intermediaria: 2,
  estreita: 1,
};

// Celula pode ser cruzada por vias de classes diferentes -- vence a de
// maior prioridade (mesma logica do sistema antigo, portada sem mudanca).
export function melhorClasse(a: ClasseViaria | null, b: ClasseViaria | null): ClasseViaria | null {
  if (a === null) return b;
  if (b === null) return a;
  return PRIORIDADE_CLASSE[a] >= PRIORIDADE_CLASSE[b] ? a : b;
}

const JANELA_QUEDA_CLASSE_MIN = 10;

// classeAtual/ultimaViaPrincipalEm ja vem calculados por quem chama (route.ts) --
// esta funcao so aplica a janela de tempo, pura, sem I/O.
export function avaliarQuedaClasseViaria(
  classeAtual: ClasseViaria | null,
  ultimaViaPrincipalEm: Date | null,
  agora: Date
): { quedaDetectada: boolean } {
  if (classeAtual !== "estreita" || ultimaViaPrincipalEm === null) {
    return { quedaDetectada: false };
  }
  const decorridoMin = (agora.getTime() - ultimaViaPrincipalEm.getTime()) / 60_000;
  return { quedaDetectada: decorridoMin <= JANELA_QUEDA_CLASSE_MIN };
}

// Achado real 28/07 (sistema antigo, Task 6 -- revisao manual de FP de rua
// estreita): 36% dos falsos positivos eram o veiculo saindo de uma parada
// de entrega LEGITIMA (dwell confirmado) e pegando uma rua estreita logo
// em seguida. Janela mais curta que a de via principal (5min vs 10min) --
// a manobra tipica (sair do raio, virar numa rua estreita) e rapida.
const JANELA_SAIDA_PARADA_MIN = 5;

export function avaliarSaiuParadaConfirmadaRecentemente(
  saiuParadaConfirmadaEm: Date | null,
  agora: Date
): boolean {
  if (saiuParadaConfirmadaEm === null) return false;
  const decorridoMin = (agora.getTime() - saiuParadaConfirmadaEm.getTime()) / 60_000;
  return decorridoMin <= JANELA_SAIDA_PARADA_MIN;
}

// Mesmo padrao de aplicarCorroboracaoCorredor (corredor-confirmacao.ts,
// 14/08) -- extraida como funcao pura testavel isoladamente pra garantir
// (spec, secao Testes): nunca muta o alerta quando nao corrobora, sempre
// preserva os demais campos, nunca passa de 100.
export function aplicarCorroboracaoClasseViaria<T extends { score: number; motivo: string }>(
  alerta: T,
  quedaDetectada: boolean,
  saiuParadaConfirmadaRecentemente: boolean,
  bonus: number
): T {
  if (!quedaDetectada || saiuParadaConfirmadaRecentemente) return alerta;
  return {
    ...alerta,
    score: Math.min(100, alerta.score + bonus),
    motivo: `${alerta.motivo} (corroborado por: saiu de via principal para rua estreita)`,
  };
}
```

- [ ] **Step 4: Rodar e confirmar que passa**

Run: `npx vitest run src/lib/classe-viaria-confirmacao.test.ts`
Expected: todos os 15 testes passando.

- [ ] **Step 5: `tsc`/`eslint`**

Run: `npx tsc --noEmit && npx eslint src/lib/classe-viaria-confirmacao.ts src/lib/classe-viaria-confirmacao.test.ts`
Expected: sem erros.

- [ ] **Step 6: Commit**

```bash
git add src/lib/classe-viaria-confirmacao.ts src/lib/classe-viaria-confirmacao.test.ts
git commit -m "feat(desvio): classe viaria como sinal de corroboracao (nunca supressao)"
```

---

### Task 3: Wiring no motor (`route.ts`) — classificação viária, estado decaindo, corroboração

**Files:**
- Modify: `src/app/api/motor/route.ts`

**Interfaces:**
- Consumes: `melhorClasse`, `avaliarQuedaClasseViaria`, `avaliarSaiuParadaConfirmadaRecentemente`, `aplicarCorroboracaoClasseViaria`, `type ClasseViaria` de `src/lib/classe-viaria-confirmacao.ts` (Task 2); `BONUS_CORROBORACAO_POR_SINAL` já exportado de `src/lib/detectores.ts`; `celulaDe`, `vizinhanca3x3` já exportados de `src/lib/celulas.ts` (não mudam nesta task).
- Produces: `alertaDesvioV2` ajustado quando classe viária corrobora; `desvio_estado.ultima_via_principal_em`/`saiu_parada_confirmada_em` persistidos; `desvio_disparo_log.classe_viaria_confirmou` gravado.

- [ ] **Step 1: Importar as novas dependências**

No topo de `src/app/api/motor/route.ts`, junto do import já existente de `@/lib/corredor-confirmacao` (linha 46), adicionar:

```typescript
import {
  melhorClasse,
  avaliarQuedaClasseViaria,
  avaliarSaiuParadaConfirmadaRecentemente,
  aplicarCorroboracaoClasseViaria,
  type ClasseViaria,
} from "@/lib/classe-viaria-confirmacao";
```

- [ ] **Step 2: Estender o prefetch de `desvio_estado` (por volta da linha 746)**

Trocar:

```typescript
    const desvioEstadoPorVeiculo = new Map<string, { afastandoStreak: number; ruaRaraStreak: number }>();
    try {
      const { rows } = await pool.query<{ veiculo_id: string; afastando_streak: number; rua_rara_streak: number }>(
        `SELECT veiculo_id, afastando_streak, rua_rara_streak FROM desvio_estado`
      );
      for (const r of rows) {
        desvioEstadoPorVeiculo.set(r.veiculo_id, { afastandoStreak: r.afastando_streak, ruaRaraStreak: r.rua_rara_streak });
      }
```

por:

```typescript
    const desvioEstadoPorVeiculo = new Map<string, {
      afastandoStreak: number;
      ruaRaraStreak: number;
      ultimaViaPrincipalEm: Date | null;
      saiuParadaConfirmadaEm: Date | null;
    }>();
    try {
      const { rows } = await pool.query<{
        veiculo_id: string;
        afastando_streak: number;
        rua_rara_streak: number;
        ultima_via_principal_em: Date | null;
        saiu_parada_confirmada_em: Date | null;
      }>(
        `SELECT veiculo_id, afastando_streak, rua_rara_streak, ultima_via_principal_em, saiu_parada_confirmada_em FROM desvio_estado`
      );
      for (const r of rows) {
        desvioEstadoPorVeiculo.set(r.veiculo_id, {
          afastandoStreak: r.afastando_streak,
          ruaRaraStreak: r.rua_rara_streak,
          ultimaViaPrincipalEm: r.ultima_via_principal_em,
          saiuParadaConfirmadaEm: r.saiu_parada_confirmada_em,
        });
      }
```

- [ ] **Step 3: Calcular a classe viária atual e a marcação de saída de parada, logo após `saiuDoRaioAgora` ser calculado (por volta da linha 2029)**

Localizar o bloco existente:

```typescript
          const saiuDoRaioAgora = codigoAnteriorNoRaio !== null && alvoNoRaioAgora === null;
          const alvoQueSaiu = (pontosVeiculo ?? []).find((pt) => pt.pontoCodigo === codigoAnteriorNoRaio) ?? null;
```

Logo depois desse bloco (antes do `const alertaBypass = ...` que já existe), inserir:

```typescript
          // Classe viaria (queda de via principal/intermediaria pra rua
          // estreita) como sinal de CORROBORACAO -- ver
          // docs/superpowers/specs/2026-08-15-classe-viaria-corroboracao-design.md.
          // Classifica a celula atual (vizinhanca 3x3, mesma tolerancia a
          // GPS na beirada da via que o sistema antigo usava) contra
          // vias_celulas (1.322.207 linhas, ainda no banco, nao precisa
          // reingestao). So classifica quando fresco -- posicao velha nao
          // deve contaminar o estado decaindo.
          let classeViaAtual: ClasseViaria | null = null;
          if (pos.fresco) {
            const { rows: classesRows } = await pool.query<{ celula: string; classe: ClasseViaria }>(
              `SELECT celula, classe FROM vias_celulas WHERE celula = ANY($1::text[])`,
              [vizinhanca3x3(pos.lat, pos.lng)]
            );
            for (const r of classesRows) classeViaAtual = melhorClasse(classeViaAtual, r.classe);
          }
          const ultimaViaPrincipalAnteriorEm = estadoDesvioAnterior.ultimaViaPrincipalEm;
          const ultimaViaPrincipalEmNova = pos.fresco && classeViaAtual === "principal" ? agora : ultimaViaPrincipalAnteriorEm;

          // Achado real 28/07 (sistema antigo): "confirmada" = parou tempo
          // suficiente pra nao ser so uma passagem -- mesmo limiar que
          // detectarBypassEntrega ja usa (BYPASS_ENTREGA_DWELL_MINIMO_SEGUNDOS).
          const deveMarcarSaidaParadaConfirmada =
            pos.fresco && alvosApiOk && saiuDoRaioAgora && dwellAnterior >= BYPASS_ENTREGA_DWELL_MINIMO_SEGUNDOS;
          const saiuParadaConfirmadaEmNova = deveMarcarSaidaParadaConfirmada
            ? agora
            : estadoDesvioAnterior.saiuParadaConfirmadaEm;
```

- [ ] **Step 4: Adicionar o bloco de corroboração, logo depois do bloco do corredor (por volta da linha 2507, antes do INSERT em `desvio_disparo_log`)**

Localizar o fim do bloco do corredor (o `}` que fecha o `if (alertaDesvioV2) { try {...corredor...} catch {...} }`), e inserir logo depois, antes do comentário `// Achado real 13/08 (casos TTH-3C94...`:

```typescript
              // Classe viaria como corroboracao (nunca supressao) -- roda
              // no mesmo ponto e com a mesma disciplina do corredor acima:
              // so ajusta score de um alerta que ja existe, fail-open
              // silencioso em qualquer falha.
              let classeViariaConfirmou = false;
              if (alertaDesvioV2) {
                try {
                  const { quedaDetectada } = avaliarQuedaClasseViaria(classeViaAtual, ultimaViaPrincipalAnteriorEm, agora);
                  const saiuParadaRecente = avaliarSaiuParadaConfirmadaRecentemente(estadoDesvioAnterior.saiuParadaConfirmadaEm, agora);
                  if (quedaDetectada && !saiuParadaRecente) {
                    classeViariaConfirmou = true;
                  }
                  alertaDesvioV2 = aplicarCorroboracaoClasseViaria(
                    alertaDesvioV2,
                    quedaDetectada,
                    saiuParadaRecente,
                    BONUS_CORROBORACAO_POR_SINAL
                  );
                } catch (errClasseViaria) {
                  erros.push(`Aviso: falha ao avaliar classe viaria pro veiculo ${veiculo_id}: ${String(errClasseViaria)}`);
                }
              }
```

- [ ] **Step 5: Estender o INSERT em `desvio_disparo_log`**

O INSERT (já estendido ontem, por volta da linha 2519) é:

```typescript
                  await pool.query(
                    `INSERT INTO desvio_disparo_log
                       (veiculo_id, tipo_disparo, destinos, streak_afastando, streak_rua_rara, celula, n_visitas_celula, posicao_corrigida, corredor_confirmou)
                     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)`,
                    [
                      veiculo_id,
                      alertaDesvioV2.origemDesvio,
                      JSON.stringify(
                        destinosRelevantes.map((d, i) => ({
                          codigo: d.codigo,
                          lat: d.lat,
                          lng: d.lng,
                          distAtualM: distAtuaisReais[i],
                          distAnteriorM: distAnterioresReais[i],
                        }))
                      ),
                      afastandoStreakNovo,
                      ruaRara.streak,
                      celulaAtualDesvio,
                      nVisitasHistorico,
                      posicaoFoiCorrigida,
                      corredorConfirmou,
                    ]
                  );
```

Trocar por:

```typescript
                  await pool.query(
                    `INSERT INTO desvio_disparo_log
                       (veiculo_id, tipo_disparo, destinos, streak_afastando, streak_rua_rara, celula, n_visitas_celula, posicao_corrigida, corredor_confirmou, classe_viaria_confirmou)
                     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)`,
                    [
                      veiculo_id,
                      alertaDesvioV2.origemDesvio,
                      JSON.stringify(
                        destinosRelevantes.map((d, i) => ({
                          codigo: d.codigo,
                          lat: d.lat,
                          lng: d.lng,
                          distAtualM: distAtuaisReais[i],
                          distAnteriorM: distAnterioresReais[i],
                        }))
                      ),
                      afastandoStreakNovo,
                      ruaRara.streak,
                      celulaAtualDesvio,
                      nVisitasHistorico,
                      posicaoFoiCorrigida,
                      corredorConfirmou,
                      classeViariaConfirmou,
                    ]
                  );
```

- [ ] **Step 6: Estender o UPSERT de `desvio_estado` (por volta da linha 2554)**

Trocar:

```typescript
            await pool.query(
              `INSERT INTO desvio_estado (veiculo_id, afastando_streak, rua_rara_streak, atualizado_em)
               VALUES ($1, $2, $3, now())
               ON CONFLICT (veiculo_id) DO UPDATE SET
                 afastando_streak = EXCLUDED.afastando_streak,
                 rua_rara_streak = EXCLUDED.rua_rara_streak,
                 atualizado_em = now()`,
              [veiculo_id, afastandoStreakNovo, ruaRaraStreakNovo]
            );
```

por:

```typescript
            await pool.query(
              `INSERT INTO desvio_estado (veiculo_id, afastando_streak, rua_rara_streak, ultima_via_principal_em, saiu_parada_confirmada_em, atualizado_em)
               VALUES ($1, $2, $3, $4, $5, now())
               ON CONFLICT (veiculo_id) DO UPDATE SET
                 afastando_streak = EXCLUDED.afastando_streak,
                 rua_rara_streak = EXCLUDED.rua_rara_streak,
                 ultima_via_principal_em = EXCLUDED.ultima_via_principal_em,
                 saiu_parada_confirmada_em = EXCLUDED.saiu_parada_confirmada_em,
                 atualizado_em = now()`,
              [veiculo_id, afastandoStreakNovo, ruaRaraStreakNovo, ultimaViaPrincipalEmNova, saiuParadaConfirmadaEmNova]
            );
```

**Confirmado por leitura direta do arquivo (não precisa reverificar):** o bloco de `alvoNoRaioAgora`/`saiuDoRaioAgora` (onde o Step 3 insere código) fica no nível superior do laço por veículo (mesma indentação de 10 espaços), IRMÃO do `if (pos.fresco && !suspensoPorChegada && ...)` que envolve a avaliação de desvio (não aninhado dentro dele) — e o UPSERT do Step 6 roda depois desse `if/else`, ainda no mesmo nível superior. Como `classeViaAtual`, `ultimaViaPrincipalAnteriorEm`, `ultimaViaPrincipalEmNova`, `saiuParadaConfirmadaEmNova` são declaradas no Step 3 nesse mesmo nível superior, elas ficam acessíveis tanto dentro do `if` (escopo aninhado lê variáveis externas normalmente) quanto no UPSERT (mesmo nível, depois). Nenhum ajuste de escopo necessário — só usar os nomes exatos declarados no Step 3.

- [ ] **Step 7: `tsc`, `eslint`, suíte completa**

Run: `npx tsc --noEmit && npx eslint src/app/api/motor/route.ts && npx vitest run`
Expected: sem erros de tipo/lint novos (os 9 warnings pré-existentes de `route.ts`, não relacionados a esta task, podem continuar); suíte inteira passando.

- [ ] **Step 8: Commit**

```bash
git add src/app/api/motor/route.ts
git commit -m "feat(desvio): liga classe viaria como corroboracao no motor"
```

---

### Task 4: Validação contra dado real de produção (com grupos de controle)

**Files:**
- Create: `scripts/validar-classe-viaria-corroboracao.mjs` (adaptado de `scripts/validar-corredor-corroboracao.mjs`, mesmo padrão de ferramenta ad-hoc).

**Interfaces:**
- Consumes: `melhorClasse`, `avaliarQuedaClasseViaria`, `avaliarSaiuParadaConfirmadaRecentemente` de `src/lib/classe-viaria-confirmacao.ts` (via `tsx`, import direto do `.ts`).

- [ ] **Step 1: Escrever o script de validação**

Arquivo `scripts/validar-classe-viaria-corroboracao.mjs`:

```javascript
// Mede quanto a classe viaria teria corroborado nos disparos reais de
// desvio dos ultimos 14 dias, COM grupos de controle -- a licao de 14/08
// (corredor: 89% de corroboracao geral escondia uma discriminacao
// invertida, falso_positivo corroborando MAIS que resolvido) exige medir
// contra controle, nao so o numero bruto. Ver
// docs/superpowers/specs/2026-08-15-classe-viaria-corroboracao-design.md.
import pg from "pg";
import { melhorClasse, avaliarQuedaClasseViaria, avaliarSaiuParadaConfirmadaRecentemente } from "../src/lib/classe-viaria-confirmacao.ts";

const c = new pg.Client({ connectionString: process.env.DATABASE_URL, ssl: { rejectUnauthorized: false } });
await c.connect();

function celulaDe(lat, lng) {
  return `${Math.round(lat * 1000)}:${Math.round(lng * 1000)}`;
}
function vizinhanca3x3(lat, lng) {
  const la = Math.round(lat * 1000);
  const lo = Math.round(lng * 1000);
  const out = [];
  for (let di = -1; di <= 1; di++) for (let dj = -1; dj <= 1; dj++) out.push(`${la + di}:${lo + dj}`);
  return out;
}

async function classificarPosicao(lat, lng) {
  const { rows } = await c.query(`SELECT classe FROM vias_celulas WHERE celula = ANY($1::text[])`, [vizinhanca3x3(lat, lng)]);
  let classe = null;
  for (const r of rows) classe = melhorClasse(classe, r.classe);
  return classe;
}

// Reconstroi ultima_via_principal_em varrendo os ultimos 15min de
// posicoes_historico do veiculo ANTES do momento do disparo -- aproximacao
// pro estado que desvio_estado teria acumulado, ja que essa coluna so
// existe a partir do deploy desta feature (nao tem historico anterior).
async function ultimaViaPrincipalAntes(veiculoId, momento) {
  const { rows } = await c.query(
    `SELECT lat, lng, criado_em FROM posicoes_historico
      WHERE veiculo_id = $1 AND criado_em >= $2::timestamptz - interval '15 minutes' AND criado_em < $2::timestamptz
      ORDER BY criado_em DESC`,
    [veiculoId, momento]
  );
  for (const r of rows) {
    const classe = await classificarPosicao(r.lat, r.lng);
    if (classe === "principal") return r.criado_em;
  }
  return null;
}

async function medirGrupo(nome, whereClause, params) {
  const { rows: disparos } = await c.query(
    `select ddl.veiculo_id, ddl.criado_em, ddl.destinos
       from desvio_disparo_log ddl
       join alertas a on a.veiculo_id = ddl.veiculo_id
         and a.desde <= ddl.criado_em and coalesce(a.resolvido_em, now()) >= ddl.criado_em
      where ddl.tipo_disparo = 'afastando_geral' and ${whereClause}`,
    params
  );
  let quedaSim = 0, semHistorico = 0, total = disparos.length;
  for (const d of disparos) {
    const posAtual = await c.query(
      `SELECT lat, lng FROM posicoes_historico WHERE veiculo_id = $1 AND criado_em <= $2::timestamptz ORDER BY criado_em DESC LIMIT 1`,
      [d.veiculo_id, d.criado_em]
    );
    if (posAtual.rows.length === 0) { semHistorico++; continue; }
    const classeAtual = await classificarPosicao(posAtual.rows[0].lat, posAtual.rows[0].lng);
    const ultimaPrincipal = await ultimaViaPrincipalAntes(d.veiculo_id, d.criado_em);
    const { quedaDetectada } = avaliarQuedaClasseViaria(classeAtual, ultimaPrincipal, d.criado_em);
    if (quedaDetectada) quedaSim++;
  }
  console.log(`${nome}: total=${total} queda_detectada=${quedaSim} sem_historico=${semHistorico} taxa=${total > 0 ? ((quedaSim / total) * 100).toFixed(1) : "n/a"}%`);
}

await medirGrupo(
  "TODOS os disparos reais (14 dias)",
  `ddl.criado_em >= now() - interval '14 days'`,
  []
);
await medirGrupo(
  "grupo FALSO_POSITIVO",
  `ddl.criado_em >= now() - interval '14 days' and a.status = 'falso_positivo'`,
  []
);
await medirGrupo(
  "grupo RESOLVIDO",
  `ddl.criado_em >= now() - interval '14 days' and a.status = 'resolvido'`,
  []
);

await c.end();
```

- [ ] **Step 2: Rodar no servidor (via SSH, banco de produção) e registrar o resultado**

```bash
scp scripts/validar-classe-viaria-corroboracao.mjs transmonseg-vps:/srv/transmonseg/temp/scripts/_tmp-validar-classe-viaria.mjs
ssh transmonseg-vps 'cd /srv/transmonseg/temp && set -a && source .env.production && set +a && npx tsx scripts/_tmp-validar-classe-viaria.mjs; rm scripts/_tmp-validar-classe-viaria.mjs'
```
Expected: três linhas de saída (total, falso_positivo, resolvido) com taxas de "queda_detectada". **Sem conclusão prescritiva automática** — reportar os números reais pro usuário decidir, mesmo padrão de ontem (a decisão de manter/ajustar o bônus depois de ver os números não é do implementador).

- [ ] **Step 3: Commit do script**

```bash
git add scripts/validar-classe-viaria-corroboracao.mjs
git commit -m "chore(desvio): script de validacao da classe viaria com grupos de controle"
```

---

### Task 5: Espelhar pro repo definitivo, aplicar migration no Contabo, deploy dos dois

**Files:**
- Modify (cópia): todos os arquivos criados/modificados nas Tasks 1-4, replicados em `/Users/joaquimsalles/Projects/Transmonseg/monitoramento/MONITORAMENTO transmonseg`.

**Interfaces:**
- N/A — task de integração/deploy.

- [ ] **Step 1: Copiar os arquivos novos/modificados pro repo definitivo**

```bash
TEMP="/Users/joaquimsalles/Projects/Transmonseg/monitoramento/MONITORAMENTO TEMP"
DEF="/Users/joaquimsalles/Projects/Transmonseg/monitoramento/MONITORAMENTO transmonseg"

cp "$TEMP/scripts/migrations/048_desvio_estado_classe_viaria.sql" "$DEF/scripts/migrations/"
cp "$TEMP/scripts/migrations/contabo/050_desvio_estado_classe_viaria.sql" "$DEF/scripts/migrations/contabo/"
cp "$TEMP/src/lib/classe-viaria-confirmacao.ts" "$DEF/src/lib/"
cp "$TEMP/src/lib/classe-viaria-confirmacao.test.ts" "$DEF/src/lib/"
cp "$TEMP/src/app/api/motor/route.ts" "$DEF/src/app/api/motor/"
cp "$TEMP/scripts/validar-classe-viaria-corroboracao.mjs" "$DEF/scripts/"

diff -rq "$TEMP/src/lib/classe-viaria-confirmacao.ts" "$DEF/src/lib/classe-viaria-confirmacao.ts"
diff -rq "$TEMP/src/app/api/motor/route.ts" "$DEF/src/app/api/motor/route.ts"
```

Expected: `diff -rq` sem saída (arquivos idênticos).

- [ ] **Step 2: `tsc`/`eslint`/`vitest` completos no repo definitivo**

```bash
cd "/Users/joaquimsalles/Projects/Transmonseg/monitoramento/MONITORAMENTO transmonseg"
npx tsc --noEmit && npx eslint src/lib/classe-viaria-confirmacao.ts src/app/api/motor/route.ts && npx vitest run
```
Expected: tudo limpo, mesma suíte passando.

- [ ] **Step 3: Commit no definitivo**

```bash
git add -A
git commit -m "feat(desvio): classe viaria como corroboracao -- espelha do TEMP"
```

- [ ] **Step 4: Push dos dois repos e confirmar que chegou**

```bash
cd "/Users/joaquimsalles/Projects/Transmonseg/monitoramento/MONITORAMENTO TEMP"
git push origin master
git fetch origin -q && git status -sb

cd "/Users/joaquimsalles/Projects/Transmonseg/monitoramento/MONITORAMENTO transmonseg"
git push origin main
git fetch origin -q && git status -sb
```
Expected: ambos sem "ahead"/"behind".

- [ ] **Step 5: Aplicar a migration no Contabo (via superuser, lição de ontem — `app_service` não é dono das tabelas)**

```bash
ssh transmonseg-vps 'sudo -u postgres psql -d transmonseg -f /srv/transmonseg/temp/scripts/migrations/contabo/050_desvio_estado_classe_viaria.sql'
```
Expected: `ALTER TABLE` x3 sem erro. Confirmar com a mesma checagem `information_schema.columns` do Step 4 da Task 1, agora contra o banco do Contabo.

- [ ] **Step 6: Deploy nos dois processos PM2**

```bash
ssh transmonseg-vps 'cd /srv/transmonseg/temp && git pull && npm run build && pm2 restart transmonseg-temp'
ssh transmonseg-vps 'cd /srv/transmonseg/definitivo && git pull && npm run build && pm2 restart transmonseg-definitivo'
```
Expected: build limpo nos dois, `pm2 restart` confirma `online`.

- [ ] **Step 7: Smoke test**

```bash
curl -s -o /dev/null -w "%{http_code}\n" https://monitoramento.transmonseg.com.br/
ssh transmonseg-vps 'sleep 40 && cd /srv/transmonseg/temp && set -a && source .env.production && set +a && node -e "
import(\"pg\").then(async ({default: pg}) => {
  const c = new pg.Client({connectionString: process.env.DATABASE_URL, ssl: {rejectUnauthorized: false}});
  await c.connect();
  const r = await c.query(\"select max(criado_em) ultimo from posicoes_historico\");
  console.log(\"Motor rodando, ultima leitura:\", r.rows[0].ultimo);
  await c.end();
});
"'
```
Expected: site responde, motor continua gravando posições normalmente após o restart.

- [ ] **Step 8: Rodar o script de validação (Task 4) de novo, já contra o código em produção, e reportar**

```bash
ssh transmonseg-vps 'cd /srv/transmonseg/temp && set -a && source .env.production && set +a && npx tsx scripts/validar-classe-viaria-corroboracao.mjs'
```
Expected: números reais dos 3 grupos (total/falso_positivo/resolvido) — reportar ao usuário sem tirar conclusão prescritiva automática, mesmo padrão do corredor ontem.
