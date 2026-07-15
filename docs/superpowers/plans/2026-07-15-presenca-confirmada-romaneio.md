# Presença Confirmada por Permanência (Romaneio) — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Marcar `presenca_confirmada_em` num ponto do romaneio quando o veículo
dwell (permanência já calculada pelo motor) ≥120s nele, e usar isso — só
internamente, nunca visível ao operador — pra parar de deixar um ponto ainda não
confirmado pela Unitrac (por causa da coordenada errada dela) influenciar os
detectores de desvio e a supressão de alerta de favela.

**Architecture:** Uma coluna nova em `romaneio_pontos`. `montarPontosDeRomaneio`
passa a unir o status da Unitrac com essa nova flag (`feito = alvo?.feito ||
presencaConfirmadaEm !== null`). O motor coleta marcações candidatas durante o loop
por veículo (reaproveitando o dwell já calculado pro bypass_entrega) e grava em lote
no fim do ciclo, mesmo padrão do baseline.

**Tech Stack:** TypeScript, Postgres, Vitest.

## Global Constraints

- Spec: `docs/superpowers/specs/2026-07-15-presenca-confirmada-romaneio-design.md`.
- **Nunca** expor esse sinal em qualquer resposta de API ou UI, nem sobrescrever
  `entregas_feitas`/`entregas_total` (fonte separada, `agruparAlvosPorPlaca`) — só
  afeta `pontosVeiculo`/`PontoEntrega.feito` internamente (usado só por
  `afastouDeTudo`/Camada 1 e pela supressão de alerta de favela, confirmado lendo o
  código antes de escrever a spec).
- Limiar: reusa `BYPASS_ENTREGA_DWELL_MINIMO_SEGUNDOS` (120s, já exportado de
  `src/lib/detectores.ts`) — não cria constante nova.
- Escrita em lote no fim do ciclo (mesmo padrão de `amostrasBaselineCiclo`,
  `route.ts:619`+~2063), nunca um UPDATE síncrono por veículo dentro do loop.
- Toda mudança precisa passar `npx tsc --noEmit`, `npx eslint <arquivo>` e
  `npx vitest run` (suite inteira) antes de commit.
- Regra do projeto: commit num dos dois repos precisa ser espelhado e pushado no
  outro no mesmo lote de trabalho (Task 3).
- Migrations aplicadas manualmente: `node --env-file=.env.local scripts/aplicar-migration.mjs 021_presenca_confirmada.sql`. Última migration aplicada: `020_romaneio_pontos.sql`.

---

### Task 1: Migration + `montarPontosDeRomaneio` une presença confirmada

**Files:**
- Create: `scripts/migrations/021_presenca_confirmada.sql`
- Modify: `src/lib/romaneio.ts` (tipo `LinhaRomaneioGeocodificada` e função
  `montarPontosDeRomaneio`, ao final do arquivo)
- Modify: `src/lib/romaneio.test.ts` (`describe("montarPontosDeRomaneio")`)

**Interfaces:**
- Produces: `LinhaRomaneioGeocodificada` ganha campo `presencaConfirmadaEm: string |
  null`; `montarPontosDeRomaneio` (mesma assinatura, `(pontosRomaneio,
  pontosUnitrac) => PontoEntrega[]`) agora seta `feito: (alvo?.feito ?? false) ||
  l.presencaConfirmadaEm !== null`.

- [ ] **Step 1: Migration**

```sql
-- 021_presenca_confirmada.sql
-- Presenca confirmada por permanencia -- ver
-- docs/superpowers/specs/2026-07-15-presenca-confirmada-romaneio-design.md
ALTER TABLE romaneio_pontos ADD COLUMN presenca_confirmada_em timestamptz;
```

Run: `node --env-file=.env.local scripts/aplicar-migration.mjs 021_presenca_confirmada.sql`
Expected: `OK — migration aplicada.`

- [ ] **Step 2: Escrever os testes que falham**

