# Fusao de sinais, calibracao ao vivo e reducao de conservadorismo Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Fechar o loop de calibracao, fazer os detectores de desvio se corroborarem em vez de so competir, corrigir o ponto cego do bypass de entrega, corrigir a autopoluicao do baseline, e reduzir 3 pontos de conservadorismo excessivo encontrados numa revisao linha por linha do codigo (parada subita sem cobertura, Camada 3 desligada, teto interurbano baixo).

**Architecture:** Oito tarefas independentes, ordenadas por risco (mudancas mecanicas e contidas primeiro, a mudanca estrutural no nucleo de arbitragem por ultimo). A maior parte e ajuste de constante + testes; uma tarefa (Fusao de sinais) extrai uma funcao de arbitragem ja existente (hoje inline dentro de `avaliar()`) pra um lugar reusavel e compartilhado entre `avaliar()` e o loop de "extras" do motor.

**Tech Stack:** Next.js 16 (App Router) + TypeScript, Supabase Postgres/PostGIS, Vitest, `pg` direto via `DATABASE_URL`.

## Global Constraints

- TDD obrigatorio: teste RED antes do codigo, GREEN depois, em toda funcao pura nova/alterada.
- Antes de cada commit: `npx vitest run` (suite completa), `npx tsc --noEmit`, `npx eslint <arquivos tocados>`, `npm run build`. Todos limpos.
- Nunca usar travessao (—) em codigo, comentarios, commits ou docs deste projeto.
- Commit por tarefa, com `git push origin main` so no final (esta branch e local ate o merge, ver Execucao).
- A Tarefa 6 (fusao de sinais) mexe no nucleo de arbitragem usado por TODOS os tipos de alerta (nao so desvio) -- apos ela, rodar a suite completa multiplas vezes e reservar auditoria adversarial extra antes do merge.

---

## Visao geral das tarefas

| Tarefa | O que entrega | Risco |
|---|---|---|
| 1 | Bypass de entrega rastreado por endereco (`pontoCodigo`), nao por nota fiscal (`codigo`) | Baixo |
| 2 | Baseline nao incorpora a propria leitura anomala enquanto o evento persiste | Baixo |
| 3 | Parada anomala dispara mais cedo (12min cidade / 20min estrada, era 20/35) | Baixo-medio (limiar ja foi mais agressivo antes e foi revertido) |
| 4 | Camada 3 (via nunca percorrida pela frota) religada | Medio |
| 5 | Teto de deslocamento interurbano sobe de 80km pra 300km | Baixo |
| 6 | Fusao de sinais: `avaliar()` para de ser pulada quando ha jammer; arbitragem vira funcao reusavel com bonus de corroboracao | **Alto** |
| 7 | Transito inferido pela propria frota reduz severidade de desvio em rodovia corroborado | Medio |
| 8 | Calibracao ao vivo: taxa de falso positivo calibrada ajusta o score final | Baixo |

---

## Tarefa 1: Bypass de entrega por endereco, nao por nota fiscal

**Files:**
- Modify: `src/app/api/motor/route.ts:1397-1440` (bloco "Bypass de entrega sem parar")

**Interfaces:**
- Nao produz nem consome interface nova -- so muda qual campo de `PontoEntrega` (`src/lib/unitrac.ts:82-99`) e usado como chave de identidade. `pontoCodigo: number | null` ja existe no tipo.

- [ ] **Step 1: Ler o bloco atual completo**

Confirmar (`route.ts:1397-1440`) que o bloco usa `pt.codigo` (numero da nota fiscal) tanto na comparacao `alvoNoRaioAgora.codigo === codigoAnteriorNoRaio` (linha 1404, `mesmoAlvoQueAntes`) quanto na atribuicao `noRaioAlvoCodigo = alvoNoRaioAgora?.codigo` (linha 1407) e na busca `alvoQueSaiu = ... pt.codigo === codigoAnteriorNoRaio` (linha 1427).

- [ ] **Step 2: Trocar `codigo` por `pontoCodigo` nos 4 pontos**

Em `route.ts`, trocar:

```ts
          const codigoAnteriorNoRaio = anterior?.no_raio_alvo_codigo ?? null;
          const desdeAnterior = anterior?.no_raio_desde ?? null;
          const dwellAnterior = anterior?.no_raio_dwell_segundos ?? 0;

          const mesmoAlvoQueAntes = alvoNoRaioAgora !== null && alvoNoRaioAgora.codigo === codigoAnteriorNoRaio;
```

por:

```ts
          // Achado real 12/07: identificar o alvo por `codigo` (NF) fazia
          // varias NFs pendentes no MESMO ENDERECO resetarem o cronometro
          // de dwell so porque uma NF especifica foi confirmada, mesmo sem
          // o veiculo ter saido fisicamente do lugar. `pontoCodigo` (endereco
          // fisico) e estavel entre NFs diferentes do mesmo ponto.
          const codigoAnteriorNoRaio = anterior?.no_raio_alvo_codigo ?? null;
          const desdeAnterior = anterior?.no_raio_desde ?? null;
          const dwellAnterior = anterior?.no_raio_dwell_segundos ?? 0;

          const mesmoAlvoQueAntes = alvoNoRaioAgora !== null && alvoNoRaioAgora.pontoCodigo === codigoAnteriorNoRaio;
```

Depois, trocar:

```ts
          let noRaioAlvoCodigo: number | null = alvoNoRaioAgora?.codigo ?? null;
```

por:

```ts
          let noRaioAlvoCodigo: number | null = alvoNoRaioAgora?.pontoCodigo ?? null;
```

E trocar:

```ts
          const alvoQueSaiu = (pontosVeiculo ?? []).find((pt) => pt.codigo === codigoAnteriorNoRaio) ?? null;
```

por:

```ts
          const alvoQueSaiu = (pontosVeiculo ?? []).find((pt) => pt.pontoCodigo === codigoAnteriorNoRaio) ?? null;
```

A coluna `no_raio_alvo_codigo` (migration 017, tipo `int`) nao muda de schema -- so passa a guardar `pontoCodigo` em vez de `codigo`, ambos `number | null`.

- [ ] **Step 3: Atualizar o comentario de limitacao conhecida**

Substituir o comentario que descreve a limitacao (linhas ~1387-1396, comeca com "Limitacao conhecida (aceita por ora...)") por:

```ts
          // Achado real 12/07: identificado por pontoCodigo (endereco), nao
          // mais por codigo (NF) -- varias NFs pendentes no mesmo endereco
          // NAO resetam mais o cronometro de dwell. Limitacao residual
          // aceita: dois ENDERECOS FISICAMENTE DIFERENTES com raio
          // sobreposto ainda podem esconder o bypass do mais distante
          // (.find() pega o primeiro que bate) -- caso raro (exigiria dois
          // clientes de entrega a poucos metros um do outro), resolver
          // exigiria checar todos os pontos simultaneamente, complexidade
          // desproporcional pro caso.
```

- [ ] **Step 4: Validar**

Run: `npx tsc --noEmit && npx eslint src/app/api/motor/route.ts && npm run build`
Expected: sem erros.

