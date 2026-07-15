# Redução de Falso Positivo da Cerca Virtual — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Reduzir falso positivo da cerca virtual (Camada 3 de verificação de rota) sem
perder sensibilidade a desvio real, atacando as duas causas confirmadas no caso do
veículo 3C94 (13:20, 15/07/2026): buffer uniforme demais na chegada e priorização de
pendentes só por distância em linha reta.

**Architecture:** Duas funções puras em `src/lib/corredor-verificacao.ts` ganham um
parâmetro opcional cada (retrocompatível — chamadas existentes sem o novo parâmetro
preservam o comportamento atual). `src/app/api/motor/route.ts` passa a calcular e
repassar os dois novos parâmetros nos dois call sites da cerca virtual (semeadura e
recuperação). Muda só o subsistema de cerca virtual — Camada 1 (comportamental) e
Camada 3/tapete não são tocadas.

**Tech Stack:** TypeScript, Next.js API route, Vitest.

## Global Constraints

- Spec: `docs/superpowers/specs/2026-07-15-desvio-reducao-falso-positivo-design.md`.
- `RAIO_CHEGADA_M = 300`, `BUFFER_CHEGADA_M = 250` (design doc, seção 1).
- `ANGULO_EMPATE_GRAUS = 30` (design doc, seção 2, refinado na revisão do spec).
- Retrocompatibilidade obrigatória: os dois novos parâmetros são opcionais com default
  que preserva o comportamento atual (testes existentes não podem quebrar sem serem
  explicitamente atualizados).
- Toda mudança precisa passar `npx tsc --noEmit`, `npx eslint <arquivo>` e
  `npx vitest run` (suite inteira, não só o arquivo tocado) antes de commit.
- Regra do projeto (memória `feedback_monitoramento_push_both_repos`): qualquer commit
  num dos dois repos (`MONITORAMENTO TEMP` e `MONITORAMENTO transmonseg`) precisa ser
  espelhado e pushado no outro no mesmo lote de trabalho.
- Repos: TEMP em `/Users/joaquimsalles/Projects/Transmonseg/monitoramento/MONITORAMENTO TEMP`
  (branch `master`), definitivo em
  `/Users/joaquimsalles/Projects/Transmonseg/monitoramento/MONITORAMENTO transmonseg`
  (branch `main`). Os dois têm o mesmo `src/app/api/motor/route.ts` e
  `src/lib/corredor-verificacao.ts` byte-idênticos hoje (confirmado por `diff` em
  15/07/2026) — cada task de código roda primeiro no TEMP, é validada, e só depois é
  replicada no definitivo (Task 4).

---

### Task 1: `bufferPorVelocidade` — zona de chegada

**Files:**
- Modify: `src/lib/corredor-verificacao.ts:13-22`
- Test: `src/lib/corredor-verificacao.test.ts:4-15`

**Interfaces:**
- Produces: `bufferPorVelocidade(velKmH: number, distDestinoMaisPertoM?: number): number`
  — mesmo nome e primeiro parâmetro do que hoje; `distDestinoMaisPertoM` é novo e
  opcional. Quando omitido ou `undefined`, comportamento idêntico ao atual (120/200m).
  Quando fornecido e `<= 300`, retorna `250` independente da velocidade.

O código atual (`src/lib/corredor-verificacao.ts:13-22`) é:

```ts
// Buffer adaptativo (pesquisa 09/07: buffer por contexto de via). Proxy de
// contexto sem mapa de vias: velocidade >= 60 km/h ~ rodovia/serra, onde a
// estrada real serpenteia longe da polilinha ideal e o GPS espaça mais —
// buffer MAIOR pra rota do OSRM cobrir o trajeto com folga. Abaixo disso,
// urbano: buffer estreito o suficiente pra pegar desvio de ~100-150m.
// Reduzido de 300/600 pra 120/200 em 11/07 (diretiva explicita do usuario:
// falso positivo aceitavel, prioridade total e nunca perder desvio real).
export function bufferPorVelocidade(velKmH: number): number {
  return velKmH >= 60 ? 200 : 120;
}
```