Adicionar ao `describe("montarPontosDeRomaneio")` existente em
`src/lib/romaneio.test.ts` (depois do último `it`):

```ts
  it("presencaConfirmadaEm nao-nulo: feito=true mesmo sem alvo da Unitrac confirmar", () => {
    const romaneio = [{ nf: "2272484", clienteNome: "X", lat: -21, lng: -41, presencaConfirmadaEm: "2026-07-15T12:00:00Z" }];
    const unitrac = [pontoUnitrac({ documento: "2272484", feito: false, situacao: 0 })];
    const resultado = montarPontosDeRomaneio(romaneio, unitrac);
    expect(resultado[0].feito).toBe(true);
  });

  it("presencaConfirmadaEm null e alvo nao confirmado: feito=false (comportamento atual preservado)", () => {
    const romaneio = [{ nf: "2272484", clienteNome: "X", lat: -21, lng: -41, presencaConfirmadaEm: null }];
    const unitrac = [pontoUnitrac({ documento: "2272484", feito: false, situacao: 0 })];
    const resultado = montarPontosDeRomaneio(romaneio, unitrac);
    expect(resultado[0].feito).toBe(false);
  });

  it("alvo da Unitrac ja confirmado, sem presenca confirmada: continua feito=true (uniao, nao substituicao)", () => {
    const romaneio = [{ nf: "2272484", clienteNome: "X", lat: -21, lng: -41, presencaConfirmadaEm: null }];
    const unitrac = [pontoUnitrac({ documento: "2272484", feito: true, situacao: 1 })];
    const resultado = montarPontosDeRomaneio(romaneio, unitrac);
    expect(resultado[0].feito).toBe(true);
  });
```

Atualizar também os 3 `it` já existentes desse `describe` (Task 4 da spec anterior)
pra incluir `presencaConfirmadaEm: null` nos objetos `romaneio` literais passados —
o tipo vai exigir o campo depois do Step 4.

- [ ] **Step 3: Rodar os testes e confirmar que falham**

Run: `npx vitest run src/lib/romaneio.test.ts`
Expected: FAIL nos 2 novos `it` de presença confirmada (campo ainda não existe/não é
usado); os `it` antigos devem falhar por erro de TIPO (`presencaConfirmadaEm`
ausente) se você rodar `tsc` — rode `npx tsc --noEmit` depois de atualizar as
fixtures do Step 2 pra confirmar isso antes de implementar.

- [ ] **Step 4: Implementar**

Em `src/lib/romaneio.ts`, trecho atual:

```ts
export type LinhaRomaneioGeocodificada = {
  nf: string;
  clienteNome: string;
  lat: number;
  lng: number;
};
```

Substituir por:

```ts
export type LinhaRomaneioGeocodificada = {
  nf: string;
  clienteNome: string;
  lat: number;
  lng: number;
  // Achado real 15/07 (depois da spec anterior): a coordenada errada da
  // Unitrac afeta a CONFIRMACAO dela propria -- se o raio dela ta centrado
  // no ponto errado, uma entrega feita de verdade no endereco certo nunca
  // entra no raio dela, e a NF fica "pendente pra sempre". presencaConfirmadaEm
  // (setado pelo motor quando o dwell no NOSSO ponto, ja calculado pro
  // bypass_entrega, cruza 120s) e um sinal so INTERNO -- une com o status da
  // Unitrac, nunca substitui, nunca aparece pro operador como "entregue" (ver
  // docs/superpowers/specs/2026-07-15-presenca-confirmada-romaneio-design.md).
  presencaConfirmadaEm: string | null;
};
```

E o trecho atual da função:

```ts
      feito: alvo?.feito ?? false,
      situacao: alvo?.situacao ?? 0,
```

Substituir por:

```ts
      feito: (alvo?.feito ?? false) || l.presencaConfirmadaEm !== null,
      situacao: alvo?.situacao ?? 0,
```

- [ ] **Step 5: Rodar os testes e confirmar que passam**

