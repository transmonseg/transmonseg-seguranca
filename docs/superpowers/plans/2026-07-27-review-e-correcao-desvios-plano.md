# Review do código de hoje + correção dos achados da segunda opinião — Plano

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans ou superpowers:subagent-driven-development pra rodar este plano tarefa por tarefa.

**Goal:** Revisar as mudanças shippadas hoje no motor de desvio (que já foram parcialmente revisadas, mas não todas) e corrigir os problemas concretos achados na revisão manual de 215 alertas (ver `~/ClaudeGerado/2026-07-27-segunda-opiniao-desvios-do-dia.md`).

**Architecture:** Fase 1 é revisão pura (sem código novo) das mudanças já em produção. Fase 2 são 2 correções mecânicas, bem entendidas, prontas pra TDD. Fase 3 são 4 itens que precisam de uma DECISÃO ou investigação antes de virar código — não têm spec ainda de propósito.

**Tech Stack:** Next.js 16 + TypeScript + Vitest, Postgres/PostGIS self-hospedado no Contabo, detecção em `src/app/api/motor/route.ts` + `src/lib/detectores.ts`.

---

## Fase 1 — Review do código já shippado hoje (sem mexer em nada ainda)

Hoje foram 4 commits no motor: classe_viaria standalone (sessão anterior, já revisado por outro agente antes deste plano), `parada_fora_tapete` + fix do tipo compartilhado (revisado por agente independente, achou e corrigiu 2 problemas reais), fix do lat/lng na escalação (revisado), e o fix do contexto de calibração da classe_viaria (**este último NÃO teve revisão independente ainda** — implementei sozinho por ser aditivo/baixo risco, mas não foi checado por outro par de olhos).

### Task 1.1: Revisão independente do fix de contexto da classe_viaria

**Arquivos:**
- Revisar: `src/app/api/motor/route.ts:2301-2377` (a lógica de `origemClasseViaria`, `ehDesvio`, `contextoClasseViaria`)

**Passo 1:** Dispatchar um agente revisor (fresh, sem ver a implementação) com este prompt:

> Leia `src/app/api/motor/route.ts` linhas 2296-2380. Hoje foi adicionado `origemClasseViaria = alerta.origemDesvio === "classe_viaria"` como prioridade sobre `ehDesvio` pra decidir lat/lng/contexto no insert de alertas — o objetivo era: quando um alerta dispara por "rua estranha" (classe viária), ele deve sempre usar `pos.lat/pos.lng` (posição atual) e um contexto próprio (`contextoClasseViaria`) com o segmento de calibração, nunca reusar um `desvioInicio` de um streak de afastamento antigo/stale. Confirme: (1) o `origemClasseViaria` está corretamente excluindo `ehDesvio` mesmo no caso raro em que `desvioInicio` não é null (streak antigo ainda não zerado); (2) `contextoClasseViaria` de fato carrega o campo `calibracao.segmento` quando `segmentoEspecifico` não é null; (3) não há caminho em que um alerta de classe_viaria acabe com `contexto: {}` de novo. Rode `npm test -- --run` e confirme 434/434.

**Passo 2:** Se o agente achar algo, criar uma correção seguindo TDD normal (teste falha → fix → teste passa) antes de prosseguir pra Fase 2.

### Task 1.2: Verificação visual das mudanças de UI (merge de parada_fora_tapete como "Desvio de rota")

**Arquivos:**
- `src/app/(app)/components/FiltrosBar.tsx`
- `src/app/(app)/components/PainelCentral.tsx`
- `src/app/(app)/central-v2/MonitorV2.tsx`
- `src/app/(app)/page.tsx`

**Passo 1:** Usar a skill `run` (ou rodar `npm run dev` manualmente) e abrir `/central-v2` no navegador.