- [ ] **Step 5: Rodar suite completa e commitar**

```bash
npx vitest run
git add src/app/api/motor/route.ts
git commit -m "fix(desvio): bypass de entrega rastreia por endereco, nao por nota fiscal"
```

---

## Tarefa 2: Baseline nao incorpora a propria leitura anomala

**Files:**
- Modify: `src/app/api/motor/route.ts:1250-1260`

**Interfaces:**
- Consumes: `alertaBaseline` (ja calculado nas linhas 1250-1257, `detectarAnomaliaBaseline` de `src/lib/detectores.ts`).

- [ ] **Step 1: Ler o bloco atual**

Confirmar (`route.ts:1250-1260`) que `amostrasBaselineCiclo.push(...)` roda incondicionalmente sempre que `pos.fresco && pos.velocidade > 0`, independente do resultado de `alertaBaseline`.

- [ ] **Step 2: So empurrar a amostra quando a leitura NAO for anomala**

Trocar:

```ts
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

por:

```ts
          const alertaBaseline = pos.fresco && pos.velocidade > 0
            ? detectarAnomaliaBaseline({
                velocidadeMediaViagemKmh: pos.velocidade,
                baselineProprio,
                baselineFrota: baselineFrotaAtual,
                minAmostrasProprio: 20,
              })
            : null;
          // Achado real 12/07 (autopoluicao confirmada com dado de producao,
          // TTH-6G37: z-score caiu de 14.5 pra 3.5 em 10min na MESMA
          // velocidade): uma leitura sinalizada como anomala neste ciclo NAO
          // entra no baseline -- ele "congela" durante o evento suspeito e
          // volta a incorporar amostras normais assim que a leitura deixar
          // de ser anomala. Sem isso, o evento anomalo sustentado acabava
          // "acostumando" o proprio baseline com ele mesmo.
          if (pos.fresco && pos.velocidade > 0 && alertaBaseline === null) {
            amostrasBaselineCiclo.push({ veiculo_id, cliente_id, tipoViagem, velocidade: pos.velocidade });
          }
```

- [ ] **Step 3: Validar**

Run: `npx tsc --noEmit && npx eslint src/app/api/motor/route.ts && npm run build`

- [ ] **Step 4: Rodar suite completa e commitar**

```bash
npx vitest run
git add src/app/api/motor/route.ts
git commit -m "fix(desvio): baseline nao incorpora a propria leitura anomala (autopoluicao)"
```

---

## Tarefa 3: Parada anomala dispara mais cedo

**Files:**
- Modify: `src/lib/detectores.ts:280-283`
- Modify: `src/lib/detectores.test.ts` (adicionar testes de boundary, arquivo ja importa `detectarParadaAnomala`)

**Interfaces:**
- Nao muda assinatura de `detectarParadaAnomala`, so os valores internos de `limiteMin`.

- [ ] **Step 1: Escrever os testes de boundary que falham (RED)**

Os testes existentes (`detectores.test.ts:828-852`, describe "detectarParadaAnomala - supressao por congestionamento") usam `paradoMin: 25` com `estavEmMovimento: true`, que fica ACIMA tanto do limiar antigo (20) quanto do novo (12) -- nao provam a mudanca. Adicionar, no mesmo arquivo, um describe novo logo depois desse bloco (apos a linha 852):

```ts

describe("detectarParadaAnomala - limiares baixados 12/07 (menos conservador)", () => {
  const base = {
    emOperacao: true,
    foraDaBase: true,
    noCliente: false,
    esMadrugada: false,
    emZonaRisco: false,
    temPOIProximo: false,
    jaParedoNoCicloAnterior: true,
    vizinhosParados: 0,
  };

  // Historico: 12/25min ja foram tentados e revertidos pra 20/35 porque
  // disparavam pra praticamente qualquer parada em transito pesado do RJ
  // (ver comentario em detectores.ts). O novo valor (12/20) fica no limite
  // do que ja foi tentado pra cidade e um meio-termo pra estrada -- mais
  // conservador que repetir exatamente o par que ja falhou (12/25).
  it("cidade, 15min parado (entre o novo 12 e o antigo 20): dispara agora", () => {
    const a = detectarParadaAnomala({ ...base, paradoMin: 15, estavEmMovimento: true });
    expect(a).not.toBeNull();
  });

  it("cidade, 10min parado (abaixo do novo minimo): ainda nao dispara", () => {
    expect(detectarParadaAnomala({ ...base, paradoMin: 10, estavEmMovimento: true })).toBeNull();
  });

  it("estrada, 22min parado (entre o novo 20 e o antigo 35): dispara agora", () => {
    const a = detectarParadaAnomala({ ...base, paradoMin: 22, estavEmMovimento: false });
    expect(a).not.toBeNull();
  });

  it("estrada, 18min parado (abaixo do novo minimo): ainda nao dispara", () => {
    expect(detectarParadaAnomala({ ...base, paradoMin: 18, estavEmMovimento: false })).toBeNull();
  });
});
```

- [ ] **Step 2: Rodar e confirmar RED**

Run: `npx vitest run src/lib/detectores.test.ts`
Expected: FAIL nos 2 testes "dispara agora" (15min cidade e 22min estrada), PASS nos 2 testes "ainda nao dispara".

- [ ] **Step 3: Baixar os limiares**

Em `src/lib/detectores.ts`, trocar:

```ts
  // 20 min em cidade (vinha de >= 30km/h), 35 min em estrada — limites anteriores
  // (12/25 min) disparavam para praticamente qualquer parada em trânsito pesado do RJ.
  const limiteMin = ctx.estavEmMovimento ? 20 : 35;
```

por:

```ts
  // Baixado de 20/35 pra 12/20 em 12/07 (revisao linha por linha a pedido do
  // usuario, buscando desvio real passando batido por excesso de cautela --
  // "um roubo tipico acontece em 10-20min" ja documentado acima, e 20/35
  // estava na borda ou depois disso). ATENCAO: os valores 12/25 ja foram
  // tentados ANTES e revertidos pra 20/35 porque disparavam pra
  // praticamente qualquer parada em transito pesado do RJ -- o novo par
  // (12/20) fica no limite do que ja foi tentado pra cidade e mais
  // conservador que repetir o par exato que falhou pra estrada. Se
  // reproduzir ruido de transito pesado, e uma reversao facil (1 linha) e
  // o monitoramento periodico ja em andamento vai pegar isso.
  const limiteMin = ctx.estavEmMovimento ? 12 : 20;
