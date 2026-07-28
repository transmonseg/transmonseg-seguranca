# Auto-resolução retroativa de "afastando de destinos" quando rota concluída + chegou na base — Plano

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development pra rodar este plano tarefa por tarefa.

**Goal:** Reduzir o padrão "voltando pra base depois de terminar a rota" (achado real: ~15 dos 91 casos de "afastando de destinos" revisados em 27/07) sem reabrir o risco que a decisão de 21/07 evitou (mascarar uma entrega forçada sob coação).

**Architecture:** Mesmo padrão retroativo já usado pra "rua estranha" hoje (alerta dispara igual, auto-fecha DEPOIS se confirmar padrão seguro) -- mas com um critério de segurança mais forte, escolhido especificamente pra não reabrir o risco de coação: só auto-resolve quando o veículo **chega fisicamente dentro do polígono de uma base mapeada** (`baseOcupada`, já calculado no motor), não só "rota concluída" sozinho (que um cenário de coação também produziria).

**Tech Stack:** `src/app/api/motor/route.ts`, `src/lib/detectores.ts`, Postgres/pg direto (mesmo pool do fix de rua estranha), Vitest.

**Decisão já tomada com o usuário:** auto-resolver (não só anotar, não suprimir na hora) -- escolhido entre 3 opções, mesma lógica de trade-off da rua estranha (mantém velocidade de detecção, só limpa depois).

**Por que "chegou na base" e não só "rota concluída":** `rota_concluida` sozinho (todas as entregas marcadas feitas) é exatamente o sinal que um cenário de coação também produziria -- motorista forçado a confirmar entregas falsamente, depois desviado/sequestrado. Auto-resolver só nisso reabriria o risco que a decisão de 21/07 evitou. Exigir que o veículo tenha fisicamente ENTRADO no polígono de uma base cadastrada (`baseOcupada` -- ver `pontoEmGeo(pos.lng, pos.lat, b.geom)`, já calculado todo ciclo) é um sinal muito mais forte: um sequestro terminando dentro de uma base real da empresa seria autodestrutivo pro atacante. Sem janela de tempo (diferente da rua estranha, que usa 5min) -- "afastando de tudo" pode legitimamente levar bem mais tempo pra voltar fisicamente até a base, então o check roda enquanto o alerta continuar `ativo`, sem prazo.

---

### Task 1: Nova função pura de elegibilidade + testes

**Arquivos:**
- Modificar: `src/lib/detectores.ts` (perto de `deveAutoResolverRuaEstranha`, `contaComoRotuloHumano`, `MOTIVO_RUA_ESTRANHA`)
- Test: `src/lib/detectores.test.ts`

**Step 1: Escrever os testes que falham primeiro**

```ts
describe("deveAutoResolverAfastandoRotaConcluida", () => {
  it("resolve quando rota concluida E chegou na base", () => {
    expect(deveAutoResolverAfastandoRotaConcluida({ rotaConcluida: true, baseOcupada: true })).toBe(true);
  });
  it("NAO resolve se rota nao concluida (mesmo na base)", () => {
    expect(deveAutoResolverAfastandoRotaConcluida({ rotaConcluida: false, baseOcupada: true })).toBe(false);
  });
  it("NAO resolve se ainda nao chegou na base (mesmo com rota concluida) -- protege contra mascarar coacao", () => {
    expect(deveAutoResolverAfastandoRotaConcluida({ rotaConcluida: true, baseOcupada: false })).toBe(false);
  });
});

describe("elegivelParaAutoResolveAfastando (wiring)", () => {
  it("exige tipo desvio, motivo 'Afastando-se de todos', status ativo", () => {
    const base = { tipo: "desvio", motivo: "Afastando-se de todos os 5 destinos há 3 leituras seguidas (~3min), +1,0km acumulado", status: "ativo" };
    expect(elegivelParaAutoResolveAfastando(base)).toBe(true);
    expect(elegivelParaAutoResolveAfastando({ ...base, status: "reconhecido" })).toBe(false);
    expect(elegivelParaAutoResolveAfastando({ ...base, tipo: "parada_fora_tapete" })).toBe(false);
    expect(elegivelParaAutoResolveAfastando({ ...base, motivo: "Direção do movimento diverge da rota esperada" })).toBe(false);
  });
});
```

