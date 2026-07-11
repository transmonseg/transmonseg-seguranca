# Hardening do detector de desvio de rota — Plano de Implementação

> **Escopo:** SOMENTE desvio de rota (disparo + resolução). Nada de outros tipos de alerta, apagão do motor, score combinado entre detectores, ou replay harness genérico — tudo isso fica documentado como próxima fase, fora deste plano.

**Goal:** Fechar todos os riscos críticos e altos confirmados hoje na detecção e resolução de desvio de rota, com TDD e sem quebrar nenhum comportamento correto já existente.

**Arquitetura:** Nenhuma camada nova. Só correções pontuais e bem localizadas em `src/lib/detectores.ts` e `src/app/api/motor/route.ts`, cada uma com teste próprio.

**Tech Stack:** TypeScript, Vitest, Postgres (Supabase). Sem migração de schema.

## Global Constraints

- Nunca fechar um alerta de desvio só porque o veículo parou (regra inegociável do projeto).
- Nunca deixar horário do relógio (fim de expediente, fora de operação) fechar um alerta sem evidência comportamental.
- Fail-open: qualquer dependência de API externa (OSRM/Valhalla) nunca deve suprimir alerta genuíno por indisponibilidade.
- Todo teste existente que hoje passa (349) deve continuar passando, exceto o único identificado abaixo (Task 3) que precisa ser reescrito porque documenta um bug como comportamento esperado.
- `npx tsc --noEmit`, `npx vitest run`, `npx eslint <arquivos tocados>` e `npm run build` limpos antes de cada push.

---

### Task 1: Guardar `detectarDesvio` contra falha da API `/alvos`

**Files:**
- Modify: `src/lib/detectores.ts` (tipo `CtxDesvio` ~linha 342, `detectarDesvio` ~linha 501, ctx de `avaliar`/`avaliarTodos` ~linha 784-811, chamadas internas ~linha 757-771 e 859-873)
- Modify: `src/app/api/motor/route.ts` (chamada a `avaliar(pos, {...})` ~linha 1116-1142)
- Test: `src/lib/detectores.test.ts`

**Interfaces:**
- Produz: `CtxDesvio.alvosApiOk?: boolean` — quando `=== false`, `detectarDesvio` retorna `null` de cara.

- [ ] **Passo 1: Teste falho**

```ts
it("alvosApiOk=false (falha da API): nao dispara mesmo afastando de tudo", () => {
  const a = detectarDesvio(emMov, { ...base, dentroTapete: true, alvosApiOk: false });
  expect(a).toBeNull();
});
it("alvosApiOk indefinido (comportamento de hoje, API ok): dispara normalmente", () => {
  const a = detectarDesvio(emMov, { ...base, dentroTapete: true });
  expect(a).not.toBeNull();
});
```
Adicionar ao final do describe `detectarDesvio (v4: ...)` em `detectores.test.ts`.

- [ ] **Passo 2: Rodar e confirmar falha**

`npx vitest run src/lib/detectores.test.ts` — falha porque `alvosApiOk` não existe no tipo/lógica ainda.

- [ ] **Passo 3: Implementar**

Em `CtxDesvio` (detectores.ts ~linha 342-382), adicionar campo opcional:
```ts
export type CtxDesvio = {
  distDestinosM: number[];
  distDestinosAnteriorM: number[];
  temPendentes: boolean;
  emOperacao: boolean;
  foraDaBase: boolean;
  entregasFeitas?: number;
  // Quando a API /alvos falhou/deu timeout neste ciclo, destinos vira so
  // bases pra TODOS os veiculos do cliente -- indistinguivel de "rota
  // realmente sem pendencias". alvosApiOk=false bloqueia o disparo (mesmo
  // tratamento que saida_nao_autorizada ja tem via alvosApiOk em route.ts).
  // undefined = comportamento de hoje (API ok).
  alvosApiOk?: boolean;
  streak: number;
  afastamentoAcumuladoM: number;
  dentroTapete: boolean | null;
  riscoAreaAtual: number;
  foraTapeteStreak: number;
};
```

Em `detectarDesvio` (~linha 501-506), adicionar guarda logo no topo:
```ts
export function detectarDesvio(p: PosicaoNormalizada, ctx: CtxDesvio): Alerta | null {
  if (ctx.alvosApiOk === false) return null;
  if (!ctx.emOperacao || !ctx.foraDaBase) return null;
  if (p.velocidade <= 0) return null;
  if (ctx.temPendentes && (ctx.entregasFeitas ?? 1) === 0) return null;
  if (ctx.distDestinosM.length === 0) return null;
  ...
```

