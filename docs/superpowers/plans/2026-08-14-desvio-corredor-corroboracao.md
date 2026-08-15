# Corredor de rota real como corroboração do desvio — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Trazer de volta a checagem de corredor real (OSRM self-hosted) como sinal de **corroboração** do desvio — soma score quando confirma que o veículo está fora de qualquer rota legítima, nunca suprime um alerta que já ia disparar.

**Architecture:** Novo módulo puro `src/lib/corredor-confirmacao.ts` (porta `bufferPorVelocidade`/`dentroDoCorredor` do antigo `corredor-verificacao.ts`, deletado no commit `6643bee`/`f695308..492f140`, mais a função nova `verificarCorredorFora`, sem throttle/fallback público/rotação de orçamento — roda 1x por disparo, não continuamente pra frota inteira). Wiring em `src/app/api/motor/route.ts`, logo após o bloco de calibração ao vivo já existente, reaproveitando `BONUS_CORROBORACAO_POR_SINAL` de `src/lib/detectores.ts`. Nova coluna `corredor_confirmou` em `desvio_disparo_log`.

**Tech Stack:** TypeScript, Next.js (App Router, ver `AGENTS.md` — APIs podem diferir do treinamento), Vitest, Postgres self-hosted no Contabo, OSRM self-hosted (`OSRM_LOCAL_URL`), PM2.

## Global Constraints

- Spec de referência: `docs/superpowers/specs/2026-08-14-desvio-corredor-corroboracao-design.md` — qualquer dúvida de comportamento, essa é a fonte da verdade.
- **Corroboração, nunca supressão**: nenhuma mudança pode fazer um alerta de desvio deixar de disparar. Toda falha (OSRM indisponível, sem âncora, timeout) cai em fail-open silencioso — sem ajuste de score, sem exceção propagada.
- O trabalho de código é feito e testado no repo TEMP (`/Users/joaquimsalles/Projects/Transmonseg/monitoramento/MONITORAMENTO TEMP`) primeiro; o repo definitivo (`/Users/joaquimsalles/Projects/Transmonseg/monitoramento/MONITORAMENTO transmonseg`) é mantido **byte-idêntico** — a Task final espelha os arquivos e faz o deploy dos dois.
- Deploy real: SSH `transmonseg-vps`, `/srv/transmonseg/temp` (PM2 `transmonseg-temp`, porta 3000, roda o motor de produção via pg_cron a cada ~30s) e `/srv/transmonseg/definitivo` (PM2 `transmonseg-definitivo`, porta 3010, serve a UI real via Caddy). `git pull && npm run build && pm2 restart <nome>` em cada um — sem CI/CD automático.
- `tsc --noEmit`, `eslint`, e a suíte `vitest` completa precisam passar limpos antes de cada commit.

---

### Task 1: Migration — coluna `corredor_confirmou` em `desvio_disparo_log`

**Files:**
- Create: `scripts/migrations/047_desvio_disparo_log_corredor_confirmou.sql`
- Create: `scripts/migrations/contabo/049_desvio_disparo_log_corredor_confirmou.sql`

**Interfaces:**
- Produces: coluna `desvio_disparo_log.corredor_confirmou boolean NOT NULL DEFAULT false`, consumida pelo INSERT que a Task 3 estende.

- [ ] **Step 1: Escrever a migration local**

Arquivo `scripts/migrations/047_desvio_disparo_log_corredor_confirmou.sql`:

```sql
-- 047_desvio_disparo_log_corredor_confirmou.sql
--
-- Ver docs/superpowers/specs/2026-08-14-desvio-corredor-corroboracao-design.md.
-- Registra se um disparo especifico foi corroborado pelo corredor real
-- (OSRM self-hosted confirmou que o veiculo esta fora de qualquer rota
-- legitima ate os destinos pendentes) -- permite medir depois quantos
-- disparos reais o corredor de fato corrobora, sem precisar reconstruir
-- do texto de `motivo`.
ALTER TABLE desvio_disparo_log ADD COLUMN IF NOT EXISTS corredor_confirmou boolean NOT NULL DEFAULT false;
NOTIFY pgrst, 'reload schema';
```

- [ ] **Step 2: Copiar pra versão Contabo (mesmo conteúdo, numeração própria)**

Arquivo `scripts/migrations/contabo/049_desvio_disparo_log_corredor_confirmou.sql` — mesmo conteúdo do Step 1, trocando só o cabeçalho do nome do arquivo no comentário:

