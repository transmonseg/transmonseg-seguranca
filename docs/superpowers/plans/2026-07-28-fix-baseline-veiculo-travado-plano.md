# Fix: baseline_veiculo trava com variancia ~0 — Plano

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development pra rodar este plano tarefa por tarefa.

**Goal:** Corrigir um bug de auto-travamento no baseline comportamental por veiculo (`baseline_veiculo`, feature `velocidade_media_kmh`) que gera falsos positivos em massa na regra "Velocidade media da viagem foge N desvios do padrao".

**Root cause (achado real 28/07, ver detalhe completo no chat):** o motor so deixa uma leitura de velocidade entrar no calculo incremental (Welford) se ela NAO tiver sido sinalizada como anomala naquele ciclo (protecao adicionada 12/07 pra evitar que um evento anomalo sustentado virasse "o novo normal", caso TTH-6G37). Essa protecao nao tem teto de tempo: uma vez que o baseline fica estreito demais (variancia perto de zero), QUALQUER velocidade normal futura passa a parecer anomala e e excluida — travando o baseline pra sempre. Confirmado com dado real: RQV-9B26 tem n=581 amostras "urbano", media=6.0km/h, desvio-padrao=0.08km/h (por isso "58km/h fugiu 589 desvios do padrao"). Nao e' isolado: dezenas de veiculos na frota tem o mesmo travamento, alguns com mais de 40 mil amostras presas (GVH-1397, n=40765, media=2km/h).

**Fix (3 partes, todas em `src/lib/baseline-veiculo.ts` + wiring em `src/app/api/motor/route.ts`):**
1. Piso de desvio-padrao (`BASELINE_DESVIO_MINIMO_KMH = 3`) — baseado na mediana real saudavel da frota (28/07: ~13.5km/h urbano, ~6.8km/h rodoviario com n>=100). Impede explosao de z-score mesmo antes do resto corrigir.
2. Teto no peso acumulado do Welford (`BASELINE_N_MAXIMO = 500`) — sem isso, veiculos com dezenas de milhares de amostras travadas levariam quase pra sempre pra se recuperar mesmo depois do fix, ja que cada amostra nova move a media/variancia por 1/n.
3. Circuit breaker por tempo (`BASELINE_EXCLUSAO_MAX_MS = 4h`) — se uma leitura deste veiculo/tipo vem sendo excluida ha mais tempo que isso, forca a readmissao mesmo que ainda pareca anomala. 4h da' bastante margem sobre o caso que motivou a exclusao original (TTH-6G37: anomalia real durou ~10min), entao nao reabre aquele problema.

**Tech Stack:** Postgres (migration no Contabo), `src/lib/baseline-veiculo.ts`, `src/lib/baseline-veiculo.test.ts`, `src/app/api/motor/route.ts`.

