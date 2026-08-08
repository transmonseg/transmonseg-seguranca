# Anotação do placar de desvio sombra no card do alerta — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** anotar, no `contexto` do alerta, o placar de desvio sombra
(`placarNovo`/`componentesPlacar`) já calculado todo ciclo por veículo em
`route.ts`, e exibir no card do alerta no frontend — pura informação, mesmo
padrão já em produção de `progresso_destino` (spec de 06/08).

**Architecture:** coleta por ciclo (array em memória) → flush em lote
aditivo no `contexto` JSONB (`contexto = contexto || $2::jsonb`) → leitura
no `enriquecer()`/rota de polling → render condicional no card. Zero
mudança em `nivel`/`status`/disparo/fechamento de qualquer alerta.

**Tech Stack:** Next.js/TypeScript, Postgres via `pg` (`pool.query`) e
Supabase client, Vitest.

## Global Constraints

- Só anota alertas cujo `motivo` bate com `MOTIVO_AFASTANDO_PREFIXO` ou
  `MOTIVO_RUA_ESTRANHA` (as únicas 2 constantes de motivo exportadas hoje
  para os 3 detectores que o placar cobre — `rumo_diverge` fica de fora,
  hoje desligado, sem constante própria).
- Nunca muda `nivel`, `status`, dispara ou fecha alerta — só leitura/anotação.
- Texto de exibição nunca usa "resolvido"/"seguro"/cor verde — número e
  sinais neutros, decisão fica com o operador.
- Toda mudança de código replicada pro repo espelho `MONITORAMENTO
  transmonseg` e deployada nos 2 processos PM2
  (`transmonseg-temp`/`transmonseg-definitivo`) antes de considerar o plano
  encerrado.
- Spec completa: `docs/superpowers/specs/2026-08-07-placar-sombra-anotacao-design.md`.

---

### Task 1: Coleta e flush do placar_sombra no motor

**Files:**
- Modify: `src/lib/detectores.ts` (nova função `elegivelParaAnotarPlacarSombra`, logo depois de `elegivelParaAutoResolveAfastando`, linha ~1067)
- Test: `src/lib/detectores.test.ts`
- Modify: `src/app/api/motor/route.ts` (declaração do array ~linha 951, bloco de coleta ~linha 3422, flush ~linha 4462)

**Interfaces:**
- Consumes: `MOTIVO_AFASTANDO_PREFIXO`, `MOTIVO_RUA_ESTRANHA` (já exportadas em `detectores.ts`); `placarNovo`/`componentesPlacar` (já calculados em `route.ts:3339-3343`); `alertasAbertos` (lista de alertas abertos do veículo no ciclo, já usada pelo bloco de `progressoDestinoCiclo`).
- Produces: `elegivelParaAnotarPlacarSombra(alerta): boolean` (consumida pela Task 2 não é necessária, só por este task); campo `contexto.placar_sombra: { placar: number, componentes: Record<string, number|boolean|string>, atualizado_em: string }` persistido no banco — consumido pela Task 2.

- [ ] **Step 1: Escrever os testes de `elegivelParaAnotarPlacarSombra`**

Em `src/lib/detectores.test.ts`, adicionar (mesmo estilo do describe de `elegivelParaAutoResolveAfastando`, que já existe no arquivo):

```typescript
describe("elegivelParaAnotarPlacarSombra (anotação do placar sombra no card)", () => {
  const base = { tipo: "desvio", motivo: "Afastando-se de todos os 3 destinos", status: "ativo" };

  it("motivo afastando_de_tudo, ativo, tipo desvio: elegivel", () => {
    expect(elegivelParaAnotarPlacarSombra(base)).toBe(true);
  });

  it("motivo rua estranha exato, ativo, tipo desvio: elegivel", () => {
    expect(elegivelParaAnotarPlacarSombra({ ...base, motivo: MOTIVO_RUA_ESTRANHA })).toBe(true);
  });

  it("motivo de corredor (fora da rota esperada): nao elegivel", () => {
    expect(elegivelParaAnotarPlacarSombra({ ...base, motivo: "Fora da rota esperada (500m da estrada real até o próximo ponto, buffer 120m)" })).toBe(false);
  });

  it("status resolvido: nao elegivel mesmo com motivo certo", () => {
    expect(elegivelParaAnotarPlacarSombra({ ...base, status: "falso_positivo" })).toBe(false);
  });

  it("tipo diferente de desvio: nao elegivel mesmo com motivo certo", () => {
    expect(elegivelParaAnotarPlacarSombra({ ...base, tipo: "parada_fora_tapete" })).toBe(false);
  });
});
```