```

- [ ] **Step 4: Rodar e confirmar GREEN**

Run: `npx vitest run src/lib/detectores.test.ts`
Expected: PASS, todos os testes do arquivo.

- [ ] **Step 5: Validar e commitar**

```bash
npx tsc --noEmit && npx eslint src/lib/detectores.ts src/lib/detectores.test.ts
npx vitest run
git add src/lib/detectores.ts src/lib/detectores.test.ts
git commit -m "feat(desvio): baixa limiares de parada anomala de 20/35 pra 12/20min"
```

---

## Tarefa 4: Religar a Camada 3 (via nunca percorrida pela frota)

**Files:**
- Modify: `src/lib/detectores.ts:340`
- Modify: `src/lib/detectores.test.ts:283-288,498-501` (2 testes precisam mudar de expectativa)
- Modify: `src/lib/desvio-cenarios.test.ts:134-146,353-361` (2 testes precisam mudar de expectativa)

**Interfaces:**
- Nao muda assinatura de nada, so o valor de `CAMADA3_TAPETE_ATIVA`.

- [ ] **Step 1: Confirmar RED olhando os testes que vao mudar de comportamento**

Rodar a suite ANTES de qualquer mudanca pra ter a baseline:

Run: `npx vitest run src/lib/detectores.test.ts src/lib/desvio-cenarios.test.ts`
Expected: todos passando (comportamento atual, Camada 3 desligada).

- [ ] **Step 2: Religar a flag**

Em `src/lib/detectores.ts:340`, trocar:

```ts
const CAMADA3_TAPETE_ATIVA = false;
```

por:

```ts
// Religada em 12/07/2026 apos revisao linha por linha a pedido do usuario.
// Causa raiz do incidente de 09/07 que motivou a desativacao (o alerta
// FECHAVA sozinho e reabria a cada ~2min, indistinguivel de bug) ja foi
// corrigida em 11/07 (desvio nunca mais fecha sozinho, commit 1a23048).
// Residual esperado: mais alertas em rotas rurais/serra com tapete esparso
// -- falso positivo que FAZ SENTIDO (fica aberto aguardando o operador, nao
// pisca), aceitavel pela diretiva do usuario. Cobertura minima POR REGIAO
// (nao so por cliente inteiro, ja proposta em docs/analise-deteccao.md
// 09/07) fica FORA de escopo deste ciclo -- resolveria a esparsidade rural
// de forma mais fina, mas e um projeto proprio.
const CAMADA3_TAPETE_ATIVA = true;
```

- [ ] **Step 3: Rodar a suite e ver exatamente o que quebrou**

Run: `npx vitest run src/lib/detectores.test.ts src/lib/desvio-cenarios.test.ts`
Expected: FAIL em 4 testes especificos (ver Steps 4-7).

- [ ] **Step 4: Corrigir teste 1 (`detectores.test.ts:283-288`)**

Trocar:

```ts
  it("streak 2 fora do tapete, CAMADA3_TAPETE_ATIVA=false: critico, mas NAO escala por tapete (zumbi fechado 10/07)", () => {
    const a = detectarDesvio(emMov, { ...base, dentroTapete: false });
    expect(a?.nivel).toBe("critico");
    expect(a?.score).toBe(45);
    expect(a?.motivo).not.toContain("fora de via conhecida");
  });
```

por:

```ts
  it("streak 2 fora do tapete, Camada 3 ATIVA (religada 12/07): escala pra 80, motivo cita via desconhecida", () => {
    const a = detectarDesvio(emMov, { ...base, dentroTapete: false });
    expect(a?.nivel).toBe("critico");
    expect(a?.score).toBe(80);
    expect(a?.motivo).toContain("fora de via conhecida");
  });
```

- [ ] **Step 5: Corrigir teste 2 (`detectores.test.ts:498-501`)**

Trocar:

```ts
  it("mesmo fora do tapete por varias leituras: NAO dispara enquanto CAMADA3_TAPETE_ATIVA=false", () => {
    const a = detectarDesvio(emMov2, { ...baseAproximando, foraTapeteStreak: 8 });
    expect(a).toBeNull();
  });
```

por:

```ts
  it("fora do tapete por varias leituras, Camada 3 ATIVA (religada 12/07): dispara", () => {
    const a = detectarDesvio(emMov2, { ...baseAproximando, foraTapeteStreak: 8 });
    expect(a).not.toBeNull();
    expect(a?.motivo).toContain("nunca percorreu");
  });
```

- [ ] **Step 6: Corrigir teste 3 (`desvio-cenarios.test.ts:134-146`)**

Trocar:

```ts
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
    expect(resultados[2]?.score).toBe(45); // streak chega a 2 no indice 2
    expect(resultados[2]?.motivo).not.toContain("fora de via conhecida");
  });
```

por:

```ts
  it("fora do tapete, Camada 3 ATIVA (religada 12/07): escala pra 80", () => {
    const ciclos: Ciclo[] = Array.from({ length: 3 }, (_, i) => ({
      ...afastarDe(MANGUINHOS, REALENGO, i * 0.01),
      dentroTapete: false,
      riscoAreaAtual: 0,
    }));
    const resultados = simular(REALENGO, ciclos);
    expect(resultados[1]?.score).toBe(80); // streak 1 ja dispara (persistencia minima 11/07)
    expect(resultados[2]?.score).toBe(80);
    expect(resultados[2]?.motivo).toContain("fora de via conhecida");
  });
```

- [ ] **Step 7: Corrigir teste 4 (`desvio-cenarios.test.ts:353-361`)**

Trocar:

```ts
  it("mesmo fora do tapete por varias leituras seguidas: NAO dispara enquanto CAMADA3_TAPETE_ATIVA=false", () => {
    const fracoes = [0, 0.3, 0.6];
    const ciclos: Ciclo[] = fracoes.map((f, i) => ({
      ...aproximarDe(MANGUINHOS, REALENGO, f),
      foraTapeteStreak: i,
    }));
    const resultados = simular(REALENGO, ciclos);
    expect(resultados.every(r => r === null)).toBe(true);
  });
```

por:

```ts
  it("fora do tapete por varias leituras seguidas, Camada 3 ATIVA (religada 12/07): dispara ao atingir o minimo", () => {
    const fracoes = [0, 0.3, 0.6];
    const ciclos: Ciclo[] = fracoes.map((f, i) => ({
      ...aproximarDe(MANGUINHOS, REALENGO, f),
      foraTapeteStreak: i,
    }));
    const resultados = simular(REALENGO, ciclos);
    expect(resultados[0]).toBeNull(); // foraTapeteStreak 0
    expect(resultados[1]).toBeNull(); // foraTapeteStreak 1, abaixo do minimo (2)
    expect(resultados[2]).not.toBeNull(); // foraTapeteStreak 2, atinge o minimo
    expect(resultados[2]?.motivo).toContain("nunca percorreu");
  });
