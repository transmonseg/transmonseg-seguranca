# Redesenho fundamentado da detecção de desvio de rota (Nutry Max) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Substituir os ajustes no chute da "Fase Agressiva" de 11/07 por um redesenho da detecção de desvio de rota fundamentado em pesquisa, no áudio do cliente Nutry Max, e em checagem empírica contra o banco de produção, incluindo um novo sinal de "bypass de entrega sem parar", um baseline comportamental por veículo (a ideia original de histórico por rota não tem dado suficiente), e um processo permanente de calibração via rótulos reais dos operadores em vez de feedback anedótico.

**Architecture:** Seis fases independentes, cada uma com um detector puro testável isoladamente (padrão já usado em `src/lib/detectores.ts`) e wiring mínimo em `src/app/api/motor/route.ts`. Nenhuma fase depende de infraestrutura nova de ML; tudo é SQL/TypeScript. A calibração usa os rótulos que os operadores já geram (Reconhecer/Resolver/Falso positivo); o "backtesting" é retroativo sobre os alertas já existentes (não existe hoje uma tabela de histórico bruto de posições para replay de trajetória completa, restrição confirmada no banco real).

**Tech Stack:** Next.js 16 (App Router) + TypeScript, Supabase Postgres/PostGIS, Vitest, `pg` direto via `DATABASE_URL`.

## Global Constraints

- TDD obrigatório em toda função pura nova: teste RED antes do código, GREEN depois. Ver `src/lib/detectores.test.ts` e `src/lib/corredor-verificacao.test.ts` para o padrão do projeto.
- Antes de cada commit: `npx vitest run` (suite completa), `npx tsc --noEmit`, `npx eslint <arquivos tocados>`, `npm run build`. Todos limpos.
- Nunca usar travessão (—) em código, comentários, commits ou docs deste projeto (preferência do usuário).
- Migrations seguem `scripts/migrations/NNN_nome.sql`, aplicadas com `node --env-file=.env.local scripts/aplicar-migration.mjs <arquivo>`. Próximo número livre: `017`.
- Nenhuma mudança de sensibilidade (buffer, streak, threshold, peso) entra em produção sem passar pela calibração da Fase 5 primeiro (é a causa raiz do problema de 11/07).
- Alertas de desvio nunca são auto-resolvidos pelo motor (decisão já tomada e implementada; nenhuma tarefa deste plano reverte isso).
- Commit por tarefa, com `git push origin main` ao final de cada tarefa (padrão já seguido a sessão inteira neste projeto).

---

## Visão geral das fases

| Fase | O que entrega | Depende de | Migration nova |
|---|---|---|---|
| 1 | Cerca virtual verifica TODOS os pendentes, não só os 3 mais próximos (a suposição de ordem de entrega não existe) | Nada | Não |
| 2 | Detector "bypass de entrega sem parar" (sinal operacional do áudio do cliente) | Nada | `017` |
| 3 | Baseline comportamental por veículo/motorista (substitui histórico por rota, que não tem dado suficiente) | Nada | `018` |
| 4 | Harness de calibração/backtesting retroativo sobre alertas já rotulados + gravação prospectiva mínima | Fases 1-3 geram os alertas que o harness vai analisar | `019` |
| 5 | Calibração automática dos pesos/thresholds usando os rótulos reais (Reconhecer/Resolver/Falso positivo) | Fase 4 (harness) | `019` (mesma) |
| 6 | Histórico por par origem-destino liga sozinho quando o par acumular 3+ dias de repetição | `corredor_celulas` já existe | Não |

---

## Fase 1: Cerca virtual verifica todos os pendentes

### Task 1.1: Extrair e testar a priorização de pendentes por distância (sem cortar em 3)

**Files:**
- Modify: `src/lib/corredor-verificacao.ts` (adicionar função nova, sem remover nada existente)
- Test: `src/lib/corredor-verificacao.test.ts`

**Interfaces:**
- Produces: `ordenarPendentesPorDistancia<T extends { lat: number; lng: number }>(pos: { lat: number; lng: number }, pendentes: T[]): T[]`, exportada de `corredor-verificacao.ts`, usada pela Task 1.2 em `route.ts`.

- [ ] **Step 1: Escrever o teste que falha**

Adicionar ao final de `src/lib/corredor-verificacao.test.ts`:

```ts
describe("ordenarPendentesPorDistancia (substitui o corte fixo em 3 mais proximos)", () => {
  it("ordena todos os pendentes por distancia crescente, sem cortar nenhum", () => {
    const pos = { lat: -22.90, lng: -43.20 };
    const pendentes = [
      { lat: -22.90, lng: -43.20 + 0.05, nome: "longe" },
      { lat: -22.90, lng: -43.20 + 0.01, nome: "perto" },
      { lat: -22.90, lng: -43.20 + 0.03, nome: "medio" },
      { lat: -22.90, lng: -43.20 + 0.09, nome: "muito longe" },
    ];
    const resultado = ordenarPendentesPorDistancia(pos, pendentes);
    expect(resultado.map((p) => p.nome)).toEqual(["perto", "medio", "longe", "muito longe"]);
    expect(resultado).toHaveLength(4); // nao corta em 3
  });

  it("lista vazia retorna vazia", () => {
    expect(ordenarPendentesPorDistancia({ lat: 0, lng: 0 }, [])).toEqual([]);
  });
});
```

E ajustar o import no topo do arquivo de teste:

```ts
import { bufferPorVelocidade, dentroDoCorredor, decodePolyline6, verificarCorredor, ordenarPendentesPorDistancia } from "./corredor-verificacao";
```

- [ ] **Step 2: Rodar e confirmar que falha**

Run: `npx vitest run src/lib/corredor-verificacao.test.ts`
Expected: FAIL, `ordenarPendentesPorDistancia is not a function` ou erro de import.

- [ ] **Step 3: Implementar**

Em `src/lib/corredor-verificacao.ts`, adicionar o import de `haversineM` no topo (hoje só importa `distanciaAoSegmentoM`):

```ts
import { distanciaAoSegmentoM, haversineM } from "./unitrac";
```

E adicionar a função (perto de `dentroDoCorredor`, mesma área de responsabilidade):

```ts
// Substitui o corte fixo em "3 mais proximos" usado ate 11/07 na cerca
// virtual -- pressupunha que o motorista vai pro pendente mais perto, mas
// nao ha ordem de entrega definida (o motorista escolhe livremente). Ordena
// por distancia como heuristica pratica de prioridade dentro do orcamento
// de chamadas (quem chama decide quantos tentar), sem descartar nenhum.
export function ordenarPendentesPorDistancia<T extends { lat: number; lng: number }>(
  pos: { lat: number; lng: number },
  pendentes: T[]
): T[] {
  return [...pendentes].sort(
    (a, b) => haversineM(pos.lat, pos.lng, a.lat, a.lng) - haversineM(pos.lat, pos.lng, b.lat, b.lng)
  );
}
```

- [ ] **Step 4: Rodar e confirmar que passa**

Run: `npx vitest run src/lib/corredor-verificacao.test.ts`
Expected: PASS, todos os testes do arquivo.

- [ ] **Step 5: Validar e commitar**

Run: `npx tsc --noEmit && npx eslint src/lib/corredor-verificacao.ts src/lib/corredor-verificacao.test.ts`
Expected: sem erros.

```bash
git add src/lib/corredor-verificacao.ts src/lib/corredor-verificacao.test.ts
git commit -m "feat(desvio): ordenarPendentesPorDistancia sem cortar em 3 (nao ha ordem de entrega)"
git push origin main
```

### Task 1.2: Trocar `tresMaisProximos` por `ordenarPendentesPorDistancia` na cerca virtual (route.ts)

**Files:**
- Modify: `src/app/api/motor/route.ts:1228-1233` (declaração de `tresMaisProximos`), e os dois call sites em `1244` e `1270`.

**Interfaces:**
- Consumes: `ordenarPendentesPorDistancia` (Task 1.1).

- [ ] **Step 1: Import**

No topo de `route.ts`, no import de `@/lib/corredor-verificacao`:

```ts
import { verificarCorredor, dentroDoCorredor, bufferPorVelocidade, ordenarPendentesPorDistancia } from "@/lib/corredor-verificacao";
```

- [ ] **Step 2: Substituir a declaração**

Trocar:

```ts
            const tresMaisProximos = () =>
              [...pendentes]
                .map((pt) => ({ pt, dist: haversineM(pos.lat, pos.lng, pt.lat, pt.lng) }))
                .sort((a, b) => a.dist - b.dist)
                .slice(0, 3)
                .map((x) => ({ lat: x.pt.lat, lng: x.pt.lng }));
```

por:

```ts
            // Achado real 11/07: nao existe ordem de entrega, o motorista
            // escolhe livremente qual pendente visitar primeiro. Cortar em
            // "3 mais proximos" presumia que o motorista ia pro mais perto,
            // o que gerava alerta em cima de gente indo legitimamente pra um
            // pendente mais distante. Agora verifica TODOS, ordenados por
            // distancia so como heuristica de prioridade dentro do
            // orcamento de chamadas (verificarCorredor ja tem deadline de
            // 5s/req e o throttle global decide quantos realmente cabem).
            const todosPendentesPriorizados = () =>
              ordenarPendentesPorDistancia(pos, pendentes).map((pt) => ({ lat: pt.lat, lng: pt.lng }));
```

- [ ] **Step 3: Atualizar os dois call sites**

Nas duas chamadas de `verificarCorredor` dentro do bloco da cerca virtual, trocar `tresMaisProximos()` por `todosPendentesPriorizados()` (linhas onde hoje diz `tresMaisProximos()`, uma na semeadura e outra na recuperação).