Adicionar `elegivelParaAnotarPlacarSombra` e `MOTIVO_RUA_ESTRANHA` ao bloco de import do topo do arquivo (mesmo import de `elegivelParaAutoResolveAfastando`).

- [ ] **Step 2: Rodar e confirmar que falha**

Run: `npx vitest run src/lib/detectores.test.ts -t "elegivelParaAnotarPlacarSombra"`
Expected: FAIL — `elegivelParaAnotarPlacarSombra is not a function` (ou erro de import).

- [ ] **Step 3: Implementar `elegivelParaAnotarPlacarSombra` em `detectores.ts`**

Logo depois de `elegivelParaAutoResolveAfastando` (linha 1067 atual):

```typescript
// Elegibilidade pra anotacao do placar de desvio sombra no contexto do
// alerta (ver docs/superpowers/specs/2026-08-07-placar-sombra-anotacao-design.md).
// So os 2 motivos hoje ativos que o placar cobre -- rumo_diverge (3o
// detector que o placar tambem pontua) fica de fora: esta desligado hoje
// (DESVIO_SO_AFASTANDO_OU_FORA_DO_TAPETE) e nao tem constante de motivo
// propria exportada pra identifica-lo com seguranca.
export function elegivelParaAnotarPlacarSombra(alerta: { tipo: string; motivo: string; status: string }): boolean {
  return (
    alerta.status === "ativo" &&
    alerta.tipo === "desvio" &&
    (alerta.motivo.startsWith(MOTIVO_AFASTANDO_PREFIXO) || alerta.motivo === MOTIVO_RUA_ESTRANHA)
  );
}
```

- [ ] **Step 4: Rodar e confirmar que passa**

Run: `npx vitest run src/lib/detectores.test.ts -t "elegivelParaAnotarPlacarSombra"`
Expected: PASS, 5/5.

- [ ] **Step 5: Declarar o array de coleta em `route.ts`**

Logo depois da declaração de `progressoDestinoCiclo` (linha 951 atual):

```typescript
    // Anotação do placar de desvio sombra em alertas afastando_de_tudo/
    // classe_viaria ativos -- ver
    // docs/superpowers/specs/2026-08-07-placar-sombra-anotacao-design.md.
    // Mesmo padrão de progressoDestinoCiclo/proximidadeDesvioCiclo: acumula
    // por ciclo, flush em lote no final, so ADICIONA campo no contexto
    // (jsonb ||), nunca muda nivel/status, nunca fecha o alerta.
    const placarSombraCiclo: { alerta_id: string; placar: number; componentes: Record<string, number | boolean | string> }[] = [];
```

- [ ] **Step 6: Coletar no loop por veículo, logo depois de `placarDesvioSombraContexto`**

Em `route.ts`, logo depois da linha `const placarDesvioSombraContexto = { placar: placarNovo, componentes: componentesPlacar };` (linha 3422 atual):

```typescript
          // Anota o placar deste ciclo nos alertas abertos elegiveis deste
          // veiculo -- mesmo padrao de progressoDestinoCiclo (ver linha
          // ~3597 abaixo). Sem guard de saltoImplausivel/pos.fresco aqui: o
          // placar ja tem seus proprios guards internos (Guard 7,
          // podeSomarSinaisPlacar) -- reflete o valor real que o placar
          // calculou pra este ciclo, sem duplicar logica de confiabilidade.
          for (const d of alertasAbertos.filter((a) => elegivelParaAnotarPlacarSombra(a))) {
            placarSombraCiclo.push({ alerta_id: d.id, placar: placarNovo, componentes: componentesPlacar });
          }
```

