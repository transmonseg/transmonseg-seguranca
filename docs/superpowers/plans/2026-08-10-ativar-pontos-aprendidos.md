# Ativar pontos_aprendidos Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Ativar a tabela `pontos_aprendidos` (já coleta desde 03/08, hoje
em modo sombra) como fonte de correção de posição da "bolinha" (alvo
Unitrac), corrigindo automaticamente tanto o motor de desvio quanto a
confirmação de entrega, já que os dois consomem a mesma lista `pendentes`.

**Architecture:** Um Map novo carregado 1x por ciclo do motor a partir de
`pontos_aprendidos` (mesmo padrão de `mapaBasesCliente`), consumido por
uma função pura nova (`corrigirComPontoAprendido`) aplicada no ponto exato
onde `pendentes` já é filtrado hoje — sem tocar em nenhum consumidor
downstream (desvio, bypass_entrega, entregas_presenca, D1/D3) individualmente.

**Tech Stack:** Next.js/TypeScript, Vitest, Postgres (Contabo).

## Global Constraints

- Spec de origem: `docs/superpowers/specs/2026-08-10-ativar-pontos-aprendidos-design.md`
  — ler o arquivo inteiro antes de qualquer task, tem o racional completo
  (por que só corrige lat/lng, por que o teto é 500m, por que não usa
  romaneio).
- Ambos os repos (`MONITORAMENTO TEMP` e `MONITORAMENTO transmonseg`)
  recebem os mesmos commits ao final. Deploy real no Contabo
  (`transmonseg-vps`, pm2 `transmonseg-temp` e `transmonseg-definitivo`) só
  no último task, com autorização já dada pelo usuário nesta sessão pro
  padrão geral de deploy (não precisa perguntar de novo, mas seguir o
  mesmo processo: push → pull → build → restart → verificar).
- Vitest é o único framework de teste (`npm test` = `vitest run`). Nenhuma
  API route deste projeto tem teste automatizado — não introduzir isso
  agora.
- `haversineM(aLat, aLng, bLat, bLng): number` já existe em
  `src/lib/unitrac.ts:213` — reusar, não duplicar.
- `PontoEntrega` (tipo, `src/lib/unitrac.ts:82-99`) já tem o campo
  `pontoCodigo: number | null` — é a chave de correlação com
  `pontos_aprendidos.ponto_codigo`.

---

### Task 1: Função pura de correção + flag de ativação

**Files:**
- Modify: `src/lib/unitrac.ts` (adicionar depois de `haversineM`, linha
  ~222)
- Test: `src/lib/unitrac.test.ts`

**Interfaces:**
- Consumes: `haversineM` (já existe, `unitrac.ts:213`), `PontoEntrega`
  (já existe, `unitrac.ts:82-99`).
- Produces: `CORRECAO_APRENDIDA_DIVERGENCIA_MAX_M: number`,
  `PONTO_APRENDIDO_ATIVO: boolean`,
  `corrigirComPontoAprendido(pt: PontoEntrega, aprendido: { lat: number; lng: number } | undefined): PontoEntrega`
  — consumido pelo Task 3 (wiring em `route.ts`).

- [ ] **Step 1: Escrever os testes primeiro**

Adicionar ao final de `src/lib/unitrac.test.ts` (usar um `describe` novo;
olhar o describe existente de `haversineM`, se houver, pra manter o
mesmo estilo de fixture de `PontoEntrega` usado no resto do arquivo):

