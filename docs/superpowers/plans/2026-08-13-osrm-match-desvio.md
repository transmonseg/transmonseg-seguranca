# Map matching (OSRM /match) no detector de desvio v2 — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Quando o detector de desvio v2 já tem um possível alerta se formando (`afastandoStreak > 0`), corrigir a posição atual/anterior via `/match` do OSRM (map matching real, não `/table` ponto-a-ponto) antes de medir distância aos destinos, eliminando o artefato de "delta de distância uniforme entre destinos completamente diferentes" achado em 4 casos reais no dia 13/08.

**Architecture:** Novo módulo puro `src/lib/osrm-match.ts` (mesmo padrão de `src/lib/distancia-real.ts`) chama `/match` com os últimos ~5min de posição do veículo e devolve os dois últimos pontos corrigidos + confiança. `route.ts` só usa esse resultado como substituto de `pos`/`anterior` brutos ANTES de chamar `buscarDistanciasReais` (que não muda) — e só quando já há streak>0. Fallback silencioso pro método bruto em qualquer falha/confiança baixa.

**Tech Stack:** TypeScript, Next.js API routes, `pg` (node-postgres), OSRM self-hosted (`/match/v1/driving`, algoritmo `mld`), Vitest.

## Global Constraints

- Correção só ativa quando `estadoDesvioAnterior.afastandoStreak > 0` (nunca em ciclo "limpo") — ver spec, seção "Não-objetivos".
- Fallback silencioso (nunca lança exceção, nunca bloqueia o ciclo) em qualquer falha do `/match` — mesmo contrato de `buscarDistanciasReais` em `src/lib/distancia-real.ts`.
- `OSRM_LOCAL_URL` já configurado (`http://127.0.0.1:5001` por padrão) — reusar a mesma env var de `distancia-real.ts`, não criar uma nova.
- Janela de dados: últimos 5 minutos de `posicoes_historico` do veículo.
- Todo código vai pros DOIS repos (`MONITORAMENTO TEMP` e `MONITORAMENTO transmonseg`, mantidos idênticos) e pros DOIS bancos (local `.env.local` + Contabo produção).
- Sem modo teste/sombra — direto pra produção, como o resto do sistema (ver spec).
- Deploy: `git pull && npm run build && pm2 restart <processo>` — SEM `rm -rf .next` (achado real 13/08: apagar `.next` com o processo antigo ainda servindo causa indisponibilidade real; só necessário quando rotas são deletadas, o que não é o caso aqui).

---

### Task 1: Migration — coluna `posicao_corrigida` em `desvio_disparo_log`

**Files:**
- Create: `scripts/migrations/046_desvio_disparo_log_posicao_corrigida.sql`
- Create: `scripts/migrations/contabo/048_desvio_disparo_log_posicao_corrigida.sql`

**Interfaces:**
- Produces: coluna `desvio_disparo_log.posicao_corrigida boolean NOT NULL DEFAULT false` — Task 4 grava esse valor no INSERT existente.

- [ ] **Step 1: Escrever a migration local**

```sql
-- 046_desvio_disparo_log_posicao_corrigida.sql
--
-- Achado real 13/08 (4 falsos positivos no mesmo dia com assinatura
-- identica -- delta de distancia uniforme entre destinos completamente
-- diferentes, causado por /table encaixando cada ponto independentemente
-- na malha viaria): ver docs/superpowers/specs/2026-08-13-osrm-match-desvio-design.md.
-- Esta coluna registra se um disparo especifico usou posicao corrigida
-- via /match (streak>0, correcao ativa e confiavel) ou bruta (streak==0,
-- ou /match falhou/confianca baixa) -- permite comparar os dois metodos
-- lado a lado com dado real depois do deploy.
ALTER TABLE desvio_disparo_log ADD COLUMN IF NOT EXISTS posicao_corrigida boolean NOT NULL DEFAULT false;
NOTIFY pgrst, 'reload schema';
```

Salvar em `scripts/migrations/046_desvio_disparo_log_posicao_corrigida.sql` (repo `MONITORAMENTO TEMP`).

- [ ] **Step 2: Aplicar a migration local**

```bash
cd "/Users/joaquimsalles/Projects/Transmonseg/monitoramento/MONITORAMENTO TEMP"
node --env-file=.env.local scripts/aplicar-migration.mjs 046_desvio_disparo_log_posicao_corrigida.sql
```