- [ ] **Step 7: Flush em lote, logo depois do flush de `progressoDestinoCiclo`**

Em `route.ts`, logo depois do bloco `if (progressoDestinoCiclo.length > 0) { ... }` (termina na linha 4462 atual):

```typescript
    // Flush do placar sombra -- mesmo padrao de flush em lote + dedupe por
    // alerta_id, mesmo padrao aditivo (contexto || jsonb, nunca muda
    // nivel/status/fecha alerta) que progressoDestinoCiclo acima.
    if (placarSombraCiclo.length > 0) {
      const porAlertaPlacar = new Map(placarSombraCiclo.map((p) => [p.alerta_id, p]));
      const resultadosPlacar = await Promise.allSettled(
        [...porAlertaPlacar.values()].map((p) =>
          pool.query(
            `update alertas set contexto = contexto || $2::jsonb where id = $1`,
            [
              p.alerta_id,
              JSON.stringify({
                placar_sombra: {
                  placar: Math.round(p.placar),
                  componentes: p.componentes,
                  atualizado_em: new Date().toISOString(),
                },
              }),
            ]
          )
        )
      );
      const falhasPlacar = resultadosPlacar.filter((r) => r.status === "rejected").length;
      if (falhasPlacar > 0) console.warn(`Aviso: ${falhasPlacar} falha(s) ao anotar placar sombra neste ciclo`);
    }
```

- [ ] **Step 8: Typecheck e suite completa**

Run: `npx tsc --noEmit && npx vitest run`
Expected: typecheck limpo, todos os testes passando (nenhum teste existente deveria mudar de resultado).

- [ ] **Step 9: Commit**

```bash
git add src/lib/detectores.ts src/lib/detectores.test.ts src/app/api/motor/route.ts
git commit -m "feat(desvio): anotar placar de desvio sombra em alertas afastando_de_tudo/classe_viaria"
```

---

### Task 2: Exibição no card (formatarPlacarSombra + wiring)

**Files:**
- Modify: `src/lib/detectores.ts` (`LABEL_COMPONENTE_PLACAR`, `formatarPlacarSombra`, logo depois de `formatarProgressoDestino`)
- Test: `src/lib/detectores.test.ts`
- Modify: `src/app/(app)/page.tsx` (interface `Alerta`, `enriquecer()`)
- Modify: `src/app/(app)/central-v2/MonitorV2.tsx` (interface `AlertaEnriquecido`, render, import)
- Modify: `src/app/api/alertas/route.ts` (tipo do parâmetro do map, campo `placarSombra` no objeto retornado)

**Interfaces:**
- Consumes: `contexto.placar_sombra` gravado pela Task 1 (`{ placar: number, componentes: Record<string, number|boolean|string>, atualizado_em: string }`).
- Produces: `formatarPlacarSombra(placar: number, componentes: Record<string, unknown>): string` — usada só pelo componente de render (não por nenhum outro task).

- [ ] **Step 1: Escrever os testes de `formatarPlacarSombra`**

Em `src/lib/detectores.test.ts`:

```typescript
describe("formatarPlacarSombra (texto do placar sombra no card)", () => {
  it("nenhum componente ativo: so o numero, sem sufixo", () => {
    expect(formatarPlacarSombra(0, {})).toBe("Placar sombra: 0/100");
  });

  it("1 componente ativo: numero + 1 sinal", () => {
    expect(formatarPlacarSombra(8, { s1AfastandoDeTudo: 8 })).toBe("Placar sombra: 8/100 — sinais: afastando de tudo");
  });

  it("multiplos componentes ativos: todos listados na ordem das chaves", () => {
    expect(formatarPlacarSombra(2, { s5DiaEstagnado: 2, s2RumoDivergente: 6, d1ParadaPertoDeEntrega: -15, d3DestinoAlinhadoAproximando: -10 }))
      .toBe("Placar sombra: 2/100 — sinais: dia estagnado, rumo divergente, parado perto de entrega, destino alinhado e aproximando");
  });

  it("componente boolean false: excluido da lista", () => {
    expect(formatarPlacarSombra(0, { classeViariaSuprimida: false })).toBe("Placar sombra: 0/100");
  });

  it("chave de auditoria desconhecida (zeradoPorChegada): excluida por nao estar no mapa de labels", () => {
    expect(formatarPlacarSombra(0, { zeradoPorChegada: true })).toBe("Placar sombra: 0/100");
  });

  it("placar fracionario: arredondado no texto", () => {
    expect(formatarPlacarSombra(17.4, {})).toBe("Placar sombra: 17/100");
  });
});
```

- [ ] **Step 2: Rodar e confirmar que falha**

Run: `npx vitest run src/lib/detectores.test.ts -t "formatarPlacarSombra"`
Expected: FAIL — `formatarPlacarSombra is not a function`.

- [ ] **Step 3: Implementar em `detectores.ts`, logo depois de `formatarProgressoDestino`**

```typescript
const LABEL_COMPONENTE_PLACAR: Record<string, string> = {
  s1AfastandoDeTudo: "afastando de tudo",
  s2RumoDivergente: "rumo divergente",
  s3ForaDoCorredor: "fora do corredor",
  s4CelulaDesconhecida: "célula desconhecida",
  s5DiaEstagnado: "dia estagnado",
  s6ParadoLongeDeTudo: "parado longe de tudo",
  d1ParadaPertoDeEntrega: "parado perto de entrega",
  d2PadraoEntrega: "padrão de entrega",
  d3DestinoAlinhadoAproximando: "destino alinhado e aproximando",
  d4DentroDoCorredor: "dentro do corredor",
};

// Texto do placar de desvio sombra pro card do alerta -- ver
// docs/superpowers/specs/2026-08-07-placar-sombra-anotacao-design.md. So
// informacao (nunca "resolvido"/"seguro", nunca cor verde no chamador) --
// numero e sinais, quem decide e o operador. Chaves de auditoria que nao
// sao pesos reais de score (classeViariaSuprimida, classeViariaSuprimidaPor,
// zeradoPorChegada) ficam de fora por nao estarem em LABEL_COMPONENTE_PLACAR
// -- sem precisar de lista de exclusao separada.
export function formatarPlacarSombra(placar: number, componentes: Record<string, unknown>): string {
  const ativos = Object.keys(componentes)
    .filter((k) => LABEL_COMPONENTE_PLACAR[k] && componentes[k] !== false)
    .map((k) => LABEL_COMPONENTE_PLACAR[k]);
  const sufixo = ativos.length > 0 ? ` — sinais: ${ativos.join(", ")}` : "";
  return `Placar sombra: ${Math.round(placar)}/100${sufixo}`;
}
```

- [ ] **Step 4: Rodar e confirmar que passa**

Run: `npx vitest run src/lib/detectores.test.ts -t "formatarPlacarSombra"`
Expected: PASS, 6/6.

- [ ] **Step 5: Typecheck e suite completa**

Run: `npx tsc --noEmit && npx vitest run`
Expected: limpo.

- [ ] **Step 6: Wiring em `page.tsx`**

Linha 9, adicionar `placar_sombra` ao tipo do campo `contexto` da interface `Alerta`:

```typescript
interface Alerta { id: string; cliente_id: string; veiculo_id: string; nivel: "critico" | "atencao"; tipo: string; motivo: string | null; desde: string; status: string; score: number | null; lat: number | null; lng: number | null; contexto: { rota_concluida?: unknown; progresso_destino?: { delta_m: number }; placar_sombra?: { placar: number; componentes: Record<string, number | boolean | string> } } | null; }
```

Linha 64 (logo depois de `progressoDestinoM`), dentro de `enriquecer()`:

```typescript
      placarSombra: (a.contexto as { placar_sombra?: { placar: number; componentes: Record<string, number | boolean | string> } } | null)?.placar_sombra ?? null,
```

- [ ] **Step 7: Wiring em `api/alertas/route.ts`**

Linha 95, adicionar `placar_sombra` ao tipo do parâmetro do map (mesmo padrão de `progresso_destino`):

```typescript
      contexto: { rota_concluida?: unknown; progresso_destino?: { delta_m: number }; placar_sombra?: { placar: number; componentes: Record<string, number | boolean | string> } } | null;
```

Linha 132 (logo depois de `progressoDestinoM`), dentro do objeto retornado:

```typescript
        placarSombra: a.contexto?.placar_sombra ?? null,
```

- [ ] **Step 8: Wiring em `MonitorV2.tsx`**

Linha 9, atualizar o import:

```typescript
import { formatarProgressoDestino, formatarPlacarSombra } from "@/lib/detectores";
```

Linha 39 (logo depois de `progressoDestinoM: number | null;` na interface `AlertaEnriquecido`):

```typescript
  placarSombra: { placar: number; componentes: Record<string, number | boolean | string> } | null;
```

Linha 1317 (logo depois do bloco de render de `progressoDestinoM`, que termina em `})()}`):

```typescript
          {a.placarSombra != null && (
            <p style={{
              margin: "0 0 2px", fontSize: 10, color: T.dim,
            }}>
              {formatarPlacarSombra(a.placarSombra.placar, a.placarSombra.componentes)}
            </p>
          )}
```

- [ ] **Step 9: Rodar dev server e validar visualmente**

Run: `npm run dev` (background), abrir `/central-v2` no navegador, confirmar que carrega sem erro de console e sem regressão nos cards existentes (não é necessário ter um alerta real com `placar_sombra` populado agora — isso só existirá depois do deploy da Task 1 em produção; o importante aqui é confirmar que a ausência do campo não quebra nada, `a.placarSombra != null` protege isso).

- [ ] **Step 10: Typecheck e suite completa**

Run: `npx tsc --noEmit && npx vitest run`
Expected: limpo.

- [ ] **Step 11: Commit**

```bash
git add src/lib/detectores.ts src/lib/detectores.test.ts "src/app/(app)/page.tsx" "src/app/(app)/central-v2/MonitorV2.tsx" src/app/api/alertas/route.ts
git commit -m "feat(desvio): exibir placar de desvio sombra no card do alerta"
```

---

### Task 3: Replicar pro repo espelho + deploy no Contabo

**Files:**
- Nenhum arquivo novo — cópia exata dos diffs das Tasks 1/2 pro repo `MONITORAMENTO transmonseg`.

**Interfaces:**
- Consumes: commits das Tasks 1/2 (repo `MONITORAMENTO TEMP`).
- Produces: mesma mudança de código rodando em produção real (PM2 `transmonseg-temp`/`transmonseg-definitivo` no Contabo) — encerra o plano.

- [ ] **Step 1: Confirmar que os repos não divergiram antes desta mudança**

```bash
cd ~/Projects/Transmonseg/monitoramento
diff "MONITORAMENTO TEMP/src/lib/detectores.ts" "MONITORAMENTO transmonseg/src/lib/detectores.ts"
diff "MONITORAMENTO TEMP/src/app/api/motor/route.ts" "MONITORAMENTO transmonseg/src/app/api/motor/route.ts"
diff "MONITORAMENTO TEMP/src/app/(app)/page.tsx" "MONITORAMENTO transmonseg/src/app/(app)/page.tsx"
diff "MONITORAMENTO TEMP/src/app/(app)/central-v2/MonitorV2.tsx" "MONITORAMENTO transmonseg/src/app/(app)/central-v2/MonitorV2.tsx"
diff "MONITORAMENTO TEMP/src/app/api/alertas/route.ts" "MONITORAMENTO transmonseg/src/app/api/alertas/route.ts"
```