- [ ] **Step 1: Escrever os testes que falham**

Adicionar ao final do `describe("bufferPorVelocidade ...")` existente em
`src/lib/corredor-verificacao.test.ts` (depois do `it("60 km/h ou mais...")`, linha 14):

```ts
  it("dentro de 300m de um destino: 250m (zona de chegada), independente da velocidade", () => {
    expect(bufferPorVelocidade(40, 100)).toBe(250);
    expect(bufferPorVelocidade(90, 300)).toBe(250);
    expect(bufferPorVelocidade(0, 0)).toBe(250);
  });
  it("mais de 300m de um destino: comportamento normal por velocidade", () => {
    expect(bufferPorVelocidade(40, 301)).toBe(120);
    expect(bufferPorVelocidade(90, 5000)).toBe(200);
  });
  it("sem distancia informada (parametro omitido): comportamento atual preservado", () => {
    expect(bufferPorVelocidade(40)).toBe(120);
    expect(bufferPorVelocidade(90)).toBe(200);
  });
```

- [ ] **Step 2: Rodar os testes e confirmar que falham**

Run: `cd "/Users/joaquimsalles/Projects/Transmonseg/monitoramento/MONITORAMENTO TEMP" && npx vitest run src/lib/corredor-verificacao.test.ts`
Expected: FAIL nos 2 novos `it` de zona de chegada (a função ainda não aceita o 2º
parâmetro, então sempre cai no cálculo por velocidade — `bufferPorVelocidade(40, 100)`
retorna `120`, não `250`). O 3º `it` (sem distância) já passa, ok.

- [ ] **Step 3: Implementar**

Substituir o bloco em `src/lib/corredor-verificacao.ts:13-22` por:

```ts
// Buffer adaptativo (pesquisa 09/07: buffer por contexto de via). Proxy de
// contexto sem mapa de vias: velocidade >= 60 km/h ~ rodovia/serra, onde a
// estrada real serpenteia longe da polilinha ideal e o GPS espaça mais —
// buffer MAIOR pra rota do OSRM cobrir o trajeto com folga. Abaixo disso,
// urbano: buffer estreito o suficiente pra pegar desvio de ~100-150m.
// Reduzido de 300/600 pra 120/200 em 11/07 (diretiva explicita do usuario:
// falso positivo aceitavel, prioridade total e nunca perder desvio real).
//
// Achado real 15/07 (caso 3C94, 13:20): o OSRM/Valhalla roteia so ate a via
// publica mais proxima do destino, nunca ate a portaria/doca real -- na
// manobra final de chegada (~200-300m) e normal e legitimo o veiculo se
// afastar mais da polilinha do que o buffer de transito permite. Buffer
// alargado so nessa zona, mantendo o buffer apertado no resto do trajeto
// (onde o risco de desvio de verdade importa mais).
const RAIO_CHEGADA_M = 300;
const BUFFER_CHEGADA_M = 250;

export function bufferPorVelocidade(velKmH: number, distDestinoMaisPertoM?: number): number {
  if (distDestinoMaisPertoM !== undefined && distDestinoMaisPertoM <= RAIO_CHEGADA_M) {
    return BUFFER_CHEGADA_M;
  }
  return velKmH >= 60 ? 200 : 120;
}
```

- [ ] **Step 4: Rodar os testes e confirmar que passam**

Run: `npx vitest run src/lib/corredor-verificacao.test.ts`
Expected: PASS em todos os `it` de `bufferPorVelocidade` (5 no total agora).

- [ ] **Step 5: Commit**

