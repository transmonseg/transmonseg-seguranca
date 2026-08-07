# Progresso ao destino em alertas "afastando de tudo" Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Anotar, a cada ciclo do motor, o quanto um alerta "afastando de tudo" ativo já se aproximou/afastou do destino conhecido mais próximo desde que começou — e exibir isso no card do operador — sem tocar em severidade, disparo ou fechamento automático.

**Architecture:** Reaproveita 3 coisas que já existem e já rodam em produção: o valor `afastamentoAcumuladoM` (já calculado todo ciclo, hoje só usado ao fechar o alerta), o padrão de anotação em lote já usado por `proximidade_atual`/`rota_concluida` (mesmo arquivo, mesmo bloco de flush), e o predicado `elegivelParaAutoResolveAfastando` (já filtra exatamente os alertas certos). Frontend: `page.tsx` extrai o campo novo do `contexto` (mesmo padrão já usado — mas incompleto — pra `rotaConcluida`); `MonitorV2.tsx` renderiza.

**Tech Stack:** Next.js/TypeScript (já no projeto), Vitest (testes já existentes em `detectores.test.ts`), Postgres self-hosted no Contabo (`transmonseg`), PM2.

## Global Constraints

- Zero mudança em `afastouDeTudo`, `nivel`, `desvioStreak`, ou qualquer lógica de disparo/fechamento — só leitura de um valor já calculado + anotação/exibição.
- Toda mudança de código replicada nos dois repos (`MONITORAMENTO TEMP` e `MONITORAMENTO transmonseg`) antes de considerar a feature pronta.
- Deploy é manual (Contabo, PM2) — `git push`/commit sozinho NÃO atualiza produção.
- Texto exibido ao operador nunca deve sugerir "resolvido"/"seguro" (achado de segurança do spec — este sinal não reduz urgência).

---

### Task 1: Anotar `progresso_destino` no motor

**Files:**
- Modify: `src/app/api/motor/route.ts:52` (import), `:933` (declaração do array de coleta), `:3533-3541` (coleta por veículo), `:4333-4354` (flush em lote)

**Interfaces:**
- Consumes: `afastamentoAcumuladoM` (já calculado por volta da linha 1836-1839, mesmo escopo de função); `elegivelParaAutoResolveAfastando` (já exportado de `src/lib/detectores.ts`); `alertasAbertos` (já disponível no loop, cada item `{ id, tipo, nivel, motivo, status }`).
- Produces: campo `contexto.progresso_destino = { delta_m: number, atualizado_em: string }` em alertas `desvio` ativos cujo motivo comece com "Afastando-se de todos" — consumido pela Task 2.

- [ ] **Step 1: Confirmar que `elegivelParaAutoResolveAfastando` já está importada**

Já confirmado por leitura direta do arquivo: `elegivelParaAutoResolveAfastando` já está na lista de imports de `@/lib/detectores` (junto de `deveAutoResolverAfastandoRotaConcluida`/`deveAutoResolverAfastandoChegadaReal`, por volta da linha 55-57). Rode só pra confirmar antes de prosseguir: `grep -n "elegivelParaAutoResolveAfastando" "src/app/api/motor/route.ts"` — deve aparecer 1 linha (o import). Nenhuma mudança necessária neste step.

- [ ] **Step 2: Declarar o array de coleta por ciclo**

Logo abaixo da declaração de `rotaConcluidaCiclo` (por volta da linha 943 — confirme o número exato com `grep -n "rotaConcluidaCiclo" src/app/api/motor/route.ts`), adicionar:

```typescript
// Anotação de progresso ao destino em alertas "afastando de tudo" ativos --
// ver docs/superpowers/specs/2026-08-06-progresso-destino-desvio-design.md.
// Mesmo padrão de proximidadeDesvioCiclo/rotaConcluidaCiclo: acumula por
// ciclo, flush em lote no final, so ADICIONA campo no contexto (jsonb ||),
// nunca muda nivel/status, nunca fecha o alerta.
const progressoDestinoCiclo: { alerta_id: string; deltaM: number }[] = [];
```

- [ ] **Step 3: Coletar o valor por veículo**

Logo depois do bloco que empurra pra `rotaConcluidaCiclo` (por volta da linha 3556, dentro do mesmo `if (deveGerenciarAlertas)`), adicionar:

```typescript
          // Anota progresso ao destino num alerta "afastando de tudo" JA
          // ATIVO -- ver docs/superpowers/specs/2026-08-06-progresso-destino-desvio-design.md.
          // Reusa afastamentoAcumuladoM (ja calculado acima nesta mesma
          // iteracao, ~linha 1836) e o mesmo predicado que o auto-resolve ja
          // usa pra saber quais alertas sao "afastando de tudo" -- so
          // anotacao, nunca gera/fecha/muda severidade de alerta.
          for (const d of alertasAbertos.filter((a) => elegivelParaAutoResolveAfastando(a))) {
            progressoDestinoCiclo.push({
              alerta_id: d.id,
              deltaM: afastamentoAcumuladoM,
            });
          }
```