```

- [ ] **Step 8: Rodar a suite completa e confirmar GREEN**

Run: `npx vitest run`
Expected: PASS, todos os testes.

- [ ] **Step 9: Validar e commitar**

```bash
npx tsc --noEmit && npx eslint src/lib/detectores.ts src/lib/detectores.test.ts src/lib/desvio-cenarios.test.ts
npm run build
git add src/lib/detectores.ts src/lib/detectores.test.ts src/lib/desvio-cenarios.test.ts
git commit -m "feat(desvio): religa a Camada 3 (via nunca percorrida pela frota)"
```

---

## Tarefa 5: Teto de deslocamento interurbano sobe pra 300km

**Files:**
- Modify: `src/lib/detectores.ts:317`
- Modify: `src/lib/detectores.test.ts:365-372`
- Modify: `src/lib/desvio-cenarios.test.ts:321-341`

**Interfaces:**
- Nao muda assinatura de nada, so o valor de `DESVIO_GATILHO_TETO_M`.

**Nota de ordem:** esta tarefa depende da Tarefa 4 ja ter sido feita (Camada 3 ativa) -- alguns cenarios de teste abaixo usam `dentroTapete: false`, que agora escala pra score 80 (nao mais 45) por causa da Tarefa 4.

- [ ] **Step 1: Corrigir o teste que fixava o teto antigo (`detectores.test.ts:365-372`)**

Trocar:

```ts
  it("acima do teto de deslocamento interurbano (80km) nao dispara", () => {
    // Subido de 25km pra 80km em 11/07 (diretiva explicita: falso positivo
    // aceitavel) -- 25km cortava desvio real em clientes com rota longa de
    // verdade (Nutry atende Angra dos Reis, Volta Redonda).
    expect(detectarDesvio(emMov, {
      ...base, distDestinosM: [90000, 95000], distDestinosAnteriorM: [89000, 94000],
    })).toBeNull();
  });
```

por:

```ts
  it("entre o teto antigo (80km) e o novo (300km): dispara agora", () => {
    const a = detectarDesvio(emMov, {
      ...base, distDestinosM: [90000, 95000], distDestinosAnteriorM: [89000, 94000],
    });
    expect(a).not.toBeNull();
  });

  it("acima do novo teto de deslocamento interurbano (300km) nao dispara", () => {
    // Subido de 80km pra 300km em 12/07 (revisao linha por linha a pedido
    // do usuario): 80km ainda escondia desvio de verdade acima disso --
    // cobre confortavelmente qualquer entrega dentro do RJ e estados
    // vizinhos (SP, MG, ES), mantendo so um piso de sanidade contra GPS
    // corrompido.
    expect(detectarDesvio(emMov, {
      ...base, distDestinosM: [350000, 355000], distDestinosAnteriorM: [349000, 354000],
    })).toBeNull();
  });
```

- [ ] **Step 2: Rodar e confirmar RED**

Run: `npx vitest run src/lib/detectores.test.ts`
Expected: FAIL no teste "entre o teto antigo e o novo" (ainda null com o valor atual de 80000), PASS no teste "acima do novo teto" (350km ja era null antes e continua null).

- [ ] **Step 3: Subir a constante**

Em `src/lib/detectores.ts:317`, trocar:

```ts
const DESVIO_GATILHO_TETO_M = 80000;
```

por:

```ts
// Subido de 80km pra 300km em 12/07 (revisao linha por linha a pedido do
// usuario, buscando desvio real passando batido por excesso de cautela):
// 80km ainda era um teto ABSOLUTO que escondia desvio de verdade acima
// disso. 300km cobre confortavelmente qualquer entrega dentro do RJ e
// estados vizinhos (SP, MG, ES), mantendo so um piso de sanidade contra
// leitura de GPS corrompida (coordenada absurda).
const DESVIO_GATILHO_TETO_M = 300000;
```

- [ ] **Step 4: Rodar e confirmar GREEN**

Run: `npx vitest run src/lib/detectores.test.ts`
Expected: PASS.

- [ ] **Step 5: Corrigir os testes de cenario (`desvio-cenarios.test.ts:321-341`)**

Trocar o bloco inteiro:

```ts
  it("DESLOCAMENTO INTERURBANO legitimo (destino > 80km): nao dispara mesmo se afastando", () => {
    // Teto subido de 25km pra 80km em 11/07 (ver DESVIO_GATILHO_TETO_M) --
    // 45km (antigo cenario deste teste) agora e desvio local de verdade
    // (rota longa legitima da Nutry, ex. Angra dos Reis/Volta Redonda), so
    // acima de 80km e que continua sendo deslocamento interurbano puro.
    const destinoLonge = { lat: MANGUINHOS.lat + 0.8, lng: MANGUINHOS.lng + 0.8 }; // ~120km
    const ciclos: Ciclo[] = Array.from({ length: 3 }, (_, i) => ({
      lat: MANGUINHOS.lat - i * 0.01, lng: MANGUINHOS.lng - i * 0.01, dentroTapete: false,
    }));
    const resultados = simular(destinoLonge, ciclos);
    expect(resultados.every(r => r === null)).toBe(true);
  });

  it("DESLOCAMENTO local legitimo antigo (destino ~45km, entre o teto velho 25km e o novo 80km): dispara agora", () => {
    const destinoMedio = { lat: MANGUINHOS.lat + 0.3, lng: MANGUINHOS.lng + 0.3 }; // ~45km
    const ciclos: Ciclo[] = Array.from({ length: 3 }, (_, i) => ({
      lat: MANGUINHOS.lat - i * 0.01, lng: MANGUINHOS.lng - i * 0.01, dentroTapete: false,
    }));
    const resultados = simular(destinoMedio, ciclos);
    expect(resultados.some(r => r !== null)).toBe(true);
  });
});
```

por:

```ts
  it("DESLOCAMENTO INTERURBANO legitimo (destino > 300km): nao dispara mesmo se afastando", () => {
    // Teto subido de 80km pra 300km em 12/07 (ver DESVIO_GATILHO_TETO_M) --
    // 120km (antigo cenario deste teste) agora e desvio local de verdade,
    // so acima de 300km e que continua sendo deslocamento interurbano puro.
    const destinoLonge = { lat: MANGUINHOS.lat + 3.0, lng: MANGUINHOS.lng + 3.0 }; // ~450km
    const ciclos: Ciclo[] = Array.from({ length: 3 }, (_, i) => ({
      lat: MANGUINHOS.lat - i * 0.01, lng: MANGUINHOS.lng - i * 0.01, dentroTapete: false,
    }));
    const resultados = simular(destinoLonge, ciclos);
    expect(resultados.every(r => r === null)).toBe(true);
  });

  it("DESLOCAMENTO legitimo antigo (destino ~120km, entre o teto velho 80km e o novo 300km): dispara agora", () => {
    // Camada 3 ja ativa (Tarefa 4): dentroTapete=false escala pra score 80,
    // nao mais 45 -- so verificamos que ALGUM alerta dispara, sem fixar score.
    const destinoMedio = { lat: MANGUINHOS.lat + 0.8, lng: MANGUINHOS.lng + 0.8 }; // ~120km
    const ciclos: Ciclo[] = Array.from({ length: 3 }, (_, i) => ({
      lat: MANGUINHOS.lat - i * 0.01, lng: MANGUINHOS.lng - i * 0.01, dentroTapete: false,
    }));
    const resultados = simular(destinoMedio, ciclos);
    expect(resultados.some(r => r !== null)).toBe(true);
  });
});
```

- [ ] **Step 6: Rodar a suite completa e confirmar GREEN**

Run: `npx vitest run`
Expected: PASS, todos os testes.

- [ ] **Step 7: Validar e commitar**

```bash
npx tsc --noEmit && npx eslint src/lib/detectores.ts src/lib/detectores.test.ts src/lib/desvio-cenarios.test.ts
npm run build
git add src/lib/detectores.ts src/lib/detectores.test.ts src/lib/desvio-cenarios.test.ts
git commit -m "feat(desvio): sobe teto de deslocamento interurbano de 80km pra 300km"
```

---

## Tarefa 6: Fusao de sinais (arbitragem reusavel + corroboracao)

**Files:**
- Modify: `src/lib/detectores.ts:934-1039` (funcao `avaliar`)
- Modify: `src/lib/detectores.test.ts` (novos testes pra `arbitrarCandidatos`)
- Modify: `src/app/api/motor/route.ts:1449-1481` (short-circuit do jammer) e `route.ts:1580-1597` (loop de extras)

**Interfaces:**
- Produces: `arbitrarCandidatos(candidatos: Alerta[]): Alerta | null`, exportada de `detectores.ts`. Usada por `avaliar()` internamente E por `route.ts` no lugar do loop de extras.

**Achado que motiva esta tarefa:** `avaliar()` (`detectores.ts:934-1039`) JA inclui `detectarJammer(p)` (linha 970) e `detectarDesvio(...)` (linhas 1013-1029) como candidatos no MESMO array, arbitrados pelo MESMO reduce final (linhas 1032-1038) -- ou seja, jammer e desvio JA corroborariam naturalmente se `avaliar()` fosse sempre chamada. O problema real esta em `route.ts:1449`: `let alerta = alertaJammer ? alertaJammer : (pos.fresco ? avaliar(...) : null)` pula `avaliar()` INTEIRA quando ha jammer, entao o proprio jammer+desvio interno de `avaliar()` nunca chega a rodar.

- [ ] **Step 1: Escrever os testes que falham pra `arbitrarCandidatos`**

Adicionar em `src/lib/detectores.test.ts`, apos a importacao existente, incluir `arbitrarCandidatos` na lista de imports de `./detectores`. Depois, no fim do arquivo, adicionar:

```ts