- [ ] **Step 4: Validar (route.ts não tem teste unitário próprio)**

Run: `npx tsc --noEmit && npx eslint src/app/api/motor/route.ts && npm run build`
Expected: sem erros. Confirmar visualmente (`grep -n "tresMaisProximos" src/app/api/motor/route.ts`) que não sobrou nenhuma referência ao nome antigo.

- [ ] **Step 5: Rodar suite completa e commitar**

```bash
npx vitest run
```
Expected: todos os testes passando (nenhum teste unitário cobre `route.ts` diretamente, então isso só confirma que nada mais quebrou).

```bash
git add src/app/api/motor/route.ts
git commit -m "feat(desvio): cerca virtual verifica todos os pendentes, nao so os 3 mais proximos"
git push origin main
```

### Task 1.3: Validar em produção com dado real (checagem manual, não é código)

- [ ] Rodar a checagem periódica de alertas de desvio da Nutry (mesmo script `check-desvio-nutry.mjs` já usado nesta sessão) por pelo menos 2h após o deploy, confirmando que o volume não voltou a explodir e que veículos com muitos pendentes (10+) não estão mais gerando "fora" constante por estarem indo pra um pendente distante legítimo.

---

## Fase 2: Detector "bypass de entrega sem parar"

Sinal do áudio do cliente: entrar no raio de um pendente, não reduzir a velocidade o suficiente por um tempo mínimo, sair sem a Unitrac confirmar entrega. Validado pela pesquisa (stay-point detection para logística urbana: raio do próprio alvo, `pt.raio`, já usado; tempo mínimo de permanência com velocidade baixa, não só posição). É sinal OPERACIONAL (nível "atencao"), nunca crítico sozinho.

### Task 2.1: Migration 017 (colunas de dwell no raio do alvo)

**Files:**
- Create: `scripts/migrations/017_bypass_entrega.sql`

- [ ] **Step 1: Escrever a migration**

```sql
-- 017: rastreio de permanencia dentro do raio de um pendente, pro detector
-- de "bypass de entrega sem parar" (achado do audio do cliente Nutry Max,
-- 11/07/2026: desvio real e quando chega na porta do cliente e nao para).
alter table posicoes_atuais
  add column if not exists no_raio_alvo_codigo int,
  add column if not exists no_raio_desde timestamptz,
  add column if not exists no_raio_dwell_segundos int not null default 0;
```

- [ ] **Step 2: Aplicar**

Run: `node --env-file=.env.local scripts/aplicar-migration.mjs 017_bypass_entrega.sql`
Expected: sucesso, sem erro. Confirmar com:
```bash
node --env-file=.env.local -e "import('pg').then(async({default:pg})=>{const p=new pg.Pool({connectionString:process.env.DATABASE_URL});const r=await p.query(\"select column_name from information_schema.columns where table_name='posicoes_atuais' and column_name like 'no_raio%'\");console.log(r.rows);await p.end();});"
```
Expected: as 3 colunas listadas.

- [ ] **Step 3: Commit**

```bash
git add scripts/migrations/017_bypass_entrega.sql
git commit -m "feat(desvio): migration 017, colunas de dwell no raio do alvo (bypass de entrega)"
git push origin main
```

### Task 2.2: Detector puro `detectarBypassEntrega`

**Files:**
- Modify: `src/lib/detectores.ts` (adicionar tipo e função, sem tocar em código existente)
- Test: `src/lib/detectores.test.ts`

**Interfaces:**
- Produces: `type CtxBypassEntrega`, `detectarBypassEntrega(ctx: CtxBypassEntrega): Alerta | null`, ambos exportados de `detectores.ts`. Consumidos pela Task 2.3 em `route.ts`.

- [ ] **Step 1: Escrever os testes que falham**

Adicionar ao final de `src/lib/detectores.test.ts`:

```ts
describe("detectarBypassEntrega (achado do audio do cliente 11/07: chegou na porta e nao parou)", () => {
  const base: CtxBypassEntrega = {
    saiuDoRaioAgora: true,
    mesmoAlvoCodigo: true,
    dwellSegundosAcumulados: 20,
    entregaConfirmada: false,
  };

  it("saiu do raio sem dwell suficiente e sem confirmar entrega: dispara atencao", () => {
    const a = detectarBypassEntrega(base);
    expect(a?.nivel).toBe("atencao");
    expect(a?.tipo).toBe("bypass_entrega");
    expect(a?.motivo).toContain("sem confirmar");
  });

  it("dwell suficiente (>=120s): nao dispara, ficou tempo bastante", () => {
    expect(detectarBypassEntrega({ ...base, dwellSegundosAcumulados: 120 })).toBeNull();
  });

  it("entrega confirmada pela Unitrac: nao dispara mesmo com dwell baixo", () => {
    expect(detectarBypassEntrega({ ...base, entregaConfirmada: true })).toBeNull();
  });

  it("nao saiu do raio agora (ainda dentro): nao dispara", () => {
    expect(detectarBypassEntrega({ ...base, saiuDoRaioAgora: false })).toBeNull();
  });

  it("trocou de alvo (nao e o mesmo raio que entrou): nao dispara", () => {
    expect(detectarBypassEntrega({ ...base, mesmoAlvoCodigo: false })).toBeNull();
  });
});
```

E adicionar `CtxBypassEntrega, detectarBypassEntrega` ao import de `./detectores` no topo do arquivo de teste.

- [ ] **Step 2: Rodar e confirmar que falha**

Run: `npx vitest run src/lib/detectores.test.ts`
Expected: FAIL, `detectarBypassEntrega is not a function`.

- [ ] **Step 3: Implementar**

Adicionar em `src/lib/detectores.ts` (perto de `detectarRetornoTardio`/`detectarAceleracaoBrusca`, mesmo padrão de detector isolado):

```ts
// Achado do audio do cliente Nutry Max (11/07/2026): "desvio de rota e
// quando ele esta na porta do cliente e nao para, segue por outra via, sem
// confirmar". Parametros de stay-point detection pra logistica urbana
// (raio do proprio alvo, ja fornecido pela Unitrac em pt.raio; tempo minimo
// de permanencia com velocidade baixa, nao so posicao). Sinal OPERACIONAL
// (nivel atencao): confirmado que ninguem na industria trata isso sozinho
// como alerta de seguranca, so combinado com outro sinal (route.ts decide
// a escalada, ver comentario no fluxo de deteccao).
export type CtxBypassEntrega = {
  saiuDoRaioAgora: boolean;
  mesmoAlvoCodigo: boolean;
  dwellSegundosAcumulados: number;
  entregaConfirmada: boolean;
};

export const BYPASS_ENTREGA_DWELL_MINIMO_SEGUNDOS = 120;

export function detectarBypassEntrega(ctx: CtxBypassEntrega): Alerta | null {
  if (!ctx.saiuDoRaioAgora || !ctx.mesmoAlvoCodigo) return null;
  if (ctx.entregaConfirmada) return null;
  if (ctx.dwellSegundosAcumulados >= BYPASS_ENTREGA_DWELL_MINIMO_SEGUNDOS) return null;
  return {
    nivel: "atencao",
    tipo: "bypass_entrega",
    motivo: `Passou pelo raio de um ponto de entrega sem confirmar (parado so ${ctx.dwellSegundosAcumulados}s, esperado ${BYPASS_ENTREGA_DWELL_MINIMO_SEGUNDOS}s+)`,
    score: 40,
  };
}
```

- [ ] **Step 4: Rodar e confirmar que passa**

Run: `npx vitest run src/lib/detectores.test.ts`
Expected: PASS, todos os testes.

- [ ] **Step 5: Validar e commitar**

```bash
npx tsc --noEmit && npx eslint src/lib/detectores.ts src/lib/detectores.test.ts && npx vitest run
git add src/lib/detectores.ts src/lib/detectores.test.ts
git commit -m "feat(desvio): detector puro de bypass de entrega sem parar (achado do audio do cliente)"
git push origin main
```

### Task 2.3: Wiring no motor (route.ts), rastrear dwell e chamar o detector

**Files:**
- Modify: `src/app/api/motor/route.ts:542-569` (select e tipo de `mapaPosAtual`, adicionar as 3 colunas novas)
- Modify: `src/app/api/motor/route.ts` (dentro do loop por veículo, perto de onde `paradoMin`/`parado_desde` já são calculados, e no array `extras` onde os outros detectores são mesclados)

**Interfaces:**
- Consumes: `detectarBypassEntrega`, `CtxBypassEntrega`, `BYPASS_ENTREGA_DWELL_MINIMO_SEGUNDOS` (Task 2.2); `pt.raio` de `PontoEntrega` (já existe em `src/lib/unitrac.ts`); campos `no_raio_alvo_codigo`, `no_raio_desde`, `no_raio_dwell_segundos` de `posicoes_atuais` (Task 2.1).

- [ ] **Step 1: Incluir as 3 colunas novas no select e no tipo de `mapaPosAtual` (linhas 542-569)**

`mapaPosAtual` é carregado UMA VEZ pra todos os veículos, antes do loop por cliente (linha 542). Hoje ele seleciona uma lista fixa de colunas; é isso que vira o `anterior` usado dentro do loop. Trocar:

```ts
    const { data: posatuaisRows } = await supabase
      .from("posicoes_atuais")
      .select("veiculo_id, lat, lng, velocidade, parado_desde, desvio_streak, desvio_inicio, ultimo_evento, fora_tapete_streak, aproximando_streak, origem_celula");

    const mapaPosAtual = new Map<
      string,
      {
        lat: number | null; lng: number | null; velocidade: number | null;
        parado_desde: string | null; desvio_streak: number; desvio_inicio: DesvioInicio | null;
        ultimo_evento: string | null; fora_tapete_streak: number; aproximando_streak: number;
        origem_celula: string | null;
      }
    >();

    for (const row of posatuaisRows ?? []) {
      mapaPosAtual.set(row.veiculo_id, {
        lat: row.lat,
        lng: row.lng,
        velocidade: row.velocidade,
        parado_desde: row.parado_desde,
        desvio_streak: row.desvio_streak ?? 0,
        desvio_inicio: (row.desvio_inicio as DesvioInicio | null) ?? null,
        ultimo_evento: row.ultimo_evento ?? null,
        fora_tapete_streak: row.fora_tapete_streak ?? 0,
        aproximando_streak: row.aproximando_streak ?? 0,
        origem_celula: row.origem_celula ?? null,
      });
    }
```

por:

```ts
    const { data: posatuaisRows } = await supabase
      .from("posicoes_atuais")
      .select("veiculo_id, lat, lng, velocidade, parado_desde, desvio_streak, desvio_inicio, ultimo_evento, fora_tapete_streak, aproximando_streak, origem_celula, no_raio_alvo_codigo, no_raio_desde, no_raio_dwell_segundos");

    const mapaPosAtual = new Map<
      string,
      {
        lat: number | null; lng: number | null; velocidade: number | null;
        parado_desde: string | null; desvio_streak: number; desvio_inicio: DesvioInicio | null;
        ultimo_evento: string | null; fora_tapete_streak: number; aproximando_streak: number;
        origem_celula: string | null;
        no_raio_alvo_codigo: number | null; no_raio_desde: string | null; no_raio_dwell_segundos: number;
      }
    >();

    for (const row of posatuaisRows ?? []) {
      mapaPosAtual.set(row.veiculo_id, {
        lat: row.lat,
        lng: row.lng,
        velocidade: row.velocidade,
        parado_desde: row.parado_desde,
        desvio_streak: row.desvio_streak ?? 0,
        desvio_inicio: (row.desvio_inicio as DesvioInicio | null) ?? null,
        ultimo_evento: row.ultimo_evento ?? null,
        fora_tapete_streak: row.fora_tapete_streak ?? 0,
        aproximando_streak: row.aproximando_streak ?? 0,
        origem_celula: row.origem_celula ?? null,
        no_raio_alvo_codigo: row.no_raio_alvo_codigo ?? null,
        no_raio_desde: row.no_raio_desde ?? null,
        no_raio_dwell_segundos: row.no_raio_dwell_segundos ?? 0,
      });
    }
```

- [ ] **Step 2: Calcular o alvo pendente cuja distância <= seu raio (se houver), e o estado anterior**

Perto de onde `pendentes` já é usado (mesma área da cerca virtual), adicionar:

```ts
          // Bypass de entrega sem parar (achado do audio do cliente).
          const alvoNoRaioAgora = pendentes.find(
            (pt) => haversineM(pos.lat, pos.lng, pt.lat, pt.lng) <= pt.raio
          ) ?? null;
          const codigoAnteriorNoRaio = anterior?.no_raio_alvo_codigo ?? null;
          const desdeAnterior = anterior?.no_raio_desde ?? null;
          const dwellAnterior = anterior?.no_raio_dwell_segundos ?? 0;

          const mesmoAlvoQueAntes = alvoNoRaioAgora !== null && alvoNoRaioAgora.codigo === codigoAnteriorNoRaio;
          const LIMIAR_VELOCIDADE_DWELL_KMH = 5;

          let noRaioAlvoCodigo: number | null = alvoNoRaioAgora?.codigo ?? null;
          let noRaioDesde: string | null = desdeAnterior;
          let noRaioDwellSegundos = dwellAnterior;

          if (alvoNoRaioAgora === null) {
            // Fora de qualquer raio: zera (o proximo bloco decide se dispara
            // ANTES de zerar, usando os valores capturados acima).
            noRaioAlvoCodigo = null;
            noRaioDesde = null;
            noRaioDwellSegundos = 0;
          } else if (!mesmoAlvoQueAntes) {
            // Entrou num raio novo (ou pela primeira vez).
            noRaioDesde = agora.toISOString();
            noRaioDwellSegundos = pos.velocidade <= LIMIAR_VELOCIDADE_DWELL_KMH ? 30 : 0;
          } else {
            // Continua no mesmo raio: acumula dwell so quando devagar/parado.
            noRaioDwellSegundos = dwellAnterior + (pos.velocidade <= LIMIAR_VELOCIDADE_DWELL_KMH ? 30 : 0);
          }

          const saiuDoRaioAgora = codigoAnteriorNoRaio !== null && alvoNoRaioAgora === null;
          const alvoQueSaiu = pendentes.find((pt) => pt.codigo === codigoAnteriorNoRaio) ?? null;
          const alertaBypass = pos.fresco
            ? detectarBypassEntrega({
                saiuDoRaioAgora,
                mesmoAlvoCodigo: codigoAnteriorNoRaio !== null,
                dwellSegundosAcumulados: dwellAnterior,
                entregaConfirmada: alvoQueSaiu?.feito ?? false,
              })
            : null;
```

Nota: o incremento de 30s no dwell assume ciclo de ~30s (cadência já validada em produção); se o ciclo variar, ajustar a constante ou (melhor, mas fora do escopo desta task) calcular a partir do timestamp real (`agora - anterior.updated_at`).

- [ ] **Step 3: Persistir os novos campos no objeto acumulado do ciclo**

No objeto `posicoesCiclo.push({...})` (mesmo bloco onde `desvio_streak`, `aproximando_streak` etc já são gravados), adicionar:

```ts
            no_raio_alvo_codigo: noRaioAlvoCodigo,
            no_raio_desde: noRaioDesde,
            no_raio_dwell_segundos: noRaioDwellSegundos,
```

- [ ] **Step 4: Incluir as 3 colunas no UPSERT em lote de `posicoes_atuais` (linhas 1640-1718)**

O upsert batch (`INSERT INTO posicoes_atuais ... FROM unnest(...) ... ON CONFLICT ... DO UPDATE`) é UM statement só pro ciclo inteiro; as colunas novas do Step 3 não aparecem nele ainda. Trocar o bloco inteiro:

```ts
        await pgPosicoes.query(
          `INSERT INTO posicoes_atuais
             (veiculo_id, lat, lng, geom, velocidade, ignicao, atraso_min,
              panico, bau_aberto, nivel, motivo, datagps, parado_desde, updated_at,
              entregas_feitas, entregas_total, local, desvio_streak, rumo,
              ultimo_evento, ultimo_evento_em, desvio_inicio, fora_tapete_streak,
              aproximando_streak, origem_celula)
           SELECT
             c.veiculo_id, c.lat, c.lng,
             ST_SetSRID(ST_MakePoint(c.lng, c.lat), 4326)::geography,
             c.velocidade, c.ignicao, c.atraso_min, c.panico, c.bau_aberto,
             c.nivel, c.motivo, c.datagps::timestamptz, c.parado_desde::timestamptz,
             c.updated_at::timestamptz, c.entregas_feitas, c.entregas_total, c.local,
             c.desvio_streak, c.rumo, c.ultimo_evento, c.updated_at::timestamptz,
             c.desvio_inicio::jsonb, c.fora_tapete_streak, c.aproximando_streak,
             c.origem_celula
           FROM unnest(
             $1::uuid[], $2::float8[], $3::float8[], $4::float8[], $5::boolean[],
             $6::integer[], $7::boolean[], $8::boolean[], $9::text[], $10::text[],
             $11::text[], $12::text[], $13::text[], $14::integer[], $15::integer[],
             $16::text[], $17::integer[], $18::integer[], $19::text[], $20::text[],
             $21::integer[], $22::integer[], $23::text[]
           ) AS c(veiculo_id, lat, lng, velocidade, ignicao, atraso_min, panico,
                  bau_aberto, nivel, motivo, datagps, parado_desde, updated_at,
                  entregas_feitas, entregas_total, local, desvio_streak, rumo,
                  ultimo_evento, desvio_inicio, fora_tapete_streak, aproximando_streak,
                  origem_celula)
           ON CONFLICT (veiculo_id) DO UPDATE SET
             lat              = EXCLUDED.lat,
             lng              = EXCLUDED.lng,
             geom             = EXCLUDED.geom,
             velocidade       = EXCLUDED.velocidade,
             ignicao          = EXCLUDED.ignicao,
             atraso_min       = EXCLUDED.atraso_min,
             panico           = EXCLUDED.panico,
             bau_aberto       = EXCLUDED.bau_aberto,
             nivel            = EXCLUDED.nivel,
             motivo           = EXCLUDED.motivo,
             datagps          = EXCLUDED.datagps,
             parado_desde     = EXCLUDED.parado_desde,
             updated_at       = EXCLUDED.updated_at,
             entregas_feitas  = EXCLUDED.entregas_feitas,
             entregas_total   = EXCLUDED.entregas_total,
             local            = COALESCE(EXCLUDED.local, posicoes_atuais.local),
             desvio_streak    = EXCLUDED.desvio_streak,
             desvio_inicio    = EXCLUDED.desvio_inicio,
             rumo             = EXCLUDED.rumo,
             ultimo_evento    = EXCLUDED.ultimo_evento,
             ultimo_evento_em = CASE WHEN EXCLUDED.ultimo_evento IS DISTINCT FROM posicoes_atuais.ultimo_evento
                                  THEN EXCLUDED.ultimo_evento_em ELSE posicoes_atuais.ultimo_evento_em END,
             fora_tapete_streak = EXCLUDED.fora_tapete_streak,
             aproximando_streak = EXCLUDED.aproximando_streak,
             origem_celula      = EXCLUDED.origem_celula`,
          [
            posicoesCiclo.map((p) => p.veiculo_id),
            posicoesCiclo.map((p) => p.lat),
            posicoesCiclo.map((p) => p.lng),
            posicoesCiclo.map((p) => p.velocidade),
            posicoesCiclo.map((p) => p.ignicao),
            posicoesCiclo.map((p) => p.atraso_min),
            posicoesCiclo.map((p) => p.panico),
            posicoesCiclo.map((p) => p.bau_aberto),
            posicoesCiclo.map((p) => p.nivel),
            posicoesCiclo.map((p) => p.motivo),
            posicoesCiclo.map((p) => p.datagps),
            posicoesCiclo.map((p) => p.parado_desde),
            posicoesCiclo.map((p) => p.updated_at),
            posicoesCiclo.map((p) => p.entregas_feitas),
            posicoesCiclo.map((p) => p.entregas_total),
            posicoesCiclo.map((p) => p.local),
            posicoesCiclo.map((p) => p.desvio_streak),
            posicoesCiclo.map((p) => p.rumo),
            posicoesCiclo.map((p) => p.ultimo_evento),
            posicoesCiclo.map((p) => p.desvio_inicio),
            posicoesCiclo.map((p) => p.fora_tapete_streak),
            posicoesCiclo.map((p) => p.aproximando_streak),
            posicoesCiclo.map((p) => p.origem_celula),
          ]
        );
```