- [ ] **Step 4: Flush em lote**

Logo depois do bloco de flush de `rotaConcluidaCiclo` (por volta da linha 4382 — confirme com `grep -n "falhasRotaConcluida" src/app/api/motor/route.ts`), adicionar:

```typescript
    // Anotacao de progresso ao destino em alertas de desvio ativos -- ver
    // docs/superpowers/specs/2026-08-06-progresso-destino-desvio-design.md.
    // Mesmo padrao de flush em lote + dedupe por alerta_id. SO ADICIONA
    // campo no contexto (jsonb ||) -- nunca muda nivel/status, nunca fecha
    // o alerta.
    if (progressoDestinoCiclo.length > 0) {
      const porAlertaProgresso = new Map(progressoDestinoCiclo.map((p) => [p.alerta_id, p]));
      const resultadosProgresso = await Promise.allSettled(
        [...porAlertaProgresso.values()].map((p) =>
          pool.query(
            `update alertas set contexto = contexto || $2::jsonb where id = $1`,
            [
              p.alerta_id,
              JSON.stringify({
                progresso_destino: {
                  delta_m: Math.round(p.deltaM),
                  atualizado_em: new Date().toISOString(),
                },
              }),
            ]
          )
        )
      );
      const falhasProgresso = resultadosProgresso.filter((r) => r.status === "rejected").length;
      if (falhasProgresso > 0) console.warn(`Aviso: ${falhasProgresso} falha(s) ao anotar progresso ao destino neste ciclo`);
    }
```

- [ ] **Step 5: Rodar o typecheck**

Run: `npx tsc --noEmit`

Expected: sem erro novo relacionado a `motor/route.ts`.

- [ ] **Step 6: Rodar a suite de testes existente (não deve ter mudado nada nela)**

Run: `npx vitest run src/lib/detectores.test.ts`

Expected: mesma contagem de testes passando de antes (esta task não mexe em `detectores.ts`).

- [ ] **Step 7: Commit**

```bash
git add src/app/api/motor/route.ts
git commit -m "feat(desvio): anotar progresso ao destino em alertas afastando_de_tudo ativos"
```

---

### Task 2: Exibir progresso no card do operador

**Files:**
- Modify: `src/lib/detectores.ts` (nova função pura de formatação)
- Test: `src/lib/detectores.test.ts` (teste da função nova)
- Modify: `src/app/(app)/page.tsx:9` (interface `Alerta`), `:52-66` (função `enriquecer`)
- Modify: `src/app/(app)/central-v2/MonitorV2.tsx:19-38` (interface `AlertaEnriquecido`), `:1274-1304` (render do card)

**Interfaces:**
- Consumes: `contexto.progresso_destino` (Task 1, formato `{ delta_m: number, atualizado_em: string }`).
- Produces: `formatarProgressoDestino(deltaM: number): { texto: string; aproximando: boolean }` (nova, em `detectores.ts`) — consumida por `MonitorV2.tsx`.

- [ ] **Step 1: Escrever o teste da função de formatação**

Em `src/lib/detectores.test.ts`, adicionar ao array de imports de `./detectores` (mesmo bloco que já importa `formataDuracao`): `formatarProgressoDestino,`. Depois, adicionar ao final do arquivo:

```typescript
describe("formatarProgressoDestino", () => {
  it("delta negativo = aproximando", () => {
    expect(formatarProgressoDestino(-120)).toEqual({
      texto: "aproximando de um destino (120m)",
      aproximando: true,
    });
  });

  it("delta positivo = ainda se afastando", () => {
    expect(formatarProgressoDestino(340)).toEqual({
      texto: "ainda se afastando (+340m)",
      aproximando: false,
    });
  });

  it("delta zero conta como ainda se afastando (nao aproximou)", () => {
    expect(formatarProgressoDestino(0)).toEqual({
      texto: "ainda se afastando (+0m)",
      aproximando: false,
    });
  });

  it("arredonda pra metro inteiro", () => {
    expect(formatarProgressoDestino(-119.6)).toEqual({
      texto: "aproximando de um destino (120m)",
      aproximando: true,
    });
  });
});
```

- [ ] **Step 2: Rodar o teste, confirmar que falha (função não existe ainda)**

Run: `npx vitest run src/lib/detectores.test.ts -t formatarProgressoDestino`

Expected: FAIL com `formatarProgressoDestino is not a function` (ou erro de import).

- [ ] **Step 3: Implementar a função**