describe("arbitrarCandidatos (fusao de sinais corroborantes, 12/07)", () => {
  const alertaBase = (tipo: string, score: number, nivel: "critico" | "atencao" = "critico"): Alerta => ({
    nivel, tipo, motivo: `motivo de ${tipo}`, score,
  });

  it("1 candidato so: retorna ele sem alteracao", () => {
    const a = arbitrarCandidatos([alertaBase("jammer", 80)]);
    expect(a?.score).toBe(80);
    expect(a?.motivo).toBe("motivo de jammer");
  });

  it("lista vazia: retorna null", () => {
    expect(arbitrarCandidatos([])).toBeNull();
  });

  it("2 candidatos SEM corroboracao relevante (retorno_tardio + parada_longa): maior score vence, sem bonus", () => {
    const a = arbitrarCandidatos([alertaBase("retorno_tardio", 40), alertaBase("parada_longa", 50)]);
    expect(a?.score).toBe(50);
    expect(a?.motivo).toBe("motivo de parada_longa");
  });

  it("2 candidatos DO conjunto relevante (jammer + desvio): corrobora, soma +15, enriquece motivo", () => {
    const a = arbitrarCandidatos([alertaBase("jammer", 80), alertaBase("desvio", 45)]);
    expect(a?.score).toBe(95); // 80 + 15
    expect(a?.motivo).toContain("motivo de jammer");
    expect(a?.motivo).toContain("corroborado por");
    expect(a?.motivo).toContain("desvio");
  });

  it("3 candidatos do conjunto relevante (jammer + desvio + baseline_veiculo): bonus dobrado (+30)", () => {
    const a = arbitrarCandidatos([alertaBase("jammer", 60), alertaBase("desvio", 45), alertaBase("baseline_veiculo", 35, "atencao")]);
    expect(a?.score).toBe(90); // 60 + 30
  });

  it("score nunca passa de 100 mesmo com muitos sinais corroborando", () => {
    const a = arbitrarCandidatos([
      alertaBase("jammer", 90), alertaBase("desvio", 80),
      alertaBase("bypass_entrega", 40, "atencao"), alertaBase("baseline_veiculo", 35, "atencao"),
    ]);
    expect(a?.score).toBe(100);
  });

  it("desvio de duas fontes (desvio + cerca, ambos tipo=desvio) conta como 1 tipo so, nao corrobora sozinho", () => {
    const a = arbitrarCandidatos([alertaBase("desvio", 45), alertaBase("desvio", 75)]);
    expect(a?.score).toBe(75); // maior dos dois, SEM bonus (mesmo tipo, nao e corroboracao)
    expect(a?.motivo).not.toContain("corroborado");
  });

  it("desvio (2 fontes, mesmo tipo) + jammer: corrobora normalmente contando desvio como 1 tipo", () => {
    const a = arbitrarCandidatos([alertaBase("desvio", 45), alertaBase("desvio", 75), alertaBase("jammer", 60)]);
    expect(a?.score).toBe(90); // 75 (maior) + 15 (1 bonus, desvio conta 1 vez so)
  });

  it("critico sempre vence atencao, independente de score", () => {
    const a = arbitrarCandidatos([alertaBase("baseline_veiculo", 90, "atencao"), alertaBase("retorno_tardio", 20, "critico")]);
    expect(a?.tipo).toBe("retorno_tardio");
  });

  it("extras operacionais (retorno_tardio, parada_noturna, aceleracao) nao contam pro bonus de corroboracao", () => {
    const a = arbitrarCandidatos([alertaBase("desvio", 45), alertaBase("retorno_tardio", 40), alertaBase("aceleracao", 70)]);
    expect(a?.score).toBe(70); // maior score vence (aceleracao), sem bonus (so 1 tipo relevante presente: desvio)
    expect(a?.motivo).not.toContain("corroborado");
  });
});
```

- [ ] **Step 2: Rodar e confirmar RED**

Run: `npx vitest run src/lib/detectores.test.ts`
Expected: FAIL, `arbitrarCandidatos is not a function` (ou erro de import).

- [ ] **Step 3: Implementar `arbitrarCandidatos`**

Em `src/lib/detectores.ts`, adicionar logo ANTES da funcao `avaliar` (antes da linha 932):

```ts
// Conjunto de sinais de seguranca relevantes pra corroboracao -- confirmado
// pela pesquisa de 11/07 como o padrao de maior confianca da industria
// ("jammer + desvio + area de risco juntos"). Extras mais operacionais
// (retorno_tardio, parada_noturna_ignicao, aceleracao_brusca) ficam de fora
// de proposito: continuam disputando a arbitragem normalmente, so nao
// geram bonus de corroboracao, pra nao diluir o sinal.
const TIPOS_CORROBORANTES = new Set(["jammer", "desvio", "bypass_entrega", "baseline_veiculo"]);
const BONUS_CORROBORACAO_POR_SINAL = 15;