```bash
cd "/Users/joaquimsalles/Projects/Transmonseg/monitoramento/MONITORAMENTO TEMP"
git add src/lib/corredor-verificacao.ts src/lib/corredor-verificacao.test.ts
git commit -m "$(cat <<'EOF'
feat(desvio): buffer alargado na zona de chegada da cerca virtual

bufferPorVelocidade ganha 2o parametro opcional (distancia ao destino mais
perto); dentro de 300m usa buffer de 250m independente da velocidade. Ataca
o caso do 3C94 (13:20 15/07): OSRM roteia so ate a via publica, nunca ate a
portaria real, entao a manobra final de chegada legitimamente passa do
buffer de transito (120/200m). Retrocompativel -- parametro omitido
preserva o comportamento atual.

Ver docs/superpowers/specs/2026-07-15-desvio-reducao-falso-positivo-design.md

Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>
EOF
)"
```

---

### Task 2: `ordenarPendentesPorDistancia` — prioridade por rumo de deslocamento

**Files:**
- Modify: `src/lib/corredor-verificacao.ts` (imports no topo + função
  `ordenarPendentesPorDistancia`, atualmente linhas 38-45)
- Test: `src/lib/corredor-verificacao.test.ts:138-155`

**Interfaces:**
- Consumes: `difAngulo(a: number, b: number): number` e
  `rumoGraus(aLat: number, aLng: number, bLat: number, bLng: number): number`, ambas já
  exportadas de `src/lib/unitrac.ts` (`difAngulo` em `unitrac.ts:263`, `rumoGraus` em
  `unitrac.ts:252`) — nenhuma das duas precisa ser criada, só importada.
- Produces: `ordenarPendentesPorDistancia<T extends {lat: number; lng: number}>(pos: {lat: number; lng: number}, pendentes: T[], rumoAtual?: number | null): T[]`
  — mesmo nome e 2 primeiros parâmetros do que hoje; `rumoAtual` é novo, opcional,
  default `null`. Quando `null`/omitido, ordena só por distância (comportamento atual,
  idêntico byte a byte). Quando fornecido, agrupa por faixa de 30° de diferença angular
  em relação ao rumo atual (faixa mais alinhada primeiro) e desempata por distância
  dentro da mesma faixa.

O código atual (`src/lib/corredor-verificacao.ts:38-45`) é:

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

E o import no topo do arquivo (`src/lib/corredor-verificacao.ts:9`) é:

```ts
import { distanciaAoSegmentoM, haversineM } from "./unitrac";
```

- [ ] **Step 1: Escrever os testes que falham**

Adicionar ao final do `describe("ordenarPendentesPorDistancia ...")` existente em
`src/lib/corredor-verificacao.test.ts` (depois do `it("lista vazia retorna vazia")`,
linha 154):

```ts
  it("com rumoAtual: candidato alinhado com o rumo vence mesmo estando mais longe", () => {
    const pos = { lat: -22.90, lng: -43.20 };
    // "norte" fica ~1.1km ao norte (rumo ~0), "leste_perto" fica ~200m a leste (rumo ~90).
    const pendentes = [
      { lat: -22.90, lng: -43.20 + 0.002, nome: "leste_perto" },
      { lat: -22.90 + 0.01, lng: -43.20, nome: "norte" },
    ];
    // rumoAtual = 0 (indo pro norte): "norte" esta na mesma faixa angular
    // (dif ~0) e deve vencer mesmo sendo mais longe que "leste_perto" (dif ~90).
    const resultado = ordenarPendentesPorDistancia(pos, pendentes, 0);
    expect(resultado.map((p) => p.nome)).toEqual(["norte", "leste_perto"]);
  });

  it("com rumoAtual: dentro da mesma faixa angular (30 graus), desempata por distancia", () => {
    const pos = { lat: -22.90, lng: -43.20 };
    const pendentes = [
      { lat: -22.90 + 0.02, lng: -43.20, nome: "norte_longe" },
      { lat: -22.90 + 0.005, lng: -43.20 + 0.001, nome: "quase_norte_perto" },
    ];
    // Ambos com rumo bem proximo de 0 (mesma faixa de 30 graus) -- o mais
    // perto vence dentro da faixa.
    const resultado = ordenarPendentesPorDistancia(pos, pendentes, 0);
    expect(resultado.map((p) => p.nome)).toEqual(["quase_norte_perto", "norte_longe"]);
  });

  it("sem rumoAtual (null ou omitido): comportamento atual preservado, so distancia", () => {
    const pos = { lat: -22.90, lng: -43.20 };
    const pendentes = [
      { lat: -22.90, lng: -43.20 + 0.05, nome: "longe" },
      { lat: -22.90, lng: -43.20 + 0.01, nome: "perto" },
    ];
    expect(ordenarPendentesPorDistancia(pos, pendentes, null).map((p) => p.nome)).toEqual(["perto", "longe"]);
    expect(ordenarPendentesPorDistancia(pos, pendentes).map((p) => p.nome)).toEqual(["perto", "longe"]);
  });
```