Em `src/lib/detectores.ts`, logo depois de `formataDuracao` (por volta da linha 82-90 — confirme com `grep -n "^export function formataDuracao" src/lib/detectores.ts`), adicionar:

```typescript
// Formata o progresso de um alerta "afastando de tudo" em relação ao
// destino conhecido mais próximo, pro card do operador -- ver
// docs/superpowers/specs/2026-08-06-progresso-destino-desvio-design.md.
// Puramente informativo: o texto nunca sugere "resolvido"/"seguro" (achado
// de segurança do spec -- este sinal nao reduz urgencia automaticamente).
export function formatarProgressoDestino(deltaM: number): { texto: string; aproximando: boolean } {
  const arredondado = Math.round(Math.abs(deltaM));
  if (deltaM < 0) {
    return { texto: `aproximando de um destino (${arredondado}m)`, aproximando: true };
  }
  return { texto: `ainda se afastando (+${arredondado}m)`, aproximando: false };
}
```

- [ ] **Step 4: Rodar o teste de novo, confirmar que passa**

Run: `npx vitest run src/lib/detectores.test.ts -t formatarProgressoDestino`

Expected: PASS, 4/4 testes.

- [ ] **Step 5: Rodar a suite inteira (garantir que nada mais quebrou)**

Run: `npx vitest run src/lib/detectores.test.ts`

Expected: todos os testes passando, mesma contagem de antes + 4 novos.

- [ ] **Step 6: Passar o campo adiante em `page.tsx`**

Em `src/app/(app)/page.tsx`, na interface `Alerta` (linha 9), mudar:

```typescript
contexto: { rota_concluida?: unknown } | null;
```

para:

```typescript
contexto: { rota_concluida?: unknown; progresso_destino?: { delta_m: number } } | null;
```

Na função `enriquecer` (dentro do objeto retornado, logo abaixo da linha `rotaConcluida: ...`, por volta da linha 63), adicionar:

```typescript
      progressoDestinoM: (a.contexto as { progresso_destino?: { delta_m: number } } | null)?.progresso_destino?.delta_m ?? null,
```

- [ ] **Step 7: Adicionar o campo na interface e renderizar no card, em `MonitorV2.tsx`**

Na interface `AlertaEnriquecido` (por volta da linha 19-38), adicionar antes do fechamento `}`:

```typescript
  progressoDestinoM: number | null;
```

Adicionar o import de `formatarProgressoDestino` no topo do arquivo, junto aos outros imports de `@/lib/detectores` (se `MonitorV2.tsx` ainda não importar nada de lá, adicionar `import { formatarProgressoDestino } from "@/lib/detectores";` perto dos outros imports locais do arquivo).

Logo depois do bloco de `motivo` que já existe (por volta da linha 1274-1304, o `{a.motivo && (() => { ... })()}`), adicionar:

```typescript
          {a.progressoDestinoM !== null && (() => {
            const { texto, aproximando } = formatarProgressoDestino(a.progressoDestinoM);
            return (
              <p style={{
                margin: "0 0 2px", fontSize: 10, fontWeight: 600,
                color: aproximando ? T.accent : T.dim,
              }}>
                {texto}
              </p>
            );
          })()}
```

(`T.accent`/`T.dim` já são usados em outros lugares deste mesmo arquivo — confirme os nomes exatos do objeto de tema `T` rodando `grep -n "T\.accent\|T\.dim" src/app/\(app\)/central-v2/MonitorV2.tsx | head -3` antes de escrever, e ajuste se os nomes forem outros.)

- [ ] **Step 8: Rodar o typecheck**

Run: `npx tsc --noEmit`

Expected: sem erro novo em `page.tsx`/`MonitorV2.tsx`.

- [ ] **Step 9: Confirmar visualmente com o dev server local**

Run: `npm run dev`

Abrir a central no browser (`/`), confirmar que a tela carrega sem erro no console. Como não há alerta real com `progresso_destino` ainda (a Task 1 só roda em produção depois do deploy), a linha nova não vai aparecer em nenhum card ainda — isso é esperado, só confirme que nada quebrou visualmente nos cards existentes. Parar o dev server depois.

- [ ] **Step 10: Commit**

```bash
git add src/lib/detectores.ts src/lib/detectores.test.ts "src/app/(app)/page.tsx" "src/app/(app)/central-v2/MonitorV2.tsx"
git commit -m "feat(desvio): exibir progresso ao destino no card do alerta"
```

---

### Task 3: Replicar pro repo espelho + deploy no Contabo

**Files:**
- Nenhum arquivo novo — copia exata dos diffs das Tasks 1/2 pro repo `MONITORAMENTO transmonseg`.