```sql
-- 049_desvio_disparo_log_corredor_confirmou.sql
--
-- Ver docs/superpowers/specs/2026-08-14-desvio-corredor-corroboracao-design.md.
-- Registra se um disparo especifico foi corroborado pelo corredor real
-- (OSRM self-hosted confirmou que o veiculo esta fora de qualquer rota
-- legitima ate os destinos pendentes) -- permite medir depois quantos
-- disparos reais o corredor de fato corrobora, sem precisar reconstruir
-- do texto de `motivo`.
ALTER TABLE desvio_disparo_log ADD COLUMN IF NOT EXISTS corredor_confirmou boolean NOT NULL DEFAULT false;
NOTIFY pgrst, 'reload schema';
```

- [ ] **Step 3: Aplicar a migration local (banco `.env.local`)**

Run: `node --env-file=.env.local scripts/aplicar-migration.mjs 047_desvio_disparo_log_corredor_confirmou.sql`
Expected: sem erro, coluna criada.

- [ ] **Step 4: Confirmar a coluna existe**

Run:
```bash
node --env-file=.env.local -e "
import('pg').then(async ({default: pg}) => {
  const c = new pg.Client({connectionString: process.env.DATABASE_URL, ssl: {rejectUnauthorized: false}});
  await c.connect();
  const r = await c.query(\"select column_name, data_type, column_default from information_schema.columns where table_name='desvio_disparo_log' and column_name='corredor_confirmou'\");
  console.log(r.rows);
  await c.end();
});
"
```
Expected: 1 linha, `data_type: boolean`, `column_default: false`.

- [ ] **Step 5: Commit**

```bash
git add scripts/migrations/047_desvio_disparo_log_corredor_confirmou.sql scripts/migrations/contabo/049_desvio_disparo_log_corredor_confirmou.sql
git commit -m "migration: adiciona corredor_confirmou em desvio_disparo_log"
```

(A aplicação no Contabo — banco de produção — acontece na Task 5, junto com o deploy.)

---

### Task 2: Módulo puro `src/lib/corredor-confirmacao.ts`

**Files:**
- Create: `src/lib/corredor-confirmacao.ts`
- Test: `src/lib/corredor-confirmacao.test.ts`

**Interfaces:**
- Consumes: `distanciaAoSegmentoM` de `src/lib/unitrac.ts` (assinatura: `(ponto: {lat,lng}, origem: {lat,lng}, destino: {lat,lng}) => number`).
- Produces:
  - `bufferPorVelocidade(velKmH: number): number`
  - `dentroDoCorredor(pos: {lat,lng}, polilinha: {lat,lng}[], bufferM: number): boolean`
  - `verificarCorredorFora(origem: {lat,lng}, posAtual: {lat,lng,velocidade}, destinos: {lat,lng}[]): Promise<{confirmaFora: boolean}>` — consumida pela Task 3.

- [ ] **Step 1: Escrever os testes de `bufferPorVelocidade` e `dentroDoCorredor` (falhando)**

Arquivo `src/lib/corredor-confirmacao.test.ts`:

```typescript
import { describe, it, expect, vi, afterEach } from "vitest";
import { bufferPorVelocidade, dentroDoCorredor, verificarCorredorFora } from "./corredor-confirmacao";

describe("bufferPorVelocidade (adaptativo: cidade estreito, rodovia largo)", () => {
  it("abaixo de 60 km/h: 120m (urbano)", () => {
    expect(bufferPorVelocidade(40)).toBe(120);
    expect(bufferPorVelocidade(0)).toBe(120);
  });
  it("60 km/h ou mais: 200m (rodovia/serra)", () => {
    expect(bufferPorVelocidade(60)).toBe(200);
    expect(bufferPorVelocidade(90)).toBe(200);
  });
});

describe("dentroDoCorredor", () => {
  const polilinha = [
    { lat: -22.90, lng: -43.20 },
    { lat: -22.895, lng: -43.20 },
    { lat: -22.89, lng: -43.20 },
  ];
  it("ponto a ~100m da linha, buffer 300m: dentro", () => {
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
```

- [ ] **Step 2: Rodar e confirmar que falha (módulo não existe ainda)**

Run: `npx vitest run src/lib/corredor-confirmacao.test.ts`
Expected: FAIL com "Cannot find module './corredor-confirmacao'".

- [ ] **Step 3: Implementar `bufferPorVelocidade` e `dentroDoCorredor` (porta do antigo `corredor-verificacao.ts`)**

Arquivo `src/lib/corredor-confirmacao.ts`:

```typescript
// Confirmacao de corredor real (OSRM self-hosted) como sinal de
// CORROBORACAO do desvio -- nunca supressao. Ver
// docs/superpowers/specs/2026-08-14-desvio-corredor-corroboracao-design.md.
// So roda 1x, no ciclo exato em que afastando_geral ja decidiu disparar
// (quem chama decide isso) -- nao compete por orcamento continuo com o
// resto da frota, por isso sem throttle/fallback publico/rotacao de
// orcamento que o corredor antigo (corredor-verificacao.ts, removido no
// commit 6643bee/f695308..492f140) precisava.
import { distanciaAoSegmentoM } from "./unitrac";

type Ponto = { lat: number; lng: number };

// Buffer adaptativo por contexto de via (sem mapa de vias): velocidade
// alta ~ rodovia, onde a estrada real serpenteia mais longe da polilinha
// ideal -- buffer maior. Valores herdados do corredor antigo (11/07,
// reduzidos de 300/600 por diretiva explicita: falso positivo aceitavel,
// nunca perder desvio real).
export function bufferPorVelocidade(velKmH: number): number {
  return velKmH >= 60 ? 200 : 120;
}

// Distancia minima do ponto a qualquer segmento da polilinha <= buffer?
export function dentroDoCorredor(pos: Ponto, polilinha: Ponto[], bufferM: number): boolean {
  if (polilinha.length < 2) return false;
  for (let i = 0; i < polilinha.length - 1; i++) {
    if (distanciaAoSegmentoM(pos, polilinha[i], polilinha[i + 1]) <= bufferM) return true;
  }
  return false;
}
```

- [ ] **Step 4: Rodar e confirmar que os testes de `bufferPorVelocidade`/`dentroDoCorredor` passam**

Run: `npx vitest run src/lib/corredor-confirmacao.test.ts`
Expected: os 6 testes já escritos passam; `verificarCorredorFora` ainda não existe (próximo passo é importar e testar ela).

- [ ] **Step 5: Escrever os testes de `verificarCorredorFora` (falhando)**

Adicionar ao final de `src/lib/corredor-confirmacao.test.ts`:

```typescript
function mockFetchSequence(respostas: (unknown | null)[]) {
  const fn = vi.fn();
  for (const r of respostas) {
    if (r === null) fn.mockRejectedValueOnce(new Error("network"));
    else fn.mockResolvedValueOnce({ ok: true, json: async () => r });
  }
  vi.stubGlobal("fetch", fn);
  return fn;
}

const ORIGEM = { lat: -22.90, lng: -43.20 };
const POS_ATUAL = { lat: -22.895, lng: -43.199, velocidade: 40 };
const DEST_A = { lat: -22.89, lng: -43.20 };
const DEST_B = { lat: -22.80, lng: -43.10 };

function respostaRotaOk(coords: [number, number][]) {
  return { code: "Ok", routes: [{ geometry: { coordinates: coords } }] };
}

describe("verificarCorredorFora", () => {
  afterEach(() => vi.unstubAllGlobals());

  it("sem destinos: confirmaFora=false (nada pra verificar)", async () => {
    const fetchSpy = vi.fn();
    vi.stubGlobal("fetch", fetchSpy);
    const r = await verificarCorredorFora(ORIGEM, POS_ATUAL, []);
    expect(r).toEqual({ confirmaFora: false });
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("posicao atual dentro do buffer da rota pro destino A: confirmaFora=false (dentro de rota legitima)", async () => {
    mockFetchSequence([
      respostaRotaOk([[-43.20, -22.90], [-43.20, -22.895], [-43.20, -22.89]]),
    ]);
    const r = await verificarCorredorFora(ORIGEM, POS_ATUAL, [DEST_A]);
    expect(r).toEqual({ confirmaFora: false });
  });

  it("posicao atual fora do buffer de TODOS os destinos testados com sucesso: confirmaFora=true", async () => {
    mockFetchSequence([
      respostaRotaOk([[-43.10, -22.80], [-43.10, -22.85]]),
      respostaRotaOk([[-43.10, -22.80], [-43.10, -22.82]]),
    ]);
    const r = await verificarCorredorFora(ORIGEM, POS_ATUAL, [DEST_B, DEST_B]);
    expect(r).toEqual({ confirmaFora: true });
  });

  it("OSRM indisponivel pra todos os destinos: confirmaFora=false (fail-open, sem bonus)", async () => {
    mockFetchSequence([null, null]);
    const r = await verificarCorredorFora(ORIGEM, POS_ATUAL, [DEST_A, DEST_B]);
    expect(r).toEqual({ confirmaFora: false });
  });

  it("1o destino falha (rede), 2o confirma fora: confirmaFora=true (pontual nao aborta o resto)", async () => {
    mockFetchSequence([
      null,
      respostaRotaOk([[-43.10, -22.80], [-43.10, -22.82]]),
    ]);
    const r = await verificarCorredorFora(ORIGEM, POS_ATUAL, [DEST_B, DEST_B]);
    expect(r).toEqual({ confirmaFora: true });
  });

  it("resposta HTTP nao-ok pro unico destino: confirmaFora=false", async () => {
    const fn = vi.fn().mockResolvedValueOnce({ ok: false, json: async () => ({}) });
    vi.stubGlobal("fetch", fn);
    const r = await verificarCorredorFora(ORIGEM, POS_ATUAL, [DEST_A]);
    expect(r).toEqual({ confirmaFora: false });
  });

  it("code != Ok: trata como rota nao resolvida (segue pro proximo, sem contar sucesso)", async () => {
    const fn = vi.fn().mockResolvedValueOnce({ ok: true, json: async () => ({ code: "NoRoute" }) });
    vi.stubGlobal("fetch", fn);
    const r = await verificarCorredorFora(ORIGEM, POS_ATUAL, [DEST_A]);
    expect(r).toEqual({ confirmaFora: false });
  });
});
```