// Arbitragem compartilhada: escolhe o candidato de maior severidade
// (critico > atencao, depois maior score) e, se 2+ TIPOS DISTINTOS do
// conjunto relevante estiverem presentes ao mesmo tempo, soma um bonus por
// tipo extra (capado em 100) e lista quem corroborou no motivo. Usada
// internamente por avaliar() E pelo motor (route.ts) pra combinar o
// resultado de avaliar() com os detectores extras (cerca, bypass, baseline).
export function arbitrarCandidatos(candidatos: Alerta[]): Alerta | null {
  if (candidatos.length === 0) return null;

  const vencedor = candidatos.reduce((melhor, atual) => {
    if (melhor.nivel === "critico" && atual.nivel !== "critico") return melhor;
    if (atual.nivel === "critico" && melhor.nivel !== "critico") return atual;
    return atual.score > melhor.score ? atual : melhor;
  });

  const tiposPresentes = new Set(
    candidatos.filter((a) => TIPOS_CORROBORANTES.has(a.tipo)).map((a) => a.tipo)
  );

  if (tiposPresentes.size < 2) return vencedor;

  const outrosTipos = [...tiposPresentes].filter((t) => t !== vencedor.tipo);
  const bonus = outrosTipos.length * BONUS_CORROBORACAO_POR_SINAL;
  return {
    ...vencedor,
    score: Math.min(100, vencedor.score + bonus),
    motivo: `${vencedor.motivo} (corroborado por: ${outrosTipos.join(", ")})`,
  };
}
```

- [ ] **Step 4: Rodar e confirmar GREEN**

Run: `npx vitest run src/lib/detectores.test.ts`
Expected: PASS, todos os testes novos de `arbitrarCandidatos`.

- [ ] **Step 5: Trocar o reduce inline de `avaliar()` pra usar a funcao nova**

Em `src/lib/detectores.ts`, dentro de `avaliar()`, trocar:

```ts
  ].filter((a): a is Alerta => a !== null);

  if (candidatos.length === 0) return null;

  return candidatos.reduce((melhor, atual) => {
    if (melhor.nivel === "critico" && atual.nivel !== "critico") return melhor;
    if (atual.nivel === "critico" && melhor.nivel !== "critico") return atual;
    return atual.score > melhor.score ? atual : melhor;
  });
}
```

por:

```ts
  ].filter((a): a is Alerta => a !== null);

  return arbitrarCandidatos(candidatos);
}
```

- [ ] **Step 6: Rodar a suite completa (rede de seguranca de regressao)**

Run: `npx vitest run`
Expected: PASS, TODOS os testes -- incluindo os testes extensos ja existentes de `avaliar()` (panico, bau, jammer, parada_longa, parada_cliente, saida_nao_autorizada, desvio, tiroteio), que devem continuar passando SEM MUDANCA nenhuma (sinal unico nao aciona corroboracao, so muda quando 2+ tipos relevantes coincidem).

- [ ] **Step 7: Parar de pular `avaliar()` quando ha jammer (route.ts)**

Em `src/app/api/motor/route.ts:1449`, trocar:

```ts
          let alerta: Alerta | null = alertaJammer
            ? alertaJammer
            : pos.fresco
              ? avaliar(pos, {
```

por:

```ts
          // Achado real 12/07: avaliar() JA inclui detectarJammer(p) como um
          // dos seus proprios candidatos (arbitrados junto com desvio pela
          // mesma arbitrarCandidatos) -- pular avaliar() inteira quando ha
          // jammer impedia esse combo (o de maior confianca segundo a
          // pesquisa) de ser sequer calculado. Agora avaliar() sempre roda
          // quando fresco; so cai pro alertaJammer isolado quando NAO
          // fresco (jammer continua valendo mesmo com atraso > 60min, caso
          // que avaliar() nao cobre).
          let alerta: Alerta | null = pos.fresco
            ? avaliar(pos, {
```

E, no fechamento do bloco `avaliar(pos, {...})` (logo apos os parametros, onde hoje fecha com `: null;`), trocar a linha final de:

```ts
                })
              : null;
```

por:

```ts
                })
            : (alertaJammer ?? null);