por (acrescenta as 3 colunas em todos os 6 lugares: lista de colunas do INSERT, lista do SELECT, tipos do `unnest`, lista do `AS c(...)`, `ON CONFLICT DO UPDATE SET`, e o array de parâmetros):

```ts
        await pgPosicoes.query(
          `INSERT INTO posicoes_atuais
             (veiculo_id, lat, lng, geom, velocidade, ignicao, atraso_min,
              panico, bau_aberto, nivel, motivo, datagps, parado_desde, updated_at,
              entregas_feitas, entregas_total, local, desvio_streak, rumo,
              ultimo_evento, ultimo_evento_em, desvio_inicio, fora_tapete_streak,
              aproximando_streak, origem_celula, no_raio_alvo_codigo, no_raio_desde,
              no_raio_dwell_segundos)
           SELECT
             c.veiculo_id, c.lat, c.lng,
             ST_SetSRID(ST_MakePoint(c.lng, c.lat), 4326)::geography,
             c.velocidade, c.ignicao, c.atraso_min, c.panico, c.bau_aberto,
             c.nivel, c.motivo, c.datagps::timestamptz, c.parado_desde::timestamptz,
             c.updated_at::timestamptz, c.entregas_feitas, c.entregas_total, c.local,
             c.desvio_streak, c.rumo, c.ultimo_evento, c.updated_at::timestamptz,
             c.desvio_inicio::jsonb, c.fora_tapete_streak, c.aproximando_streak,
             c.origem_celula, c.no_raio_alvo_codigo, c.no_raio_desde::timestamptz,
             c.no_raio_dwell_segundos
           FROM unnest(
             $1::uuid[], $2::float8[], $3::float8[], $4::float8[], $5::boolean[],
             $6::integer[], $7::boolean[], $8::boolean[], $9::text[], $10::text[],
             $11::text[], $12::text[], $13::text[], $14::integer[], $15::integer[],
             $16::text[], $17::integer[], $18::integer[], $19::text[], $20::text[],
             $21::integer[], $22::integer[], $23::text[], $24::integer[], $25::text[],
             $26::integer[]
           ) AS c(veiculo_id, lat, lng, velocidade, ignicao, atraso_min, panico,
                  bau_aberto, nivel, motivo, datagps, parado_desde, updated_at,
                  entregas_feitas, entregas_total, local, desvio_streak, rumo,
                  ultimo_evento, desvio_inicio, fora_tapete_streak, aproximando_streak,
                  origem_celula, no_raio_alvo_codigo, no_raio_desde, no_raio_dwell_segundos)
           ON CONFLICT (veiculo_id) DO UPDATE SET
             lat              = EXCLUDED.lat,
             lng              = EXCLUDED.lng,
             geom             = EXCLUDED.geom,
             velocidade       = EXCLUDED.velocidade,
             ignicao          = EXCLUDED.ignicao,
             atraso_min       = EXCLUDED.atraso_min,
             panico           = EXCLUDED.panico,
             bau_aberto       = EXCLUDED.bau_aberto,
             nivel            = EXCLUDED.nivel,
             motivo           = EXCLUDED.motivo,
             datagps          = EXCLUDED.datagps,
             parado_desde     = EXCLUDED.parado_desde,
             updated_at       = EXCLUDED.updated_at,
             entregas_feitas  = EXCLUDED.entregas_feitas,
             entregas_total   = EXCLUDED.entregas_total,
             local            = COALESCE(EXCLUDED.local, posicoes_atuais.local),
             desvio_streak    = EXCLUDED.desvio_streak,
             desvio_inicio    = EXCLUDED.desvio_inicio,
             rumo             = EXCLUDED.rumo,
             ultimo_evento    = EXCLUDED.ultimo_evento,
             ultimo_evento_em = CASE WHEN EXCLUDED.ultimo_evento IS DISTINCT FROM posicoes_atuais.ultimo_evento
                                  THEN EXCLUDED.ultimo_evento_em ELSE posicoes_atuais.ultimo_evento_em END,
             fora_tapete_streak = EXCLUDED.fora_tapete_streak,
             aproximando_streak = EXCLUDED.aproximando_streak,
             origem_celula      = EXCLUDED.origem_celula,
             no_raio_alvo_codigo = EXCLUDED.no_raio_alvo_codigo,
             no_raio_desde       = EXCLUDED.no_raio_desde,
             no_raio_dwell_segundos = EXCLUDED.no_raio_dwell_segundos`,
          [
            posicoesCiclo.map((p) => p.veiculo_id),
            posicoesCiclo.map((p) => p.lat),
            posicoesCiclo.map((p) => p.lng),
            posicoesCiclo.map((p) => p.velocidade),
            posicoesCiclo.map((p) => p.ignicao),
            posicoesCiclo.map((p) => p.atraso_min),
            posicoesCiclo.map((p) => p.panico),
            posicoesCiclo.map((p) => p.bau_aberto),
            posicoesCiclo.map((p) => p.nivel),
            posicoesCiclo.map((p) => p.motivo),
            posicoesCiclo.map((p) => p.datagps),
            posicoesCiclo.map((p) => p.parado_desde),
            posicoesCiclo.map((p) => p.updated_at),
            posicoesCiclo.map((p) => p.entregas_feitas),
            posicoesCiclo.map((p) => p.entregas_total),
            posicoesCiclo.map((p) => p.local),
            posicoesCiclo.map((p) => p.desvio_streak),
            posicoesCiclo.map((p) => p.rumo),
            posicoesCiclo.map((p) => p.ultimo_evento),
            posicoesCiclo.map((p) => p.desvio_inicio),
            posicoesCiclo.map((p) => p.fora_tapete_streak),
            posicoesCiclo.map((p) => p.aproximando_streak),
            posicoesCiclo.map((p) => p.origem_celula),
            posicoesCiclo.map((p) => p.no_raio_alvo_codigo),
            posicoesCiclo.map((p) => p.no_raio_desde),
            posicoesCiclo.map((p) => p.no_raio_dwell_segundos),
          ]
        );
```

- [ ] **Step 5: Mesclar no array `extras`**

No array `extras` (onde `alertaCerca` já foi adicionado hoje), adicionar `alertaBypass`:

```ts
          const extras: Alerta[] = [
            detectarRetornoTardio({ entregas_feitas, entregas_total, foraDaBase, paradoMin, emOperacao }),
            detectarParadaNoturnaIgnicaoAtiva(pos, { foraDaBase, noCliente, horaSP }),
            detectarAceleracaoBrusca(pos, {
              velocidadeAnterior: anterior?.velocidade ?? null,
              foraDaBase,
            }),
            alertaCerca,
            alertaBypass,
          ].filter((a): a is Alerta => a !== null);
```

- [ ] **Step 6: Validar**

Run: `npx tsc --noEmit && npx eslint src/app/api/motor/route.ts && npm run build`
Expected: sem erros (o Step 1 já cobriu a tipagem de `anterior.no_raio_*`).

- [ ] **Step 7: Rodar suite completa e commitar**

```bash
npx vitest run
git add src/app/api/motor/route.ts
git commit -m "feat(desvio): liga o detector de bypass de entrega no motor, persiste dwell no raio"
git push origin main
```

### Task 2.4: Validar em produção

- [ ] Rodar a checagem periódica de alertas por pelo menos algumas horas, filtrando por `tipo='bypass_entrega'` além de `'desvio'`, conferindo se os casos fazem sentido (cliente fechado/endereço errado vão aparecer como falso positivo esperado, é sinal operacional mesmo).

---

## Fase 3: Baseline comportamental por veículo/motorista

Não existe tabela de histórico bruto de posições no banco (confirmado: só `posicoes_atuais` como snapshot atual, `rota_perfil` e `corredor_celulas` como resumos incrementais). O baseline por veículo também precisa ser incremental (mesmo padrão EWMA/Welford já usado em `rota_perfil`), acumulando a partir de agora, não minerando histórico que não existe.