```typescript
describe("corrigirComPontoAprendido", () => {
  const pontoBase: PontoEntrega = {
    lat: -22.9, lng: -43.2, raio: 150, ordem: 1, nome: "Cliente Teste",
    feito: false, situacao: 0, codigo: 111, pontoCodigo: 222,
    documento: "NF1", identificador: null, dataInicio: null,
    dataRealizado: null, observacoes: null, rota: null,
  };

  it("sem correção disponível, retorna o ponto inalterado", () => {
    const r = corrigirComPontoAprendido(pontoBase, undefined);
    expect(r).toEqual(pontoBase);
  });

  it("correção dentro do teto de 500m, aplica lat/lng do aprendido e mantém o resto", () => {
    // ~111m ao norte da posição original (0.001 grau de lat ~ 111m)
    const aprendido = { lat: -22.899, lng: -43.2 };
    const r = corrigirComPontoAprendido(pontoBase, aprendido);
    expect(r.lat).toBe(aprendido.lat);
    expect(r.lng).toBe(aprendido.lng);
    expect(r.raio).toBe(pontoBase.raio);
    expect(r.nome).toBe(pontoBase.nome);
    expect(r.pontoCodigo).toBe(pontoBase.pontoCodigo);
  });

  it("correção fora do teto de 500m, retorna o ponto inalterado", () => {
    // ~1110m ao norte (0.01 grau de lat ~ 1110m, bem acima do teto de 500m)
    const aprendidoLonge = { lat: -22.89, lng: -43.2 };
    const r = corrigirComPontoAprendido(pontoBase, aprendidoLonge);
    expect(r).toEqual(pontoBase);
  });

  it("correção exatamente no teto (500m) ainda aplica (limite inclusivo)", () => {
    // ~499m ao norte -- dentro do teto por pouco
    const aprendidoNoLimite = { lat: -22.9 + 499 / 111320, lng: -43.2 };
    const r = corrigirComPontoAprendido(pontoBase, aprendidoNoLimite);
    expect(r.lat).toBe(aprendidoNoLimite.lat);
  });
});
```

- [ ] **Step 2: Rodar os testes, confirmar que falham**

Run: `npx vitest run src/lib/unitrac.test.ts -t corrigirComPontoAprendido`
Expected: FAIL com "corrigirComPontoAprendido is not defined" (ou erro de
import).

- [ ] **Step 3: Implementar em `src/lib/unitrac.ts`**

Adicionar logo depois da função `haversineM` (linha ~222):

```typescript
// Achado real 10/08 (conversa com operador no WhatsApp, motivada pela
// investigacao de marcacao errada / dado_entrada_errado): pontos_aprendidos
// (scripts/migrations/contabo/028_pontos_aprendidos.sql) ja coleta desde
// 03/08 a posicao real aprendida por (cliente_id, ponto_codigo), a partir
// do acumulado de paradas confirmadas -- mas estava 100% em modo sombra,
// nunca consumido. Divergencia real medida hoje contra a Unitrac: mediana
// 56m, maximo observado 232m, 91 pontos com correspondencia. Ativando
// aqui como correcao de posicao na fonte comum (pendentes), propagando
// pro motor de desvio E pra confirmacao de entrega ao mesmo tempo (ver
// docs/superpowers/specs/2026-08-10-ativar-pontos-aprendidos-design.md).
export const PONTO_APRENDIDO_ATIVO = true;

// Teto de divergencia: acima disso, a leitura atual da Unitrac diverge
// demais do aprendido pra tratar como "mesmo lugar, correcao de ruido" --
// protege contra confiar num ponto aprendido desatualizado se o endereco
// real do cliente mudar no futuro. Com o dado real de hoje (mediana 56m,
// max 232m) este teto nunca bloqueia uma correcao real -- e protecao pro
// futuro, nao limitador atual.
export const CORRECAO_APRENDIDA_DIVERGENCIA_MAX_M = 500;

// So corrige lat/lng -- raio (raio de chegada nominal) NAO muda, porque
// pontos_aprendidos.raio_m tem semantica diferente ("maior distancia da
// mediana entre as observacoes", nao "raio de tolerancia de chegada").
// Misturar os dois faria o raio de chegada oscilar sem relacao com o
// problema que resolve.
export function corrigirComPontoAprendido(
  pt: PontoEntrega,
  aprendido: { lat: number; lng: number } | undefined
): PontoEntrega {
  if (!aprendido) return pt;
  const divergenciaM = haversineM(pt.lat, pt.lng, aprendido.lat, aprendido.lng);
  if (divergenciaM > CORRECAO_APRENDIDA_DIVERGENCIA_MAX_M) return pt;
  return { ...pt, lat: aprendido.lat, lng: aprendido.lng };
}
```

