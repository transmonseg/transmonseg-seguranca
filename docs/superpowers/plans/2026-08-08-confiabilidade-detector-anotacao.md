# Anotação de confiabilidade histórica do detector no card — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** exibir, no card do alerta, a taxa de falso positivo histórica
(`contexto.calibracao.taxa_falso_positivo`) já gravada na criação de todo
alerta de desvio — zero mudança no motor, só leitura/exibição.

**Architecture:** campo já existente no banco (nenhuma escrita nova) → leitura
no `enriquecer()`/rota de polling → render condicional no card. Mesmo padrão
de `progresso_destino`/`placar_sombra`, já em produção.

**Tech Stack:** Next.js/TypeScript, Vitest.

## Global Constraints

- ZERO mudança em `route.ts` (motor) — o campo já é gravado, esta é uma
  feature 100% de leitura/exibição.
- `taxa_falso_positivo === -1` significa "sem dado de calibração" — nunca
  exibir um número nesse caso (mentira por omissão de contexto).
- Texto nunca usa "resolvido"/"seguro"; cor sempre `T.dim` (neutra),
  independente do valor (não fica vermelho pra 66% nem verde pra 9%).
- Toda mudança replicada pro repo espelho `MONITORAMENTO transmonseg` e
  deployada nos 2 processos PM2 antes de considerar o plano encerrado.
- Spec completa: `docs/superpowers/specs/2026-08-08-confiabilidade-detector-anotacao-design.md`.

---

### Task 1: Formatação e exibição no card

**Files:**
- Modify: `src/lib/detectores.ts` (nova função `formatarConfiabilidadeDetector`, logo depois de `formatarPlacarSombra`)
- Test: `src/lib/detectores.test.ts`
- Modify: `src/app/(app)/page.tsx` (interface `Alerta` linha 9, `enriquecer()` logo após linha 65)
- Modify: `src/app/(app)/central-v2/MonitorV2.tsx` (import linha 9, interface `AlertaEnriquecido` logo após linha 40, render logo após linha 1325)
- Modify: `src/app/api/alertas/route.ts` (tipo do parâmetro do map linha 95, campo no objeto retornado logo após linha 133)

**Interfaces:**
- Consumes: `contexto.calibracao: { segmento: string | null, taxa_falso_positivo: number } | undefined` — campo já gravado por `montarContextoDesvio` em `route.ts`, nenhuma mudança necessária ali.
- Produces: `formatarConfiabilidadeDetector(taxaFalsoPositivo: number): string | null` — usada só pelo componente de render.

- [ ] **Step 1: Escrever os testes de `formatarConfiabilidadeDetector`**

Em `src/lib/detectores.test.ts`:

```typescript
describe("formatarConfiabilidadeDetector (texto de confiabilidade histórica no card)", () => {
  it("taxa -1 (sem dado de calibracao): retorna null, nao mostra numero inventado", () => {
    expect(formatarConfiabilidadeDetector(-1)).toBeNull();
  });

  it("taxa 0: retorna 0% de falso positivo", () => {
    expect(formatarConfiabilidadeDetector(0)).toBe("Histórico: 0% de falso positivo neste tipo de alerta");
  });

  it("taxa 0.661 (caso real classe_viaria): arredonda pra 66%", () => {
    expect(formatarConfiabilidadeDetector(0.661)).toBe("Histórico: 66% de falso positivo neste tipo de alerta");
  });

  it("taxa 0.092 (caso real afastando_de_tudo): arredonda pra 9%", () => {
    expect(formatarConfiabilidadeDetector(0.092)).toBe("Histórico: 9% de falso positivo neste tipo de alerta");
  });

  it("taxa 1 (100% falso positivo): retorna 100%", () => {
    expect(formatarConfiabilidadeDetector(1)).toBe("Histórico: 100% de falso positivo neste tipo de alerta");
  });
});
```

- [ ] **Step 2: Rodar e confirmar que falha**

Run: `npx vitest run src/lib/detectores.test.ts -t "formatarConfiabilidadeDetector"`
Expected: FAIL — `formatarConfiabilidadeDetector is not a function`.

- [ ] **Step 3: Implementar em `detectores.ts`, logo depois de `formatarPlacarSombra`**