Run: `npx vitest run src/lib/romaneio.test.ts && npx tsc --noEmit && npx eslint src/lib/romaneio.ts && npx vitest run`
Expected: tudo verde.

- [ ] **Step 6: Commit**

```bash
git add scripts/migrations/021_presenca_confirmada.sql src/lib/romaneio.ts src/lib/romaneio.test.ts
git commit -m "$(cat <<'EOF'
feat(romaneio): presenca confirmada por permanencia une com status da Unitrac

Coluna romaneio_pontos.presenca_confirmada_em (nullable). montarPontosDeRomaneio
agora considera feito=true quando presencaConfirmadaEm != null, ALEM do status
da Unitrac -- uniao dos dois sinais, nunca substituicao. Resolve o caso onde a
coordenada errada da Unitrac afeta a propria confirmacao dela (NF fica
"pendente pra sempre" mesmo com entrega feita de verdade).

Ver docs/superpowers/specs/2026-07-15-presenca-confirmada-romaneio-design.md

Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>
EOF
)"
```

---

### Task 2: Motor grava presença confirmada (reaproveitando o dwell existente)

**Files:**
- Modify: `src/app/api/motor/route.ts`:
  - Import de `@/lib/detectores` (linha ~18-33): adicionar
    `BYPASS_ENTREGA_DWELL_MINIMO_SEGUNDOS`.
  - Declaração de array de coleta por ciclo, próximo a `amostrasBaselineCiclo`
    (`route.ts:619`).
  - Query de `romaneioPontosPorPlaca` (`route.ts:876-908`): incluir
    `presenca_confirmada_em` no `select` e no tipo do Map.
  - Bloco de dwell (`route.ts:1513-1540`): coletar candidato a presença confirmada.
  - Flush em lote no fim do ciclo, próximo ao flush de `amostrasBaselineCiclo`
    (`route.ts` ~2063+).

**Interfaces:**
- Consumes: `BYPASS_ENTREGA_DWELL_MINIMO_SEGUNDOS` (Task 1 do plano anterior, já
  existe em `detectores.ts`); `dataHojeSP` (já existe, `route.ts:448`).
- Produces: nada consumido por task depois — ponto final.

- [ ] **Step 1: Import do limiar**

Em `route.ts`, no bloco de import de `@/lib/detectores` (linhas 18-33), adicionar
`BYPASS_ENTREGA_DWELL_MINIMO_SEGUNDOS` à lista (ordem alfabética não é seguida no
arquivo hoje, adicionar em qualquer posição da lista, ex. logo após
`detectarBypassEntrega`).

- [ ] **Step 2: Declarar o array de coleta do ciclo**

Próximo a `amostrasBaselineCiclo` (`route.ts:619`):

```ts
    // Presenca confirmada por permanencia (romaneio) -- ver
    // docs/superpowers/specs/2026-07-15-presenca-confirmada-romaneio-design.md.
    // Coleta candidatos durante o loop, grava em lote no fim do ciclo (mesmo
    // padrao de amostrasBaselineCiclo acima).
    const presencaConfirmadaCiclo: { veiculo_id: string; nf: string }[] = [];
```

- [ ] **Step 3: Atualizar a query de `romaneioPontosPorPlaca` pra trazer a nova coluna**

Trecho atual (`route.ts:876-908`):