Rodar: `npm test -- --run detectores.test.ts`
Esperado: FAIL

**Step 2: Implementar**

```ts
// Auto-resolucao retroativa de "afastando de todos os destinos" quando a
// rota foi 100% concluida (achado real 27/07, revisao de 215 alertas: ~15
// dos 91 casos eram esse padrao -- voltando pra base depois de terminar).
// NAO usa so "rota concluida" (entregas_feitas>=entregas_total) -- esse
// sinal sozinho e' EXATAMENTE o que um cenario de entrega forcada sob
// coacao tambem produziria (motorista forcado a confirmar falsamente,
// depois desviado). Por isso exige TAMBEM baseOcupada=true (veiculo
// fisicamente DENTRO do poligono de uma base cadastrada, ja calculado
// todo ciclo em route.ts) -- sinal muito mais forte, um sequestro
// terminando dentro de uma base real seria autodestrutivo pro atacante.
// Decisao de 21/07 (docs/superpowers/specs/2026-07-21-anotacao-rota-
// concluida-desvio-design.md) evitava suprimir so por rota_concluida por
// esse motivo exato -- este design respeita a mesma preocupacao.
export function deveAutoResolverAfastandoRotaConcluida(ctx: {
  rotaConcluida: boolean;
  baseOcupada: boolean;
}): boolean {
  return ctx.rotaConcluida && ctx.baseOcupada;
}

export const MOTIVO_AFASTANDO_PREFIXO = "Afastando-se de todos";

export function elegivelParaAutoResolveAfastando(alerta: { tipo: string; motivo: string; status: string }): boolean {
  return alerta.status === "ativo" && alerta.tipo === "desvio" && alerta.motivo.startsWith(MOTIVO_AFASTANDO_PREFIXO);
}
```

**Step 3: Rodar e confirmar que passam**

Rodar: `npm test -- --run detectores.test.ts`
Esperado: PASS

**Step 4: Commit**

```bash
git add src/lib/detectores.ts src/lib/detectores.test.ts
git commit -m "feat(desvio): funcoes puras p/ auto-resolucao de afastando-de-destinos quando rota concluida + chegou na base"
```

---

### Task 2: Wiring no motor

**Arquivos:**
- Modificar: `src/app/api/motor/route.ts`