- [ ] **Step 2: Rodar os testes e confirmar que falham**

Run: `npx vitest run src/lib/corredor-verificacao.test.ts`
Expected: FAIL nos 2 primeiros `it` novos (a função ainda ignora o 3º argumento e ordena
só por distância — "leste_perto" venceria "norte" no 1º teste porque está mais perto em
linha reta). O 3º `it` novo já passa (comportamento atual preservado mesmo passando
`null`, já que a função hoje ignora qualquer argumento extra).

- [ ] **Step 3: Implementar**

Trocar o import no topo (`src/lib/corredor-verificacao.ts:9`):

```ts
import { distanciaAoSegmentoM, haversineM, difAngulo, rumoGraus } from "./unitrac";
```

Adicionar a constante e substituir a função (`src/lib/corredor-verificacao.ts:38-45`
atual) por:

```ts
// Faixa de "empate" angular: candidatos cuja diferenca de rumo em relacao ao
// deslocamento atual do veiculo cai na mesma faixa de 30 graus sao tratados
// como igualmente alinhados e desempatados por distancia -- evita que um
// candidato 1 grau mais alinhado, mas muito mais longe, roube a prioridade
// de um candidato quase tao alinhado e bem mais perto.
const ANGULO_EMPATE_GRAUS = 30;

// Substitui o corte fixo em "3 mais proximos" usado ate 11/07 na cerca
// virtual -- pressupunha que o motorista vai pro pendente mais perto, mas
// nao ha ordem de entrega definida (o motorista escolhe livremente). Ordena
// por distancia como heuristica pratica de prioridade dentro do orcamento
// de chamadas (quem chama decide quantos tentar), sem descartar nenhum.
//
// Achado real 15/07: com o orcamento de chamadas limitado pelo throttle de
// 1 req/s do OSRM publico (~4-5 candidatos testaveis por verificacao) e
// clientes com mediana de 11 pendentes (Nutry Max), o destino real do
// motorista pode nunca ser testado se so a distancia em linha reta manda --
// rio/rodovia/mao unica separam distancia real de distancia em linha reta
// (caso 3C94). rumoAtual (rumo de deslocamento do ciclo anterior->atual, ja
// calculado no motor como `rumoMovimento`) prioriza candidatos "na frente"
// do veiculo primeiro, sem gastar mais chamadas de API -- so muda a ORDEM.
export function ordenarPendentesPorDistancia<T extends { lat: number; lng: number }>(
  pos: { lat: number; lng: number },
  pendentes: T[],
  rumoAtual: number | null = null
): T[] {
  if (rumoAtual === null) {
    return [...pendentes].sort(
      (a, b) => haversineM(pos.lat, pos.lng, a.lat, a.lng) - haversineM(pos.lat, pos.lng, b.lat, b.lng)
    );
  }
  return pendentes
    .map((p) => {
      const dist = haversineM(pos.lat, pos.lng, p.lat, p.lng);
      const rumoAoPonto = rumoGraus(pos.lat, pos.lng, p.lat, p.lng);
      const faixaAngular = Math.floor(difAngulo(rumoAtual, rumoAoPonto) / ANGULO_EMPATE_GRAUS);
      return { p, dist, faixaAngular };
    })
    .sort((a, b) => a.faixaAngular - b.faixaAngular || a.dist - b.dist)
    .map((x) => x.p);
}
```