### Task 3.1: Migration 018 (tabela de baseline incremental por veículo)

**Files:**
- Create: `scripts/migrations/018_baseline_veiculo.sql`

- [ ] **Step 1: Escrever a migration**

```sql
-- 018: baseline comportamental incremental por veiculo (substitui a ideia
-- original de historico por rota especifica -- dado real mostrou que so
-- 1,2% dos pares origem-destino repetem em 2+ dias, insuficiente). Mesmo
-- padrao ja usado em rota_perfil (media/variancia incremental, algoritmo de
-- Welford), agora por (veiculo, tipo_viagem, feature).
create table if not exists baseline_veiculo (
  veiculo_id uuid not null,
  tipo_viagem text not null,
  feature text not null,
  n_amostras bigint not null default 0,
  media double precision not null default 0,
  variancia double precision not null default 0,
  atualizado_em timestamptz not null default now(),
  primary key (veiculo_id, tipo_viagem, feature)
);

-- Baseline da FROTA INTEIRA por tipo_viagem (fallback de cold start,
-- enquanto o veiculo especifico nao acumula amostras suficientes).
create table if not exists baseline_frota (
  cliente_id uuid not null,
  tipo_viagem text not null,
  feature text not null,
  n_amostras bigint not null default 0,
  media double precision not null default 0,
  variancia double precision not null default 0,
  atualizado_em timestamptz not null default now(),
  primary key (cliente_id, tipo_viagem, feature)
);
```

- [ ] **Step 2: Aplicar e confirmar**

Run: `node --env-file=.env.local scripts/aplicar-migration.mjs 018_baseline_veiculo.sql`

- [ ] **Step 3: Commit**

```bash
git add scripts/migrations/018_baseline_veiculo.sql
git commit -m "feat(desvio): migration 018, tabelas de baseline incremental por veiculo e frota"
git push origin main
```

### Task 3.2: Função pura de atualização incremental (Welford) e z-score

**Files:**
- Create: `src/lib/baseline-veiculo.ts`
- Test: `src/lib/baseline-veiculo.test.ts`

**Interfaces:**
- Produces: `type Baseline = { n: number; media: number; variancia: number }`, `atualizarBaselineWelford(atual: Baseline, novoValor: number): Baseline`, `zScoreBaseline(valor: number, baseline: Baseline, minAmostras: number): number | null`, `classificarTipoViagem(velocidadeMediaKmh: number): "urbano" | "rodoviario"`. Todos exportados, consumidos por `detectarAnomaliaBaseline` (Task 3.3) e pelo wiring do motor (Task 3.4).

- [ ] **Step 1: Escrever os testes que falham**

```ts
import { describe, it, expect } from "vitest";
import { atualizarBaselineWelford, zScoreBaseline, classificarTipoViagem, type Baseline } from "./baseline-veiculo";

describe("atualizarBaselineWelford (media/variancia incremental, sem guardar amostras cruas)", () => {
  it("primeira amostra vira a media, variancia zero", () => {
    const r = atualizarBaselineWelford({ n: 0, media: 0, variancia: 0 }, 50);
    expect(r).toEqual({ n: 1, media: 50, variancia: 0 });
  });

  it("converge pra media real apos varias amostras identicas", () => {
    let b: Baseline = { n: 0, media: 0, variancia: 0 };
    for (const v of [40, 40, 40, 40]) b = atualizarBaselineWelford(b, v);
    expect(b.media).toBeCloseTo(40, 5);
    expect(b.variancia).toBeCloseTo(0, 5);
    expect(b.n).toBe(4);
  });

  it("detecta variancia com valores diferentes", () => {
    let b: Baseline = { n: 0, media: 0, variancia: 0 };
    for (const v of [10, 20, 30, 40, 50]) b = atualizarBaselineWelford(b, v);
    expect(b.media).toBeCloseTo(30, 5);
    expect(b.variancia).toBeGreaterThan(0);
  });
});

describe("zScoreBaseline", () => {
  const baseline: Baseline = { n: 50, media: 40, variancia: 100 }; // desvio = 10
  it("valor igual a media: z = 0", () => {
    expect(zScoreBaseline(40, baseline, 20)).toBeCloseTo(0, 5);
  });
  it("valor 2 desvios acima: z = 2", () => {
    expect(zScoreBaseline(60, baseline, 20)).toBeCloseTo(2, 5);
  });
  it("amostras insuficientes (cold start): retorna null", () => {
    expect(zScoreBaseline(60, { n: 5, media: 40, variancia: 100 }, 20)).toBeNull();
  });
  it("variancia zero: nao divide por zero, retorna 0 se valor igual, diferenca grande se nao", () => {
    expect(zScoreBaseline(40, { n: 50, media: 40, variancia: 0 }, 20)).toBe(0);
  });
});

describe("classificarTipoViagem", () => {
  it("velocidade media alta (>=60): rodoviario", () => {
    expect(classificarTipoViagem(65)).toBe("rodoviario");
    expect(classificarTipoViagem(60)).toBe("rodoviario");
  });
  it("velocidade media abaixo de 60: urbano", () => {
    expect(classificarTipoViagem(59)).toBe("urbano");
    expect(classificarTipoViagem(20)).toBe("urbano");
  });
});
```

- [ ] **Step 2: Rodar e confirmar que falha**

Run: `npx vitest run src/lib/baseline-veiculo.test.ts`
Expected: FAIL, módulo não existe.

- [ ] **Step 3: Implementar**

```ts
// Baseline comportamental incremental por veiculo (Welford, media/variancia
// sem guardar amostras cruas -- nao existe tabela de historico bruto de
// posicoes no banco, so resumos incrementais, mesmo padrao ja usado em
// rota_perfil). Substitui a ideia original de comparar contra o historico
// da MESMA rota/par especifico: dado real mostrou que so 1,2% dos pares
// origem-destino repetem em 2+ dias (corredor_celulas, 11/07/2026),
// insuficiente. Agregando por VEICULO (nao por rota) ha muito mais dado
// disponivel, ja que o veiculo opera todo dia independente do destino.
export type Baseline = {
  n: number;
  media: number;
  variancia: number;
};

export function atualizarBaselineWelford(atual: Baseline, novoValor: number): Baseline {
  const n = atual.n + 1;
  const delta = novoValor - atual.media;
  const media = atual.media + delta / n;
  const delta2 = novoValor - media;
  const m2Anterior = atual.variancia * atual.n;
  const variancia = (m2Anterior + delta * delta2) / n;
  return { n, media, variancia };
}

// null = amostras insuficientes ainda (cold start), quem chama decide o
// fallback (baseline da frota inteira, ver classificarTipoViagem/route.ts).
export function zScoreBaseline(valor: number, baseline: Baseline, minAmostras: number): number | null {
  if (baseline.n < minAmostras) return null;
  const desvio = Math.sqrt(baseline.variancia);
  if (desvio < 1e-6) return valor === baseline.media ? 0 : (valor > baseline.media ? 1 : -1) * Infinity;
  return (valor - baseline.media) / desvio;
}

// Classificacao deliberadamente simples (regra, nao clustering) -- so por
// velocidade media da viagem, sem depender de classificacao de via do OSM
// (descartada como sinal: rua de bairro e normal no Rio, nao e anomalia).
export function classificarTipoViagem(velocidadeMediaKmh: number): "urbano" | "rodoviario" {
  return velocidadeMediaKmh >= 60 ? "rodoviario" : "urbano";
}
```

- [ ] **Step 4: Rodar e confirmar que passa**

Run: `npx vitest run src/lib/baseline-veiculo.test.ts`
Expected: PASS.

- [ ] **Step 5: Validar e commitar**

```bash
npx tsc --noEmit && npx eslint src/lib/baseline-veiculo.ts src/lib/baseline-veiculo.test.ts && npx vitest run
git add src/lib/baseline-veiculo.ts src/lib/baseline-veiculo.test.ts
git commit -m "feat(desvio): funcoes puras de baseline incremental (Welford) e classificacao de viagem"
git push origin main
```

### Task 3.3: Detector puro `detectarAnomaliaBaseline`

**Files:**
- Modify: `src/lib/detectores.ts`
- Test: `src/lib/detectores.test.ts`

**Interfaces:**
- Consumes: `Baseline`, `zScoreBaseline` (Task 3.2, importar de `./baseline-veiculo`).
- Produces: `type CtxAnomaliaBaseline`, `detectarAnomaliaBaseline(ctx: CtxAnomaliaBaseline): Alerta | null`.

- [ ] **Step 1: Escrever os testes que falham**

```ts
import { zScoreBaseline, type Baseline } from "./baseline-veiculo"; // ja deve estar importado onde fizer sentido no arquivo de teste

describe("detectarAnomaliaBaseline (baseline comportamental por veiculo)", () => {
  const baselineProprioEstavel: Baseline = { n: 50, media: 40, variancia: 100 };
  const baselineFrota: Baseline = { n: 500, media: 45, variancia: 121 };

  it("dentro do padrao do proprio veiculo (menos de 3 desvios): nao dispara", () => {
    const a = detectarAnomaliaBaseline({
      velocidadeMediaViagemKmh: 50,
      baselineProprio: baselineProprioEstavel,
      baselineFrota,
      minAmostrasProprio: 20,
    });
    expect(a).toBeNull();
  });

  it("mais de 3 desvios do proprio veiculo: dispara atencao", () => {
    const a = detectarAnomaliaBaseline({
      velocidadeMediaViagemKmh: 80,
      baselineProprio: baselineProprioEstavel,
      baselineFrota,
      minAmostrasProprio: 20,
    });
    expect(a?.nivel).toBe("atencao");
    expect(a?.tipo).toBe("baseline_veiculo");
  });

  it("veiculo em cold start (poucas amostras proprias): usa baseline da frota", () => {
    const a = detectarAnomaliaBaseline({
      velocidadeMediaViagemKmh: 80,
      baselineProprio: { n: 3, media: 40, variancia: 100 },
      baselineFrota,
      minAmostrasProprio: 20,
    });
    // z contra a frota (media 45, desvio 11): (80-45)/11 = 3.18, dispara
    expect(a).not.toBeNull();
  });

  it("sem baseline nenhum ainda confiavel (nem proprio nem frota): nao dispara", () => {
    const a = detectarAnomaliaBaseline({
      velocidadeMediaViagemKmh: 80,
      baselineProprio: { n: 0, media: 0, variancia: 0 },
      baselineFrota: { n: 0, media: 0, variancia: 0 },
      minAmostrasProprio: 20,
    });
    expect(a).toBeNull();
  });
});
```