No tipo do `ctx` de `avaliar` (~linha 784-811), adicionar `alvosApiOk?: boolean;` junto dos outros campos opcionais.

Nas DUAS chamadas internas a `detectarDesvio` (dentro de `avaliarTodos`, ~linha 757-771, e dentro de `avaliar`, ~linha 859-873), adicionar `alvosApiOk: ctx.alvosApiOk,` ao objeto passado.

Em `route.ts`, na chamada a `avaliar(pos, {...})` (~linha 1116-1142), adicionar `alvosApiOk,` (a variável já existe em escopo, calculada por cliente na linha 710).

- [ ] **Passo 4: Rodar e confirmar passa**

`npx vitest run src/lib/detectores.test.ts` — todos passam.

- [ ] **Passo 5: Commit**

```bash
git add src/lib/detectores.ts src/app/api/motor/route.ts src/lib/detectores.test.ts
git commit -m "fix(desvio): guarda detectarDesvio contra falha da API /alvos"
```

---

### Task 2: Corrigir posição CONGELADA sendo lida como aproximação (auto-resolve perigoso)

**Achado de hoje (auditoria de interação entre detectores):** se a posição do veículo trava entre ciclos (sinal ruim/travado) mas a velocidade reportada continua >0, `afastouDeTudo` calcula `false` (distância não mudou) e a histerese lê isso como "aproximando" — em 2 ciclos zera o streak E fecha um alerta de desvio já ativo (via `aproximandoStreak>=2` em `foraDeRota`). Cenário real de risco: sequestro com bloqueio de sinal no meio de um desvio em curso.

**Files:**
- Modify: `src/lib/detectores.ts` (nova função pura)
- Modify: `src/app/api/motor/route.ts` (~linha 896-923, guarda de avanço de streak)
- Test: `src/lib/detectores.test.ts`

**Interfaces:**
- Produz: `devAvancarStreaksDesvio(ctx): boolean` — decide se o ciclo atual deve alimentar `avancarStreaksDesvio`, ou se é um "não-evento" (sem informação nova) que deve congelar tudo.

- [ ] **Passo 1: Teste falho**

```ts
describe("devAvancarStreaksDesvio (posicao congelada nao conta como aproximacao)", () => {
  it("posicao praticamente identica ao ciclo anterior (<10m): NAO avanca (congela)", () => {
    expect(devAvancarStreaksDesvio({
      fresco: true, saltoImplausivel: false, distanciaAoAnteriorM: 3, velocidade: 40,
    })).toBe(false);
  });
  it("movimento real (>=10m): avanca normalmente", () => {
    expect(devAvancarStreaksDesvio({
      fresco: true, saltoImplausivel: false, distanciaAoAnteriorM: 50, velocidade: 40,
    })).toBe(true);
  });
  it("sem posicao anterior: nao avanca (nada a comparar)", () => {
    expect(devAvancarStreaksDesvio({
      fresco: true, saltoImplausivel: false, distanciaAoAnteriorM: null, velocidade: 40,
    })).toBe(false);
  });
  it("nao fresco ou salto implausivel: nao avanca (regras existentes preservadas)", () => {
    expect(devAvancarStreaksDesvio({
      fresco: false, saltoImplausivel: false, distanciaAoAnteriorM: 50, velocidade: 40,
    })).toBe(false);
    expect(devAvancarStreaksDesvio({
      fresco: true, saltoImplausivel: true, distanciaAoAnteriorM: 50, velocidade: 40,
    })).toBe(false);
  });
  it("velocidade 0 (genuinamente parado, posicao real): nao avanca", () => {
    expect(devAvancarStreaksDesvio({
      fresco: true, saltoImplausivel: false, distanciaAoAnteriorM: 50, velocidade: 0,
    })).toBe(false);
  });
});
```

- [ ] **Passo 2: Rodar e confirmar falha**

`npx vitest run src/lib/detectores.test.ts` — falha, função não existe.

- [ ] **Passo 3: Implementar**