- [ ] **Step 4: Rodar os testes e confirmar que passam**

Run: `npx vitest run src/lib/corredor-verificacao.test.ts`
Expected: PASS em todos os `it` de `ordenarPendentesPorDistancia` (5 no total agora).

- [ ] **Step 5: Rodar a suite inteira, tsc e eslint**

Run: `npx vitest run && npx tsc --noEmit && npx eslint src/lib/corredor-verificacao.ts`
Expected: `vitest`: todos os arquivos passando (268+ testes, 264 atuais + 4 novos desta
task + 3 novos da Task 1); `tsc`: sem output (sem erro); `eslint`: sem output.

- [ ] **Step 6: Commit**

```bash
git add src/lib/corredor-verificacao.ts src/lib/corredor-verificacao.test.ts
git commit -m "$(cat <<'EOF'
feat(desvio): cerca virtual prioriza pendentes por rumo de deslocamento

ordenarPendentesPorDistancia ganha 3o parametro opcional (rumoAtual);
quando informado, agrupa candidatos por faixa de 30 graus de alinhamento
com o rumo de deslocamento do veiculo antes de desempatar por distancia.
Aumenta a chance de o destino real do motorista ser testado dentro do
orcamento de ~4-5 verificacoes por chamada (throttle 1 req/s do OSRM
publico), sem gastar mais chamadas de API -- so muda a ordem de teste.
Retrocompativel -- parametro omitido ou null preserva o comportamento
atual (so distancia).

Ver docs/superpowers/specs/2026-07-15-desvio-reducao-falso-positivo-design.md

Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>
EOF
)"
```

---

### Task 3: Conectar as duas mudanças na cerca virtual (`route.ts`, repo TEMP)

**Files:**
- Modify: `src/app/api/motor/route.ts:1338` (buffer) e `src/app/api/motor/route.ts:1347-1348`
  (priorização) — ambos dentro do bloco `CERCA VIRTUAL` iniciado em `route.ts:1306`.

**Interfaces:**
- Consumes: `bufferPorVelocidade(velKmH, distDestinoMaisPertoM?)` e
  `ordenarPendentesPorDistancia(pos, pendentes, rumoAtual?)` (Tasks 1 e 2); `haversineM`
  (já importado em `route.ts`, usado em dezenas de outros pontos do arquivo);
  `rumoMovimento: number | null`, já calculado em `route.ts:1151-1154` (rumo do ciclo
  anterior → posição atual), em escopo no bloco da cerca virtual (mesma iteração do
  loop por veículo).
- Produces: nada consumido por tasks depois desta — é o ponto final de integração.

O trecho atual (`src/app/api/motor/route.ts:1333-1348`) é:

```ts
            const destinosCerca = [...pendentes.map((pt) => ({ lat: pt.lat, lng: pt.lng, codigo: pt.codigo ?? `${pt.lat},${pt.lng}` })), ...basesComoDestinoCerca];
            const chaveCerca = destinosCerca.map((pt) => pt.codigo).sort().join(",");
            const cerca = cacheCercaPorVeiculo.get(veiculo_id);
            const cercaValida =
              cerca && cerca.pendentesChave === chaveCerca && Date.now() - cerca.calculadoEm < CERCA_CACHE_MS;
            const bufferCerca = bufferPorVelocidade(pos.velocidade);
            // Achado real 11/07: nao existe ordem de entrega, o motorista
            // escolhe livremente qual pendente visitar primeiro. Cortar em
            // "3 mais proximos" presumia que o motorista ia pro mais perto,
            // o que gerava alerta em cima de gente indo legitimamente pra um
            // pendente mais distante. Agora verifica TODOS, ordenados por
            // distancia so como heuristica de prioridade dentro do
            // orcamento de chamadas (verificarCorredor ja tem deadline de
            // 5s/req e o throttle global decide quantos realmente cabem).
            const todosPendentesPriorizados = () =>
              ordenarPendentesPorDistancia(pos, destinosCerca).map((pt) => ({ lat: pt.lat, lng: pt.lng }));
```