```ts
      const cacheRomaneio = cacheRomaneioPorCliente.get(cliente.id);
      let romaneioPontosPorPlaca: Map<string, { nf: string; clienteNome: string; lat: number; lng: number }[]>;
      if (cacheRomaneio && cacheRomaneio.expiraEm > Date.now()) {
        romaneioPontosPorPlaca = cacheRomaneio.pontosPorPlaca;
      } else {
        romaneioPontosPorPlaca = new Map();
        const veiculoIdsDoCliente = [...mapaCv.values()]
          .filter((v) => v.cliente_id === cliente.id)
          .map((v) => v.veiculo_id);
        const { data: linhasRomaneio } = await supabase
          .from("romaneio_pontos")
          .select("placa, nf, cliente_nome, lat, lng")
          .eq("romaneio_data", dataHojeSP)
          .not("lat", "is", null)
          .not("lng", "is", null)
          .in("veiculo_id", veiculoIdsDoCliente);
        for (const l of linhasRomaneio ?? []) {
          const lista = romaneioPontosPorPlaca.get(l.placa) ?? [];
          lista.push({ nf: l.nf, clienteNome: l.cliente_nome, lat: l.lat, lng: l.lng });
          romaneioPontosPorPlaca.set(l.placa, lista);
        }
        cacheRomaneioPorCliente.set(cliente.id, { pontosPorPlaca: romaneioPontosPorPlaca, expiraEm: Date.now() + CACHE_ROMANEIO_MS });
      }
```

Substituir por (só o `select`, o tipo do Map, e o `push` mudam):

```ts
      const cacheRomaneio = cacheRomaneioPorCliente.get(cliente.id);
      let romaneioPontosPorPlaca: Map<string, { nf: string; clienteNome: string; lat: number; lng: number; presencaConfirmadaEm: string | null }[]>;
      if (cacheRomaneio && cacheRomaneio.expiraEm > Date.now()) {
        romaneioPontosPorPlaca = cacheRomaneio.pontosPorPlaca;
      } else {
        romaneioPontosPorPlaca = new Map();
        const veiculoIdsDoCliente = [...mapaCv.values()]
          .filter((v) => v.cliente_id === cliente.id)
          .map((v) => v.veiculo_id);
        const { data: linhasRomaneio } = await supabase
          .from("romaneio_pontos")
          .select("placa, nf, cliente_nome, lat, lng, presenca_confirmada_em")
          .eq("romaneio_data", dataHojeSP)
          .not("lat", "is", null)
          .not("lng", "is", null)
          .in("veiculo_id", veiculoIdsDoCliente);
        for (const l of linhasRomaneio ?? []) {
          const lista = romaneioPontosPorPlaca.get(l.placa) ?? [];
          lista.push({ nf: l.nf, clienteNome: l.cliente_nome, lat: l.lat, lng: l.lng, presencaConfirmadaEm: l.presenca_confirmada_em });
          romaneioPontosPorPlaca.set(l.placa, lista);
        }
        cacheRomaneioPorCliente.set(cliente.id, { pontosPorPlaca: romaneioPontosPorPlaca, expiraEm: Date.now() + CACHE_ROMANEIO_MS });
      }
```

E o `type RomaneioCache` (`route.ts:76`):

```ts
type RomaneioCache = { pontosPorPlaca: Map<string, { nf: string; clienteNome: string; lat: number; lng: number }[]>; expiraEm: number };
```

Substituir por:

```ts
type RomaneioCache = { pontosPorPlaca: Map<string, { nf: string; clienteNome: string; lat: number; lng: number; presencaConfirmadaEm: string | null }[]>; expiraEm: number };
```

- [ ] **Step 4: Coletar candidato a presença confirmada no bloco de dwell**

Trecho atual (`route.ts:1536-1540`):

```ts
          } else if (!mesmoAlvoQueAntes) {
            // Entrou num raio novo (ou pela primeira vez).
            noRaioDesde = agora.toISOString();
            noRaioDwellSegundos = pos.velocidade <= LIMIAR_VELOCIDADE_DWELL_KMH ? 30 : 0;
          } else {
            // Continua no mesmo raio: acumula dwell so quando devagar/parado.
            noRaioDwellSegundos = dwellAnterior + (pos.velocidade <= LIMIAR_VELOCIDADE_DWELL_KMH ? 30 : 0);
          }
```

Substituir por (adiciona o `else if` novo depois, sem mudar a lógica de dwell em
si):