- [ ] **Step 6: Rodar e confirmar que os testes de `verificarCorredorFora` falham (função não existe)**

Run: `npx vitest run src/lib/corredor-confirmacao.test.ts`
Expected: FAIL — `verificarCorredorFora is not a function` (ou erro de import).

- [ ] **Step 7: Implementar `verificarCorredorFora`**

Adicionar ao final de `src/lib/corredor-confirmacao.ts`:

```typescript
const OSRM_LOCAL_URL = process.env.OSRM_LOCAL_URL ?? "http://127.0.0.1:5001";
// Deadline TOTAL do loop (checado a cada iteracao, nao por chamada
// individual) -- mais curto que os 5s do corredor antigo porque aqui nao
// ha fallback publico pra esperar, e a funcao roda 1x por disparo ja
// formado, nao continuamente por toda a frota suspeita.
const DEADLINE_TOTAL_MS = 3000;

type OsrmRouteResponse = {
  code: string;
  routes?: { geometry?: { coordinates?: [number, number][] } }[];
};

async function rotaOSRMLocal(a: Ponto, b: Ponto): Promise<Ponto[] | null> {
  const res = await fetch(
    `${OSRM_LOCAL_URL}/route/v1/driving/${a.lng},${a.lat};${b.lng},${b.lat}?geometries=geojson&overview=full`,
    { signal: AbortSignal.timeout(1000) }
  );
  if (!res.ok) return null;
  const data = (await res.json()) as OsrmRouteResponse;
  const coords = data.routes?.[0]?.geometry?.coordinates;
  if (data.code !== "Ok" || !coords || coords.length < 2) return null;
  return coords.map(([lng, lat]) => ({ lat, lng }));
}

// Traca a rota real de `origem` (ponto do PASSADO -- nunca a posicao
// atual, senao a checagem e tautologica: toda rota comeca no seu proprio
// ponto de partida) ate cada destino, e confirma se NENHUMA delas passa
// perto o suficiente de `posAtual`. So retorna confirmaFora=true quando
// pelo menos uma rota foi calculada com sucesso e nenhuma bateu -- se
// nenhuma rota resolveu (OSRM indisponivel), fail-open: sem confirmacao,
// sem bonus, nunca bloqueia o alerta que ja ia disparar.
export async function verificarCorredorFora(
  origem: Ponto,
  posAtual: Ponto & { velocidade: number },
  destinos: Ponto[]
): Promise<{ confirmaFora: boolean }> {
  if (destinos.length === 0) return { confirmaFora: false };
  const buffer = bufferPorVelocidade(posAtual.velocidade);
  const inicio = Date.now();
  let algumaRotaSucesso = false;
  for (const destino of destinos) {
    if (Date.now() - inicio > DEADLINE_TOTAL_MS) break;
    let rota: Ponto[] | null = null;
    try {
      rota = await rotaOSRMLocal(origem, destino);
    } catch {
      // Falha pontual de rede num destino -- segue pro proximo, nao aborta.
    }
    if (!rota) continue;
    algumaRotaSucesso = true;
    if (dentroDoCorredor(posAtual, rota, buffer)) {
      return { confirmaFora: false };
    }
  }
  return { confirmaFora: algumaRotaSucesso };
}
```