Adicionar o import de `zScoreBaseline`/`Baseline` no topo de `detectores.ts` (não do arquivo de teste, do próprio módulo) na Step 3.

- [ ] **Step 2: Rodar e confirmar que falha**

Run: `npx vitest run src/lib/detectores.test.ts`
Expected: FAIL.

- [ ] **Step 3: Implementar**

Em `src/lib/detectores.ts`, adicionar o import no topo:

```ts
import { zScoreBaseline, type Baseline } from "./baseline-veiculo";
```

E o detector:

```ts
export type CtxAnomaliaBaseline = {
  velocidadeMediaViagemKmh: number;
  baselineProprio: Baseline;
  baselineFrota: Baseline;
  minAmostrasProprio: number;
};

const BASELINE_MIN_AMOSTRAS_FROTA = 20;
const BASELINE_Z_LIMIAR = 3;

export function detectarAnomaliaBaseline(ctx: CtxAnomaliaBaseline): Alerta | null {
  const usaProprio = ctx.baselineProprio.n >= ctx.minAmostrasProprio;
  const baseline = usaProprio ? ctx.baselineProprio : ctx.baselineFrota;
  const minAmostras = usaProprio ? ctx.minAmostrasProprio : BASELINE_MIN_AMOSTRAS_FROTA;
  const z = zScoreBaseline(ctx.velocidadeMediaViagemKmh, baseline, minAmostras);
  if (z === null || !Number.isFinite(z) || Math.abs(z) < BASELINE_Z_LIMIAR) return null;
  const origem = usaProprio ? "deste veiculo" : "da frota (veiculo ainda sem historico proprio)";
  return {
    nivel: "atencao",
    tipo: "baseline_veiculo",
    motivo: `Velocidade media da viagem (${ctx.velocidadeMediaViagemKmh.toFixed(0)}km/h) foge ${Math.abs(z).toFixed(1)} desvios do padrao ${origem}`,
    score: 35,
  };
}
```

- [ ] **Step 4: Rodar e confirmar que passa**

Run: `npx vitest run src/lib/detectores.test.ts`
Expected: PASS.

- [ ] **Step 5: Validar e commitar**

```bash
npx tsc --noEmit && npx eslint src/lib/detectores.ts src/lib/detectores.test.ts && npx vitest run
git add src/lib/detectores.ts src/lib/detectores.test.ts
git commit -m "feat(desvio): detector puro de anomalia de baseline comportamental por veiculo"
git push origin main
```

### Task 3.4: Wiring no motor (route.ts), atualizar baseline e chamar o detector

**Files:**
- Modify: `src/app/api/motor/route.ts`

**Interfaces:**
- Consumes: `atualizarBaselineWelford`, `classificarTipoViagem` (Task 3.2), `detectarAnomaliaBaseline`, `CtxAnomaliaBaseline` (Task 3.3), tabelas `baseline_veiculo`/`baseline_frota` (Task 3.1).

- [ ] **Step 1: Carregar o baseline de TODOS os veículos e de TODA a frota, uma vez, antes do loop por cliente**

Mesmo lugar e mesmo padrão de `mapaPosAtual` (`src/app/api/motor/route.ts:542-569`, carregado uma vez pra todos os clientes, não filtrado por array de IDs). Adicionar logo depois do bloco de `mapaPosAtual`:

```ts
    const { data: baselineVeiculoRows } = await supabase
      .from("baseline_veiculo")
      .select("veiculo_id, tipo_viagem, feature, n_amostras, media, variancia");
    const mapaBaselineVeiculo = new Map<string, Baseline>();
    for (const r of baselineVeiculoRows ?? []) {
      mapaBaselineVeiculo.set(`${r.veiculo_id}:${r.tipo_viagem}:${r.feature}`, {
        n: Number(r.n_amostras), media: r.media, variancia: r.variancia,
      });
    }

    const { data: baselineFrotaRows } = await supabase
      .from("baseline_frota")
      .select("cliente_id, tipo_viagem, feature, n_amostras, media, variancia");
    const mapaBaselineFrota = new Map<string, Baseline>();
    for (const r of baselineFrotaRows ?? []) {
      mapaBaselineFrota.set(`${r.cliente_id}:${r.tipo_viagem}:${r.feature}`, {
        n: Number(r.n_amostras), media: r.media, variancia: r.variancia,
      });
    }

    // Acumula amostras deste ciclo (veiculo + cliente) pra atualizar os
    // dois baselines em lote no fim, fora do loop de deteccao (mesmo
    // principio ja usado pra geocodesPendentes: nao bloquear o caminho
    // critico com round-trips extras por veiculo).
    const amostrasBaselineCiclo: { veiculo_id: string; cliente_id: string; tipoViagem: "urbano" | "rodoviario"; velocidade: number }[] = [];
```

Importar `Baseline` de `@/lib/baseline-veiculo` no topo do arquivo junto dos outros imports de libs.

- [ ] **Step 2: Por veículo, classificar a viagem, chamar o detector, e acumular a amostra**

Dentro do loop por veículo, perto de onde `riscoAreaAtual` já é calculado:

```ts
          const tipoViagem = classificarTipoViagem(pos.velocidade);
          const baselineProprio = mapaBaselineVeiculo.get(`${veiculo_id}:${tipoViagem}:velocidade_media_kmh`)
            ?? { n: 0, media: 0, variancia: 0 };
          const baselineFrotaAtual = mapaBaselineFrota.get(`${cliente_id}:${tipoViagem}:velocidade_media_kmh`)
            ?? { n: 0, media: 0, variancia: 0 };
          const alertaBaseline = pos.fresco && pos.velocidade > 0
            ? detectarAnomaliaBaseline({
                velocidadeMediaViagemKmh: pos.velocidade,
                baselineProprio,
                baselineFrota: baselineFrotaAtual,
                minAmostrasProprio: 20,
              })
            : null;
          if (pos.fresco && pos.velocidade > 0) {
            amostrasBaselineCiclo.push({ veiculo_id, cliente_id, tipoViagem, velocidade: pos.velocidade });
          }
```

Nota: usar `pos.velocidade` (velocidade instantânea do ciclo) como proxy de "velocidade média da viagem" é uma simplificação de primeira versão (não temos boundaries de viagem definidos ainda, cada ciclo de 30s vira uma "amostra"). Documentar isso no commit. Refinar exigiria detectar início/fim de viagem, fora do escopo desta fase.

- [ ] **Step 3: Adicionar ao array `extras`**

```ts
            alertaCerca,
            alertaBypass,
            alertaBaseline,
          ].filter((a): a is Alerta => a !== null);
```

- [ ] **Step 4: Atualizar os dois baselines em lote, depois do loop principal (não bloqueia a detecção)**

Perto de onde `geocodesPendentes` é processado depois do upsert de posições (mesma área, fora do caminho crítico):

```ts
    // Atualiza baseline_veiculo e baseline_frota incrementalmente (Welford)
    // com as amostras deste ciclo. Roda depois do loop de deteccao, mesmo
    // principio do processamento de geocodesPendentes: nao e critico pra
    // este ciclo, so alimenta a calibracao dos proximos.
    if (amostrasBaselineCiclo.length > 0) {
      const porVeiculo = new Map<string, Baseline>();
      const porFrota = new Map<string, Baseline>();
      for (const a of amostrasBaselineCiclo) {
        const chaveVeiculo = `${a.veiculo_id}:${a.tipoViagem}`;
        const atualVeiculo = porVeiculo.get(chaveVeiculo)
          ?? mapaBaselineVeiculo.get(`${chaveVeiculo}:velocidade_media_kmh`)
          ?? { n: 0, media: 0, variancia: 0 };
        porVeiculo.set(chaveVeiculo, atualizarBaselineWelford(atualVeiculo, a.velocidade));

        const chaveFrota = `${a.cliente_id}:${a.tipoViagem}`;
        const atualFrota = porFrota.get(chaveFrota)
          ?? mapaBaselineFrota.get(`${chaveFrota}:velocidade_media_kmh`)
          ?? { n: 0, media: 0, variancia: 0 };
        porFrota.set(chaveFrota, atualizarBaselineWelford(atualFrota, a.velocidade));
      }

      await Promise.allSettled(
        [...porVeiculo].map(([chave, b]) => {
          const [veiculo_id, tipoViagem] = chave.split(":");
          return pool.query(
            `insert into baseline_veiculo (veiculo_id, tipo_viagem, feature, n_amostras, media, variancia, atualizado_em)
             values ($1, $2, 'velocidade_media_kmh', $3, $4, $5, now())
             on conflict (veiculo_id, tipo_viagem, feature)
             do update set n_amostras = $3, media = $4, variancia = $5, atualizado_em = now()`,
            [veiculo_id, tipoViagem, b.n, b.media, b.variancia]
          );
        })
      );

      await Promise.allSettled(
        [...porFrota].map(([chave, b]) => {
          const [cliente_id, tipoViagem] = chave.split(":");
          return pool.query(
            `insert into baseline_frota (cliente_id, tipo_viagem, feature, n_amostras, media, variancia, atualizado_em)
             values ($1, $2, 'velocidade_media_kmh', $3, $4, $5, now())
             on conflict (cliente_id, tipo_viagem, feature)
             do update set n_amostras = $3, media = $4, variancia = $5, atualizado_em = now()`,
            [cliente_id, tipoViagem, b.n, b.media, b.variancia]
          );
        })
      );
    }
```