- [ ] **Step 1: Implementar (não há teste unitário novo aqui — é fiação; a cobertura vem
  dos testes das Tasks 1/2 + da suite de integração de `route.ts` que já existe)**

Substituir esse trecho por:

```ts
            const destinosCerca = [...pendentes.map((pt) => ({ lat: pt.lat, lng: pt.lng, codigo: pt.codigo ?? `${pt.lat},${pt.lng}` })), ...basesComoDestinoCerca];
            const chaveCerca = destinosCerca.map((pt) => pt.codigo).sort().join(",");
            const cerca = cacheCercaPorVeiculo.get(veiculo_id);
            const cercaValida =
              cerca && cerca.pendentesChave === chaveCerca && Date.now() - cerca.calculadoEm < CERCA_CACHE_MS;
            // Achado real 15/07 (caso 3C94): buffer alargado perto da chegada
            // (o corredor OSRM so vai ate a via publica, nunca ate a
            // portaria/doca real) -- ver bufferPorVelocidade.
            const distDestinoMaisPertoM = destinosCerca.length > 0
              ? Math.min(...destinosCerca.map((d) => haversineM(pos.lat, pos.lng, d.lat, d.lng)))
              : undefined;
            const bufferCerca = bufferPorVelocidade(pos.velocidade, distDestinoMaisPertoM);
            // Achado real 11/07: nao existe ordem de entrega, o motorista
            // escolhe livremente qual pendente visitar primeiro. Cortar em
            // "3 mais proximos" presumia que o motorista ia pro mais perto,
            // o que gerava alerta em cima de gente indo legitimamente pra um
            // pendente mais distante. Agora verifica TODOS, ordenados por
            // distancia so como heuristica de prioridade dentro do
            // orcamento de chamadas (verificarCorredor ja tem deadline de
            // 5s/req e o throttle global decide quantos realmente cabem).
            // Achado real 15/07: com orcamento apertado (~4-5 candidatos
            // testaveis) e clientes com mediana de 11 pendentes, prioriza
            // por alinhamento com o rumo de deslocamento (rumoMovimento, ja
            // calculado acima) antes da distancia pura -- aumenta a chance
            // de testar o destino real do motorista.
            const todosPendentesPriorizados = () =>
              ordenarPendentesPorDistancia(pos, destinosCerca, rumoMovimento).map((pt) => ({ lat: pt.lat, lng: pt.lng }));
```

- [ ] **Step 2: Rodar tsc, eslint, suite inteira e build**

Run:
```bash
npx tsc --noEmit
npx eslint src/app/api/motor/route.ts
npx vitest run
npx next build
```
Expected: os 4 comandos sem erro (`tsc`/`eslint` sem output; `vitest`: todos os testes
passando; `next build`: "Compiled successfully").

- [ ] **Step 3: Commit**

```bash
git add src/app/api/motor/route.ts
git commit -m "$(cat <<'EOF'
feat(desvio): conecta buffer de chegada e priorizacao por rumo na cerca virtual

Fiacao final das duas mudancas (bufferPorVelocidade e
ordenarPendentesPorDistancia): route.ts agora calcula a distancia ao
destino mais perto e passa pro buffer, e passa o rumo de deslocamento do
veiculo (rumoMovimento, ja calculado em route.ts:1151) pra priorizacao da
cerca virtual. Sem mudanca de comportamento na Camada 1 nem na Camada 3.

tsc/eslint/vitest/build limpos.

Ver docs/superpowers/specs/2026-07-15-desvio-reducao-falso-positivo-design.md

Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>
EOF
)"
git push
```

---

### Task 4: Replicar no repo definitivo e push nos dois