- [ ] **Step 8: Rodar a suíte completa do arquivo e confirmar que passa**

Run: `npx vitest run src/lib/corredor-confirmacao.test.ts`
Expected: todos os 13 testes passando.

- [ ] **Step 9: `tsc --noEmit` e `eslint` limpos**

Run: `npx tsc --noEmit && npx eslint src/lib/corredor-confirmacao.ts src/lib/corredor-confirmacao.test.ts`
Expected: sem erros.

- [ ] **Step 10: Commit**

```bash
git add src/lib/corredor-confirmacao.ts src/lib/corredor-confirmacao.test.ts
git commit -m "feat(desvio): corredor real via OSRM como sinal de corroboracao (nunca supressao)"
```

---

### Task 3: Wiring no motor (`route.ts`) — exportar bônus, aplicar corroboração, estender o log

**Files:**
- Modify: `src/lib/detectores.ts` (exportar `BONUS_CORROBORACAO_POR_SINAL`)
- Modify: `src/app/api/motor/route.ts`

**Interfaces:**
- Consumes: `verificarCorredorFora` de `src/lib/corredor-confirmacao.ts` (Task 2); `BONUS_CORROBORACAO_POR_SINAL` de `src/lib/detectores.ts`.
- Produces: `alertaDesvioV2.score` ajustado e `alertaDesvioV2.motivo` anotado quando o corredor corrobora; `desvio_disparo_log.corredor_confirmou` gravado.

- [ ] **Step 1: Exportar `BONUS_CORROBORACAO_POR_SINAL` em `detectores.ts`**

Em `src/lib/detectores.ts`, linha 912, trocar:

```typescript
const BONUS_CORROBORACAO_POR_SINAL = 15;
```

por:

```typescript
export const BONUS_CORROBORACAO_POR_SINAL = 15;
```

- [ ] **Step 2: Rodar `tsc --noEmit` pra confirmar que nada quebrou com o export novo**

Run: `npx tsc --noEmit`
Expected: sem erros (export a mais nunca quebra consumidores existentes).

- [ ] **Step 3: Importar as novas dependências em `route.ts`**

Achar o bloco de imports de `src/lib/detectores.ts` e `src/lib/calibracao-desvio.ts` no topo de `src/app/api/motor/route.ts` (por volta da linha 8-22) e adicionar:

```typescript
import { verificarCorredorFora } from "@/lib/corredor-confirmacao";
```

E no import já existente de `@/lib/detectores` (qualquer que seja a lista atual de símbolos importados de lá), adicionar `BONUS_CORROBORACAO_POR_SINAL` à lista.

- [ ] **Step 4: Escrever o bloco de confirmação de corredor, logo após o bloco de calibração ao vivo**

Em `src/app/api/motor/route.ts`, o bloco de calibração ao vivo termina assim (por volta da linha 2436):

```typescript
              if (alertaDesvioV2) {
                try {
                  const taxas = await getTaxasCalibracaoDesvio(pool);
                  const segmento = segmentoCalibracaoPreferido(
                    { tipo: alertaDesvioV2.tipo, origemDesvio: alertaDesvioV2.origemDesvio },
                    null
                  );
                  const taxa = (segmento ? taxas.get(segmento) : undefined) ?? taxas.get(`tipo:${alertaDesvioV2.tipo}`);
                  if (taxa != null) {
                    alertaDesvioV2 = { ...alertaDesvioV2, score: aplicarFatorCalibrado(alertaDesvioV2.score, taxa) };
                  }
                } catch (errCalibracao) {
                  erros.push(`Aviso: falha ao aplicar calibracao de desvio pro veiculo ${veiculo_id}: ${String(errCalibracao)}`);
                }
              }
```

Logo depois desse `}`, e ANTES do comentário `// Achado real 13/08 (casos TTH-3C94...` que introduz o INSERT em `desvio_disparo_log`, inserir:

```typescript
              // Corredor real via OSRM como sinal de CORROBORACAO (nunca
              // supressao) -- ver
              // docs/superpowers/specs/2026-08-14-desvio-corredor-corroboracao-design.md.
              // So roda quando o alerta ja vai disparar (nunca decide SE
              // dispara), ancorado na posicao de quando o streak atual
              // COMECOU (nunca a posicao atual -- checagem tautologica
              // senao), buscada em posicoes_historico pela janela
              // equivalente ao streak em ciclos de 30s (motor-tick-30s no
              // pg_cron). Qualquer falha (sem ancora, OSRM indisponivel,
              // erro de rede) cai em fail-open silencioso -- sem bonus, o
              // alerta grava do mesmo jeito.
              let corredorConfirmou = false;
              if (alertaDesvioV2) {
                try {
                  const segundosStreak = afastandoStreakNovo * 30;
                  const { rows: ancoraRows } = await pool.query<{ lat: number; lng: number }>(
                    `SELECT lat, lng FROM posicoes_historico
                      WHERE veiculo_id = $1 AND criado_em <= now() - ($2 || ' seconds')::interval
                      ORDER BY criado_em DESC LIMIT 1`,
                    [veiculo_id, String(segundosStreak)]
                  );
                  const ancora = ancoraRows[0];
                  if (ancora) {
                    const { confirmaFora } = await verificarCorredorFora(
                      { lat: ancora.lat, lng: ancora.lng },
                      { lat: pos.lat, lng: pos.lng, velocidade: pos.velocidade },
                      destinosRelevantes
                    );
                    if (confirmaFora) {
                      corredorConfirmou = true;
                      alertaDesvioV2 = {
                        ...alertaDesvioV2,
                        score: Math.min(100, alertaDesvioV2.score + BONUS_CORROBORACAO_POR_SINAL),
                        motivo: `${alertaDesvioV2.motivo} (corroborado por: corredor real fora de rota)`,
                      };
                    }
                  }
                } catch (errCorredor) {
                  erros.push(`Aviso: falha ao verificar corredor pro veiculo ${veiculo_id}: ${String(errCorredor)}`);
                }
              }
```

- [ ] **Step 5: Estender o INSERT em `desvio_disparo_log` com `corredor_confirmou`**

No mesmo arquivo, o INSERT existente (por volta da linha 2450) é:

```typescript
                  await pool.query(
                    `INSERT INTO desvio_disparo_log
                       (veiculo_id, tipo_disparo, destinos, streak_afastando, streak_rua_rara, celula, n_visitas_celula, posicao_corrigida)
                     VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`,
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
                    ]
                  );
```

Trocar por:

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

- [ ] **Step 6: `tsc --noEmit`, `eslint`, suíte completa**

Run: `npx tsc --noEmit && npx eslint src/app/api/motor/route.ts && npx vitest run`
Expected: sem erros de tipo/lint; suíte inteira (todos os arquivos, não só os novos) passando — nenhum teste existente de `route.ts`/`detectores.ts` pode ter mudado de comportamento.

- [ ] **Step 7: Commit**

```bash
git add src/lib/detectores.ts src/app/api/motor/route.ts
git commit -m "feat(desvio): liga corredor real como corroboracao no motor"
```

---

### Task 4: Validação contra dado real de produção (sem mudar comportamento)

**Files:**
- Create: `scripts/validar-corredor-corroboracao.mjs` (script ad-hoc, roda contra o banco de produção via SSH — não precisa de teste automatizado, é uma ferramenta de medição única, mesmo padrão de `scripts/calibrar-piso-confianca-match.mjs`).

**Interfaces:**
- Consumes: `verificarCorredorFora` de `src/lib/corredor-confirmacao.ts` (via `tsx`, import direto do `.ts`, mesmo padrão das simulações de dia inteiro já usadas nesta sessão).

- [ ] **Step 1: Escrever o script de validação**

Arquivo `scripts/validar-corredor-corroboracao.mjs`:

```javascript
// Mede quanto o corredor real teria corroborado nos disparos de desvio
// reais dos ultimos 14 dias, SEM mudar nenhum comportamento de disparo --
// so' roda a funcao pura contra dado ja gravado. Ver
// docs/superpowers/specs/2026-08-14-desvio-corredor-corroboracao-design.md,
// secao "Testes e validacao".
import pg from "pg";
import { verificarCorredorFora } from "../src/lib/corredor-confirmacao.ts";

const c = new pg.Client({ connectionString: process.env.DATABASE_URL, ssl: { rejectUnauthorized: false } });
await c.connect();

const { rows: disparos } = await c.query(`
  select ddl.id, ddl.veiculo_id, ddl.destinos, ddl.streak_afastando, ddl.criado_em, v.placa
  from desvio_disparo_log ddl
  join veiculos v on v.id = ddl.veiculo_id
  where ddl.tipo_disparo = 'afastando_geral'
    and ddl.criado_em >= now() - interval '14 days'
  order by ddl.criado_em desc