Nota: `Promise.allSettled` (não `Promise.all`) porque uma falha isolada de upsert de baseline não deve derrubar o ciclo inteiro (mesmo princípio de tolerância a falha usado em outros pontos não críticos do motor).

- [ ] **Step 5: Validar**

Run: `npx tsc --noEmit && npx eslint src/app/api/motor/route.ts && npm run build`

- [ ] **Step 6: Rodar suite completa e commitar**

```bash
npx vitest run
git add src/app/api/motor/route.ts
git commit -m "feat(desvio): liga baseline comportamental por veiculo e frota no motor (atualiza e detecta)"
git push origin main
```

### Task 3.5: Validar em produção (crescimento do baseline)

- [ ] Depois de alguns dias no ar, checar `select veiculo_id, tipo_viagem, n_amostras from baseline_veiculo order by n_amostras desc limit 20;` pra confirmar que os veículos mais ativos já passaram do `minAmostrasProprio` (20) e estão usando baseline próprio, não mais o da frota.

---

## Fase 4: Harness de calibração/backtesting retroativo

**Restrição confirmada:** não existe tabela de histórico bruto de posições no banco (só `posicoes_atuais` como snapshot atual). Não é possível fazer "replay de trajetória completa" de dias passados. O harness desta fase é retroativo sobre os ALERTAS já existentes (que têm motivo, contexto, score, e o rótulo final do operador), e também prepara uma gravação leve daqui pra frente pra permitir mais precisão nas próximas calibrações.

### Task 4.1: Script de análise retroativa (precision por segmento, usando rótulos já existentes)

**Files:**
- Create: `scripts/backtest-desvio.mjs`

- [ ] **Step 1: Escrever o script**

```js
// Analise retroativa de precisao dos alertas de desvio, usando os rotulos
// que os operadores JA geraram (status='falso_positivo' vs
// status in ('resolvido','reconhecido','ativo') como proxy de "achou real
// o suficiente pra nao descartar na hora"). Nao existe historico bruto de
// posicoes no banco pra replay de trajetoria completa (restricao
// confirmada 11/07/2026) -- isso mede precisao sobre o que JA disparou, nao
// pega falso negativo (desvio real que nunca chegou a disparar).
import pg from "pg";

const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL });

const { rows } = await pool.query(`
  select
    v.placa,
    a.tipo,
    a.score,
    a.status,
    a.contexto -> 'corredor' ->> 'veredito' as corredor_veredito,
    extract(hour from a.created_at at time zone 'America/Sao_Paulo') as hora_sp
  from alertas a
  join veiculos v on v.id = a.veiculo_id
  where a.tipo in ('desvio', 'bypass_entrega', 'baseline_veiculo')
    and a.status != 'ativo'
  order by a.created_at asc
`);

function segmentar(rows, chave) {
  const grupos = new Map();
  for (const r of rows) {
    const k = chave(r);
    const g = grupos.get(k) ?? { total: 0, falsoPositivo: 0 };
    g.total++;
    if (r.status === "falso_positivo") g.falsoPositivo++;
    grupos.set(k, g);
  }
  return grupos;
}

console.log("=== Por tipo ===");
for (const [k, g] of segmentar(rows, (r) => r.tipo)) {
  const precisao = g.total > 0 ? (100 * (g.total - g.falsoPositivo) / g.total).toFixed(1) : "n/a";
  console.log(`${k}: ${g.total} alertas, ${g.falsoPositivo} falso positivo, precisao ${precisao}% ${g.total < 20 ? "(AMOSTRA INSUFICIENTE, minimo 20)" : ""}`);
}

console.log("\n=== Por veredito do corredor (so tipo=desvio) ===");
for (const [k, g] of segmentar(rows.filter((r) => r.tipo === "desvio"), (r) => r.corredor_veredito ?? "sem_contexto")) {
  const precisao = g.total > 0 ? (100 * (g.total - g.falsoPositivo) / g.total).toFixed(1) : "n/a";
  console.log(`${k}: ${g.total} alertas, precisao ${precisao}% ${g.total < 20 ? "(AMOSTRA INSUFICIENTE)" : ""}`);
}

console.log("\n=== Por faixa horaria ===");
for (const [k, g] of segmentar(rows, (r) => `${Math.floor(r.hora_sp / 6) * 6}h-${Math.floor(r.hora_sp / 6) * 6 + 6}h`)) {
  const precisao = g.total > 0 ? (100 * (g.total - g.falsoPositivo) / g.total).toFixed(1) : "n/a";
  console.log(`${k}: ${g.total} alertas, precisao ${precisao}% ${g.total < 20 ? "(AMOSTRA INSUFICIENTE)" : ""}`);
}

await pool.end();
```

- [ ] **Step 2: Rodar contra o banco real**

Run: `node --env-file=.env.local scripts/backtest-desvio.mjs`
Expected: tabela de precisão por tipo/veredito/faixa horária, sem erro. Segmentos com menos de 20 alertas marcados como amostra insuficiente (mesma regra da Fase 5).

- [ ] **Step 3: Commit**

```bash
git add scripts/backtest-desvio.mjs
git commit -m "feat(desvio): script de analise retroativa de precisao por segmento (rotulos reais)"
git push origin main
```

### Task 4.2: Migration 019 (tabela de thresholds calibrados por segmento)

**Files:**
- Create: `scripts/migrations/019_calibracao_desvio.sql`

- [ ] **Step 1: Escrever a migration**

```sql
-- 019: thresholds/pesos calibrados por segmento de contexto, calculados a
-- partir dos rotulos reais dos operadores (Fase 5). Substitui o ajuste no
-- chute que causou o problema de 11/07.
create table if not exists calibracao_desvio (
  segmento text primary key, -- ex: 'tipo:desvio', 'corredor_veredito:fora', 'hora:12h-18h'
  n_amostras int not null default 0,
  n_falso_positivo int not null default 0,
  taxa_falso_positivo double precision not null default 0,
  score_ajustado double precision, -- null = usa o score default do detector (amostra insuficiente)
  atualizado_em timestamptz not null default now()
);
```

- [ ] **Step 2: Aplicar**

Run: `node --env-file=.env.local scripts/aplicar-migration.mjs 019_calibracao_desvio.sql`

- [ ] **Step 3: Commit**

```bash
git add scripts/migrations/019_calibracao_desvio.sql
git commit -m "feat(desvio): migration 019, tabela de calibracao por segmento"
git push origin main
```

---

## Fase 5: Calibração automática via rótulos reais

### Task 5.1: Função pura de shrinkage bayesiano (Beta-Binomial simples)

**Files:**
- Create: `src/lib/calibracao-desvio.ts`
- Test: `src/lib/calibracao-desvio.test.ts`

**Interfaces:**
- Produces: `taxaFalsoPositivoCalibrada(nAmostras: number, nFalsoPositivo: number, taxaGlobal: number, minAmostras: number): number`, exportada, usada pelo script de recalibração (Task 5.2).

- [ ] **Step 1: Escrever os testes que falham**

```ts
import { describe, it, expect } from "vitest";
import { taxaFalsoPositivoCalibrada } from "./calibracao-desvio";

describe("taxaFalsoPositivoCalibrada (shrinkage bayesiano simples, Beta-Binomial)", () => {
  it("com poucas amostras (abaixo do minimo), fica igual a taxa global (shrinkage total)", () => {
    const r = taxaFalsoPositivoCalibrada(2, 1, 0.3, 20);
    expect(r).toBeCloseTo(0.3, 1);
  });

  it("com muitas amostras, converge pra taxa observada do proprio segmento", () => {
    const r = taxaFalsoPositivoCalibrada(1000, 100, 0.3, 20); // 10% observado
    expect(r).toBeCloseTo(0.1, 1);
  });

  it("com amostras no meio do caminho, fica entre a taxa global e a observada", () => {
    const r = taxaFalsoPositivoCalibrada(20, 2, 0.3, 20); // observado 10%, global 30%
    expect(r).toBeGreaterThan(0.1);
    expect(r).toBeLessThan(0.3);
  });

  it("zero amostras: retorna exatamente a taxa global", () => {
    expect(taxaFalsoPositivoCalibrada(0, 0, 0.3, 20)).toBe(0.3);
  });
});
```

- [ ] **Step 2: Rodar e confirmar que falha**

Run: `npx vitest run src/lib/calibracao-desvio.test.ts`

- [ ] **Step 3: Implementar**