Expected: `OK — migration aplicada.` e `desvio_disparo_log` aparece na lista de tabelas impressa.

- [ ] **Step 3: Copiar a mesma migration pra pasta contabo com número próprio**

```bash
cp scripts/migrations/046_desvio_disparo_log_posicao_corrigida.sql \
   scripts/migrations/contabo/048_desvio_disparo_log_posicao_corrigida.sql
```

(Conteúdo SQL idêntico — só muda a pasta/numeração, mesmo padrão já usado por `045_desvio_disparo_log.sql`/`contabo/047_desvio_disparo_log.sql` no mesmo dia.)

- [ ] **Step 4: Copiar os dois arquivos de migration pro repo definitivo**

```bash
cp scripts/migrations/046_desvio_disparo_log_posicao_corrigida.sql \
   "/Users/joaquimsalles/Projects/Transmonseg/monitoramento/MONITORAMENTO transmonseg/scripts/migrations/046_desvio_disparo_log_posicao_corrigida.sql"
cp scripts/migrations/contabo/048_desvio_disparo_log_posicao_corrigida.sql \
   "/Users/joaquimsalles/Projects/Transmonseg/monitoramento/MONITORAMENTO transmonseg/scripts/migrations/contabo/048_desvio_disparo_log_posicao_corrigida.sql"
```

- [ ] **Step 5: Aplicar a migration em produção (Contabo)**

A tabela `desvio_disparo_log` foi criada originalmente via superuser (`sudo -u postgres psql`), não via `app_service` — aplicar do mesmo jeito:

```bash
scp scripts/migrations/contabo/048_desvio_disparo_log_posicao_corrigida.sql \
    transmonseg-vps:/srv/transmonseg/temp/scripts/migrations/contabo/048_desvio_disparo_log_posicao_corrigida.sql
ssh transmonseg-vps "sudo -u postgres psql -d transmonseg -f /srv/transmonseg/temp/scripts/migrations/contabo/048_desvio_disparo_log_posicao_corrigida.sql"
```

Expected: `ALTER TABLE` e `NOTIFY` impressos, sem erro.

- [ ] **Step 6: Commit**

```bash
cd "/Users/joaquimsalles/Projects/Transmonseg/monitoramento/MONITORAMENTO TEMP"
git add scripts/migrations/046_desvio_disparo_log_posicao_corrigida.sql scripts/migrations/contabo/048_desvio_disparo_log_posicao_corrigida.sql
git commit -m "feat(desvio): migration posicao_corrigida em desvio_disparo_log"
git push origin HEAD

cd "/Users/joaquimsalles/Projects/Transmonseg/monitoramento/MONITORAMENTO transmonseg"
git add scripts/migrations/046_desvio_disparo_log_posicao_corrigida.sql scripts/migrations/contabo/048_desvio_disparo_log_posicao_corrigida.sql
git commit -m "feat(desvio): migration posicao_corrigida em desvio_disparo_log"
git push origin HEAD
```

---

### Task 2: `corrigirPosicoesComMatch` — função pura + testes

**Files:**
- Create: `src/lib/osrm-match.ts`
- Test: `src/lib/osrm-match.test.ts`

**Interfaces:**
- Produces:
  ```ts
  export type PosicaoCorrigida = { lat: number; lng: number };
  export type ResultadoMatch = { atual: PosicaoCorrigida; anterior: PosicaoCorrigida; confidence: number };
  export async function corrigirPosicoesComMatch(
    pontos: { lat: number; lng: number; timestamp: Date }[]
  ): Promise<ResultadoMatch | null>
  ```
  — Task 4 (`route.ts`) importa e chama `corrigirPosicoesComMatch`.
- Consumes: nada de tasks anteriores (função de rede isolada, mesmo padrão de `buscarDistanciasReais` em `src/lib/distancia-real.ts`).