```typescript
// Texto de confiabilidade historica do card, a partir de
// contexto.calibracao.taxa_falso_positivo -- ja gravado na criacao/
// escalacao de todo alerta de desvio por montarContextoDesvio (route.ts),
// nenhuma escrita nova. Ver
// docs/superpowers/specs/2026-08-08-confiabilidade-detector-anotacao-design.md:
// achado real que classe_viaria erra 66% das vezes (139+ amostras) sem
// nenhum sinal nos dados ja coletados que discrimine certo de errado --
// em vez de inventar supressao automatica sem sinal confiavel, expoe o
// numero real e deixa a leitura com o operador. So informacao, nunca
// "resolvido"/"seguro", nunca cor por valor.
export function formatarConfiabilidadeDetector(taxaFalsoPositivo: number): string | null {
  if (taxaFalsoPositivo < 0) return null;
  const pct = Math.round(taxaFalsoPositivo * 100);
  return `Histórico: ${pct}% de falso positivo neste tipo de alerta`;
}
```

- [ ] **Step 4: Rodar e confirmar que passa**

Run: `npx vitest run src/lib/detectores.test.ts -t "formatarConfiabilidadeDetector"`
Expected: PASS, 5/5.

- [ ] **Step 5: Typecheck e suite completa**

Run: `npx tsc --noEmit && npx vitest run`
Expected: limpo.

- [ ] **Step 6: Wiring em `page.tsx`**

Linha 9, adicionar `calibracao` ao tipo do campo `contexto` da interface `Alerta`:

```typescript
interface Alerta { id: string; cliente_id: string; veiculo_id: string; nivel: "critico" | "atencao"; tipo: string; motivo: string | null; desde: string; status: string; score: number | null; lat: number | null; lng: number | null; contexto: { rota_concluida?: unknown; progresso_destino?: { delta_m: number }; placar_sombra?: { placar: number; componentes: Record<string, number | boolean | string> }; calibracao?: { segmento: string | null; taxa_falso_positivo: number } } | null; }
```

Logo depois da linha `placarSombra: (a.contexto as ...)?.placar_sombra ?? null,` (linha 65 atual), dentro de `enriquecer()`:

```typescript
      calibracao: (a.contexto as { calibracao?: { segmento: string | null; taxa_falso_positivo: number } } | null)?.calibracao ?? null,
```

- [ ] **Step 7: Wiring em `api/alertas/route.ts`**

Linha 95, adicionar `calibracao` ao tipo do parâmetro do map:

```typescript
      contexto: { rota_concluida?: unknown; progresso_destino?: { delta_m: number }; placar_sombra?: { placar: number; componentes: Record<string, number | boolean | string> }; calibracao?: { segmento: string | null; taxa_falso_positivo: number } } | null;
```

Logo depois da linha `placarSombra: a.contexto?.placar_sombra ?? null,` (linha 133 atual), dentro do objeto retornado:

```typescript
        calibracao: a.contexto?.calibracao ?? null,
```

- [ ] **Step 8: Wiring em `MonitorV2.tsx`**

Linha 9, atualizar o import:

```typescript
import { formatarProgressoDestino, formatarPlacarSombra, formatarConfiabilidadeDetector } from "@/lib/detectores";
```

Logo depois de `placarSombra: { placar: number; componentes: Record<string, number | boolean | string> } | null;` (linha 40 atual) na interface `AlertaEnriquecido`:

```typescript
  calibracao: { segmento: string | null; taxa_falso_positivo: number } | null;
```

Logo depois do bloco de render de `placarSombra` (linhas 1319-1325 atuais, que terminam em `)}`), antes do bloco `{a.local && (...)}`:

```typescript
          {a.calibracao != null && (() => {
            const texto = formatarConfiabilidadeDetector(a.calibracao.taxa_falso_positivo);
            if (texto == null) return null;
            return (
              <p style={{
                margin: "0 0 2px", fontSize: 10, color: T.dim,
              }}>
                {texto}
              </p>
            );
          })()}
```

- [ ] **Step 9: Rodar dev server e validar visualmente**

Run: `npm run dev` (background, use uma porta alternativa se 3000 já estiver ocupada por outro processo — não mate processos que você não subiu; confirme com `lsof -i :PORTA` antes de tentar liberar qualquer porta), abrir `/` no navegador, confirmar que carrega sem erro de console e sem regressão nos cards existentes.

- [ ] **Step 10: Typecheck e suite completa**

Run: `npx tsc --noEmit && npx vitest run`
Expected: limpo.

- [ ] **Step 11: Commit**

```bash
git add src/lib/detectores.ts src/lib/detectores.test.ts "src/app/(app)/page.tsx" "src/app/(app)/central-v2/MonitorV2.tsx" src/app/api/alertas/route.ts
git commit -m "feat(desvio): exibir confiabilidade histórica do detector no card do alerta"
```

---

### Task 2: Replicar pro repo espelho + deploy no Contabo

**Files:**
- Nenhum arquivo novo — cópia exata do diff da Task 1 pro repo `MONITORAMENTO transmonseg`.

**Interfaces:**
- Consumes: commit da Task 1 (repo `MONITORAMENTO TEMP`).
- Produces: mesma mudança de código rodando em produção real (PM2 `transmonseg-temp`/`transmonseg-definitivo` no Contabo) — encerra o plano.