```ts
// Shrinkage bayesiano simples (Beta-Binomial com prior = taxa global) pra
// calibrar a taxa de falso positivo por segmento sem overfitting quando ha
// poucos dados. O prior tem peso equivalente a `minAmostras` observacoes
// fantasmas com a taxa global -- segmento com poucos rotulos fica quase
// identico ao global; com muitos rotulos, converge pro observado.
export function taxaFalsoPositivoCalibrada(
  nAmostras: number,
  nFalsoPositivo: number,
  taxaGlobal: number,
  minAmostras: number
): number {
  const alphaPrior = taxaGlobal * minAmostras;
  const betaPrior = (1 - taxaGlobal) * minAmostras;
  return (alphaPrior + nFalsoPositivo) / (alphaPrior + betaPrior + nAmostras);
}
```

- [ ] **Step 4: Rodar e confirmar que passa**

Run: `npx vitest run src/lib/calibracao-desvio.test.ts`

- [ ] **Step 5: Validar e commitar**

```bash
npx tsc --noEmit && npx eslint src/lib/calibracao-desvio.ts src/lib/calibracao-desvio.test.ts && npx vitest run
git add src/lib/calibracao-desvio.ts src/lib/calibracao-desvio.test.ts
git commit -m "feat(desvio): shrinkage bayesiano simples pra calibracao de taxa de falso positivo"
git push origin main
```

### Task 5.2: Script de recalibração (lê alertas rotulados, escreve em `calibracao_desvio`)

**Files:**
- Create: `scripts/recalibrar-desvio.mjs`

**Interfaces:**
- Consumes: `taxaFalsoPositivoCalibrada` (Task 5.1), tabela `calibracao_desvio` (Task 4.2).

- [ ] **Step 1: Escrever o script**

```js
// Recalcula calibracao_desvio a partir dos alertas ja rotulados pelos
// operadores. Rodar manualmente por enquanto (nao automatizado neste
// ciclo); candidato a virar cron semanal depois de validar as primeiras
// rodadas.
import pg from "pg";

const MIN_AMOSTRAS = 20;
const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL });

function taxaFalsoPositivoCalibrada(nAmostras, nFalsoPositivo, taxaGlobal, minAmostras) {
  const alphaPrior = taxaGlobal * minAmostras;
  const betaPrior = (1 - taxaGlobal) * minAmostras;
  return (alphaPrior + nFalsoPositivo) / (alphaPrior + betaPrior + nAmostras);
}

const { rows } = await pool.query(`
  select tipo, status, contexto -> 'corredor' ->> 'veredito' as corredor_veredito
  from alertas
  where tipo in ('desvio', 'bypass_entrega', 'baseline_veiculo') and status != 'ativo'
`);

const totalFalsoPositivo = rows.filter((r) => r.status === "falso_positivo").length;
const taxaGlobal = rows.length > 0 ? totalFalsoPositivo / rows.length : 0.3; // default conservador se nao houver dado nenhum ainda

function segmentar(chave) {
  const grupos = new Map();
  for (const r of rows) {
    const k = chave(r);
    if (k == null) continue;
    const g = grupos.get(k) ?? { total: 0, falsoPositivo: 0 };
    g.total++;
    if (r.status === "falso_positivo") g.falsoPositivo++;
    grupos.set(k, g);
  }
  return grupos;
}

const segmentos = new Map([
  ...[...segmentar((r) => `tipo:${r.tipo}`)].map(([k, v]) => [k, v]),
  ...[...segmentar((r) => (r.corredor_veredito ? `corredor_veredito:${r.corredor_veredito}` : null))].map(([k, v]) => [k, v]),
]);

for (const [segmento, g] of segmentos) {
  const taxa = taxaFalsoPositivoCalibrada(g.total, g.falsoPositivo, taxaGlobal, MIN_AMOSTRAS);
  await pool.query(
    `insert into calibracao_desvio (segmento, n_amostras, n_falso_positivo, taxa_falso_positivo, atualizado_em)
     values ($1, $2, $3, $4, now())
     on conflict (segmento) do update set n_amostras = $2, n_falso_positivo = $3, taxa_falso_positivo = $4, atualizado_em = now()`,
    [segmento, g.total, g.falsoPositivo, taxa]
  );
  console.log(`${segmento}: ${g.total} amostras, taxa calibrada ${(taxa * 100).toFixed(1)}%`);
}

await pool.end();
```

- [ ] **Step 2: Rodar contra o banco real**

Run: `node --env-file=.env.local scripts/recalibrar-desvio.mjs`
Expected: lista de segmentos com taxa calibrada, sem erro. Confirmar com `select * from calibracao_desvio order by n_amostras desc;`.

- [ ] **Step 3: Commit**

```bash
git add scripts/recalibrar-desvio.mjs
git commit -m "feat(desvio): script de recalibracao a partir dos rotulos reais dos operadores"
git push origin main
```

**Nota importante:** este script roda manualmente por enquanto e só ESCREVE a tabela `calibracao_desvio`; nenhuma task deste plano ainda faz o motor LER essa tabela pra ajustar score/threshold em tempo real (isso exigiria decidir, com dado real acumulado, exatamente quais parâmetros ficam sob calibração automática, o que é prematuro com o volume de rótulos que existe hoje). Ligar a leitura em `route.ts` fica registrado como próximo passo natural, depois de rodar esse script por algumas semanas e olhar os números.

---

## Fase 6: Histórico por par origem-destino liga sozinho

### Task 6.1: Função pura que decide se um par já tem repetição suficiente

**Files:**
- Modify: `src/lib/corredor-verificacao.ts`
- Test: `src/lib/corredor-verificacao.test.ts`

**Interfaces:**
- Produces: `parOrigemDestinoTemHistoricoSuficiente(diasDistintos: number, minDias: number): boolean`.

- [ ] **Step 1: Escrever o teste que falha**

```ts
describe("parOrigemDestinoTemHistoricoSuficiente", () => {
  it("menos de 3 dias distintos: false", () => {
    expect(parOrigemDestinoTemHistoricoSuficiente(2, 3)).toBe(false);
  });
  it("3 ou mais dias distintos: true", () => {
    expect(parOrigemDestinoTemHistoricoSuficiente(3, 3)).toBe(true);
    expect(parOrigemDestinoTemHistoricoSuficiente(10, 3)).toBe(true);
  });
});
```

- [ ] **Step 2: Rodar e confirmar que falha**

Run: `npx vitest run src/lib/corredor-verificacao.test.ts`

- [ ] **Step 3: Implementar**

```ts
// Achado empirico 11/07/2026: so 1,2% dos pares origem-destino repetem em
// 2+ dias (corredor_celulas, 6 dias de dado real da Nutry). O historico por
// par so deve ser confiavel a partir de 3+ dias distintos vistos -- liga
// sozinho por par conforme o dado acumular, sem decisao manual.
export function parOrigemDestinoTemHistoricoSuficiente(diasDistintos: number, minDias: number): boolean {
  return diasDistintos >= minDias;
}
```

- [ ] **Step 4: Rodar e confirmar que passa**

Run: `npx vitest run src/lib/corredor-verificacao.test.ts`

- [ ] **Step 5: Validar e commitar**

```bash
npx tsc --noEmit && npx eslint src/lib/corredor-verificacao.ts src/lib/corredor-verificacao.test.ts && npx vitest run
git add src/lib/corredor-verificacao.ts src/lib/corredor-verificacao.test.ts
git commit -m "feat(desvio): funcao pura pra decidir quando um par origem-destino tem historico suficiente"
git push origin main
```

### Task 6.2: Query de checagem (usada manualmente por enquanto, sem wiring automático no motor)

**Files:**
- Create: `scripts/checar-pares-com-historico.mjs`

- [ ] **Step 1: Escrever o script**

```js
// Lista os pares origem-destino que ja acumularam 3+ dias distintos em
// corredor_celulas -- candidatos a religar historico proprio (Fase adiada
// no design, so quando o dado sustentar). Rodar periodicamente pra
// acompanhar o crescimento, sem acao automatica ainda.
import pg from "pg";

const MIN_DIAS = 3;
const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL });

const { rows } = await pool.query(`
  select cliente_id, origem_celula, destino_celula, count(distinct ultimo_visto) as dias_distintos
  from corredor_celulas
  where origem_celula is not null and destino_celula is not null
  group by cliente_id, origem_celula, destino_celula
  having count(distinct ultimo_visto) >= $1
  order by dias_distintos desc
`, [MIN_DIAS]);

console.log(`${rows.length} pares com ${MIN_DIAS}+ dias distintos de historico:`);
console.log(JSON.stringify(rows, null, 1));

await pool.end();
```

- [ ] **Step 2: Rodar contra o banco real**

Run: `node --env-file=.env.local scripts/checar-pares-com-historico.mjs`
Expected: lista (provavelmente vazia ou pequena por enquanto, dado o achado de 1,2%), sem erro.

- [ ] **Step 3: Commit**

```bash
git add scripts/checar-pares-com-historico.mjs
git commit -m "feat(desvio): script pra acompanhar pares origem-destino acumulando historico"
git push origin main
```

**Nota:** ligar isso de fato no motor (usar o par com histórico suficiente como sinal adicional em vez do corredor OSRM) fica registrado como próximo passo, condicionado ao script acima mostrar volume real de pares qualificados. Forçar isso agora, com 1,2% de repetição, seria construir em cima de dado que não existe ainda.

---

## Validação final (depois de todas as fases)

- [ ] `npx vitest run` (suite completa), `npx tsc --noEmit`, `npx eslint .` (ciente de que já existem avisos pré-existentes em componentes de frontend não relacionados, não bloqueiam), `npm run build`.
- [ ] Rodar `scripts/backtest-desvio.mjs` novamente depois de 1-2 semanas no ar, comparando a precisão por segmento antes/depois das fases 1-3.
- [ ] Atualizar `ESTADO.md` com o resumo das 6 fases, seguindo o padrão de documentação já usado no projeto.