**Contrato exato:**
- `pontos` já vem ORDENADO por tempo crescente (mais antigo primeiro, mais recente por último) — quem chama (Task 4) garante isso.
- Se `pontos.length < 2`: retorna `null` sem chamar rede (não dá pra corrigir "atual" e "anterior" com menos de 2 pontos).
- Chama `GET {OSRM_LOCAL_URL}/match/v1/driving/{lng1,lat1;lng2,lat2;...}?timestamps={ts1;ts2;...}&annotations=false&overview=false`, timestamps em segundos Unix (`Math.floor(p.timestamp.getTime() / 1000)`).
- Resposta OSRM tem `code`, `matchings[]` (cada uma com `confidence`), e `tracepoints[]` (um item por ponto de ENTRADA, na mesma ordem, `null` se aquele ponto foi descartado como outlier, senão `{ location: [lng, lat], matchings_index: number, ... }`).
- Pega os dois ÚLTIMOS `tracepoints` não-nulos da lista, na ordem em que aparecem (o último = "atual" corrigido, o penúltimo não-nulo antes dele = "anterior" corrigido). Se não houver 2 tracepoints não-nulos, retorna `null`.
- `confidence` do resultado = `matchings[tracepoints_do_atual.matchings_index].confidence`.
- Qualquer falha (`!res.ok`, `code !== "Ok"`, exceção de rede/timeout, resposta sem `tracepoints`/`matchings`, menos de 2 tracepoints válidos) retorna `null` — NUNCA lança.
- Timeout de rede: mesmo `DEADLINE_MS = 5000` de `distancia-real.ts`.

- [ ] **Step 1: Escrever os testes (mockando fetch global)**

```ts
import { describe, it, expect, vi, afterEach } from "vitest";
import { corrigirPosicoesComMatch } from "./osrm-match";

function mockFetchOnce(body: unknown, ok = true) {
  vi.stubGlobal(
    "fetch",
    vi.fn().mockResolvedValue({ ok, json: async () => body })
  );
}

const PONTOS = [
  { lat: -22.649233, lng: -42.003758, timestamp: new Date("2026-08-13T14:04:12Z") },
  { lat: -22.650163, lng: -42.004082, timestamp: new Date("2026-08-13T14:08:43Z") },
  { lat: -22.648532, lng: -42.00391, timestamp: new Date("2026-08-13T14:09:48Z") },
];

describe("corrigirPosicoesComMatch", () => {
  afterEach(() => vi.unstubAllGlobals());

  it("retorna null com menos de 2 pontos (sem chamar rede)", async () => {
    const fetchSpy = vi.fn();
    vi.stubGlobal("fetch", fetchSpy);
    const r = await corrigirPosicoesComMatch([PONTOS[0]]);
    expect(r).toBeNull();
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("corrige com sucesso: pega os 2 ultimos tracepoints nao-nulos + confidence da matching certa", async () => {
    mockFetchOnce({
      code: "Ok",
      matchings: [{ confidence: 0.87 }],
      tracepoints: [
        { location: [-42.0038, -22.6493], matchings_index: 0 },
        { location: [-42.0041, -22.6502], matchings_index: 0 },
        { location: [-42.0039, -22.6485], matchings_index: 0 },
      ],
    });
    const r = await corrigirPosicoesComMatch(PONTOS);
    expect(r).toEqual({
      anterior: { lat: -22.6502, lng: -42.0041 },
      atual: { lat: -22.6485, lng: -42.0039 },
      confidence: 0.87,
    });
  });

  it("pula tracepoints nulos (outliers descartados) ao escolher os 2 ultimos", async () => {
    mockFetchOnce({
      code: "Ok",
      matchings: [{ confidence: 0.5 }],
      tracepoints: [
        { location: [-42.0038, -22.6493], matchings_index: 0 },
        { location: [-42.0041, -22.6502], matchings_index: 0 },
        null,
      ],
    });
    const r = await corrigirPosicoesComMatch(PONTOS);
    expect(r).toEqual({
      anterior: { lat: -22.6493, lng: -42.0038 },
      atual: { lat: -22.6502, lng: -42.0041 },
      confidence: 0.5,
    });
  });

  it("retorna null se a resposta HTTP nao for ok", async () => {
    mockFetchOnce({}, false);
    expect(await corrigirPosicoesComMatch(PONTOS)).toBeNull();
  });

  it("retorna null se code != Ok", async () => {
    mockFetchOnce({ code: "NoMatch" });
    expect(await corrigirPosicoesComMatch(PONTOS)).toBeNull();
  });

  it("retorna null se houver menos de 2 tracepoints nao-nulos", async () => {
    mockFetchOnce({
      code: "Ok",
      matchings: [{ confidence: 0.9 }],
      tracepoints: [null, null, { location: [-42.0039, -22.6485], matchings_index: 0 }],
    });
    expect(await corrigirPosicoesComMatch(PONTOS)).toBeNull();
  });

  it("retorna null em erro de rede (nunca lanca excecao)", async () => {
    vi.stubGlobal("fetch", vi.fn().mockRejectedValue(new Error("timeout")));
    await expect(corrigirPosicoesComMatch(PONTOS)).resolves.toBeNull();
  });
});
```