Em `detectores.ts`, logo antes de `avancarStreaksDesvio` (~linha 444):
```ts
// Tolerancia de "jitter" normal de GPS parado -- abaixo disso, o veiculo
// nao se moveu de verdade (nao e sinal de aproximacao nem de afastamento).
const POSICAO_CONGELADA_M = 10;

// Decide se o ciclo atual tem informacao NOVA o suficiente pra avancar os
// streaks de desvio, ou se e um nao-evento que deve congelar tudo (mesmo
// tratamento ja dado a saltoImplausivel). Achado real 10/07: se a posicao
// trava entre ciclos (sinal ruim/bloqueado) mas a velocidade reportada
// continua >0, afastouDeTudo() calcula "sem afastamento" (distancia nao
// mudou) e a historese le isso como aproximacao -- em 2 ciclos zera o
// streak E fecha um alerta ja ativo, exatamente o que um sequestro com
// bloqueio de sinal faria parecer. distanciaAoAnteriorM=null (sem ciclo
// anterior) tambem nao avanca -- nada a comparar ainda.
export function devAvancarStreaksDesvio(ctx: {
  fresco: boolean;
  saltoImplausivel: boolean;
  distanciaAoAnteriorM: number | null;
  velocidade: number;
}): boolean {
  if (!ctx.fresco || ctx.saltoImplausivel) return false;
  if (ctx.distanciaAoAnteriorM === null) return false;
  if (ctx.distanciaAoAnteriorM < POSICAO_CONGELADA_M) return false;
  return ctx.velocidade > 0;
}
```

Em `route.ts` (~linha 907), trocar a guarda inline:
```ts
// ANTES:
if (pos.fresco && !saltoImplausivel && pos.velocidade > 0 && temAnterior) {

// DEPOIS:
if (devAvancarStreaksDesvio({
  fresco: pos.fresco,
  saltoImplausivel,
  distanciaAoAnteriorM: temAnterior ? haversineM(anterior!.lat!, anterior!.lng!, pos.lat, pos.lng) : null,
  velocidade: pos.velocidade,
})) {
```
Adicionar `devAvancarStreaksDesvio` ao import de `@/lib/detectores` no topo do arquivo.

- [ ] **Passo 4: Rodar e confirmar passa**

`npx vitest run` — todos passam. `npx tsc --noEmit` limpo.

- [ ] **Passo 5: Commit**

```bash
git add src/lib/detectores.ts src/app/api/motor/route.ts src/lib/detectores.test.ts
git commit -m "fix(desvio): posicao congelada nao conta mais como aproximacao (achado real: pode mascarar sequestro)"
```

---

### Task 3: Fechar o "zumbi" da Camada 3 dentro da Camada 1

**Files:**
- Modify: `src/lib/detectores.ts` (~linha 539)
- Test: `src/lib/desvio-cenarios.test.ts` (reescrever 1 teste que documenta o bug como esperado)

- [ ] **Passo 1: Confirmar o teste que vai quebrar (não escrever teste novo, é regressão)**

`npx vitest run src/lib/desvio-cenarios.test.ts` antes da mudança — todos passam (baseline).

- [ ] **Passo 2: Implementar**

Em `detectores.ts` linha 539:
```ts
// ANTES:
  if (ctx.dentroTapete === false) {

// DEPOIS:
  // Mesmo dado de tapete que causou o incidente de 09/07 (Camada 3) -- esta
  // escalada vivia SEM a flag, e continuava produzindo o mesmo sintoma
  // ("fora de via conhecida da frota") mesmo com CAMADA3_TAPETE_ATIVA=false.
  // Confirmado com dado real: disparou as 21h43 de 09/07, depois da
  // desativacao. Agora atras da MESMA flag que protege a linha 519.
  if (CAMADA3_TAPETE_ATIVA && ctx.dentroTapete === false) {
```

- [ ] **Passo 3: Rodar e ver a falha esperada**

`npx vitest run src/lib/desvio-cenarios.test.ts` — falha exatamente em "DESVIO INJETADO fora do tapete: dispara IMEDIATO (score 80) mesmo em area sem risco" (linha ~127-136), `expected 45 to be 80`.

- [ ] **Passo 4: Reescrever o teste (documentava o bug como esperado)**