Se algum diff não estiver vazio (fora as mudanças das Tasks 1/2 que acabaram de ser feitas só no TEMP), pare e reporte — não prossiga adivinhando qual versão é a certa.

- [ ] **Step 2: Copiar os 6 arquivos tocados**

```bash
cp "MONITORAMENTO TEMP/src/lib/detectores.ts" "MONITORAMENTO transmonseg/src/lib/detectores.ts"
cp "MONITORAMENTO TEMP/src/lib/detectores.test.ts" "MONITORAMENTO transmonseg/src/lib/detectores.test.ts"
cp "MONITORAMENTO TEMP/src/app/api/motor/route.ts" "MONITORAMENTO transmonseg/src/app/api/motor/route.ts"
cp "MONITORAMENTO TEMP/src/app/(app)/page.tsx" "MONITORAMENTO transmonseg/src/app/(app)/page.tsx"
cp "MONITORAMENTO TEMP/src/app/(app)/central-v2/MonitorV2.tsx" "MONITORAMENTO transmonseg/src/app/(app)/central-v2/MonitorV2.tsx"
cp "MONITORAMENTO TEMP/src/app/api/alertas/route.ts" "MONITORAMENTO transmonseg/src/app/api/alertas/route.ts"
cp "MONITORAMENTO TEMP/docs/superpowers/specs/2026-08-07-placar-sombra-anotacao-design.md" "MONITORAMENTO transmonseg/docs/superpowers/specs/"
cp "MONITORAMENTO TEMP/docs/superpowers/plans/2026-08-07-placar-sombra-anotacao.md" "MONITORAMENTO transmonseg/docs/superpowers/plans/"
```

- [ ] **Step 3: Testes e typecheck no repo espelho**

```bash
cd "MONITORAMENTO transmonseg"
npx tsc --noEmit
npx vitest run
```

Expected: mesmo resultado limpo das Tasks 1/2.

- [ ] **Step 4: Commit no repo espelho**

```bash
git add -A
git commit -m "feat(desvio): anotar e exibir placar de desvio sombra no card do alerta (replica de MONITORAMENTO TEMP)"
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

Expected: build sem erro, `pm2 list` mostra `transmonseg-temp` `online` com PID novo.

- [ ] **Step 7: Deploy manual no Contabo — `transmonseg-definitivo`**

```bash
ssh transmonseg-vps "cd /srv/transmonseg/definitivo && git pull && npm ci && npm run build && pm2 restart transmonseg-definitivo --update-env"
```

Expected: build sem erro, `pm2 list` mostra `transmonseg-definitivo` `online` com PID novo.

- [ ] **Step 8: Confirmar não regressão**

```bash
ssh transmonseg-vps "pm2 jlist | node -e 'let d=\"\"; process.stdin.on(\"data\",c=>d+=c); process.stdin.on(\"end\",()=>{JSON.parse(d).forEach(p=>console.log(p.name, p.pid, p.pm2_env.status, p.pm2_env.restart_time))})'"
```

Expected: `transmonseg-temp`/`transmonseg-definitivo` ambos `online`, `restart_time` batendo exatamente com os 2 restarts desta task (sem crash loop).

- [ ] **Step 9: Confirmar em produção real que a anotação está rodando**

```bash
ssh transmonseg-vps "sudo -u postgres psql -d transmonseg -c \"select id, motivo, contexto->'placar_sombra' from alertas where tipo='desvio' and status='ativo' and (motivo ilike 'Afastando-se de todos%' or motivo = 'Saiu de via principal recentemente e está em rua estreita, fora do raio de qualquer destino conhecido') order by desde desc limit 5;\""
```

Expected: se houver algum alerta ativo de um dos 2 tipos cobertos, `placar_sombra` deve aparecer preenchido (pode levar até 1 ciclo do motor, ~30s). Se não houver nenhum alerta ativo desses tipos agora, confirme ao menos que o motor não caiu (`ssh transmonseg-vps "pm2 logs transmonseg-definitivo --lines 30 --nostream"` sem erro novo relacionado a "placar").