```ts
          } else if (!mesmoAlvoQueAntes) {
            // Entrou num raio novo (ou pela primeira vez).
            noRaioDesde = agora.toISOString();
            noRaioDwellSegundos = pos.velocidade <= LIMIAR_VELOCIDADE_DWELL_KMH ? 30 : 0;
          } else {
            // Continua no mesmo raio: acumula dwell so quando devagar/parado.
            noRaioDwellSegundos = dwellAnterior + (pos.velocidade <= LIMIAR_VELOCIDADE_DWELL_KMH ? 30 : 0);
          }

          // Presenca confirmada por permanencia (romaneio) -- ver
          // docs/superpowers/specs/2026-07-15-presenca-confirmada-romaneio-design.md.
          // Mesmo limiar que ja diferencia "parou de verdade" de "so passou"
          // no bypass_entrega (120s). So se aplica a pontos vindos do
          // romaneio (romaneioDoVeiculo, ja calculado acima nesta mesma
          // iteracao) -- sem romaneio, o motor ja confia direto na
          // coordenada da Unitrac, nao ha o problema de coordenada errada
          // afetando a propria confirmacao. Idempotente na escrita (Task 1
          // do flush, WHERE presenca_confirmada_em IS NULL) -- pode coletar
          // o mesmo par repetidas vezes sem problema.
          if (romaneioDoVeiculo && romaneioDoVeiculo.length > 0 && alvoNoRaioAgora?.documento && noRaioDwellSegundos >= BYPASS_ENTREGA_DWELL_MINIMO_SEGUNDOS) {
            presencaConfirmadaCiclo.push({ veiculo_id, nf: alvoNoRaioAgora.documento });
          }
```

- [ ] **Step 5: Flush em lote no fim do ciclo**

Próximo ao flush de `amostrasBaselineCiclo` (`route.ts` ~2063, depois do bloco
`if (amostrasBaselineCiclo.length > 0) { ... }`), adicionar:

```ts
    if (presencaConfirmadaCiclo.length > 0) {
      const paresUnicos = [...new Map(presencaConfirmadaCiclo.map((p) => [`${p.veiculo_id}:${p.nf}`, p])).values()];
      const resultadosPresenca = await Promise.allSettled(
        paresUnicos.map((p) =>
          pool.query(
            `update romaneio_pontos set presenca_confirmada_em = now()
             where veiculo_id = $1 and nf = $2 and romaneio_data = $3 and presenca_confirmada_em is null`,
            [p.veiculo_id, p.nf, dataHojeSP]
          )
        )
      );
      const falhasPresenca = resultadosPresenca.filter((r) => r.status === "rejected").length;
      if (falhasPresenca > 0) console.warn(`Aviso: ${falhasPresenca} falha(s) ao gravar presenca_confirmada_em neste ciclo`);
    }
```

- [ ] **Step 6: Rodar tsc, eslint, suite e build**

Run: `npx tsc --noEmit && npx eslint src/app/api/motor/route.ts && npx vitest run && npx next build`
Expected: tudo limpo.

- [ ] **Step 7: Validação (sem rodar o motor de producao — mesma cautela da task anterior)**

Testar isoladamente a query de UPDATE contra o banco real (script temporário,
apagado depois): inserir uma linha de teste em `romaneio_pontos` com
`presenca_confirmada_em` nulo, rodar a query exata do Step 5 com
`presenca_confirmada_em is null` uma vez (deve setar), rodar de novo (deve ser
no-op, idempotente — confirmar `updated_at`/`presenca_confirmada_em` não muda na
segunda chamada). Apagar a linha de teste depois.

- [ ] **Step 8: Commit e push**