Em `desvio-cenarios.test.ts`, substituir o teste (linhas ~127-136):
```ts
// ANTES:
  it("DESVIO INJETADO fora do tapete: dispara IMEDIATO (score 80) mesmo em area sem risco", () => {
    const ciclos: Ciclo[] = Array.from({ length: 3 }, (_, i) => ({
      ...afastarDe(MANGUINHOS, REALENGO, i * 0.01),
      dentroTapete: false,
      riscoAreaAtual: 0,
    }));
    const resultados = simular(REALENGO, ciclos);
    expect(resultados[2]?.score).toBe(80); // streak chega a 2 no indice 2
    expect(resultados[2]?.motivo).toContain("fora de via conhecida");
  });

// DEPOIS:
  it("fora do tapete, mas CAMADA3_TAPETE_ATIVA=false: nao escala, segue escalonamento normal (score 45)", () => {
    // Achado real 10/07: este branch escalava pra 80 mesmo com a Camada 3
    // "desativada" -- o mesmo sintoma do incidente de 09/07 (mesmo motivo,
    // mesma origem de dado) sobrevivia por nao estar atras da flag.
    const ciclos: Ciclo[] = Array.from({ length: 3 }, (_, i) => ({
      ...afastarDe(MANGUINHOS, REALENGO, i * 0.01),
      dentroTapete: false,
      riscoAreaAtual: 0,
    }));
    const resultados = simular(REALENGO, ciclos);
    expect(resultados[2]?.score).toBe(45);
    expect(resultados[2]?.motivo).not.toContain("fora de via conhecida");
  });
```

- [ ] **Passo 5: Rodar tudo e confirmar passa**

`npx vitest run` — 349 testes passam (mesmo total, 1 reescrito).

- [ ] **Passo 6: Commit**

```bash
git add src/lib/detectores.ts src/lib/desvio-cenarios.test.ts
git commit -m "fix(desvio): fecha o zumbi da Camada 3 -- escalada por tapete atras da flag CAMADA3_TAPETE_ATIVA"
```

---

### Task 4: Campo estruturado em vez de string mágica + log do veredito do corredor

**Files:**
- Modify: `src/lib/detectores.ts` (tipo `Alerta`, 4 branches de `detectarDesvio`)
- Modify: `src/app/api/motor/route.ts` (condição do bloco de corredor ~linha 1158-1214, insert do alerta ~linha 1343-1361)
- Test: `src/lib/detectores.test.ts`

**Interfaces:**
- Produz: `Alerta.precisaVerificacaoCorredor?: boolean`.

- [ ] **Passo 1: Teste falho**

```ts
it("os 4 branches do fluxo principal marcam precisaVerificacaoCorredor=true", () => {
  expect(detectarDesvio(emMov, { ...base, dentroTapete: true }).precisaVerificacaoCorredor).toBe(true); // score 45
  expect(detectarDesvio(emMov, { ...base, streak: 4, dentroTapete: true }).precisaVerificacaoCorredor).toBe(true); // score 68
  expect(detectarDesvio(emMov, { ...base, dentroTapete: true, riscoAreaAtual: RISCO_AREA_LIMIAR }).precisaVerificacaoCorredor).toBe(true); // score 80 risco
});
it("o branch Camada 3 remanescente (linha 519, aproximando fora do tapete) NAO marca -- so dispara com a flag ligada, hoje desligada", () => {
  const a = detectarDesvio(emMov2, { ...baseAproximando, foraTapeteStreak: 8 });
  expect(a).toBeNull(); // confirma que hoje esse branch nem dispara, ver Task 3
});
```
Adicionar ao describe `detectarDesvio (v4: ...)`.

- [ ] **Passo 2: Rodar e confirmar falha**

`npx vitest run src/lib/detectores.test.ts` — falha, propriedade não existe.

- [ ] **Passo 3: Implementar**

No tipo `Alerta` (~linha 7-12):
```ts
export type Alerta = {
  nivel: "critico" | "atencao";
  tipo: string;
  motivo: string;
  score: number;
  // Sinaliza que este alerta de desvio precisa passar pela verificacao de
  // corredor real (route.ts) antes de confirmar -- substitui o acoplamento
  // por string magica (motivo.startsWith("Afastando-se")) que existia ate
  // 10/07: qualquer ajuste de texto desligava a protecao inteira em
  // silencio. So os branches do FLUXO PRINCIPAL de detectarDesvio setam
  // isso; o branch remanescente da Camada 3 (linha ~519, "Aproximando...")
  // nao seta -- tem semantica de deteccao diferente (nunca teve
  // verificacao de corredor).
  precisaVerificacaoCorredor?: boolean;
};
```