**Passo 2:** Confirmar visualmente: o filtro "Desvio" na sidebar mostra os dois tipos juntos (`desvio` + `parada_fora_tapete`) contados numa chip só; a faixa do topo de desvios ativos inclui qualquer `parada_fora_tapete` que exista; o label exibido pra esse tipo é "Desvio de rota" em todo lugar (não "Fora do tapete" residual em nenhuma tela).

**Passo 3:** Se algo não bater, corrigir o arquivo específico e repetir a verificação visual (não só o build — já confirmamos build/typecheck, falta o visual).

---

## Fase 2 — Correções prontas (bem entendidas, baixo risco, TDD direto)

### Task 2.1: Destinos fantasma (coordenada nula tratada como 0,0)

**Causa raiz confirmada:** `haversineM` (`src/lib/unitrac.ts:213`) não valida os parâmetros — se `pt.lat`/`pt.lng` vier `null` da API da Unitrac (endereço nunca geocodificado), a subtração `bLat - aLat` coage `null` pra `0` em JS, e a distância calculada vira a distância até (0,0), que a partir do Rio de Janeiro (-22.9,-43.2) é ~5.317km — bate exatamente com os "destinos fantasma" de ~5.280-5.365km achados em 15 dos 91 casos de "afastando de destinos" revisados hoje. Isso infla artificialmente a contagem de destinos no texto do motivo (ex: "14 destinos" quando só 2 são reais).

**Arquivos:**
- Modificar: `src/app/api/motor/route.ts:1261` (filtro de `pendentes`)
- Test: `src/lib/detectores.test.ts` (ou novo teste focado, se preferir isolar a lógica de filtro numa função pura testável em `detectores.ts`)

**Step 1: Extrair a validação pra uma função pura testável**

Em `src/lib/detectores.ts`, adicionar (perto de `afastouDeTudo`, mesma vizinhança lógica):

```ts
// Ponto de entrega com coordenada valida? Unitrac retorna null quando o
// endereco nunca foi geocodificado -- sem este filtro, haversineM trata
// null como 0 (coercao JS), e o "destino" vira um ponto fantasma a
// ~5.300km (distancia até 0,0 a partir do Rio) que infla a contagem de
// destinos pendentes sem representar nada real.
export function temCoordenadaValida(pt: { lat: number | null; lng: number | null }): boolean {
  return pt.lat != null && pt.lng != null && !(pt.lat === 0 && pt.lng === 0);
}
```

**Step 2: Escrever o teste que falha primeiro**

Em `src/lib/detectores.test.ts`, adicionar:

```ts
describe("temCoordenadaValida", () => {
  it("rejeita lat/lng null", () => {
    expect(temCoordenadaValida({ lat: null, lng: -43.2 })).toBe(false);
    expect(temCoordenadaValida({ lat: -22.9, lng: null })).toBe(false);
  });
  it("rejeita (0,0) explicito", () => {
    expect(temCoordenadaValida({ lat: 0, lng: 0 })).toBe(false);
  });
  it("aceita coordenada real do Rio", () => {
    expect(temCoordenadaValida({ lat: -22.9, lng: -43.2 })).toBe(true);
  });
});
```

Rodar: `npm test -- --run detectores.test.ts`
Esperado: FAIL (`temCoordenadaValida is not a function` ou `is not exported`)

**Step 3: Implementar (o código do Step 1 já é a implementação — só falta exportar/rodar)**

Confirmar que `temCoordenadaValida` está exportado no topo do arquivo junto dos outros exports.

**Step 4: Rodar o teste e confirmar que passa**

Rodar: `npm test -- --run detectores.test.ts`
Esperado: PASS (3/3 novos testes)

**Step 5: Usar a função no motor**

Em `src/app/api/motor/route.ts:1261`, trocar:

```ts
const pendentes = (pontosVeiculo ?? []).filter((pt) => !pt.feito);
```

por:

```ts
const pendentes = (pontosVeiculo ?? []).filter((pt) => !pt.feito && temCoordenadaValida(pt));
```

E importar `temCoordenadaValida` de `@/lib/detectores` no topo do arquivo.