- [ ] **Step 4: Rodar os testes de novo, confirmar que passam**

Run: `npx vitest run src/lib/unitrac.test.ts -t corrigirComPontoAprendido`
Expected: PASS (4 testes)

- [ ] **Step 5: Rodar a suíte inteira**

Run: `npm test`
Expected: PASS — nenhum teste existente quebra (função nova, aditiva, não
muda comportamento de nenhuma função já existente).

- [ ] **Step 6: Commit**

```bash
git add src/lib/unitrac.ts src/lib/unitrac.test.ts
git commit -m "feat(unitrac): corrigirComPontoAprendido -- ativa pontos_aprendidos como correcao de posicao"
```

---

### Task 2: Carregar `pontos_aprendidos` uma vez por ciclo do motor

**Files:**
- Modify: `src/app/api/motor/route.ts` (novo bloco, logo depois do bloco
  de carregamento de `mapaBasesCliente`, que termina por volta da linha
  792 — inserir o bloco novo IMEDIATAMENTE após, mesmo padrão de
  organização)

**Interfaces:**
- Consumes: nada de outras tasks (é só carregamento de dados).
- Produces: `mapaPontosAprendidos: Map<string, Map<number, { lat: number; lng: number }>>`
  — consumido pelo Task 3 (wiring na montagem de `pendentes`).

Este task não tem teste automatizado (é carregamento de dados de uma
rota sem testes, mesmo padrão de `mapaBasesCliente` — que também não tem
teste dedicado). Verificação é via Step 3 abaixo (rodar o motor
localmente ou revisão de código cuidadosa) e verificação manual pós-deploy
no Task 4.

- [ ] **Step 1: Localizar o ponto de inserção**

Abrir `src/app/api/motor/route.ts`, localizar o bloco de carregamento de
`mapaBasesCliente` (texto: `const mapaBasesCliente = new Map<`). O bloco
termina no `}` que fecha o `try/catch/finally` desse carregamento (por
volta da linha 792). O novo bloco entra logo depois desse `}` de
fechamento, antes do próximo código existente.

- [ ] **Step 2: Adicionar o import**

No topo do arquivo, localizar o bloco de imports de `src/lib/unitrac`
(mesmo import que já traz `PontoEntrega`, `haversineM`, etc — procurar
`from "@/lib/unitrac"` ou caminho relativo equivalente já usado no
arquivo) e adicionar `corrigirComPontoAprendido` à lista de nomes
importados.

- [ ] **Step 3: Adicionar o bloco de carregamento**

```typescript
const mapaPontosAprendidos = new Map<string, Map<number, { lat: number; lng: number }>>();

{
  const pgAprendidos = await pool.connect();
  try {
    const { rows: pontosAprendidosRows } = await pgAprendidos.query<{
      cliente_id: string;
      ponto_codigo: number;
      lat: number;
      lng: number;
    }>(`SELECT cliente_id, ponto_codigo, lat, lng FROM pontos_aprendidos`);
    for (const r of pontosAprendidosRows) {
      const porCliente = mapaPontosAprendidos.get(r.cliente_id) ?? new Map();
      porCliente.set(r.ponto_codigo, { lat: r.lat, lng: r.lng });
      mapaPontosAprendidos.set(r.cliente_id, porCliente);
    }
  } catch (errAprendidos) {
    const msg = `Aviso: erro ao carregar pontos_aprendidos (${String(errAprendidos)})`;
    console.warn(msg);
    erros.push(msg);
  } finally {
    pgAprendidos.release();
  }
}
```

`pool`, `erros` já existem no escopo (usados pelo bloco de
`mapaBasesCliente` logo acima, que segue o mesmo padrão) — não precisam
ser declarados de novo.

- [ ] **Step 4: Verificar que o arquivo compila**

Run: `npx tsc --noEmit`
Expected: sem erro novo relacionado a este bloco (erros pré-existentes no
projeto, se houver, não são deste task — confirmar isso comparando com
`git stash` antes/depois se houver dúvida).