Nos 4 branches de `detectarDesvio` que retornam alerta com "Afastando-se" (linhas ~540-546, ~555-561, ~566-572, ~575-579), adicionar `precisaVerificacaoCorredor: true,` a cada objeto retornado.

Em `route.ts` (~linha 1158-1164), trocar a condição:
```ts
// ANTES:
          if (
            CAMADA_CORREDOR_ATIVA &&
            alerta?.tipo === "desvio" &&
            alerta.motivo.startsWith("Afastando-se") &&
            pos.fresco &&
            desvioInicio
          ) {

// DEPOIS:
          if (
            CAMADA_CORREDOR_ATIVA &&
            alerta?.tipo === "desvio" &&
            alerta.precisaVerificacaoCorredor === true &&
            pos.fresco &&
            desvioInicio
          ) {
```

- [ ] **Passo 4: Rodar e confirmar passa**

`npx vitest run` — todos passam.

- [ ] **Passo 5: Commit**

```bash
git add src/lib/detectores.ts src/app/api/motor/route.ts src/lib/detectores.test.ts
git commit -m "fix(desvio): campo estruturado precisaVerificacaoCorredor substitui string magica no motivo"
```

---

### Task 5: Logar o veredito do corredor no `contexto` do alerta

**Files:**
- Modify: `src/app/api/motor/route.ts` (bloco de corredor ~linha 1158-1214, insert ~linha 1343-1361)

**Interfaces:**
- Produz: `contexto.corredor: { veredito: "dentro"|"fora"|"indisponivel"|"orcamento_estourado"; bufferM: number } | undefined` no insert de alertas de desvio.

Sem teste automatizado (route.ts não tem harness de integração — ver Task 9 do backlog de fase 2). QA manual obrigatório: rodar um ciclo real e conferir `contexto` na tabela `alertas` depois do deploy.

- [ ] **Passo 1: Implementar**

Declarar variável antes do bloco de corredor (perto da linha 1158):
```ts
let corredorInfo: { veredito: "dentro" | "fora" | "indisponivel" | "orcamento_estourado"; bufferM: number } | null = null;
```

Preencher em cada saída do bloco (linhas ~1174-1214):
```ts
            if (cacheValido && cache && dentroDoCorredor(pos, cache.polilinha, bufferPorVelocidade(pos.velocidade))) {
              cache.ultimoDentro = { lat: pos.lat, lng: pos.lng };
              corredorInfo = { veredito: "dentro", bufferM: bufferPorVelocidade(pos.velocidade) };
              alerta = null;
              desvioStreak = 0;
              desvioInicio = null;
            } else if (verificacoesCorredorNoCiclo < MAX_VERIFICACOES_POR_CICLO) {
              verificacoesCorredorNoCiclo++;
              const bufferAtual = bufferPorVelocidade(pos.velocidade);
              const candidatos = [...destinos]
                .map((d) => ({ d, dist: haversineM(pos.lat, pos.lng, d.lat, d.lng) }))
                .sort((a, b) => a.dist - b.dist)
                .slice(0, 3)
                .map((x) => x.d);
              const r = await verificarCorredor(origem, { lat: pos.lat, lng: pos.lng, velocidade: pos.velocidade }, candidatos);
              corredorInfo = { veredito: r.veredito, bufferM: bufferAtual };
              if (r.veredito === "dentro" && r.corredor) {
                cacheCorredorPorVeiculo.set(veiculo_id, {
                  polilinha: r.corredor,
                  ultimoDentro: { lat: pos.lat, lng: pos.lng },
                  pendentesChave,
                  origemTs: desvioInicio.ts,
                  expiraEm: Date.now() + CORREDOR_CACHE_MS,
                });
                alerta = null;
                desvioStreak = 0;
                desvioInicio = null;
              } else if (r.veredito === "fora") {
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
            } else {
              corredorInfo = { veredito: "orcamento_estourado", bufferM: bufferPorVelocidade(pos.velocidade) };
            }
```
(nota: o `else` final é NOVO — hoje o comentário "Orçamento estourado: deixa o alerta seguir como hoje" não tinha branch nenhum; agora só grava a info, sem mudar comportamento.)

No insert do alerta (~linha 1357-1359):
```ts
// ANTES:
                  contexto: ehDesvio
                    ? { inicio_ts: desvioInicio!.ts, fora_tapete: dentroTapete === false }
                    : {},

// DEPOIS:
                  contexto: ehDesvio
                    ? {
                        inicio_ts: desvioInicio!.ts,
                        fora_tapete: dentroTapete === false,
                        ...(corredorInfo ? { corredor: corredorInfo } : {}),
                      }
                    : {},
```