`);
console.log(`Disparos reais de afastando_geral, 14 dias: ${disparos.length}`);

let confirmados = 0;
let semAncora = 0;
let semDestinos = 0;
let indisponivel = 0;

for (const d of disparos) {
  const destinos = d.destinos.map((x) => ({ lat: x.lat, lng: x.lng }));
  if (destinos.length === 0) { semDestinos++; continue; }

  const segundosStreak = d.streak_afastando * 30;
  const { rows: ancoraRows } = await c.query(
    `SELECT lat, lng FROM posicoes_historico
      WHERE veiculo_id = $1 AND criado_em <= $2::timestamptz - ($3 || ' seconds')::interval
      ORDER BY criado_em DESC LIMIT 1`,
    [d.veiculo_id, d.criado_em, String(segundosStreak)]
  );
  const ancora = ancoraRows[0];
  if (!ancora) { semAncora++; continue; }

  // posicao atual = posicao no momento do disparo (o proprio criado_em)
  const { rows: atualRows } = await c.query(
    `SELECT lat, lng, velocidade FROM posicoes_historico
      WHERE veiculo_id = $1 AND criado_em <= $2::timestamptz
      ORDER BY criado_em DESC LIMIT 1`,
    [d.veiculo_id, d.criado_em]
  );
  const atual = atualRows[0];
  if (!atual) { semAncora++; continue; }

  const { confirmaFora } = await verificarCorredorFora(
    { lat: ancora.lat, lng: ancora.lng },
    { lat: atual.lat, lng: atual.lng, velocidade: atual.velocidade ?? 0 },
    destinos
  );
  if (confirmaFora) confirmados++;
  else indisponivel++;
}

console.log(`Corroborados (confirmaFora=true): ${confirmados}`);
console.log(`Nao corroborados (OSRM indisponivel/dentro de rota): ${indisponivel}`);
console.log(`Sem ancora suficiente: ${semAncora}`);
console.log(`Sem destinos gravados: ${semDestinos}`);

await c.end();
```

- [ ] **Step 2: Rodar no servidor (via SSH, banco de produção) e registrar o resultado**

Copiar o script pro servidor e rodar (mesmo padrão de scripts ad-hoc já usados nesta sessão):

```bash
scp scripts/validar-corredor-corroboracao.mjs transmonseg-vps:/srv/transmonseg/temp/scripts/_tmp-validar-corredor.mjs
ssh transmonseg-vps 'cd /srv/transmonseg/temp && set -a && source .env.production && set +a && npx tsx scripts/_tmp-validar-corredor.mjs; rm scripts/_tmp-validar-corredor.mjs'
```

Expected: números concretos de quantos disparos reais o corredor teria corroborado — usar como referência pra confirmar que o mecanismo tá funcionando contra dado real antes de considerar a feature validada (não há um número "certo" esperado, é medição, não teste de aceite — mas confirmados=0 pra TODOS os disparos indicaria bug, já que pelo menos alguns devem confirmar fora de rota).

- [ ] **Step 3: Commit do script (fica no repo como ferramenta, mesmo padrão de scripts de calibração anteriores)**

```bash
git add scripts/validar-corredor-corroboracao.mjs
git commit -m "chore(desvio): script de validacao do corredor contra disparos reais"
```

---

### Task 5: Espelhar pro repo definitivo, aplicar migration no Contabo, deploy dos dois

**Files:**
- Modify (cópia): todos os arquivos criados/modificados nas Tasks 1-4, replicados em `/Users/joaquimsalles/Projects/Transmonseg/monitoramento/MONITORAMENTO transmonseg`.

**Interfaces:**
- N/A — task de integração/deploy, não introduz símbolos novos.

- [ ] **Step 1: Copiar os arquivos novos/modificados pro repo definitivo**