- [ ] **Step 5: Rodar a suíte inteira**

Run: `npm test`
Expected: PASS (este task não muda nenhuma função testada, só adiciona
uma variável nova ainda não consumida — o Task 3 é que fecha o
comportamento).

- [ ] **Step 6: Commit**

```bash
git add src/app/api/motor/route.ts
git commit -m "feat(motor): carrega pontos_aprendidos 1x por ciclo (mapaPontosAprendidos)"
```

---

### Task 3: Aplicar a correção na montagem de `pendentes`

**Files:**
- Modify: `src/app/api/motor/route.ts:1805` (bloco de montagem de
  `pendentes`)

**Interfaces:**
- Consumes: `mapaPontosAprendidos` (Task 2), `corrigirComPontoAprendido`
  e `PONTO_APRENDIDO_ATIVO` (Task 1, já importados).
- Produces: nada de novo pra outras tasks — este é o task que fecha o
  comportamento observável da feature.

- [ ] **Step 1: Localizar o bloco atual**

Em `src/app/api/motor/route.ts`, por volta da linha 1805, o bloco atual é:

```typescript
const pendentes = (pontosVeiculo ?? []).filter(
  (pt) =>
    !pt.feito &&
    temCoordenadaValida(pt) &&
    !(
      ENTREGA_PRESENCA_ATIVA &&
      pt.pontoCodigo != null &&
      presencaEntregaCliente.has(`${veiculo_id}:${pt.pontoCodigo}`)
    )
);
```

Confirme o texto exato antes de editar (buscar por
`const pendentes = (pontosVeiculo ?? []).filter(` — se a linha mudou de
número, localizar pelo texto).

- [ ] **Step 2: Editar pra aplicar a correção depois do filtro**

```typescript
const pontosAprendidosCliente = mapaPontosAprendidos.get(cliente_id);
const pendentes = (pontosVeiculo ?? [])
  .filter(
    (pt) =>
      !pt.feito &&
      temCoordenadaValida(pt) &&
      !(
        ENTREGA_PRESENCA_ATIVA &&
        pt.pontoCodigo != null &&
        presencaEntregaCliente.has(`${veiculo_id}:${pt.pontoCodigo}`)
      )
  )
  .map((pt) =>
    PONTO_APRENDIDO_ATIVO && pt.pontoCodigo != null
      ? corrigirComPontoAprendido(pt, pontosAprendidosCliente?.get(pt.pontoCodigo))
      : pt
  );
```

`cliente_id` já está disponível neste escopo (desestruturado na linha
1693, `const { veiculo_id, cliente_id } = entrada;`, antes deste bloco).

- [ ] **Step 3: Verificar que o arquivo compila**

Run: `npx tsc --noEmit`
Expected: sem erro novo.

- [ ] **Step 4: Rodar a suíte inteira**

Run: `npm test`
Expected: PASS (682+ testes — nenhum teste existente exercita
`mapaPontosAprendidos`/`PONTO_APRENDIDO_ATIVO` diretamente, já que não há
teste de rota neste projeto; a suíte só precisa continuar verde,
provando que a mudança não quebrou nenhum comportamento já coberto).

- [ ] **Step 5: Commit**

```bash
git add src/app/api/motor/route.ts
git commit -m "feat(motor): aplica correcao de pontos_aprendidos na montagem de pendentes"
```

---

### Task 4: Sincronizar mirror, deploy real e verificação em produção

**Files:** nenhum arquivo novo — task de integração/deploy.

- [ ] **Step 1: Rodar a suíte completa mais uma vez, do zero**

Run: `npm test`
Expected: PASS, 100%.

- [ ] **Step 2: Push do repo principal**

```bash
cd "/Users/joaquimsalles/Projects/Transmonseg/monitoramento/MONITORAMENTO TEMP"
git push origin master
```

- [ ] **Step 3: Sincronizar o mirror `MONITORAMENTO transmonseg`**