- [ ] **Passo 2: Validar**

`npx tsc --noEmit` limpo. `npx vitest run` — 349 passam (nada de lógica de teste tocado aqui).

- [ ] **Passo 3: Commit**

```bash
git add src/app/api/motor/route.ts
git commit -m "feat(desvio): loga veredito do corredor no contexto do alerta (fim da arqueologia manual)"
```

---

### Task 6: Remover `!emOperacao` como gatilho de FECHAMENTO em `foraDeRota`

**Achado de hoje (deep-dive de resolução):** `foraDeRota` retorna `false` (= "resolver") sempre que `!emOperacao` — ou seja, fecha QUALQUER desvio ativo assim que a próxima posição fresca chegar fora do horário 6h-20h seg-sex (ou fim de semana), sem checar nada do comportamento. Confirmado com dado real: 3 alertas com <30min de vida fechados exatamente às 20h (só esse caminho explica, já que o mecanismo de limpeza exige 30min+).

**Files:**
- Modify: `src/lib/detectores.ts` (~linha 481-494)
- Modify: `src/app/api/motor/route.ts` (~linha 996-997)
- Test: `src/lib/detectores.test.ts` (~linha 560-586)

- [ ] **Passo 1: Ajustar teste (remove o caso que documentava o bug)**

Em `detectores.test.ts`, trocar:
```ts
// ANTES:
  it("resolve dentro da base ou fora de operacao", () => {
    expect(foraDeRota(p, { menorDistDestinoM: 9000, emOperacao: true, foraDaBase: false, aproximandoStreak: 0 })).toBe(false);
    expect(foraDeRota(p, { menorDistDestinoM: 9000, emOperacao: false, foraDaBase: true, aproximandoStreak: 0 })).toBe(false);
  });

// DEPOIS:
  it("resolve dentro da base", () => {
    expect(foraDeRota(p, { menorDistDestinoM: 9000, foraDaBase: false, aproximandoStreak: 0 })).toBe(false);
  });
  // Achado real 10/07: fora de operacao (noite/fim de semana) NAO deve mais
  // fechar sozinho -- fechava QUALQUER desvio ativo assim que a proxima
  // posicao fresca chegasse fora do horario 6h-20h seg-sex, sem checar
  // comportamento. Removido de foraDeRota; emOperacao continua controlando
  // CRIACAO de alerta novo (detectarDesvio), nunca mais o fechamento.
  it("fora de horario de operacao NAO fecha mais sozinho (so o comportamento decide)", () => {
    expect(foraDeRota(p, { menorDistDestinoM: 9000, foraDaBase: true, aproximandoStreak: 0 })).toBe(true);
  });
```
Remover `emOperacao` dos outros literais em todo o describe (linhas 563, 566, 581, 584) — ficam `{ menorDistDestinoM, foraDaBase, aproximandoStreak }`.

- [ ] **Passo 2: Rodar e confirmar falha**

`npx vitest run src/lib/detectores.test.ts` — falha (TS: propriedade `emOperacao` inexistente, ou runtime se `ctx.emOperacao` ainda for lido).

- [ ] **Passo 3: Implementar**

Em `detectores.ts` (~linha 481-494):
```ts
export function foraDeRota(
  p: PosicaoNormalizada,
  ctx: {
    menorDistDestinoM: number | null;
    foraDaBase: boolean;
    aproximandoStreak: number;
  }
): boolean {
  if (!ctx.foraDaBase) return false;
  if (ctx.aproximandoStreak >= APROXIMANDO_RESOLVE_STREAK) return false;
  if (ctx.menorDistDestinoM === null) return false;
  return ctx.menorDistDestinoM >= DESVIO_RESOLVE_M;
}
```
(assinatura de `p: PosicaoNormalizada` mantida mesmo sem uso direto, pra não quebrar callers que passam posição — checar se `p` é usado em algum lugar da função antes de remover o parâmetro; se não for usado em lugar nenhum, pode remover do types dos callers também, mas manter compatível é mais seguro aqui.)