- [ ] **Step 2: Rodar os testes, confirmar que falham (arquivo `osrm-match.ts` ainda não existe)**

```bash
cd "/Users/joaquimsalles/Projects/Transmonseg/monitoramento/MONITORAMENTO TEMP"
npx vitest run src/lib/osrm-match.test.ts
```

Expected: FAIL — `Cannot find module './osrm-match'`.

- [ ] **Step 3: Implementar `src/lib/osrm-match.ts`**

```ts
// Corrige posicao atual/anterior via map matching real do OSRM (/match,
// Hidden Markov Model) antes do calculo de distancia -- ver
// docs/superpowers/specs/2026-08-13-osrm-match-desvio-design.md. Ao
// contrario de /table (distancia-real.ts), que encaixa cada ponto
// independentemente na rua mais proxima, /match encaixa a TRAJETORIA
// inteira de uma vez, evitando o artefato de "delta uniforme entre
// destinos completamente diferentes" achado em 4 casos reais no dia
// 13/08 -- puramente uma chamada de rede, sem logica de decisao (quem
// chama decide QUANDO usar isso, ver route.ts).

const OSRM_LOCAL_URL = process.env.OSRM_LOCAL_URL ?? "http://127.0.0.1:5001";
const DEADLINE_MS = 5000;

export type PosicaoCorrigida = { lat: number; lng: number };
export type ResultadoMatch = { atual: PosicaoCorrigida; anterior: PosicaoCorrigida; confidence: number };

type TracePoint = { location: [number, number]; matchings_index: number } | null;
type RespostaMatch = { code: string; matchings?: { confidence: number }[]; tracepoints?: TracePoint[] };

export async function corrigirPosicoesComMatch(
  pontos: { lat: number; lng: number; timestamp: Date }[]
): Promise<ResultadoMatch | null> {
  if (pontos.length < 2) return null;

  const coords = pontos.map((p) => `${p.lng},${p.lat}`).join(";");
  const timestamps = pontos.map((p) => Math.floor(p.timestamp.getTime() / 1000)).join(";");

  try {
    const res = await fetch(
      `${OSRM_LOCAL_URL}/match/v1/driving/${coords}?timestamps=${timestamps}&annotations=false&overview=false`,
      { signal: AbortSignal.timeout(DEADLINE_MS) }
    );
    if (!res.ok) return null;

    const data = (await res.json()) as RespostaMatch;
    if (data.code !== "Ok" || !data.matchings || !data.tracepoints) return null;

    const validos = data.tracepoints.filter((tp): tp is NonNullable<TracePoint> => tp !== null);
    if (validos.length < 2) return null;

    const tpAtual = validos[validos.length - 1];
    const tpAnterior = validos[validos.length - 2];
    const confidence = data.matchings[tpAtual.matchings_index]?.confidence;
    if (confidence == null) return null;

    return {
      atual: { lat: tpAtual.location[1], lng: tpAtual.location[0] },
      anterior: { lat: tpAnterior.location[1], lng: tpAnterior.location[0] },
      confidence,
    };
  } catch {
    return null;
  }
}
```

- [ ] **Step 4: Rodar os testes, confirmar que passam**

```bash
npx vitest run src/lib/osrm-match.test.ts
```

Expected: 7 testes, todos PASS.

- [ ] **Step 5: Typecheck**

```bash
npx tsc --noEmit -p .
```

Expected: sem erro.

- [ ] **Step 6: Copiar pro repo definitivo, confirmar testes+typecheck lá também**

```bash
cp src/lib/osrm-match.ts src/lib/osrm-match.test.ts \
   "/Users/joaquimsalles/Projects/Transmonseg/monitoramento/MONITORAMENTO transmonseg/src/lib/"
cd "/Users/joaquimsalles/Projects/Transmonseg/monitoramento/MONITORAMENTO transmonseg"
npx vitest run src/lib/osrm-match.test.ts
npx tsc --noEmit -p .
```

- [ ] **Step 7: Commit nos dois repos**