```

- [ ] **Step 8: Trocar o loop manual de extras pra usar `arbitrarCandidatos`**

Em `route.ts`, importar `arbitrarCandidatos` no topo (mesmo import de `avaliar`, `detectarJammer`, etc):

```ts
import {
  avaliar,
  detectarJammer,
  arbitrarCandidatos,
  ...
```

Depois, trocar:

```ts
          for (const extra of extras) {
            if (!alerta) { alerta = extra; continue; }
            if (alerta.nivel === "critico" && extra.nivel !== "critico") continue;
            if (extra.nivel === "critico" && alerta.nivel !== "critico") { alerta = extra; continue; }
            if (extra.score > alerta.score) alerta = extra;
          }
```

por:

```ts
          alerta = arbitrarCandidatos([...(alerta ? [alerta] : []), ...extras]);
```

- [ ] **Step 9: Validar**

Run: `npx tsc --noEmit && npx eslint src/lib/detectores.ts src/lib/detectores.test.ts src/app/api/motor/route.ts && npm run build`
Expected: sem erros.

- [ ] **Step 10: Rodar a suite completa MULTIPLAS VEZES (item de maior risco)**

Run: `npx vitest run` (repetir 2-3 vezes seguidas pra garantir estabilidade, nao flakiness)
Expected: PASS consistente em todas as rodadas.

- [ ] **Step 11: Commitar**

```bash
git add src/lib/detectores.ts src/lib/detectores.test.ts src/app/api/motor/route.ts
git commit -m "feat(desvio): fusao de sinais -- jammer nao bloqueia mais avaliar(), arbitragem reusavel com corroboracao"
```

---

## Tarefa 7: Transito inferido pela propria frota

**Files:**
- Modify: `src/lib/detectores.ts` (nova funcao pura)
- Modify: `src/lib/detectores.test.ts` (TDD da funcao nova)
- Modify: `src/app/api/motor/route.ts:858-873,1217-1223` (generalizar `paradosFrescos`, calcular `vizinhosLentos`) e o ponto onde o `alerta` final e decidido (apos a Tarefa 6)

**Interfaces:**
- Consumes: nada de tarefas anteriores diretamente (funcao nova e independente).
- Produces: `reduzirPorTransitoInferido(alerta: Alerta, ctx: { emRodovia: boolean; vizinhosLentos: number }): Alerta`, exportada de `detectores.ts`. Consumida por `route.ts`.

- [ ] **Step 1: Escrever os testes que falham**

Adicionar em `src/lib/detectores.test.ts` (incluir `reduzirPorTransitoInferido` no import):

```ts

describe("reduzirPorTransitoInferido (transito real da propria frota corrobora corte de transito, 12/07)", () => {
  const desvioRodovia: Alerta = { nivel: "critico", tipo: "desvio", motivo: "Fora da rota esperada", score: 75 };

  it("fora de rodovia (contexto urbano): nao reduz, mesmo com vizinhos lentos", () => {
    const a = reduzirPorTransitoInferido(desvioRodovia, { emRodovia: false, vizinhosLentos: 3 });
    expect(a.score).toBe(75);
  });

  it("em rodovia mas sem vizinhos lentos o suficiente (so 1): nao reduz", () => {
    const a = reduzirPorTransitoInferido(desvioRodovia, { emRodovia: true, vizinhosLentos: 1 });
    expect(a.score).toBe(75);
  });

  it("em rodovia com 2+ vizinhos lentos: reduz 20 pontos", () => {
    const a = reduzirPorTransitoInferido(desvioRodovia, { emRodovia: true, vizinhosLentos: 2 });
    expect(a.score).toBe(55);
  });

  it("reducao respeita piso minimo de 30 (nao deixa o alerta sumir)", () => {
    const scoreBaixo: Alerta = { ...desvioRodovia, score: 40 };
    const a = reduzirPorTransitoInferido(scoreBaixo, { emRodovia: true, vizinhosLentos: 5 });
    expect(a.score).toBe(30); // 40 - 20 = 20, mas piso e 30
  });

  it("so aplica a alertas tipo desvio -- outros tipos passam intactos", () => {
    const outroTipo: Alerta = { nivel: "critico", tipo: "jammer", motivo: "x", score: 80 };
    const a = reduzirPorTransitoInferido(outroTipo, { emRodovia: true, vizinhosLentos: 3 });
    expect(a.score).toBe(80);
  });
});
```

- [ ] **Step 2: Rodar e confirmar RED**

Run: `npx vitest run src/lib/detectores.test.ts`
Expected: FAIL, funcao nao existe.

- [ ] **Step 3: Implementar**

Em `src/lib/detectores.ts`, adicionar apos `arbitrarCandidatos`:

```ts
const TRANSITO_INFERIDO_MIN_VIZINHOS = 2;
const TRANSITO_INFERIDO_REDUCAO = 20;
const TRANSITO_INFERIDO_SCORE_MINIMO = 30;

// Transito inferido pela PROPRIA frota (floating car data, decisao do
// usuario 12/07 apos pesquisa mostrar que nao ha fonte de transito real
// gratuita e self-serve viavel): se 2+ outros veiculos da frota estao
// LENTOS (nao parados, ver vizinhosParados que ja existe pra isso) perto
// da posicao, em contexto de rodovia, isso corrobora "corte de transito
// legitimo" em vez de desvio suspeito -- reduz a prioridade, nunca some o
// alerta (piso minimo).
export function reduzirPorTransitoInferido(
  alerta: Alerta,
  ctx: { emRodovia: boolean; vizinhosLentos: number }
): Alerta {
  if (alerta.tipo !== "desvio") return alerta;
  if (!ctx.emRodovia || ctx.vizinhosLentos < TRANSITO_INFERIDO_MIN_VIZINHOS) return alerta;
  return {
    ...alerta,
    score: Math.max(TRANSITO_INFERIDO_SCORE_MINIMO, alerta.score - TRANSITO_INFERIDO_REDUCAO),
  };
}
```

- [ ] **Step 4: Rodar e confirmar GREEN**

Run: `npx vitest run src/lib/detectores.test.ts`
Expected: PASS.

- [ ] **Step 5: Generalizar `paradosFrescos` em route.ts**

Em `route.ts:858-873`, trocar:

```ts
      const paradosFrescos: { lat: number; lng: number }[] = [];
      const celulasCandidatasTapete = new Set<string>();
      const chavesCandidatasGeocode = new Set<string>();
      for (const raw of posicoesRaw) {
        try {
          const p = normalizar(raw as Record<string, unknown>);
          if (p.fresco && p.velocidade === 0 && p.lat != null && p.lng != null) {
            paradosFrescos.push({ lat: p.lat, lng: p.lng });
          }
          if (p.fresco && p.lat != null && p.lng != null) {
            for (const c of vizinhanca3x3(p.lat, p.lng)) celulasCandidatasTapete.add(c);
            chavesCandidatasGeocode.add(chaveGeocode(p.lat, p.lng));
          }
        } catch { /* posicao malformada: ignora na pre-passada */ }
      }
      const RAIO_CONGESTION_M = 250;
```

por:

```ts
      // Generalizado 12/07 (era so p.velocidade===0) pra tambem alimentar
      // vizinhosLentos (transito inferido pela propria frota) -- guarda
      // TODO veiculo fresco com sua velocidade, nao so os parados.
      const posicoesFrescasComVelocidade: { lat: number; lng: number; velocidade: number }[] = [];
      const celulasCandidatasTapete = new Set<string>();
      const chavesCandidatasGeocode = new Set<string>();
      for (const raw of posicoesRaw) {
        try {
          const p = normalizar(raw as Record<string, unknown>);
          if (p.fresco && p.lat != null && p.lng != null) {
            posicoesFrescasComVelocidade.push({ lat: p.lat, lng: p.lng, velocidade: p.velocidade });
            for (const c of vizinhanca3x3(p.lat, p.lng)) celulasCandidatasTapete.add(c);
            chavesCandidatasGeocode.add(chaveGeocode(p.lat, p.lng));
          }
        } catch { /* posicao malformada: ignora na pre-passada */ }
      }
      const RAIO_CONGESTION_M = 250;
```

- [ ] **Step 6: Ajustar `vizinhosParados` e adicionar `vizinhosLentos`**

Em `route.ts:1217-1223`, trocar:

```ts
          let vizinhosParados = 0;
          if (candidatoParadaAnomala) {
            let dentro = 0;
            for (const q of paradosFrescos) {
              if (haversineM(pos.lat, pos.lng, q.lat, q.lng) <= RAIO_CONGESTION_M) dentro++;
            }
            vizinhosParados = Math.max(0, dentro - 1); // exclui o proprio veiculo
          }
```

por:

```ts
          let vizinhosParados = 0;
          let vizinhosLentos = 0;
          if (candidatoParadaAnomala) {
            let dentro = 0;
            for (const q of posicoesFrescasComVelocidade) {
              if (q.velocidade === 0 && haversineM(pos.lat, pos.lng, q.lat, q.lng) <= RAIO_CONGESTION_M) dentro++;
            }
            vizinhosParados = Math.max(0, dentro - 1); // exclui o proprio veiculo
          }
          if (pos.fresco) {
            let dentroLento = 0;
            for (const q of posicoesFrescasComVelocidade) {
              if (q.velocidade > 0 && q.velocidade <= 20 && haversineM(pos.lat, pos.lng, q.lat, q.lng) <= RAIO_CONGESTION_M) dentroLento++;
            }
            vizinhosLentos = Math.max(0, dentroLento - (pos.velocidade > 0 && pos.velocidade <= 20 ? 1 : 0));
          }
```

- [ ] **Step 7: Aplicar a reducao apos a arbitragem final**

Em `route.ts`, logo apos a linha da Tarefa 6 Step 8 (`alerta = arbitrarCandidatos([...(alerta ? [alerta] : []), ...extras]);`), adicionar:

```ts
          if (alerta) {
            alerta = reduzirPorTransitoInferido(alerta, {
              emRodovia: bufferPorVelocidade(pos.velocidade) === 200,
              vizinhosLentos,
            });
          }
```

E importar `reduzirPorTransitoInferido` no topo do arquivo junto de `arbitrarCandidatos`.

- [ ] **Step 8: Validar**

Run: `npx tsc --noEmit && npx eslint src/lib/detectores.ts src/lib/detectores.test.ts src/app/api/motor/route.ts && npm run build`
Expected: sem erros. Se `paradosFrescos` ainda for referenciado em algum outro lugar do arquivo (buscar com grep), atualizar essas referencias tambem pra `posicoesFrescasComVelocidade`.

- [ ] **Step 9: Rodar suite completa e commitar**

```bash
npx vitest run
git add src/lib/detectores.ts src/lib/detectores.test.ts src/app/api/motor/route.ts
git commit -m "feat(desvio): transito inferido pela propria frota reduz severidade de desvio em rodovia"
```

---

## Tarefa 8: Calibracao ao vivo

**Files:**
- Modify: `src/lib/calibracao-desvio.ts` (nova funcao)
- Modify: `src/lib/calibracao-desvio.test.ts` (TDD)
- Modify: `src/app/api/motor/route.ts` (carregar `calibracao_desvio`, aplicar o fator)

**Interfaces:**
- Consumes: nada de tarefas anteriores.
- Produces: `aplicarFatorCalibrado(scoreBase: number, taxaFalsoPositivo: number): number`, exportada de `calibracao-desvio.ts`. Consumida por `route.ts`.

- [ ] **Step 1: Escrever os testes que falham**

Adicionar em `src/lib/calibracao-desvio.test.ts` (incluir `aplicarFatorCalibrado` no import existente):

```ts

describe("aplicarFatorCalibrado", () => {
  it("taxa de falso positivo zero: score sai igual", () => {
    expect(aplicarFatorCalibrado(80, 0)).toBe(80);
  });

  it("taxa de falso positivo 0.5: score cai pela metade", () => {
    expect(aplicarFatorCalibrado(80, 0.5)).toBe(40);
  });

  it("taxa de falso positivo alta (0.9): score cai bastante mas nao desaparece", () => {
    expect(aplicarFatorCalibrado(80, 0.9)).toBe(8);
  });

  it("arredonda pro inteiro mais proximo", () => {
    expect(aplicarFatorCalibrado(45, 0.33)).toBe(30); // 45 * 0.67 = 30.15
  });
});
```

- [ ] **Step 2: Rodar e confirmar RED**

Run: `npx vitest run src/lib/calibracao-desvio.test.ts`
Expected: FAIL, funcao nao existe.

- [ ] **Step 3: Implementar**

Em `src/lib/calibracao-desvio.ts`, adicionar apos `taxaFalsoPositivoCalibrada`:

```ts
// Fator ao vivo aplicado ao score final, derivado direto da taxa de falso
// positivo ja calibrada (nao precisa de uma coluna "score_ajustado"
// separada -- alertas do MESMO tipo tem scores base muito diferentes, 45 a
// 85 so pro desvio, entao um valor absoluto por segmento nao se aplica
// igual a todos; o FATOR proporcional sim). taxa=0 mantem o score igual;
// taxa=1 zeraria (na pratica nunca chega la, protegido pelo shrinkage
// bayesiano em taxaFalsoPositivoCalibrada).
export function aplicarFatorCalibrado(scoreBase: number, taxaFalsoPositivo: number): number {
  return Math.round(scoreBase * (1 - taxaFalsoPositivo));
}
```

- [ ] **Step 4: Rodar e confirmar GREEN**

Run: `npx vitest run src/lib/calibracao-desvio.test.ts`
Expected: PASS.

- [ ] **Step 5: Carregar `calibracao_desvio` uma vez por ciclo (route.ts)**

Importar `aplicarFatorCalibrado` no topo de `route.ts` junto dos outros imports de `@/lib/calibracao-desvio` (ou criar o import se nao existir ainda).

Perto de onde `mapaBaselineVeiculo`/`mapaBaselineFrota` sao carregados (mesmo padrao, tabela pequena, uma vez por ciclo pra todos os clientes), adicionar:

```ts
    const { data: calibracaoRows } = await supabase
      .from("calibracao_desvio")
      .select("segmento, n_amostras, taxa_falso_positivo");
    const MIN_AMOSTRAS_CALIBRACAO = 20;
    const mapaCalibracao = new Map<string, number>();
    for (const r of calibracaoRows ?? []) {
      if (r.n_amostras >= MIN_AMOSTRAS_CALIBRACAO) {
        mapaCalibracao.set(r.segmento, r.taxa_falso_positivo);
      }
    }
```

- [ ] **Step 6: Aplicar o fator ao alerta final**

Depois do ajuste de transito inferido da Tarefa 7 (Step 7), adicionar:

```ts
          if (alerta) {
            const segmentoEspecifico = alerta.tipo === "desvio" && corredorInfo?.veredito
              ? `corredor_veredito:${corredorInfo.veredito}`
              : null;
            const taxaFp = (segmentoEspecifico && mapaCalibracao.get(segmentoEspecifico))
              ?? mapaCalibracao.get(`tipo:${alerta.tipo}`);
            if (taxaFp !== undefined) {
              alerta = { ...alerta, score: aplicarFatorCalibrado(alerta.score, taxaFp) };
            }
          }
```

- [ ] **Step 7: Documentar a coluna nao usada**

No topo de `scripts/recalibrar-desvio.mjs`, adicionar comentario:

```js
// Nota 12/07: a coluna score_ajustado (migration 019) fica SEM USO -- o
// motor aplica o fator ao vivo direto de taxa_falso_positivo
// (aplicarFatorCalibrado em src/lib/calibracao-desvio.ts), nao precisa de
// um "score base de referencia" pre-calculado (ambiguo: alertas do mesmo
// tipo tem scores base muito diferentes).
```

- [ ] **Step 8: Validar**

Run: `npx tsc --noEmit && npx eslint src/lib/calibracao-desvio.ts src/lib/calibracao-desvio.test.ts src/app/api/motor/route.ts && npm run build`
Expected: sem erros.

- [ ] **Step 9: Rodar suite completa e commitar**

```bash
npx vitest run
git add src/lib/calibracao-desvio.ts src/lib/calibracao-desvio.test.ts src/app/api/motor/route.ts scripts/recalibrar-desvio.mjs
git commit -m "feat(desvio): calibracao ao vivo -- taxa de falso positivo ajusta o score final"
```

---

## Validacao final (depois de todas as tarefas)

- [ ] `npx vitest run` (suite completa), `npx tsc --noEmit`, `npx eslint .` (avisos pre-existentes em componentes de frontend nao relacionados nao bloqueiam), `npm run build`.
- [ ] Auditoria adversarial via Agent focada especialmente na Tarefa 6 (fusao de sinais) antes do merge -- mesmo processo que achou o bug critico do `bypass_entrega` no ciclo anterior.
- [ ] Atualizar `ESTADO.md` com o resumo das 8 tarefas.
- [ ] Continuar o monitoramento periodico ja em andamento (checks de 30min) por pelo menos algumas horas apos o deploy, prestando atencao especial na Tarefa 3 (parada anomala, risco de reproduzir ruido de transito ja documentado) e na Tarefa 4 (Camada 3, risco de mais alertas em rotas rurais).