Em `route.ts` (~linha 996-997):
```ts
// ANTES:
          const estaForaDeRota =
            pos.fresco && foraDeRota(pos, { menorDistDestinoM, emOperacao, foraDaBase, aproximandoStreak });

// DEPOIS:
          const estaForaDeRota =
            pos.fresco && foraDeRota(pos, { menorDistDestinoM, foraDaBase, aproximandoStreak });
```
(nota: essa linha vira `let` na Task 7 abaixo, não `const` — ver próxima task.)

- [ ] **Passo 4: Rodar e confirmar passa**

`npx vitest run` — todos passam. `npx tsc --noEmit` limpo.

- [ ] **Passo 5: Commit**

```bash
git add src/lib/detectores.ts src/app/api/motor/route.ts src/lib/detectores.test.ts
git commit -m "fix(desvio): remove fim-de-horario como fechamento automatico -- so comportamento resolve"
```

---

### Task 7: Corredor confirmando "dentro" fecha o alerta JÁ ativo no mesmo ciclo

**Achado de hoje:** o bloco de corredor (route.ts) hoje só afeta `alerta`/`desvioStreak`/`desvioInicio` em memória (pro próximo ciclo) — nunca alimenta `estaForaDeRota`, que já foi calculado ANTES desse bloco rodar. Um desvio confirmado "dentro" pelo corredor continua "ativo" na tela até bater alguma OUTRA régua de resolução (aproximação sustentada ou <2,5km). Confirmado por 2 agentes independentes hoje.

**Files:**
- Modify: `src/app/api/motor/route.ts` (~linha 996-997 vira `let`, blocos "dentro" ~linha 1174-1198)

Sem teste automatizado direto (motor não tem harness) — QA manual obrigatório: forçar um "dentro" via corredor com um alerta já ativo no banco e confirmar que fecha no mesmo ciclo.

- [ ] **Passo 1: Implementar**

Trocar `const estaForaDeRota` por `let estaForaDeRota` (linha ~996).

Nos DOIS branches "dentro" do bloco de corredor (cache-hit ~linha 1174-1179, e verificação ao vivo ~linha 1188-1198), adicionar `estaForaDeRota = false;` junto das outras atribuições:
```ts
            if (cacheValido && cache && dentroDoCorredor(pos, cache.polilinha, bufferPorVelocidade(pos.velocidade))) {
              cache.ultimoDentro = { lat: pos.lat, lng: pos.lng };
              corredorInfo = { veredito: "dentro", bufferM: bufferPorVelocidade(pos.velocidade) };
              alerta = null;
              desvioStreak = 0;
              desvioInicio = null;
              estaForaDeRota = false;   // NOVO: fecha o alerta ja ativo neste mesmo ciclo
            } else if (verificacoesCorredorNoCiclo < MAX_VERIFICACOES_POR_CICLO) {
              ...
              if (r.veredito === "dentro" && r.corredor) {
                cacheCorredorPorVeiculo.set(veiculo_id, {...});
                alerta = null;
                desvioStreak = 0;
                desvioInicio = null;
                estaForaDeRota = false;   // NOVO
              } else if (r.veredito === "fora") {
                ...
              }
            }
```

- [ ] **Passo 2: Validar**

`npx tsc --noEmit` limpo. `npx vitest run` — 349 passam (nada de lógica pura tocada).

- [ ] **Passo 3: Commit**

```bash
git add src/app/api/motor/route.ts
git commit -m "fix(desvio): corredor confirmando 'dentro' fecha o alerta ja ativo no mesmo ciclo, nao so evita recriacao"
```

---

### Task 8: Proteger `desvio` dos mecanismos de fechamento cegos (20h e sem-comunicação)

**Files:**
- Modify: `src/app/api/motor/route.ts` (~linha 1502, ~linha 1711)

- [ ] **Passo 1: Implementar**

Mecanismo "sem comunicação" (~linha 1502):
```ts
// ANTES:
            AND a.tipo NOT IN ('favela', 'jammer', 'panico')

// DEPOIS:
            -- desvio adicionado 10/07: cortar o sinal pode ser um roubo em
            -- andamento, mesmo criterio ja usado pra favela/jammer/panico.
            AND a.tipo NOT IN ('favela', 'jammer', 'panico', 'desvio')
```