```bash
cd "/Users/joaquimsalles/Projects/Transmonseg/monitoramento/MONITORAMENTO TEMP"
git add src/lib/osrm-match.ts src/lib/osrm-match.test.ts
git commit -m "feat(desvio): corrigirPosicoesComMatch -- map matching via OSRM /match"
git push origin HEAD

cd "/Users/joaquimsalles/Projects/Transmonseg/monitoramento/MONITORAMENTO transmonseg"
git add src/lib/osrm-match.ts src/lib/osrm-match.test.ts
git commit -m "feat(desvio): corrigirPosicoesComMatch -- map matching via OSRM /match"
git push origin HEAD
```

---

### Task 3: Calibrar o piso de confiança com dado real (13/08)

**Files:**
- Create: `scripts/calibrar-piso-confianca-match.mjs` (script manual, roda contra produção, NÃO faz parte do build/deploy — é só pra decidir o valor da constante usada na Task 4)

**Interfaces:**
- Consumes: `corrigirPosicoesComMatch` (Task 2).
- Produces: um número (a escolher com base na saída do script) que a Task 4 usa como `LIMIAR_CONFIANCA_MATCH`.

**Contexto:** os 4 casos reais de falso positivo do dia 13/08 (ver spec) precisam, DEPOIS de corrigidos via `/match`, deixar de mostrar o delta uniforme entre destinos de distâncias muito diferentes. Este script reproduz exatamente isso com o `/match` de verdade (não mockado) contra as posições reais gravadas naquele dia.

- [ ] **Step 1: Escrever o script de calibração**

```js
// scripts/calibrar-piso-confianca-match.mjs
// Roda MANUALMENTE via SSH contra o Contabo (posicoes_historico so' existe
// la, mesmo padrao de outros scripts de investigacao desta sessao):
//   ssh transmonseg-vps "cd /srv/transmonseg/temp && npx tsx --env-file=.env.production scripts/calibrar-piso-confianca-match.mjs"
import pg from "pg";
import { corrigirPosicoesComMatch } from "../src/lib/osrm-match.ts";

const c = new pg.Client({ connectionString: process.env.DATABASE_URL, ssl: { rejectUnauthorized: false } });
await c.connect();

// Placas + timestamp de disparo dos 4 casos reais de falso positivo
// (13/08, achado via desvio_disparo_log -- ver spec).
const CASOS = [
  { placa: "RBG-5G18", quando: "2026-08-13T14:18:55.370Z" },
  { placa: "TTH-6G37", quando: "2026-08-13T14:31:38.152Z" },
  { placa: "RQU-2H61", quando: "2026-08-13T14:37:37.488Z" },
  { placa: "TOS-2B69", quando: "2026-08-13T14:36:12.057Z" },
];

for (const caso of CASOS) {
  const { rows: v } = await c.query(`SELECT id FROM veiculos WHERE placa = $1`, [caso.placa]);
  const veiculo_id = v[0].id;
  const quando = new Date(caso.quando);
  const { rows: pos } = await c.query(
    `SELECT lat, lng, criado_em FROM posicoes_historico
      WHERE veiculo_id = $1 AND criado_em BETWEEN $2 AND $3
      ORDER BY criado_em ASC`,
    [veiculo_id, new Date(quando.getTime() - 5 * 60000), quando]
  );
  const pontos = pos.map((p) => ({ lat: p.lat, lng: p.lng, timestamp: p.criado_em }));
  const resultado = await corrigirPosicoesComMatch(pontos);
  console.log(`${caso.placa}: ${pontos.length} pontos na janela de 5min -> `, resultado);
}

await c.end();
```

- [ ] **Step 2: Copiar o script pro servidor e rodar**

```bash
scp scripts/calibrar-piso-confianca-match.mjs transmonseg-vps:/srv/transmonseg/temp/scripts/calibrar-piso-confianca-match.mjs
ssh transmonseg-vps "cd /srv/transmonseg/temp && npx tsx --env-file=.env.production scripts/calibrar-piso-confianca-match.mjs"
```

- [ ] **Step 3: Escolher o piso com base na saída**

Ler o `confidence` impresso pra cada um dos 4 casos. Escolher `LIMIAR_CONFIANCA_MATCH` como um valor **abaixo** do menor `confidence` observado nesses 4 casos reais (todos devem ser aceitos como "corrigíveis", já que são exatamente os casos que a correção pretende resolver) — arredondado pra baixo com folga (ex: se o menor observado for 0.31, considerar algo como 0.2-0.25, não 0.30 exato, pra não ficar refém de uma casa decimal). Anotar o valor escolhido e o raciocínio num comentário — vai direto pro código na Task 4, Step 3.