```bash
cd "/Users/joaquimsalles/Projects/Transmonseg/monitoramento/MONITORAMENTO transmonseg"
git remote add temp-local "/Users/joaquimsalles/Projects/Transmonseg/monitoramento/MONITORAMENTO TEMP"
git fetch temp-local master
git cherry-pick <hash-do-commit-do-Task-1>..<hash-do-commit-do-Task-3>
git remote remove temp-local
```

(Usar os hashes reais anotados no ledger de progresso ao longo da
execução — não confiar em `HEAD~N` depois de várias tasks. Resolver
qualquer conflito trivial como já foi feito antes nesta sessão, ex:
`.gitignore`.)

- [ ] **Step 4: Rodar a suíte no mirror, depois push**

```bash
npm test
git push origin main
```

Expected: PASS antes do push.

- [ ] **Step 5: Deploy real no Contabo, os dois processos**

```bash
ssh transmonseg-vps "cd /srv/transmonseg/temp && git pull origin master && npm run build && pm2 restart transmonseg-temp"
ssh transmonseg-vps "cd /srv/transmonseg/definitivo && git pull origin main && npm run build && pm2 restart transmonseg-definitivo"
```

(Nenhum `package.json`/`package-lock.json` muda neste plano — pode pular
`npm install`, mas confirmar com
`git diff HEAD origin/master -- package.json package-lock.json` antes de
assumir isso fechado.)

- [ ] **Step 6: Verificar via pm2 que os dois processos subiram sem erro fatal**

```bash
ssh transmonseg-vps "pm2 describe transmonseg-temp | grep -E 'status|restart'; pm2 logs transmonseg-temp --lines 30 --nostream | grep -iE 'error|exception|fatal'"
ssh transmonseg-vps "pm2 describe transmonseg-definitivo | grep -E 'status|restart'; pm2 logs transmonseg-definitivo --lines 30 --nostream | grep -iE 'error|exception|fatal'"
```

Expected: `status: online`. Erros de rede externa (Unitrac timeout, etc)
são ruído esperado, não bloqueiam — só travar em erro relacionado a
`mapaPontosAprendidos`/`corrigirComPontoAprendido`/query de
`pontos_aprendidos`.

- [ ] **Step 7: Verificação real — confirmar que o motor carrega
  `pontos_aprendidos` sem erro**

```bash
ssh transmonseg-vps "pm2 logs transmonseg-temp --lines 200 --nostream | grep -i 'pontos_aprendidos'"
```

Expected: nenhuma linha de aviso ("Aviso: erro ao carregar
pontos_aprendidos...") — ausência de log é o resultado esperado (o
carregamento só loga em caso de erro).

- [ ] **Step 8: Verificação real — confirmar que a correção está sendo
  aplicada de fato**

Usar o ponto com maior divergência medida hoje (`ponto_codigo=563321`,
242m de divergência entre Unitrac e `pontos_aprendidos` no momento da
investigação) para comparar a posição gravada em
`pendentes_snapshot_log` ANTES e DEPOIS do deploy:

```bash
ssh transmonseg-vps "psql 'postgres://app_service:5cf0fd1c8cfc0dfdf66a19196d5e6ebc691bbc628d7e637c@localhost:5432/transmonseg' -c \"
select criado_em, pt->>'lat' as lat, pt->>'lng' as lng
from pendentes_snapshot_log, jsonb_array_elements(pendentes) as pt
where pt->>'codigo' = '563321' and criado_em >= now() - interval '15 minutes'
order by criado_em desc limit 5;
\""
```

Comparar o `lat`/`lng` retornado contra a posição aprendida (consultar
`select lat, lng from pontos_aprendidos where ponto_codigo = 563321`) —
depois do deploy, devem bater (ou ficar muito próximos, dentro de
alguns metros de arredondamento), não mais com a posição bruta da
Unitrac de antes do deploy.

- [ ] **Step 9: Atualizar o ledger do plano com o resumo final**

Documentar no ledger (`.superpowers/sdd/2026-08-10-ativar-pontos-aprendidos/progress.md`):
hashes de commit finais nos dois repos, resultado da verificação do Step 8
(bateu ou não bateu, e se não bateu, o que foi investigado).