**Global Constraints:**
- `baseline_frota` (agregado da frota inteira por cliente) usa as MESMAS funcoes `atualizarBaselineWelford`/`zScoreBaseline` — o piso e o teto de n se aplicam a ele tambem automaticamente (correto, sem trabalho extra). O circuit breaker de exclusao (`excluida_desde`) e' especifico de `baseline_veiculo` — nao criar coluna equivalente em `baseline_frota` (agregado de varios veiculos, ficar travado exigiria TODOS os veiculos do cliente excluirem ao mesmo tempo, cenario muito menos provavel; fora de escopo deste fix).
- Nao mexer em `detectarAnomaliaBaseline` nem em `BASELINE_Z_LIMIAR` (o limiar de 3 desvios continua o mesmo — o fix e' garantir que o desvio calculado seja realista, nao mudar o limiar de disparo).
- `agora` (variavel `Date` do ciclo atual) ja existe no escopo de `route.ts` onde o wiring acontece (usada em `parado_desde` mais acima no mesmo arquivo) — reusar, nao criar `new Date()` novo ali.

---

## Task 1: Migration — coluna `excluida_desde` em `baseline_veiculo`

**Arquivos:**
- Criar: `scripts/migrations/contabo/008_baseline_veiculo_excluida_desde.sql`

```sql
-- scripts/migrations/contabo/008_baseline_veiculo_excluida_desde.sql
--
-- Achado real 28/07: baseline_veiculo trava com variancia ~0 porque a
-- protecao anti-autopoluicao (12/07, TTH-6G37) exclui leituras "anomalas"
-- do calculo sem teto de tempo -- uma vez travado, toda leitura normal
-- futura parece anomala e e excluida, entao nada nunca mais entra.
-- excluida_desde marca o INICIO da exclusao continua (null = nao esta
-- sendo excluido agora); route.ts usa isso pra forcar readmissao depois
-- de BASELINE_EXCLUSAO_MAX_MS (ver baseline-veiculo.ts).
ALTER TABLE baseline_veiculo ADD COLUMN IF NOT EXISTS excluida_desde timestamptz NULL DEFAULT NULL;

NOTIFY pgrst, 'reload schema';
```

**Aplicar:** `scp` pro Contabo + `sudo -u postgres psql -d transmonseg -f <arquivo>` (mesmo padrao de toda migration desta sessao, ver `007_status_limpo.sql`). Confirmar com `\d baseline_veiculo` que a coluna existe.

---

## Task 2: `baseline-veiculo.ts` — piso de desvio, teto de n, circuit breaker

**Arquivos:**
- Modificar: `src/lib/baseline-veiculo.ts`
- Modificar: `src/lib/baseline-veiculo.test.ts`

**Step 1: Escrever os testes que vao falhar primeiro**

Adicionar ao final de `src/lib/baseline-veiculo.test.ts` (mantendo os `describe` blocks existentes, so ajustando o teste de variancia zero que muda de comportamento):

```ts
// Substituir o teste existente "variancia zero: nao divide por zero..."
// por este (o comportamento muda: em vez de +-Infinity, agora usa o piso):
it("variancia zero: usa o piso de desvio em vez de dividir por zero", () => {
  expect(zScoreBaseline(40, { n: 50, media: 40, variancia: 0 }, 20)).toBe(0);
  expect(zScoreBaseline(50, { n: 50, media: 40, variancia: 0 }, 20)).toBeCloseTo(10 / 3, 5);
  expect(zScoreBaseline(30, { n: 50, media: 40, variancia: 0 }, 20)).toBeCloseTo(-10 / 3, 5);
});

it("variancia pequena mas nao-zero (caso real RQV-9B26): piso evita explosao de z-score", () => {
  // n=581, media=6.0, variancia=0.0068 (desvio real ~0.083km/h) -- sem piso,
  // 58km/h dava z=(58-6)/0.083 ~= 626. Com piso de 3km/h, fica bem menor.
  const baselineTravado = { n: 581, media: 6.0, variancia: 0.0068 };
  const z = zScoreBaseline(58, baselineTravado, 20)!;
  expect(z).toBeCloseTo((58 - 6.0) / 3, 1);
  expect(z).toBeLessThan(20);
});

it("variancia ja saudavel (acima do piso): nao mexe no desvio calculado", () => {
  const baselineSaudavel = { n: 100, media: 30, variancia: 100 }; // desvio = 10
  expect(zScoreBaseline(50, baselineSaudavel, 20)).toBeCloseTo(2, 5);
});

describe("atualizarBaselineWelford: teto de peso acumulado (BASELINE_N_MAXIMO)", () => {
  it("nao ultrapassa o teto mesmo com muitas amostras", () => {
    let b: Baseline = { n: 0, media: 0, variancia: 0 };
    for (let i = 0; i < BASELINE_N_MAXIMO + 100; i++) b = atualizarBaselineWelford(b, 10);
    expect(b.n).toBe(BASELINE_N_MAXIMO);
  });

  it("depois de saturar, uma amostra nova ainda move a media perceptivelmente", () => {
    let b: Baseline = { n: 0, media: 0, variancia: 0 };
    for (let i = 0; i < BASELINE_N_MAXIMO + 50; i++) b = atualizarBaselineWelford(b, 6);
    expect(b.media).toBeCloseTo(6, 5);
    const antes = b.media;
    b = atualizarBaselineWelford(b, 60);
    // com n tampado, o peso da amostra nova e 1/BASELINE_N_MAXIMO -- deve
    // mover a media de forma mensuravel, nao travar em ~6 pra sempre.
    expect(b.media).toBeGreaterThan(antes + 0.05);
  });
});

describe("deveForcarReadmissaoBaseline", () => {
  it("nunca foi excluida (null): nao forca", () => {
    expect(deveForcarReadmissaoBaseline(null, new Date("2026-07-28T12:00:00Z"))).toBe(false);
  });

  it("excluida ha menos tempo que o limiar: nao forca", () => {
    const excluidaDesde = "2026-07-28T10:00:00Z";
    const agora = new Date("2026-07-28T12:00:00Z"); // 2h depois
    expect(deveForcarReadmissaoBaseline(excluidaDesde, agora)).toBe(false);
  });

  it("excluida ha mais tempo que o limiar: forca", () => {
    const excluidaDesde = "2026-07-28T06:00:00Z";
    const agora = new Date("2026-07-28T12:00:00Z"); // 6h depois (limiar e 4h)
    expect(deveForcarReadmissaoBaseline(excluidaDesde, agora)).toBe(true);
  });

  it("aceita limiar customizado", () => {
    const excluidaDesde = "2026-07-28T11:00:00Z";
    const agora = new Date("2026-07-28T12:00:00Z"); // 1h depois
    expect(deveForcarReadmissaoBaseline(excluidaDesde, agora, 30 * 60 * 1000)).toBe(true); // limiar 30min
  });
});
```

Atualizar o import no topo do arquivo de teste para incluir os novos exports:
```ts
import {
  atualizarBaselineWelford, zScoreBaseline, classificarTipoViagem,
  deveForcarReadmissaoBaseline, BASELINE_N_MAXIMO,
  type Baseline,
} from "./baseline-veiculo";
```

**Step 2: Rodar os testes pra confirmar que falham**

Run: `npx vitest run src/lib/baseline-veiculo.test.ts`
Expected: FAIL (funcoes/constantes novas nao existem ainda, teste de variancia zero quebra contra o comportamento antigo)

**Step 3: Implementar**

Substituir o conteudo de `src/lib/baseline-veiculo.ts` inteiro por:

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

// Achado real 28/07: dezenas de veiculos na frota tinham baseline "urbano"
// travado com variancia ~0 (ex: RQV-9B26, n=581, media=6km/h,
// desvio=0.08km/h -- qualquer velocidade normal virava "589 desvios do
// padrao"). Causa raiz: Welford acumulativo sem teto -- com n na casa dos
// milhares/dezenas de milhares (GVH-1397: n=40765), cada amostra nova move
// a media/variancia quase nada, e a exclusao de leituras "anomalas" (ver
// route.ts, guarda anti-autopoluicao de 12/07) trava o baseline pra sempre
// assim que ele fica estreito demais: toda leitura normal futura passa a
// parecer anomala e e excluida, entao nada nunca mais entra de novo.
// BASELINE_N_MAXIMO tampa o peso acumulado (efeito de janela deslizante:
// uma vez saturado, cada amostra nova sempre pesa pelo menos 1/N_MAXIMO,
// entao o baseline volta a se mover em vez de travar por anos).
export const BASELINE_N_MAXIMO = 500;

// Piso de desvio-padrao: mediana real da frota (28/07, veiculos com
// n>=100) e ~13.5km/h urbano / ~6.8km/h rodoviario -- 3km/h fica bem
// abaixo dos dois, longe o bastante pra nao distorcer baseline saudavel,
// mas alto o bastante pra matar as explosoes de z-score tipo "589 desvios".
export const BASELINE_DESVIO_MINIMO_KMH = 3;

// Tempo maximo que uma leitura pode ficar sendo excluida (por parecer
// anomala) antes de ser forcada de volta pro baseline. 4h da bastante
// margem sobre o caso que motivou a exclusao original (TTH-6G37, 12/07:
// anomalia real durou so ~10min) -- um baseline genuinamente travado
// comeca a se recuperar dentro do mesmo dia, sem reabrir aquele problema.
export const BASELINE_EXCLUSAO_MAX_MS = 4 * 60 * 60 * 1000;

export function atualizarBaselineWelford(atual: Baseline, novoValor: number): Baseline {
  const nEfetivo = Math.min(atual.n, BASELINE_N_MAXIMO);
  const n = Math.min(nEfetivo + 1, BASELINE_N_MAXIMO);
  const delta = novoValor - atual.media;
  const media = atual.media + delta / n;
  const delta2 = novoValor - media;
  const m2Anterior = atual.variancia * nEfetivo;
  const variancia = (m2Anterior + delta * delta2) / n;
  return { n, media, variancia };
}

// null = amostras insuficientes ainda (cold start), quem chama decide o
// fallback (baseline da frota inteira, ver classificarTipoViagem/route.ts).
export function zScoreBaseline(valor: number, baseline: Baseline, minAmostras: number): number | null {
  if (baseline.n < minAmostras) return null;
  const desvio = Math.max(Math.sqrt(baseline.variancia), BASELINE_DESVIO_MINIMO_KMH);
  return (valor - baseline.media) / desvio;
}

// Achado real 28/07 (ver BASELINE_N_MAXIMO acima): sem isso, um baseline
// travado (variancia ~0) exclui toda leitura normal futura pra sempre,
// porque toda leitura normal parece anomala em relacao a ele. Se ja faz
// BASELINE_EXCLUSAO_MAX_MS que uma leitura deste veiculo/tipo vem sendo
// excluida, forca a proxima de volta pro baseline mesmo que ainda pareca
// anomala -- e a unica forma dele se corrigir sozinho.
export function deveForcarReadmissaoBaseline(
  excluidaDesde: string | null,
  agora: Date,
  limiarMs: number = BASELINE_EXCLUSAO_MAX_MS
): boolean {
  if (excluidaDesde === null) return false;
  return agora.getTime() - new Date(excluidaDesde).getTime() >= limiarMs;
}

// Classificacao deliberadamente simples (regra, nao clustering) -- so por
// velocidade media da viagem, sem depender de classificacao de via do OSM
// (descartada como sinal: rua de bairro e normal no Rio, nao e anomalia).
export function classificarTipoViagem(velocidadeMediaKmh: number): "urbano" | "rodoviario" {
  return velocidadeMediaKmh >= 60 ? "rodoviario" : "urbano";
}
```

**Step 4: Rodar os testes de novo**

Run: `npx vitest run src/lib/baseline-veiculo.test.ts`
Expected: PASS (todos, incluindo os antigos que nao mudaram)

**Step 5: Commit**

```bash
git add src/lib/baseline-veiculo.ts src/lib/baseline-veiculo.test.ts
git commit -m "fix: piso de variancia + teto de n + circuit breaker no baseline_veiculo"
```

---

## Task 3: Wiring em `route.ts` — persistir e usar `excluida_desde`

**Arquivos:**
- Modificar: `src/app/api/motor/route.ts`

**Step 1: Extender a leitura inicial do baseline_veiculo (perto da linha 656-667)**

Trocar:
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
```
Por:
```ts
    const { data: baselineVeiculoRows } = await supabase
      .from("baseline_veiculo")
      .select("veiculo_id, tipo_viagem, feature, n_amostras, media, variancia, excluida_desde");
    const mapaBaselineVeiculo = new Map<string, Baseline & { excluidaDesde: string | null }>();
    for (const r of baselineVeiculoRows ?? []) {
      mapaBaselineVeiculo.set(`${r.veiculo_id}:${r.tipo_viagem}:${r.feature}`, {
        n: Number(r.n_amostras), media: r.media, variancia: r.variancia,
        excluidaDesde: r.excluida_desde ?? null,
      });
    }
```

Import `deveForcarReadmissaoBaseline` no topo do arquivo, junto do import existente de `atualizarBaselineWelford`/`zScoreBaseline`/`Baseline` de `@/lib/baseline-veiculo`.

**Step 2: Adicionar o accumulator de exclusao (perto da linha 683, ao lado de `amostrasBaselineCiclo`)**

```ts
    const amostrasBaselineCiclo: { veiculo_id: string; cliente_id: string; tipoViagem: "urbano" | "rodoviario"; velocidade: number }[] = [];
    // Achado real 28/07: quando uma leitura e excluida (parece anomala), o
    // baseline nao ganha amostra nova neste ciclo, mas ainda precisamos
    // marcar o INICIO da exclusao continua (ver BASELINE_EXCLUSAO_MAX_MS em
    // baseline-veiculo.ts) -- guardado a parte porque aqui nao ha
    // n_amostras/media/variancia novos pra gravar, so o timestamp. So
    // marca o INICIO (nao reescreve se ja estava marcado): resetar pra
    // null acontece automaticamente no bloco de amostrasBaselineCiclo
    // sempre que uma amostra e admitida (normal ou forcada).
    const baselineExclusaoCiclo = new Map<string, string>(); // chave veiculo:tipo -> excluida_desde novo
```

**Step 3: Trocar a logica de decisao (linhas ~1689-1715, bloco "Baseline comportamental por veiculo")**

Trocar:
```ts
          // Baseline comportamental por veiculo (Fase 3). velocidade
          // instantanea do ciclo como proxy de "velocidade media da
          // viagem" -- simplificacao de primeira versao, nao ha boundaries
          // de viagem definidos ainda; cada ciclo de 30s vira 1 amostra.
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
Por:
```ts
          // Baseline comportamental por veiculo (Fase 3). velocidade
          // instantanea do ciclo como proxy de "velocidade media da
          // viagem" -- simplificacao de primeira versao, nao ha boundaries
          // de viagem definidos ainda; cada ciclo de 30s vira 1 amostra.
          const tipoViagem = classificarTipoViagem(pos.velocidade);
          const baselineProprio = mapaBaselineVeiculo.get(`${veiculo_id}:${tipoViagem}:velocidade_media_kmh`)
            ?? { n: 0, media: 0, variancia: 0, excluidaDesde: null };
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
          // Achado real 12/07 (autopoluicao confirmada com dado de producao,
          // TTH-6G37: z-score caiu de 14.5 pra 3.5 em 10min na MESMA
          // velocidade): uma leitura sinalizada como anomala neste ciclo NAO
          // entra no baseline -- ele "congela" durante o evento suspeito e
          // volta a incorporar amostras normais assim que a leitura deixar
          // de ser anomala. Sem isso, o evento anomalo sustentado acabava
          // "acostumando" o proprio baseline com ele mesmo.
          //
          // Achado real 28/07: sem teto de tempo, essa mesma protecao trava
          // um baseline que ja ficou estreito demais (variancia ~0) PRA
          // SEMPRE -- toda leitura normal futura passa a parecer anomala e
          // e excluida, entao nada nunca mais entra. Se ja faz
          // BASELINE_EXCLUSAO_MAX_MS que este veiculo/tipo vem sendo
          // excluido, forca a readmissao mesmo que ainda pareca anomalo.
          const chaveBaselineVeiculo = `${veiculo_id}:${tipoViagem}`;
          const forcarReadmissaoBaseline = alertaBaseline !== null &&
            deveForcarReadmissaoBaseline(baselineProprio.excluidaDesde, agora);
          if (pos.fresco && pos.velocidade > 0 && (alertaBaseline === null || forcarReadmissaoBaseline)) {
            amostrasBaselineCiclo.push({ veiculo_id, cliente_id, tipoViagem, velocidade: pos.velocidade });
          } else if (alertaBaseline !== null && baselineProprio.excluidaDesde === null) {
            baselineExclusaoCiclo.set(chaveBaselineVeiculo, agora.toISOString());
          }
```

**Step 4: Extender o upsert em lote (linhas ~2789-2830, bloco "Atualiza baseline_veiculo e baseline_frota")**

Trocar a assinatura/uso de `porVeiculo` (que hoje e `Map<string, Baseline>`) pra usar o fallback certo (com `excluidaDesde`), e o UPSERT de `baseline_veiculo` pra sempre zerar `excluida_desde` quando ha amostra admitida neste ciclo:

```ts
    if (amostrasBaselineCiclo.length > 0) {
      const porVeiculo = new Map<string, Baseline>();
      const porFrota = new Map<string, Baseline>();
      for (const a of amostrasBaselineCiclo) {
        const chaveVeiculo = `${a.veiculo_id}:${a.tipoViagem}`;
        const atualVeiculo = porVeiculo.get(chaveVeiculo)
          ?? mapaBaselineVeiculo.get(`${chaveVeiculo}:velocidade_media_kmh`)
          ?? { n: 0, media: 0, variancia: 0, excluidaDesde: null };
        porVeiculo.set(chaveVeiculo, atualizarBaselineWelford(atualVeiculo, a.velocidade));

        const chaveFrota = `${a.cliente_id}:${a.tipoViagem}`;
        const atualFrota = porFrota.get(chaveFrota)
          ?? mapaBaselineFrota.get(`${chaveFrota}:velocidade_media_kmh`)
          ?? { n: 0, media: 0, variancia: 0 };
        porFrota.set(chaveFrota, atualizarBaselineWelford(atualFrota, a.velocidade));
      }

      const resultadosVeiculo = await Promise.allSettled(
        [...porVeiculo].map(([chave, b]) => {
          const [veiculo_id, tipoViagem] = chave.split(":");
          // Amostra admitida neste ciclo -- sempre zera excluida_desde
          // (readmissao normal ou forcada, ver BASELINE_EXCLUSAO_MAX_MS).
          return pool.query(
            `insert into baseline_veiculo (veiculo_id, tipo_viagem, feature, n_amostras, media, variancia, excluida_desde, atualizado_em)
             values ($1, $2, 'velocidade_media_kmh', $3, $4, $5, null, now())
             on conflict (veiculo_id, tipo_viagem, feature)
             do update set n_amostras = $3, media = $4, variancia = $5, excluida_desde = null, atualizado_em = now()`,
            [veiculo_id, tipoViagem, b.n, b.media, b.variancia]
          );
        })
      );
      const falhasVeiculo = resultadosVeiculo.filter((r) => r.status === "rejected").length;
      if (falhasVeiculo > 0) console.warn(`Aviso: ${falhasVeiculo} falha(s) ao gravar baseline_veiculo neste ciclo`);

      const resultadosFrota = await Promise.allSettled(
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
      const falhasFrota = resultadosFrota.filter((r) => r.status === "rejected").length;
      if (falhasFrota > 0) console.warn(`Aviso: ${falhasFrota} falha(s) ao gravar baseline_frota neste ciclo`);
    }

    // Marca excluida_desde pra veiculo/tipo que NAO tiveram amostra admitida
    // neste ciclo (ver BASELINE_EXCLUSAO_MAX_MS em baseline-veiculo.ts) --
    // separado do bloco acima porque aqui nao ha n_amostras/media/variancia
    // novos pra gravar, so o timestamp de inicio da exclusao.
    if (baselineExclusaoCiclo.size > 0) {
      const resultadosExclusao = await Promise.allSettled(
        [...baselineExclusaoCiclo].map(([chave, valor]) => {
          const [veiculo_id, tipoViagem] = chave.split(":");
          return pool.query(
            `update baseline_veiculo set excluida_desde = $3
             where veiculo_id = $1 and tipo_viagem = $2 and feature = 'velocidade_media_kmh'`,
            [veiculo_id, tipoViagem, valor]
          );
        })
      );
      const falhasExclusao = resultadosExclusao.filter((r) => r.status === "rejected").length;
      if (falhasExclusao > 0) console.warn(`Aviso: ${falhasExclusao} falha(s) ao gravar excluida_desde em baseline_veiculo`);
    }
```

Nota pro implementador: a linha `const [veiculo_id, tipoViagem] = chave.split(":");` dentro do `.map` de `porVeiculo` ja existe no codigo atual — so mantenha, o tipo de `porVeiculo` continua `Map<string, Baseline>` (sem `excluidaDesde`, que so faz sentido no `mapaBaselineVeiculo` de leitura, nao no resultado do Welford).

**Step 5: Build + typecheck**

Run: `npx tsc --noEmit && npm run build`
Expected: sem erros de tipo, build limpo.

**Step 6: Commit**

```bash
git add src/app/api/motor/route.ts
git commit -m "feat: wiring do circuit breaker de baseline_veiculo travado no motor"
```

---

## Task 4: Testes finais + deploy

- Rodar `npm test -- --run` (suite inteira), `npx tsc --noEmit`, `npm run build` — todos devem passar limpo.
- Revisao independente antes de commitar (mesma classe de risco de tudo que mexeu em calibracao hoje): confirmar que `baseline_frota` continua intocado quanto ao circuit breaker (so ganha piso/teto via funcoes compartilhadas, sem coluna `excluida_desde` nem logica de exclusao propria); confirmar que o `else if` de marcacao de exclusao nunca sobrescreve um `excluida_desde` ja existente (so marca quando `=== null`); confirmar que o UPSERT de amostra admitida sempre zera `excluida_desde` (inclusive em cold-start / primeira linha, via `on conflict ... do update`).
- Replicar pros dois repos (TEMP + definitivo) + aplicar a migration no Postgres do Contabo + deploy manual nos 2 processos PM2 (`transmonseg-temp` e `transmonseg-definitivo`, `git pull && npm ci && npm run build && pm2 restart --update-env` nos dois).
- Verificar logs limpos por alguns minutos depois do deploy (`pm2 logs transmonseg-temp --lines 50`).
- Checar no banco, algumas horas depois: `SELECT placa, tipo_viagem, n_amostras, media, variancia, excluida_desde FROM baseline_veiculo b JOIN veiculos v ON v.id=b.veiculo_id WHERE v.placa = 'RQV-9B26';` — variancia deve comecar a subir de 0.0068 conforme leituras normais voltam a ser admitidas (nao vai corrigir instantaneamente, mas o `excluida_desde` deve aparecer marcado logo, e depois de 4h sem readmissao natural o circuit breaker forca).