Se algum dos 4 casos vier com `resultado === null` (match falhou nesse caso específico): não é bloqueante — documentar no comentário da Task 4 que aquele caso específico continua caindo no fallback bruto (ainda protegido pelo `LIMIAR_MOVIMENTO_MINIMO_M` já existente), e seguir com o piso calibrado pelos casos que retornaram resultado.

- [ ] **Step 4: Apagar o script do servidor (era só investigação, não fica em produção)**

```bash
ssh transmonseg-vps "rm -f /srv/transmonseg/temp/scripts/calibrar-piso-confianca-match.mjs"
```

O arquivo local (`scripts/calibrar-piso-confianca-match.mjs`) pode ficar commitado no repo como documentação do processo de calibração (mesmo padrão de outros scripts de validação já commitados nesta sessão, ex: `scripts/validar-desvio-v2.mjs`) — não precisa apagar localmente.

- [ ] **Step 5: Commit**

```bash
cd "/Users/joaquimsalles/Projects/Transmonseg/monitoramento/MONITORAMENTO TEMP"
cp scripts/calibrar-piso-confianca-match.mjs "/Users/joaquimsalles/Projects/Transmonseg/monitoramento/MONITORAMENTO transmonseg/scripts/"
git add scripts/calibrar-piso-confianca-match.mjs
git commit -m "chore(desvio): script de calibracao do piso de confianca do /match"
git push origin HEAD

cd "/Users/joaquimsalles/Projects/Transmonseg/monitoramento/MONITORAMENTO transmonseg"
git add scripts/calibrar-piso-confianca-match.mjs
git commit -m "chore(desvio): script de calibracao do piso de confianca do /match"
git push origin HEAD
```

---

### Task 4: Wire em `route.ts` — correção gated por streak>0

**Files:**
- Modify: `src/app/api/motor/route.ts` (bloco do detector de desvio v2, em torno de `avaliarAfastandoDeTudo` e do INSERT em `desvio_disparo_log` — ver comentários "Achado real 13/08" já presentes no arquivo pra localizar o trecho exato)

**Interfaces:**
- Consumes: `corrigirPosicoesComMatch` (Task 2), `LIMIAR_CONFIANCA_MATCH` calibrado (Task 3).
- Produces: nenhuma interface nova exportada — mudança interna ao ciclo do motor.

- [ ] **Step 1: Import**

No topo de `route.ts`, junto dos outros imports de `@/lib`:

```ts
import { corrigirPosicoesComMatch } from "@/lib/osrm-match";
```

- [ ] **Step 2: Buscar a janela de posição recente (só quando streak>0)**

Logo ANTES do bloco que hoje monta `distAtuaisReais`/`distAnterioresReais` (procurar `buscarDistanciasReais({ lat: pos.lat, lng: pos.lng }, destinosRelevantes)` no arquivo), adicionar:

```ts
// Achado real 13/08 (4 falsos positivos no mesmo dia com delta de
// distancia identico entre destinos completamente diferentes -- ver
// docs/superpowers/specs/2026-08-13-osrm-match-desvio-design.md): /table
// encaixa cada ponto independentemente na malha viaria, sem contexto de
// trajeto. Quando ja ha um possivel desvio se formando
// (afastandoStreak>0), corrige a posicao atual/anterior via /match
// (Hidden Markov Model sobre os ultimos 5min de trajeto) antes de medir
// distancia -- so' entra em acao quando ja' ha streak, entao o pior
// cenario de bug aqui e' atrasar/distorcer um alerta que ja estava se
// formando, nunca cria um do zero. Piso de confianca calibrado contra os
// 4 casos reais de 13/08 (ver scripts/calibrar-piso-confianca-match.mjs).
const LIMIAR_CONFIANCA_MATCH = 0.2; // TODO Task 3: substituir pelo valor calibrado

let posParaAvaliar = { lat: pos.lat, lng: pos.lng };
let anteriorParaAvaliar = anterior && anterior.lat != null && anterior.lng != null
  ? { lat: anterior.lat, lng: anterior.lng }
  : null;

if (estadoDesvioAnterior.afastandoStreak > 0) {
  const { rows: janelaRecente } = await pool.query<{ lat: number; lng: number; criado_em: Date }>(
    `SELECT lat, lng, criado_em FROM posicoes_historico
      WHERE veiculo_id = $1 AND criado_em > now() - interval '5 minutes'
      ORDER BY criado_em ASC`,
    [veiculo_id]
  );
  const pontosMatch = janelaRecente.map((p) => ({ lat: p.lat, lng: p.lng, timestamp: p.criado_em }));
  const corrigido = await corrigirPosicoesComMatch(pontosMatch);
  if (corrigido && corrigido.confidence >= LIMIAR_CONFIANCA_MATCH) {
    posParaAvaliar = corrigido.atual;
    anteriorParaAvaliar = corrigido.anterior;
  }
}
```