**Step 6: Rodar a suite inteira**

Rodar: `npm test -- --run`
Esperado: PASS (437/437 — 434 atuais + 3 novos)

**Step 7: Rodar build e commit**

```bash
npx tsc --noEmit
npm run build
git add src/lib/detectores.ts src/lib/detectores.test.ts src/app/api/motor/route.ts
git commit -m "fix(desvio): filtra destinos com coordenada nula (destino fantasma a ~5300km)"
```

Lembrar: replicar o MESMO patch pro repo `MONITORAMENTO transmonseg` (definitivo) e fazer deploy manual nos dois processos PM2 do Contabo (git pull + npm ci + npm run build + pm2 restart --update-env em `transmonseg-temp` e `transmonseg-definitivo`) — git push sozinho NÃO atualiza o motor em produção.

---

### Task 2.2: Persistir o afastamento acumulado real no contexto (não "corrigir uma fórmula" — a fórmula está certa, falta o dado)

**Achado importante que precisa ser corrigido no relatório anterior:** a análise da segunda opinião apontou "o +X km acumulado não bate com o delta calculável" como se fosse um bug na fórmula. **Não é.** `afastamentoAcumuladoM` (`route.ts:1325-1328`) é `menorDistDestinoM - desvioInicio.menor_dist_m` — a distância acumulada desde o INÍCIO do streak (que pode ter várias leituras), não o delta de UM ciclo. O agente que revisou não tinha acesso a `desvioInicio.menor_dist_m` (não é salvo no `contexto`), só conseguia comparar `dist_destinos_m` vs `dist_destinos_anterior_m` de UM ciclo — por isso a comparação dele ficava sistematicamente menor (mediana 2,2x) que o valor real acumulado. **A fórmula do motivo está correta; falta é salvar o dado usado pra calculá-la, pra quem revisa depois conseguir auditar sem recalcular errado.**

**Arquivos:**
- Modificar: `src/lib/detectores.ts:626-660` (`montarContextoDesvio`)
- Modificar: `src/app/api/motor/route.ts` (as duas chamadas de `montarContextoDesvio`, ~linha 2340 e ~2392)
- Test: `src/lib/detectores.test.ts`

**Step 1: Escrever o teste que falha primeiro**

Em `src/lib/detectores.test.ts`, achar o teste existente de `montarContextoDesvio` (deve existir já, dado que essa função é testada) e adicionar uma asserção nova:

```ts
it("inclui o afastamento acumulado (menor_dist_m do desvioInicio) no contexto", () => {
  const ctx = montarContextoDesvio({
    desvioInicio: { lat: -22.9, lng: -43.2, ts: "2026-07-27T10:00:00.000Z", menor_dist_m: 5000 },
    dentroTapete: false,
    corredorInfo: null,
    distDestinosM: [8000],
    distDestinosAnteriorM: [7500],
    desvioStreak: 3,
    foraTapeteStreak: 0,
    divergenciaRumoStreak: 0,
    riscoAreaAtual: 0,
    familiarVeiculo: null,
    classeViaAtual: null,
    quedaClasseViaria: false,
    segmentoEspecifico: null,
    taxaFp: undefined,
  });
  expect(ctx.afastamento_acumulado_m).toBe(3000); // 8000 - 5000
});
```

Rodar: `npm test -- --run detectores.test.ts`
Esperado: FAIL (`afastamento_acumulado_m` undefined, ou a asserção falha)

**Step 2: Adicionar o campo na função**

Em `src/lib/detectores.ts`, na função `montarContextoDesvio` (retorno, dentro do objeto), adicionar:

```ts
afastamento_acumulado_m: Math.min(...p.distDestinosM) - p.desvioInicio.menor_dist_m,
```

**Step 3: Rodar o teste e confirmar que passa**

Rodar: `npm test -- --run detectores.test.ts`
Esperado: PASS

**Step 4: Rodar a suite inteira, tsc, build**