```bash
TEMP="/Users/joaquimsalles/Projects/Transmonseg/monitoramento/MONITORAMENTO TEMP"
DEF="/Users/joaquimsalles/Projects/Transmonseg/monitoramento/MONITORAMENTO transmonseg"

cp "$TEMP/scripts/migrations/047_desvio_disparo_log_corredor_confirmou.sql" "$DEF/scripts/migrations/"
cp "$TEMP/scripts/migrations/contabo/049_desvio_disparo_log_corredor_confirmou.sql" "$DEF/scripts/migrations/contabo/"
cp "$TEMP/src/lib/corredor-confirmacao.ts" "$DEF/src/lib/"
cp "$TEMP/src/lib/corredor-confirmacao.test.ts" "$DEF/src/lib/"
cp "$TEMP/src/lib/detectores.ts" "$DEF/src/lib/"
cp "$TEMP/src/app/api/motor/route.ts" "$DEF/src/app/api/motor/"
cp "$TEMP/scripts/validar-corredor-corroboracao.mjs" "$DEF/scripts/"

diff -rq "$TEMP/src/lib/corredor-confirmacao.ts" "$DEF/src/lib/corredor-confirmacao.ts"
diff -rq "$TEMP/src/app/api/motor/route.ts" "$DEF/src/app/api/motor/route.ts"
diff -rq "$TEMP/src/lib/detectores.ts" "$DEF/src/lib/detectores.ts"
```

Expected: todos os `diff -rq` sem saída (arquivos idênticos).

- [ ] **Step 2: `tsc`/`eslint`/`vitest` completos no repo definitivo**

```bash
cd "/Users/joaquimsalles/Projects/Transmonseg/monitoramento/MONITORAMENTO transmonseg"
npx tsc --noEmit && npx eslint src/lib/corredor-confirmacao.ts src/app/api/motor/route.ts src/lib/detectores.ts && npx vitest run
```
Expected: tudo limpo, mesma suíte passando.

- [ ] **Step 3: Commit nos dois repos**

```bash
cd "/Users/joaquimsalles/Projects/Transmonseg/monitoramento/MONITORAMENTO TEMP"
git add -A
git commit -m "feat(desvio): corredor real via OSRM como corroboracao -- espelha pro definitivo"

cd "/Users/joaquimsalles/Projects/Transmonseg/monitoramento/MONITORAMENTO transmonseg"
git add -A
git commit -m "feat(desvio): corredor real via OSRM como corroboracao -- espelha pro definitivo"
```

(Nota: se as Tasks 1-4 já foram commitadas incrementalmente só no TEMP, este step comita de uma vez só no definitivo o equivalente a todos os commits anteriores — squash natural, aceitável já que o definitivo não roda o motor e só precisa refletir o estado final.)

- [ ] **Step 4: Push dos dois repos e confirmar que o push realmente chegou (achado real de 13/08: push pode falhar silenciosamente)**

```bash
cd "/Users/joaquimsalles/Projects/Transmonseg/monitoramento/MONITORAMENTO TEMP"
git push origin master
git fetch origin -q && git status -sb

cd "/Users/joaquimsalles/Projects/Transmonseg/monitoramento/MONITORAMENTO transmonseg"
git push origin main
git fetch origin -q && git status -sb
```
Expected: ambos `git status -sb` mostram `master...origin/master`/`main...origin/main` sem "ahead"/"behind".

- [ ] **Step 5: Aplicar a migration no Contabo (banco de produção, via SSH)**

`scripts/aplicar-migration.mjs` resolve o argumento como `path.join(dir, "migrations", arg)` — aceita subcaminho, então passar `contabo/049_...` funciona sem script separado:

```bash
ssh transmonseg-vps 'cd /srv/transmonseg/temp && set -a && source .env.production && set +a && node --env-file=.env.production scripts/aplicar-migration.mjs contabo/049_desvio_disparo_log_corredor_confirmou.sql'
```

Expected: saída `OK — migration aplicada.` e a lista de tabelas em `public` incluindo `desvio_disparo_log`.

- [ ] **Step 6: Deploy nos dois processos PM2**

```bash
ssh transmonseg-vps 'cd /srv/transmonseg/temp && git pull && npm run build && pm2 restart transmonseg-temp'
ssh transmonseg-vps 'cd /srv/transmonseg/definitivo && git pull && npm run build && pm2 restart transmonseg-definitivo'
```
Expected: build limpo nos dois, `pm2 restart` confirma status `online`.

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
Expected: site responde (307, mesmo padrão de antes), motor continua gravando posições normalmente após o restart.

- [ ] **Step 8: Rodar o script de validação (Task 4) de novo, agora contra o código já em produção, e reportar o resultado**

```bash
ssh transmonseg-vps 'cd /srv/transmonseg/temp && set -a && source .env.production && set +a && npx tsx scripts/validar-corredor-corroboracao.mjs'
```
Expected: mesmo tipo de saída do Step 2 da Task 4 — usar pra confirmar visualmente, com o operador, que os próximos disparos reais de desvio passam a vir com "(corroborado por: corredor real fora de rota)" no motivo quando aplicável.