**IMPORTANTE (Task 3 pendency):** o valor `0.2` acima é um placeholder de segurança até a Task 3 rodar contra dados reais — antes de considerar esta task completa, substituir pelo valor calibrado (Task 3, Step 3) e remover o comentário `// TODO Task 3`.

- [ ] **Step 3: Usar `posParaAvaliar`/`anteriorParaAvaliar` em vez de `pos`/`anterior` nas duas chamadas de `buscarDistanciasReais`**

Trocar (mesmo bloco, poucas linhas abaixo):

```ts
const distAtuaisReais = await buscarDistanciasReais({ lat: pos.lat, lng: pos.lng }, destinosRelevantes);
const distAnterioresReais =
  anterior && anterior.lat != null && anterior.lng != null && distAtuaisReais
    ? await buscarDistanciasReais({ lat: anterior.lat, lng: anterior.lng }, destinosRelevantes)
    : null;
```

por:

```ts
const distAtuaisReais = await buscarDistanciasReais(posParaAvaliar, destinosRelevantes);
const distAnterioresReais =
  anteriorParaAvaliar && distAtuaisReais
    ? await buscarDistanciasReais(anteriorParaAvaliar, destinosRelevantes)
    : null;
```

- [ ] **Step 4: Registrar `posicao_corrigida` no INSERT existente de `desvio_disparo_log`**

Localizar o `INSERT INTO desvio_disparo_log` já existente (colunas `veiculo_id, tipo_disparo, destinos, streak_afastando, streak_rua_rara, celula, n_visitas_celula`) e:

1. Adicionar `posicao_corrigida` na lista de colunas do SQL e um `$8` novo nos values.
2. Passar `posParaAvaliar !== { lat: pos.lat, lng: pos.lng }` — como objetos não comparam por valor em JS, usar uma flag booleana explícita em vez de comparar objetos. Adicionar uma variável antes do `if` do Step 2:

```ts
let posicaoFoiCorrigida = false;
```

E dentro do `if (corrigido && corrigido.confidence >= LIMIAR_CONFIANCA_MATCH)`, junto das duas atribuições:

```ts
posicaoFoiCorrigida = true;
```

No array de valores do INSERT, adicionar `posicaoFoiCorrigida` como último elemento.

- [ ] **Step 5: Typecheck**

```bash
cd "/Users/joaquimsalles/Projects/Transmonseg/monitoramento/MONITORAMENTO TEMP"
npx tsc --noEmit -p .
```

Expected: sem erro. (Não precisa de `rm -rf .next` — nenhuma rota foi criada/apagada, só um arquivo de rota existente foi editado.)

- [ ] **Step 6: Rodar a suite de testes de desvio (não deve quebrar nada)**

```bash
npx vitest run src/lib/desvio.test.ts src/lib/calibracao-desvio.test.ts src/lib/detectores.test.ts src/lib/osrm-match.test.ts src/lib/casos-desvio-revisao.test.ts
```

Expected: todos os arquivos passam (a lógica de streak/limiar não muda, só a entrada de coordenadas).

- [ ] **Step 7: Copiar `route.ts` pro repo definitivo, typecheck lá também**

```bash
cp src/app/api/motor/route.ts "/Users/joaquimsalles/Projects/Transmonseg/monitoramento/MONITORAMENTO transmonseg/src/app/api/motor/route.ts"
cd "/Users/joaquimsalles/Projects/Transmonseg/monitoramento/MONITORAMENTO transmonseg"
npx tsc --noEmit -p .
```

- [ ] **Step 8: Commit nos dois repos**

```bash
cd "/Users/joaquimsalles/Projects/Transmonseg/monitoramento/MONITORAMENTO TEMP"
git add src/app/api/motor/route.ts
git commit -m "feat(desvio): usa posicao corrigida via /match quando streak>0"
git push origin HEAD

cd "/Users/joaquimsalles/Projects/Transmonseg/monitoramento/MONITORAMENTO transmonseg"
git add src/app/api/motor/route.ts
git commit -m "feat(desvio): usa posicao corrigida via /match quando streak>0"
git push origin HEAD
```