**Files:**
- Modify (no repo `/Users/joaquimsalles/Projects/Transmonseg/monitoramento/MONITORAMENTO transmonseg`,
  branch `main`): `src/lib/corredor-verificacao.ts`, `src/lib/corredor-verificacao.test.ts`,
  `src/app/api/motor/route.ts` — os mesmos 3 diffs das Tasks 1-3, aplicados palavra por
  palavra (os arquivos são byte-idênticos aos do TEMP antes desta mudança).

**Interfaces:**
- Consumes: os diffs exatos produzidos nas Tasks 1, 2 e 3 (mesmo texto, aplicado no
  outro checkout).
- Produces: nada — task final da cadeia.

- [ ] **Step 1: Confirmar que os arquivos ainda são idênticos ao TEMP antes da Task 1**

Run:
```bash
diff "/Users/joaquimsalles/Projects/Transmonseg/monitoramento/MONITORAMENTO transmonseg/src/lib/corredor-verificacao.ts" \
     <(cd "/Users/joaquimsalles/Projects/Transmonseg/monitoramento/MONITORAMENTO TEMP" && git show HEAD~3:src/lib/corredor-verificacao.ts)
diff "/Users/joaquimsalles/Projects/Transmonseg/monitoramento/MONITORAMENTO transmonseg/src/app/api/motor/route.ts" \
     <(cd "/Users/joaquimsalles/Projects/Transmonseg/monitoramento/MONITORAMENTO TEMP" && git show HEAD~3:src/app/api/motor/route.ts)
```
Expected: sem output (idênticos). Se houver diferença, PARE e reconcilie manualmente
antes de continuar — não aplique os patches às cegas em cima de um arquivo divergente.

- [ ] **Step 2: Aplicar os mesmos 3 diffs**

Repetir exatamente as edições dos Steps 3 de Task 1, Task 2 e Task 1 de Task 3 (imports,
`bufferPorVelocidade`, `ordenarPendentesPorDistancia`, os dois testes novos em cada
`describe`, e a fiação em `route.ts`) nos arquivos correspondentes deste repo.

- [ ] **Step 3: Rodar tsc, eslint, suite inteira e build**

Run (dentro de `/Users/joaquimsalles/Projects/Transmonseg/monitoramento/MONITORAMENTO transmonseg`):
```bash
npx tsc --noEmit
npx eslint src/lib/corredor-verificacao.ts src/app/api/motor/route.ts
npx vitest run
npx next build
```
Expected: mesmo resultado limpo da Task 3, Step 2.

- [ ] **Step 4: Commit e push**

```bash
git add src/lib/corredor-verificacao.ts src/lib/corredor-verificacao.test.ts src/app/api/motor/route.ts
git commit -m "$(cat <<'EOF'
feat(desvio): buffer de chegada + priorizacao por rumo na cerca virtual

Espelha no definitivo os commits do TEMP (bufferPorVelocidade com zona de
chegada de 250m/300m, ordenarPendentesPorDistancia priorizando por rumo de
deslocamento) -- ver docs/superpowers/specs/2026-07-15-desvio-reducao-falso-positivo-design.md.

Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>
EOF
)"
git push
```

- [ ] **Step 5: Confirmar os dois repos sincronizados**

Run:
```bash
diff "/Users/joaquimsalles/Projects/Transmonseg/monitoramento/MONITORAMENTO transmonseg/src/lib/corredor-verificacao.ts" \
     "/Users/joaquimsalles/Projects/Transmonseg/monitoramento/MONITORAMENTO TEMP/src/lib/corredor-verificacao.ts"
diff "/Users/joaquimsalles/Projects/Transmonseg/monitoramento/MONITORAMENTO transmonseg/src/app/api/motor/route.ts" \
     "/Users/joaquimsalles/Projects/Transmonseg/monitoramento/MONITORAMENTO TEMP/src/app/api/motor/route.ts"
```
Expected: sem output nos dois (arquivos idênticos entre os repos).