Mecanismo "fim de expediente 20h" (~linha 1711-1712):
```ts
// ANTES:
              AND tipo IN ('saida_nao_autorizada','parada_longa','parada_anomala',
                           'parada_cliente','excesso','desvio')

// DEPOIS:
              -- desvio removido 10/07: fechava alertas reais so por bater
              -- 20h, sem checar comportamento (achado real: 210+ alertas
              -- de desvio fechados assim em 5 dias). Desvio agora so fecha
              -- por evidencia (Task 6/7) ou resolucao manual do operador.
              AND tipo IN ('saida_nao_autorizada','parada_longa','parada_anomala',
                           'parada_cliente','excesso')
```

- [ ] **Passo 2: Validar**

`npx tsc --noEmit` limpo (mudança só em template string SQL). `npx vitest run` — 349 passam.

- [ ] **Passo 3: Commit**

```bash
git add src/app/api/motor/route.ts
git commit -m "fix(desvio): remove desvio dos fechamentos cegos por horario e por falta de sinal"
```

---

### Task 9: Corrigir `simular()` pra usar a histerese REAL (fim da cobertura falsa)

**Achado de hoje (auditoria de teste):** `simular()` em `desvio-cenarios.test.ts` reimplementa a lógica de streak de forma simplificada (zera na hora ao aproximar), diferente da histerese real (`avancarStreaksDesvio`, 1 aproximação isolada CONGELA, só 2 zeram). Os 16 cenários "realistas" desse arquivo não validam o comportamento real de produção.

**Files:**
- Modify: `src/lib/desvio-cenarios.test.ts` (função `simular()`)

- [ ] **Passo 1: Ler a implementação atual de `simular()` e localizar o bloco de streak inline**

(Passo de investigação, não de código — confirmar linhas exatas antes de editar, já que o arquivo pode ter mudado após as Tasks 3/9 anteriores.)

- [ ] **Passo 2: Substituir a lógica de streak inline por chamadas reais**

Trocar o cálculo manual de `streak` dentro de `simular()` por uma chamada a `avancarStreaksDesvio(afastouDeTudo(...), { desvioStreak, aproximandoStreak })`, mantendo `aproximandoStreak` como estado acumulado ao longo dos ciclos (hoje `simular()` nem calcula isso). Repassar `ctx.streak` e (se algum cenário depender de resolução) considerar `foraDeRota` também, mantendo a interface pública de `simular()` (assinatura, retorno) inalterada — só a lógica INTERNA muda pra usar as funções reais em vez da reimplementação simplificada.

- [ ] **Passo 3: Rodar a suite inteira e comparar resultados**

`npx vitest run src/lib/desvio-cenarios.test.ts` — ATENÇÃO: alguns dos 16 cenários existentes podem mudar de resultado (a histerese real congela onde a simulação antiga zerava). Cada cenário que mudar precisa ser analisado: o resultado NOVO é o comportamento correto de produção (ajustar o `expect`), ou o cenário em si ficou sem sentido com a histerese real (ajustar o cenário)? Documentar a decisão em comentário no teste alterado.

- [ ] **Passo 4: Rodar suite completa do projeto**

`npx vitest run` — todos os 349 (+ ajustes desta task) passam.

- [ ] **Passo 5: Commit**

```bash
git add src/lib/desvio-cenarios.test.ts
git commit -m "test(desvio): simular() usa a historese real (avancarStreaksDesvio) em vez de logica simplificada"
```

---

### Task 10: Validação final e deploy

- [ ] **Passo 1: Validação completa**

```bash
npx tsc --noEmit
npx vitest run
npx eslint src/lib/detectores.ts src/lib/corredor-verificacao.ts src/app/api/motor/route.ts src/lib/detectores.test.ts src/lib/desvio-cenarios.test.ts
npm run build
```
Todos limpos antes de prosseguir.

- [ ] **Passo 2: Push**

```bash
git push origin main
```

- [ ] **Passo 3: Validação em produção**

Via Vercel MCP: confirmar deploy READY, `get_runtime_errors` limpo. Depois, com dado real (mesmo padrão de query usado a sessão inteira): confirmar que (a) desvio continua sendo detectado normalmente (comparar volume com dias anteriores), (b) nenhum alerta de desvio real foi fechado por horário desde o deploy, (c) ao menos um alerta de desvio (se houver) tem `contexto.corredor` preenchido.

- [ ] **Passo 4: Atualizar ESTADO.md e docs/analise-deteccao.md**

Registrar os 10 itens corrigidos, os achados que ficaram documentados mas FORA de escopo (apagão de 20h, score combinado, cobertura de sábado/madrugada, dado O-D contaminado) como próxima fase.