```bash
git add src/app/api/motor/route.ts
git commit -m "$(cat <<'EOF'
feat(romaneio): motor grava presenca confirmada reaproveitando o dwell existente

Reusa o dwell ja calculado pelo bypass_entrega (no_raio_dwell_segundos,
ja contra a coordenada do romaneio quando existe) -- quando cruza 120s
(BYPASS_ENTREGA_DWELL_MINIMO_SEGUNDOS) num ponto do romaneio, coleta o
par (veiculo, NF) e grava presenca_confirmada_em em lote no fim do ciclo
(mesmo padrao do baseline), idempotente (WHERE ... IS NULL).

tsc/eslint/vitest/build limpos. Query de escrita validada isoladamente
contra o banco real (nao rodei o motor de producao, mesma cautela da
task anterior desta sessao).

Ver docs/superpowers/specs/2026-07-15-presenca-confirmada-romaneio-design.md

Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>
EOF
)"
git push
```

---

### Task 3: Replicar no repo definitivo e push nos dois

**Files:**
- Modify (repo `/Users/joaquimsalles/Projects/Transmonseg/monitoramento/MONITORAMENTO transmonseg`): os mesmos arquivos das Tasks 1-2.

- [ ] **Step 1: Confirmar sincronismo antes de começar**

Commit do TEMP imediatamente antes da Task 1 deste plano: `7bba7e30436d2c32359efd937c0739845256df39`
(commit da spec de presença confirmada, último antes deste plano). Run:
```bash
diff "/Users/joaquimsalles/Projects/Transmonseg/monitoramento/MONITORAMENTO transmonseg/src/lib/romaneio.ts" \
     <(cd "/Users/joaquimsalles/Projects/Transmonseg/monitoramento/MONITORAMENTO TEMP" && git show 7bba7e30436d2c32359efd937c0739845256df39:src/lib/romaneio.ts)
diff "/Users/joaquimsalles/Projects/Transmonseg/monitoramento/MONITORAMENTO transmonseg/src/app/api/motor/route.ts" \
     <(cd "/Users/joaquimsalles/Projects/Transmonseg/monitoramento/MONITORAMENTO TEMP" && git show 7bba7e30436d2c32359efd937c0739845256df39:src/app/api/motor/route.ts)
```
Expected: sem output nos dois (idênticos).

- [ ] **Step 2: Gerar e aplicar o patch**

```bash
cd "/Users/joaquimsalles/Projects/Transmonseg/monitoramento/MONITORAMENTO TEMP"
git diff 7bba7e30436d2c32359efd937c0739845256df39..HEAD -- src/lib/romaneio.ts src/lib/romaneio.test.ts src/app/api/motor/route.ts scripts/migrations/021_presenca_confirmada.sql docs/superpowers/specs/2026-07-15-presenca-confirmada-romaneio-design.md docs/superpowers/plans/2026-07-15-presenca-confirmada-romaneio.md > /tmp/presenca-confirmada.patch
cd "/Users/joaquimsalles/Projects/Transmonseg/monitoramento/MONITORAMENTO transmonseg"
git apply --check /tmp/presenca-confirmada.patch && git apply /tmp/presenca-confirmada.patch
```

**Nota:** a migration já está aplicada no banco (mesmo Supabase dos dois repos) —
não rodar `aplicar-migration.mjs` de novo, só copiar o `.sql` por completude do
histórico (já incluído no patch acima).

- [ ] **Step 3: Rodar tsc, eslint, suite e build**

Run: `npx tsc --noEmit && npx eslint src/lib/romaneio.ts src/app/api/motor/route.ts && npx vitest run && npx next build`
Expected: tudo limpo.

- [ ] **Step 4: Commit e push**

```bash
git add -A
git commit -m "$(cat <<'EOF'
feat(romaneio): presenca confirmada por permanencia

Espelha os commits do TEMP -- ver
docs/superpowers/specs/2026-07-15-presenca-confirmada-romaneio-design.md.
Migration ja aplicada (mesmo banco Supabase dos dois repos).

Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>
EOF
)"
git push
```

- [ ] **Step 5: Confirmar sincronismo final**

Run: `diff -rq "/Users/joaquimsalles/Projects/Transmonseg/monitoramento/MONITORAMENTO transmonseg/src" "/Users/joaquimsalles/Projects/Transmonseg/monitoramento/MONITORAMENTO TEMP/src"`
Expected: sem output.