**Contexto necessário (ler antes de implementar):**
- `baseOcupada` já é computado por veículo por ciclo (`route.ts`, busca por `basesCliente.find((b) => pontoEmGeo(...))`) -- reusar a mesma variável já em escopo, não recalcular.
- `rotaConcluidaCiclo` já existe (anotação retroativa) -- a condição que ele usa (`entregas_total > 0 && entregas_feitas >= entregas_total`) é exatamente o `rotaConcluida` que este novo check precisa. Reusar a MESMA condição, não duplicar lógica solta.
- Seguir EXATAMENTE o mesmo padrão já estabelecido pro auto-resolve de rua estranha hoje (acumulador por ciclo, flush em lote com `pg` direto fazendo merge de contexto via `contexto = coalesce(contexto,'{}'::jsonb) || $2::jsonb`, `.eq("status","ativo")` como guarda de corrida, `contexto: {auto_resolvido: true, motivo: "..."}` mesclado sem apagar o resto, SEM chamar `registrarCasosDesvioRevisao` -- mesmo motivo (não poluir calibração com veredito de máquina), NÃO esquecer de excluir do `mapaTiposSilenciados` (reusar `contaComoEventoDeSilenciamento`, já genérico) e do filtro de `recalibrar-desvio/route.ts` (já usa `contaComoRotuloHumano`, que já cobre `auto_resolvido` -- não precisa de mudança lá, o predicado já é genérico o bastante).

**Step 1: Declarar o acumulador**

Perto de `ruaEstranhaAutoResolveCiclo`:
```ts
const afastandoRotaConcluidaAutoResolveCiclo: { alerta_id: string }[] = [];
```

**Step 2: Check por veículo**

Perto do bloco de `rotaConcluidaCiclo` (reusar a mesma condição `entregas_total > 0 && entregas_feitas >= entregas_total` já calculada ali):
```ts
          if (entregas_total > 0 && entregas_feitas >= entregas_total && baseOcupada) {
            for (const a of alertasAbertos.filter(elegivelParaAutoResolveAfastando)) {
              if (deveAutoResolverAfastandoRotaConcluida({ rotaConcluida: true, baseOcupada: true })) {
                afastandoRotaConcluidaAutoResolveCiclo.push({ alerta_id: a.id });
              }
            }
          }
```
(Nota: como o `if` externo já garante `rotaConcluida=true` e `baseOcupada=true`, a chamada de `deveAutoResolverAfastandoRotaConcluida` aqui é redundante em termos de resultado -- mas mantém a decisão centralizada na função pura testada, não duplicada como condição solta. Manter assim.)

**Step 3: Flush em lote** (mesmo padrão exato do flush de rua estranha -- dedupe por `alerta_id`, `pg` direto, merge de contexto, guarda de status)

```ts
    if (afastandoRotaConcluidaAutoResolveCiclo.length > 0) {
      const porAlertaAfastando = new Map(afastandoRotaConcluidaAutoResolveCiclo.map((r) => [r.alerta_id, r]));
      const idsAfastando = [...porAlertaAfastando.keys()];
      try {
        await pool.query(
          `UPDATE alertas
           SET status = 'falso_positivo',
               resolvido_em = $3,
               contexto = coalesce(contexto, '{}'::jsonb) || $2::jsonb
           WHERE id = ANY($1::uuid[]) AND status = 'ativo'`,
          [idsAfastando, JSON.stringify({ auto_resolvido: true, motivo: "rota concluida e chegou na base" }), agora.toISOString()]
        );
      } catch (err) {
        console.warn(`Aviso: erro ao auto-resolver afastando-de-destinos (rota concluida): ${String(err)}`);
      }
    }
```

**Step 4: Importar as duas novas funções** de `@/lib/detectores` no topo do arquivo.

**Step 5: Rodar suite inteira, tsc, build**

```bash
npm test -- --run
npx tsc --noEmit
npm run build
```

**Step 6: Commit**

```bash
git add src/app/api/motor/route.ts
git commit -m "feat(desvio): auto-resolve retroativo de afastando-de-destinos quando rota concluida + chegou na base"
```

Replicar pro repo definitivo, deploy manual nos dois processos PM2 do Contabo.

---

### Nota de segurança pra quem revisar (ler antes de aprovar)

Este é o mesmo tipo de mudança que precisou de 4 rodadas de revisão hoje mais cedo (rua estranha) -- checar especificamente:
1. `baseOcupada` é recalculado a cada ciclo (não cacheado/stale de um ciclo anterior)?
2. O check exige AMBOS sinais (rota concluída E dentro da base), nunca só um?
3. Mesmos 2 bloqueadores da rua estranha não se repetem aqui: reusar `falso_positivo` sem checar o efeito de silenciamento de 2h (já devia estar coberto por `contaComoEventoDeSilenciamento` ser genérico, mas CONFIRMAR, não assumir); auto-resolver um alerta que o operador já reconheceu (`.eq("status","ativo")` cobre, CONFIRMAR o guard está de fato presente).
4. `basesCliente` vazio/query de bases falhando -- `baseOcupada` deveria ficar `false` nesse caso (fail-safe, nunca auto-resolve), CONFIRMAR isso é realmente o comportamento, não assumir.