```bash
npm test -- --run
npx tsc --noEmit
npm run build
```

**Step 5: Commit, replicar no definitivo, deploy manual**

```bash
git add src/lib/detectores.ts src/lib/detectores.test.ts
git commit -m "fix(desvio): persiste afastamento_acumulado_m no contexto p/ auditoria (nao muda o motivo exibido, so os dados salvos)"
```

Mesma rotina de sempre: replicar patch no repo definitivo, deploy manual nos 2 processos PM2.

---

## Fase 3 — Decisões pendentes (precisam de brainstorming/investigação antes de virar plano de código)

Estes 4 itens NÃO têm spec ainda — não dá pra escrever passos de TDD sem antes decidir o comportamento desejado ou confirmar uma causa raiz.

### Item 3.1: Suprimir "afastando de destinos" quando `rota_concluida = true`?

Hoje `rota_concluida` é só uma ANOTAÇÃO retroativa no contexto (`route.ts:2708-2734`, ver `docs/superpowers/specs/2026-07-21-anotacao-rota-concluida-desvio-design.md`) — deliberadamente NÃO fecha nem suprime o alerta, decisão de design de 21/07. A revisão de hoje achou ~15 dos 91 casos de "afastando de destinos" com esse padrão (retorno à base após rota 100% concluída). **Decisão necessária:** manter só como anotação (operador dispensa manualmente, mais rápido de ver) vs. suprimir automaticamente (risco: pode mascarar um cenário real de entrega forçada sob coação nas últimas paradas). Recomendo trazer essa decisão pro usuário antes de mexer — não é bug, é trade-off de produto.

### Item 3.2: Trecho de via perto do "PetroMasa" (-22.830, -43.332) classificado errado

7 dos 36 alertas de "rua estranha" hoje dispararam nesse ponto específico, com veículos diferentes passando reto e rápido sem parar — forte indício de erro de classificação em `vias_celulas` (trecho marcado "estreita" quando deveria ser "principal"/"intermediaria"). **Investigação necessária antes do fix:** consultar `vias_celulas` no Postgres pra essa coordenada e confirmar a classificação atual, depois decidir se corrige manualmente aquele trecho ou se é sintoma de um problema mais amplo na fonte de classificação (OSM/Overpass).

### Item 3.3: Redesenhar "rumo diverge" pra não quebrar com muitos destinos pendentes

75% dos 80 casos revisados ficaram INCERTO — quando há 15+ destinos pendentes, "o destino mais próximo" vira um alvo instável (quase qualquer movimento parece afastamento). Isso é uma decisão de design real, com mais de uma abordagem possível (exigir corroboração extra acima de N destinos; normalizar por % de destinos que pioraram, não só o mais próximo; etc.) — **usar a skill `brainstorming`, possivelmente com uma `pesquisa` prévia** sobre como sistemas de rastreamento lidam com o problema de nearest-neighbor instável com múltiplos alvos, antes de escrever qualquer spec de implementação.

### Item 3.4: Suprimir "rua estranha" quando o veículo para pouco depois sem entrar em área de risco

12 dos 24 casos "resolvido" de rua estranha (50%) mostraram: saiu de via principal, andou por rua estreita, parou poucos minutos depois sem estar perto de nenhuma favela/área de risco — padrão de chegada legítima. **Decisão necessária:** que threshold de "parou rápido o suficiente" e "longe o suficiente de área de risco" usar pra suprimir/rebaixar automaticamente, sem enfraquecer demais a regra pros casos REAIS achados hoje (que também tendem a estar perto de favela mapeada — ver TTH-6H80, TTK-4D14, TTT-1E20, TTI-9B97, TUI-0H19, RQP-4A68, TTH-0G95: todos os 7 casos REAIS da revisão de hoje estavam a menos de ~230m de uma favela geofenced). Isso sugere que "está perto de área de risco mapeada" pode ser exatamente o corroborador que falta nessa regra — vale considerar como abordagem central antes de brainstormar alternativas.