---

### Task 5: Deploy e validação em produção

**Files:** nenhum arquivo novo — só operação de deploy + verificação.

**Interfaces:** N/A (task de verificação, não de código).

- [ ] **Step 1: Deploy no TEMP (processo que realmente processa via pg_cron, porta 3000)**

```bash
ssh transmonseg-vps "cd /srv/transmonseg/temp && git pull && npm run build && pm2 restart transmonseg-temp"
```

Expected: build sem erro, `pm2 restart` mostra `online`.

- [ ] **Step 2: Deploy no definitivo (serve a tela do operador via Caddy, porta 3010)**

```bash
ssh transmonseg-vps "cd /srv/transmonseg/definitivo && git pull && npm run build && pm2 restart transmonseg-definitivo"
```

- [ ] **Step 3: Confirmar que o site não caiu**

```bash
curl -s -o /dev/null -w 'HTTP %{http_code}\n' https://monitoramento.transmonseg.com.br/
```

Expected: `HTTP 307` (redireciona pro login, comportamento normal).

- [ ] **Step 4: Confirmar que o motor continua vivo (evita falso "quebrou" por silêncio)**

```bash
ssh transmonseg-vps "curl -s -o /dev/null -w 'Tempo: %{time_total}s (HTTP %{http_code})\n' -X POST -H 'x-motor-key: f8acef6d89d1ad73c5b500e269000b7f9b4bca1422fbca2f8765a7b976369322' http://localhost:3000/api/motor"
```

Expected: `HTTP 200`, tempo total próximo do que era antes (~7-8s pra 347 veículos — se disparar `/match` com frequência isso pode subir; se subir muito além de ~15-20s, investigar antes de deixar rodando, porque o cron dispara a cada 30s e não pode acumular fila).

- [ ] **Step 5: Aguardar o próximo caso real de streak>0 e conferir `posicao_corrigida` no log**

```bash
ssh transmonseg-vps "cd /srv/transmonseg/temp && npx tsx --env-file=.env.production -e \"
import('pg').then(async ({default: pg}) => {
  const c = new pg.Client({connectionString: process.env.DATABASE_URL, ssl:{rejectUnauthorized:false}});
  await c.connect();
  const { rows } = await c.query('SELECT veiculo_id, tipo_disparo, posicao_corrigida, criado_em FROM desvio_disparo_log ORDER BY criado_em DESC LIMIT 10');
  console.log(rows);
  await c.end();
});
\""
```

Expected: linhas recentes aparecendo com `posicao_corrigida` preenchido (`true` ou `false`, nunca `null`) — confirma que a lógica está rodando de verdade, não só compilando.

---

## Self-Review

**Cobertura da spec:** Arquitetura (Task 2+4), não-objetivos respeitados (correção só com streak>0, `/table`/`avaliarAfastandoDeTudo` não mudam — Task 4 Step 3 só troca a ENTRADA), janela de 5min (Task 4 Step 2), piso de confiança calibrado com dado real (Task 3), fallback silencioso em toda falha (Task 2 contrato + Task 4 `if` só substitui quando `corrigido` existe E confiança OK), coluna de observabilidade (Task 1 + Task 4 Step 4), teste unitário mockado (Task 2) + validação com os 4 casos reais (Task 3), rollout (Task 5). Todos os itens da spec têm task correspondente.

**Placeholder scan:** O único valor não-final no plano é o `0.2` inicial no Step 2 da Task 4, marcado EXPLICITAMENTE como placeholder de segurança a ser substituído pelo output da Task 3 antes de considerar a Task 4 encerrada — isso é intencional (o valor real só existe depois de rodar contra produção), não um placeholder esquecido. Nenhum outro "TBD"/"depois" solto no plano.

**Consistência de tipo:** `corrigirPosicoesComMatch` retorna `ResultadoMatch | null` (Task 2) — Task 4 usa exatamente esse formato (`corrigido.atual`, `corrigido.anterior`, `corrigido.confidence`). `PosicaoCorrigida = { lat, lng }` é o mesmo shape que `buscarDistanciasReais` já espera como primeiro argumento (`posAtual: { lat: number; lng: number }`) — não precisa de conversão extra na Task 4 Step 3.
