# Auto-resolução retroativa da "rua estranha" (classe viária) — Plano

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development pra rodar este plano tarefa por tarefa.

**Goal:** Reduzir o ~69% de falso positivo da regra "rua estranha" (achado na revisão manual de 215 alertas, 27/07) sem atrasar a detecção — o alerta continua disparando na hora, mas se o veículo parar pouco depois sem estar perto de área de risco mapeada, o próprio sistema fecha sozinho como falso positivo (em vez de ficar esperando revisão manual).

**Architecture:** Novo check retroativo no motor, mesmo padrão já usado pra `rota_concluida` (anotação por ciclo em alertas já ativos) — só que este muda o `status` de verdade, não só anota. Roda todo ciclo (30s), olhando alertas de "rua estranha" ainda `ativo` com menos de 5min de vida.

**Tech Stack:** `src/app/api/motor/route.ts`, Postgres/Supabase client, Vitest.

**Decisão já tomada com o usuário:** usa `falso_positivo` (não um status novo) — o botão "Limpar avisos" discutido mais cedo é um projeto separado, adiado pro fim do dia; não misturar os dois. Marcar como `falso_positivo` (não `resolvido`) é semanticamente correto aqui E alimenta a calibração corretamente (o objetivo do dia inteiro era fazer o segmento "origem:classe_viaria" aprender sua taxa real de falso positivo — isso finalmente dá dado de verdade pra ele).

---

### Task 1: Estender o carregamento de alertas abertos com `desde` e `motivo`

**Arquivos:**
- Modificar: `src/app/api/motor/route.ts:1128-1139`

**Step 1: Adicionar os campos que faltam**

Trocar:
```ts
      const { data: todosAlertasAbertos } = await supabase
        .from("alertas")
        .select("id, tipo, veiculo_id, nivel")
        .eq("cliente_id", cliente.id)
        .in("status", ["ativo", "reconhecido"]);

      const mapaAlertasAbertos = new Map<string, { id: string; tipo: string; nivel: string }[]>();
      for (const ab of todosAlertasAbertos ?? []) {
        const lista = mapaAlertasAbertos.get(ab.veiculo_id) ?? [];
        lista.push({ id: ab.id, tipo: ab.tipo, nivel: ab.nivel });
        mapaAlertasAbertos.set(ab.veiculo_id, lista);
      }
```

por:
```ts
      const { data: todosAlertasAbertos } = await supabase
        .from("alertas")
        .select("id, tipo, veiculo_id, nivel, desde, motivo")
        .eq("cliente_id", cliente.id)
        .in("status", ["ativo", "reconhecido"]);

      const mapaAlertasAbertos = new Map<string, { id: string; tipo: string; nivel: string; desde: string; motivo: string }[]>();
      for (const ab of todosAlertasAbertos ?? []) {
        const lista = mapaAlertasAbertos.get(ab.veiculo_id) ?? [];
        lista.push({ id: ab.id, tipo: ab.tipo, nivel: ab.nivel, desde: ab.desde, motivo: ab.motivo });
        mapaAlertasAbertos.set(ab.veiculo_id, lista);
      }
```

**Step 2: Rodar tsc pra confirmar que nenhum outro uso de `alertasAbertos` quebrou**

Rodar: `npx tsc --noEmit`
Esperado: sem erros (os outros usos só leem `id`/`tipo`/`nivel`, que continuam presentes)

**Step 3: Commit**

```bash
git add src/app/api/motor/route.ts
git commit -m "chore(desvio): carrega desde/motivo junto com alertas abertos (prep p/ auto-resolucao rua estranha)"
```

---

### Task 2: Novo check retroativo — auto-resolver "rua estranha" quando para sem risco por perto

**Arquivos:**
- Modificar: `src/app/api/motor/route.ts` (perto do bloco de `rotaConcluidaCiclo`, ~linha 689 pra declaração + ~linha 2252-2265 pro check por veículo + ~linha 2764 pro flush em lote)
- Test: precisa de um teste de integração ou ao menos uma função pura extraída e testada isoladamente (ver Step 1)

**Constantes (mesmo espírito de todo limiar deste projeto — ajustável com dado real depois):**
```ts
const RUA_ESTRANHA_JANELA_AUTORESOLVE_MIN = 5;
const RUA_ESTRANHA_PARADO_MIN_MIN = 2; // minutos parado pra contar como "parou de verdade", nao blip de semaforo
```

**Step 1: Extrair a decisão numa função pura testável**

Em `src/lib/detectores.ts`, adicionar (perto de `RISCO_AREA_LIMIAR`, que já existe e será reusado):

```ts
// Auto-resolucao retroativa da "rua estranha" (achado real 27/07, revisao
// manual de 215 alertas: ~69% de falso positivo, padrao dominante era
// "chegou e parou pouco depois, sem area de risco por perto" -- exatamente
// o tipo de coisa que so da pra confirmar DEPOIS do alerta ja ter
// disparado). Mantem a deteccao rapida (dispara igual a hoje) e so limpa
// sozinho o que se confirma como falso positivo -- nao atrasa nenhum caso
// real.
export function deveAutoResolverRuaEstranha(ctx: {
  idadeAlertaMin: number;
  paradoMin: number;
  riscoAreaAtual: number;
}): boolean {
  return (
    ctx.idadeAlertaMin <= 5 &&
    ctx.paradoMin >= 2 &&
    ctx.riscoAreaAtual < RISCO_AREA_LIMIAR
  );
}
```

**Step 2: Escrever os testes que falham primeiro**

Em `src/lib/detectores.test.ts`:

```ts
describe("deveAutoResolverRuaEstranha", () => {
  it("resolve quando parou >=2min, sem risco, dentro da janela de 5min", () => {
    expect(deveAutoResolverRuaEstranha({ idadeAlertaMin: 3, paradoMin: 2, riscoAreaAtual: 0 })).toBe(true);
  });
  it("NAO resolve se ainda nao parou o suficiente", () => {
    expect(deveAutoResolverRuaEstranha({ idadeAlertaMin: 3, paradoMin: 1, riscoAreaAtual: 0 })).toBe(false);
  });
  it("NAO resolve se tem area de risco por perto", () => {
    expect(deveAutoResolverRuaEstranha({ idadeAlertaMin: 3, paradoMin: 3, riscoAreaAtual: 40 })).toBe(false);
  });
  it("NAO resolve depois da janela de 5min (deixa pro operador revisar manualmente)", () => {
    expect(deveAutoResolverRuaEstranha({ idadeAlertaMin: 6, paradoMin: 3, riscoAreaAtual: 0 })).toBe(false);
  });
});
```

Rodar: `npm test -- --run detectores.test.ts`
Esperado: FAIL (`deveAutoResolverRuaEstranha is not a function`)

**Step 3: Implementar (código do Step 1) e confirmar que os 4 testes passam**

Rodar: `npm test -- --run detectores.test.ts`
Esperado: PASS

**Step 4: Declarar o acumulador do ciclo**

Em `src/app/api/motor/route.ts`, perto de `rotaConcluidaCiclo` (linha ~689):

```ts
    const ruaEstranhaAutoResolveCiclo: { alerta_id: string }[] = [];
```

**Step 5: Adicionar o check por veículo**

Perto do bloco de `rotaConcluidaCiclo` (linha ~2252-2265), adicionar:

```ts
          // Auto-resolucao retroativa da "rua estranha" -- ver
          // deveAutoResolverRuaEstranha em detectores.ts pro raciocinio
          // completo. So roda quando o veiculo esta FRESCO e parado agora
          // (paradoMin so faz sentido com velocidade===0).
          if (pos.fresco && pos.velocidade === 0) {
            const MOTIVO_RUA_ESTRANHA = "Saiu de via principal recentemente e está em rua estreita, fora do raio de qualquer destino conhecido";
            for (const a of alertasAbertos.filter((a) => a.tipo === "desvio" && a.motivo === MOTIVO_RUA_ESTRANHA)) {
              const idadeAlertaMin = (agora.getTime() - new Date(a.desde).getTime()) / 60_000;
              if (deveAutoResolverRuaEstranha({ idadeAlertaMin, paradoMin, riscoAreaAtual })) {
                ruaEstranhaAutoResolveCiclo.push({ alerta_id: a.id });
              }
            }
          }
```

Importar `deveAutoResolverRuaEstranha` de `@/lib/detectores` no topo do arquivo (junto do import existente).

**Step 6: Flush em lote no fim do ciclo**

Perto do flush de `rotaConcluidaCiclo` (linha ~2764), adicionar um bloco irmão:

```ts
    // Flush da auto-resolucao de "rua estranha" -- marca falso_positivo
    // (nao "resolvido": e o rotulo semanticamente correto aqui, e o unico
    // que alimenta calibracao-desvio.ts corretamente como amostra de FP
    // real pro segmento "origem:classe_viaria").
    if (ruaEstranhaAutoResolveCiclo.length > 0) {
      const ids = ruaEstranhaAutoResolveCiclo.map((r) => r.alerta_id);
      await registrarCasosDesvioRevisao(supabase, ids, "falso_positivo");
      const { error: erroAutoResolve } = await supabase
        .from("alertas")
        .update({
          status: "falso_positivo",
          resolvido_em: agora.toISOString(),
          geom: null, lat: null, lng: null,
          contexto: { auto_resolvido: true, motivo: "parou sem area de risco por perto, dentro de 5min" },
        })
        .in("id", ids);
      if (erroAutoResolve) console.warn(`Aviso: erro ao auto-resolver rua estranha: ${erroAutoResolve.message}`);
    }
```

Confirmar que `registrarCasosDesvioRevisao` já está importado no arquivo (deve estar, é usado em `acoes-alertas.ts` — se o motor não importar ainda, importar de `@/lib/casos-desvio-revisao`).

**Step 7: Rodar a suite inteira, tsc, build**

```bash
npm test -- --run
npx tsc --noEmit
npm run build
```
Esperado: todos os testes passando (436+4 novos = 440... na verdade like 444, contar o real depois dos fixes de hoje), sem erro de tipo, build limpo.

**Step 8: Commit**

```bash
git add src/app/api/motor/route.ts src/lib/detectores.ts src/lib/detectores.test.ts
git commit -m "feat(desvio): auto-resolve retroativo da rua estranha quando para sem risco por perto"
```

Lembrar: replicar pro repo `MONITORAMENTO transmonseg` (definitivo) e fazer deploy manual nos dois processos PM2 do Contabo.

---

### Nota pra quem revisar

Ponto de atenção pro revisor independente: confirmar que `registrarCasosDesvioRevisao` funciona chamado assim (fora do fluxo normal de `resolverAlerta`/`marcarFalsoPositivo` em `acoes-alertas.ts`) — ela é `async` e não lança erro (try/catch interno), então deve ser segura de chamar direto do motor, mas vale confirmar que a assinatura bate (`admin: SupabaseClient, ids: string[], statusFinal`) e que o motor já tem um client Supabase compatível com esse tipo à mão (o `supabase` já usado nas outras queries do arquivo).