- [ ] **Step 1: Confirmar que os repos não divergiram antes desta mudança**

```bash
cd ~/Projects/Transmonseg/monitoramento
diff "MONITORAMENTO TEMP/src/lib/detectores.ts" "MONITORAMENTO transmonseg/src/lib/detectores.ts"
diff "MONITORAMENTO TEMP/src/app/(app)/page.tsx" "MONITORAMENTO transmonseg/src/app/(app)/page.tsx"
diff "MONITORAMENTO TEMP/src/app/(app)/central-v2/MonitorV2.tsx" "MONITORAMENTO transmonseg/src/app/(app)/central-v2/MonitorV2.tsx"
diff "MONITORAMENTO TEMP/src/app/api/alertas/route.ts" "MONITORAMENTO transmonseg/src/app/api/alertas/route.ts"
```

Se algum diff não estiver vazio (fora as mudanças da Task 1 que acabaram de ser feitas só no TEMP), pare e reporte — não prossiga adivinhando qual versão é a certa.

- [ ] **Step 2: Copiar os 4 arquivos tocados + docs**

```bash
cp "MONITORAMENTO TEMP/src/lib/detectores.ts" "MONITORAMENTO transmonseg/src/lib/detectores.ts"
cp "MONITORAMENTO TEMP/src/lib/detectores.test.ts" "MONITORAMENTO transmonseg/src/lib/detectores.test.ts"
cp "MONITORAMENTO TEMP/src/app/(app)/page.tsx" "MONITORAMENTO transmonseg/src/app/(app)/page.tsx"
cp "MONITORAMENTO TEMP/src/app/(app)/central-v2/MonitorV2.tsx" "MONITORAMENTO transmonseg/src/app/(app)/central-v2/MonitorV2.tsx"
cp "MONITORAMENTO TEMP/src/app/api/alertas/route.ts" "MONITORAMENTO transmonseg/src/app/api/alertas/route.ts"
cp "MONITORAMENTO TEMP/docs/superpowers/specs/2026-08-08-confiabilidade-detector-anotacao-design.md" "MONITORAMENTO transmonseg/docs/superpowers/specs/"
cp "MONITORAMENTO TEMP/docs/superpowers/plans/2026-08-08-confiabilidade-detector-anotacao.md" "MONITORAMENTO transmonseg/docs/superpowers/plans/"
```

- [ ] **Step 3: Testes e typecheck no repo espelho**

```bash
cd "MONITORAMENTO transmonseg"
npx tsc --noEmit
npx vitest run
```

Expected: mesmo resultado limpo da Task 1.

- [ ] **Step 4: Commit no repo espelho**

```bash
git add -A
git commit -m "feat(desvio): exibir confiabilidade histórica do detector no card do alerta (replica de MONITORAMENTO TEMP)"
git push origin main
```

- [ ] **Step 5: Push do repo TEMP**

```bash
cd "../MONITORAMENTO TEMP"
git push origin master
```

- [ ] **Step 6: Deploy manual no Contabo — `transmonseg-temp`**

```bash
ssh transmonseg-vps "cd /srv/transmonseg/temp && git pull && npm ci && npm run build && pm2 restart transmonseg-temp --update-env"
```

- [ ] **Step 7: Deploy manual no Contabo — `transmonseg-definitivo`**

```bash
ssh transmonseg-vps "cd /srv/transmonseg/definitivo && git pull && npm ci && npm run build && pm2 restart transmonseg-definitivo --update-env"
```

- [ ] **Step 8: Confirmar não regressão**

```bash
ssh transmonseg-vps "pm2 jlist | node -e 'let d=\"\"; process.stdin.on(\"data\",c=>d+=c); process.stdin.on(\"end\",()=>{JSON.parse(d).forEach(p=>console.log(p.name, p.pid, p.pm2_env.status, p.pm2_env.restart_time))})'"
```

Expected: `transmonseg-temp`/`transmonseg-definitivo` ambos `online`, `restart_time` batendo exatamente com os 2 restarts desta task.

- [ ] **Step 9: Confirmar em produção real**

```bash
ssh transmonseg-vps "sudo -u postgres psql -d transmonseg -c \"select id, motivo, contexto->'calibracao' from alertas where tipo='desvio' and status='ativo' and contexto->'calibracao' is not null order by desde desc limit 8;\""
```

Expected: alertas `classe_viaria` mostrando `taxa_falso_positivo` alto (~0.66), alertas `afastando_de_tudo` mostrando um número bem menor. Se algum estiver com `-1`, confirme que é esperado (segmento com pouca amostra ainda) e não um bug de gravação.