**Interfaces:**
- Consumes: commits das Tasks 1/2 (repo `MONITORAMENTO TEMP`).
- Produces: mesma mudança de código rodando em produção real (PM2 `transmonseg-temp`/`transmonseg-definitivo` no Contabo) — encerra o plano.

- [ ] **Step 1: Replicar as mudanças pro repo espelho**

```bash
cd ~/Projects/Transmonseg/monitoramento
diff "MONITORAMENTO TEMP/src/app/api/motor/route.ts" "MONITORAMENTO transmonseg/src/app/api/motor/route.ts" | head -5
```

Confirme que os arquivos batem antes da Task 1 (se não baterem, os dois repos já divergiam antes desta mudança — pare e reporte, não prossiga adivinhando qual versão é a certa). Se baterem, copie os 4 arquivos tocados nas Tasks 1/2:

```bash
cp "MONITORAMENTO TEMP/src/app/api/motor/route.ts" "MONITORAMENTO transmonseg/src/app/api/motor/route.ts"
cp "MONITORAMENTO TEMP/src/lib/detectores.ts" "MONITORAMENTO transmonseg/src/lib/detectores.ts"
cp "MONITORAMENTO TEMP/src/lib/detectores.test.ts" "MONITORAMENTO transmonseg/src/lib/detectores.test.ts"
cp "MONITORAMENTO TEMP/src/app/(app)/page.tsx" "MONITORAMENTO transmonseg/src/app/(app)/page.tsx"
cp "MONITORAMENTO TEMP/src/app/(app)/central-v2/MonitorV2.tsx" "MONITORAMENTO transmonseg/src/app/(app)/central-v2/MonitorV2.tsx"
cp "MONITORAMENTO TEMP/docs/superpowers/specs/2026-08-06-progresso-destino-desvio-design.md" "MONITORAMENTO transmonseg/docs/superpowers/specs/"
cp "MONITORAMENTO TEMP/docs/superpowers/plans/2026-08-06-progresso-destino-desvio.md" "MONITORAMENTO transmonseg/docs/superpowers/plans/"
```

- [ ] **Step 2: Rodar testes e typecheck no repo espelho**

```bash
cd "MONITORAMENTO transmonseg"
npx tsc --noEmit
npx vitest run src/lib/detectores.test.ts
```

Expected: mesmo resultado limpo da Task 2.

- [ ] **Step 3: Commit no repo espelho**

```bash
git add -A
git commit -m "feat(desvio): anotar e exibir progresso ao destino em alertas afastando_de_tudo (replica de MONITORAMENTO TEMP)"
git push origin master
```

- [ ] **Step 4: Deploy manual no Contabo — `transmonseg-temp`**

```bash
ssh transmonseg-vps "cd /srv/transmonseg/temp && git pull && npm ci && npm run build && pm2 restart transmonseg-temp --update-env"
```

Expected: build sem erro, `pm2 list` mostra `transmonseg-temp` `online` com PID novo.

- [ ] **Step 5: Deploy manual no Contabo — `transmonseg-definitivo`**

```bash
ssh transmonseg-vps "cd /srv/transmonseg/definitivo && git pull && npm ci && npm run build && pm2 restart transmonseg-definitivo --update-env"
```

Expected: build sem erro, `pm2 list` mostra `transmonseg-definitivo` `online` com PID novo.

- [ ] **Step 6: Confirmar em produção real que a anotação está rodando**

```bash
ssh transmonseg-vps "sudo -u postgres psql -d transmonseg -c \"select id, motivo, contexto->'progresso_destino' from alertas where tipo='desvio' and status='ativo' and motivo ilike 'Afastando-se de todos%' order by desde desc limit 5;\""
```

Expected: se houver algum alerta `afastando_de_tudo` ativo no momento, `progresso_destino` deve aparecer preenchido (pode levar até 1 ciclo do motor, ~30s, pra popular num alerta recém-criado). Se não houver nenhum alerta ativo desse tipo agora, isso é esperado — a anotação só roda quando existe alerta pra anotar; confirme ao menos que o motor não caiu (`ssh transmonseg-vps "pm2 logs transmonseg-definitivo --lines 30 --nostream"` sem erro novo relacionado a "progresso").

- [ ] **Step 7: Confirmar não regressão**

```bash
ssh transmonseg-vps "pm2 jlist | node -e 'let d=\"\"; process.stdin.on(\"data\",c=>d+=c); process.stdin.on(\"end\",()=>{JSON.parse(d).forEach(p=>console.log(p.name, p.pid, p.pm2_env.status, p.pm2_env.restart_time))})'"
```

Expected: `transmonseg-temp`/`transmonseg-definitivo` ambos `online`, sem erro de crash-loop (restart_time só sobe pelo restart desta task, não fica subindo sozinho depois).
