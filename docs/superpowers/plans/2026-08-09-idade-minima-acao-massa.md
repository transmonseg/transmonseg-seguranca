# Idade mínima pra ações em massa — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** `resolverVarios`/`limparVarios` (botões "Resolver todos"/"Limpar
avisos") nunca fecham um alerta com menos de 5 minutos de vida sem review
individual — proteção contra o achado real de 08/08 (TTH-3C94, alerta real
fechado 80s depois de nascer por ação em massa).

**Architecture:** guard de idade aplicado nos dois lados. Servidor
(`acoes-alertas.ts`) é a autoridade: busca `desde` dos ids recebidos,
filtra antes de fazer qualquer update, nunca confia no cliente. Cliente
(`MonitorV2.tsx`) replica o mesmo filtro ANTES da remoção otimista da tela,
pra nunca nem piscar um alerta jovem como se tivesse sumido.

**Tech Stack:** Next.js/TypeScript (server actions), Vitest.

## Global Constraints

- Limiar: **5 minutos**, uma única constante exportada de `detectores.ts`
  (`IDADE_MINIMA_ACAO_MASSA_MIN`), importada tanto pelo servidor quanto
  pelo cliente — nunca duplicar o número literal em mais de um lugar.
- Servidor é sempre a autoridade final — o filtro do cliente é só UX
  (evita o flicker), nunca a única barreira.
- Ações INDIVIDUAIS (`resolverAlerta`/`marcarFalsoPositivo`) não mudam —
  essa proteção é só pras duas ações de massa.
- Zero mudança em `nivel`/detecção/disparo de qualquer alerta.
- Toda mudança replicada pro repo espelho `MONITORAMENTO transmonseg` e
  deployada nos 2 processos PM2 antes de considerar o plano encerrado.
- Spec completa: `docs/superpowers/specs/2026-08-09-idade-minima-acao-massa-design.md`.

---

### Task 1: Função pura de elegibilidade + constante

**Files:**
- Modify: `src/lib/detectores.ts` (nova constante `IDADE_MINIMA_ACAO_MASSA_MIN` e função `elegivelParaAcaoMassa`, logo depois de `elegivelParaAnotarPlacarSombra`)
- Test: `src/lib/detectores.test.ts`

**Interfaces:**
- Produces: `IDADE_MINIMA_ACAO_MASSA_MIN: number` (minutos) e
  `elegivelParaAcaoMassa(desde: string, agora: Date): boolean` — usadas
  pela Task 2 (`acoes-alertas.ts`, servidor) e a constante também pela
  Task 3 (`MonitorV2.tsx`, cliente, junto com o `minutosDesde` já
  existente lá).

- [ ] **Step 1: Escrever os testes**

Em `src/lib/detectores.test.ts`:

```typescript
describe("elegivelParaAcaoMassa (guard de idade minima pra acao em massa)", () => {
  const AGORA = new Date("2026-08-09T12:00:00.000Z");

  it("alerta com exatamente 5min de idade: elegivel (limite inclusivo)", () => {
    expect(elegivelParaAcaoMassa("2026-08-09T11:55:00.000Z", AGORA)).toBe(true);
  });

  it("alerta com 4min59s de idade: NAO elegivel (1s antes do limite)", () => {
    expect(elegivelParaAcaoMassa("2026-08-09T11:55:01.000Z", AGORA)).toBe(false);
  });

  it("alerta com 5min01s de idade: elegivel (1s depois do limite)", () => {
    expect(elegivelParaAcaoMassa("2026-08-09T11:54:59.000Z", AGORA)).toBe(true);
  });

  it("alerta recem-criado (idade zero): NAO elegivel", () => {
    expect(elegivelParaAcaoMassa("2026-08-09T12:00:00.000Z", AGORA)).toBe(false);
  });

  it("alerta antigo (varios dias): elegivel", () => {
    expect(elegivelParaAcaoMassa("2026-08-01T12:00:00.000Z", AGORA)).toBe(true);
  });

  it("caso real TTH-3C94 (nasceu as 12:17, acao em massa as 12:18:20 -- 80s depois): NAO elegivel", () => {
    const nascimento = "2026-08-08T15:17:00.000Z";
    const tentativaDeAcao = new Date("2026-08-08T15:18:20.000Z");
    expect(elegivelParaAcaoMassa(nascimento, tentativaDeAcao)).toBe(false);
  });
});
```

- [ ] **Step 2: Rodar e confirmar que falha**

Run: `npx vitest run src/lib/detectores.test.ts -t "elegivelParaAcaoMassa"`
Expected: FAIL — `elegivelParaAcaoMassa is not a function`.

- [ ] **Step 3: Implementar em `detectores.ts`**

```typescript
// Idade minima (minutos) pra um alerta virar elegivel pra acao em massa
// (Resolver todos / Limpar avisos) -- ver
// docs/superpowers/specs/2026-08-09-idade-minima-acao-massa-design.md.
// Achado real 08/08 (caso TTH-3C94): alerta real fechado por "limpar em
// massa" 80s depois de nascer, antes de qualquer revisao humana -- 22
// casos assim nos ultimos 7 dias (todos < 2min), 0 casos assim em acao
// INDIVIDUAL no mesmo periodo. So acoes em massa tem esse risco.
export const IDADE_MINIMA_ACAO_MASSA_MIN = 5;

// Limite INCLUSIVO (exatamente 5min conta como elegivel) -- evita ficar
// preso por causa de arredondamento entre o momento gravado em `desde` e
// o momento do clique real do operador.
export function elegivelParaAcaoMassa(desde: string, agora: Date): boolean {
  const idadeMin = (agora.getTime() - new Date(desde).getTime()) / 60000;
  return idadeMin >= IDADE_MINIMA_ACAO_MASSA_MIN;
}
```

- [ ] **Step 4: Rodar e confirmar que passa**

Run: `npx vitest run src/lib/detectores.test.ts -t "elegivelParaAcaoMassa"`
Expected: PASS, 6/6.

- [ ] **Step 5: Typecheck e suite completa**

Run: `npx tsc --noEmit && npx vitest run`
Expected: limpo.

- [ ] **Step 6: Commit**

```bash
git add src/lib/detectores.ts src/lib/detectores.test.ts
git commit -m "feat(desvio): guard de idade mínima pra elegibilidade de ação em massa"
```

---

### Task 2: Guard no servidor (`acoes-alertas.ts`)

**Files:**
- Modify: `src/app/(app)/acoes-alertas.ts`

**Interfaces:**
- Consumes: `elegivelParaAcaoMassa` da Task 1.
- Produces: `ResultadoAcao` ganha campo opcional `ignoradosRecentes?: number`; `resolverVarios`/`limparVarios` passam a retornar esse campo — consumido pela Task 3.

- [ ] **Step 1: Adicionar o campo ao tipo `ResultadoAcao`**

No topo do arquivo (linha 8 atual):

```typescript
export type ResultadoAcao = { ok?: boolean; erro?: string; ignoradosRecentes?: number };
```

- [ ] **Step 2: Importar `elegivelParaAcaoMassa`**

Logo depois do import de `registrarCasosDesvioRevisao` (linha 6 atual):

```typescript
import { elegivelParaAcaoMassa } from "@/lib/detectores";
```

- [ ] **Step 3: Aplicar o guard em `resolverVarios`**

Substituir a função inteira (linhas 70-97 atuais) por:

```typescript
// Resolve vários alertas de uma vez (botão "Resolver todos" do painel).
export async function resolverVarios(
  ids: string[]
): Promise<ResultadoAcao & { resolvidos?: number }> {
  const opId = await operadorAtual();
  if (!opId) return { erro: "Sessao expirada." };
  if (ids.length === 0) return { ok: true, resolvidos: 0 };
  const admin = createAdminClient();
  // Guard de idade minima (achado real 08/08, caso TTH-3C94): acao em
  // massa nunca fecha alerta recem-nascido sem revisao individual -- ver
  // docs/superpowers/specs/2026-08-09-idade-minima-acao-massa-design.md.
  // Servidor e' a AUTORIDADE (nunca confia no cliente ja ter filtrado) --
  // busca desde de verdade antes de decidir.
  const { data: linhas } = await admin.from("alertas").select("id, desde").in("id", ids);
  const agora = new Date();
  const elegiveis = (linhas ?? []).filter((l) => elegivelParaAcaoMassa(l.desde, agora)).map((l) => l.id);
  const ignoradosRecentes = ids.length - elegiveis.length;
  if (elegiveis.length === 0) return { ok: true, resolvidos: 0, ignoradosRecentes };
  // Achado 01/08: este botao gravava exatamente igual ao "Resolver"
  // individual -- inclusive alimentando casos_desvio_revisao como se fosse
  // veredito caso a caso. Nao era possivel, olhando o dado, saber se um
  // 'resolvido' foi julgamento ou clique pra desentupir a tela. Agora
  // carrega origem_acao='resolver_massa' nos DOIS lugares, e quem le pra
  // medir/calibrar filtra por origem individual.
  await registrarCasosDesvioRevisao(admin, elegiveis, "resolvido", "resolver_massa");
  const { error } = await admin
    .from("alertas")
    .update({
      status: "resolvido",
      resolvido_em: new Date().toISOString(),
      operador_id: opId,
      origem_acao: "resolver_massa",
      ...STRIP_PESADO,
    })
    .in("id", elegiveis);
  if (error) return { erro: "Não foi possível resolver os alertas." };
  revalidatePath("/");
  return { ok: true, resolvidos: elegiveis.length, ignoradosRecentes };
}
```

- [ ] **Step 4: Aplicar o mesmo guard em `limparVarios`**

Substituir a função inteira (linhas 106-126 atuais) por:

```typescript
// Operador so quer tirar da tela, sem afirmar nada sobre o caso (nem real,
// nem falso) -- achado real 27-28/07: "Resolver todos" clicado em massa
// nao e' revisao caso a caso, mas contava como se fosse (contaminava
// calibracao e qualquer leitura de "quantos confirmados"). Este botao e'
// pro caso comum (limpar a tela no fim do turno), sem fingir confirmacao.
// Por isso NAO chama registrarCasosDesvioRevisao (nao e' veredito humano,
// nao deve alimentar casos_desvio_revisao nem taxaGlobal/segmento algum).
export async function limparVarios(
  ids: string[]
): Promise<ResultadoAcao & { limpos?: number }> {
  const opId = await operadorAtual();
  if (!opId) return { erro: "Sessao expirada." };
  if (ids.length === 0) return { ok: true, limpos: 0 };
  const admin = createAdminClient();
  // Mesmo guard de idade minima de resolverVarios acima -- ver
  // docs/superpowers/specs/2026-08-09-idade-minima-acao-massa-design.md.
  const { data: linhas } = await admin.from("alertas").select("id, desde").in("id", ids);
  const agora = new Date();
  const elegiveis = (linhas ?? []).filter((l) => elegivelParaAcaoMassa(l.desde, agora)).map((l) => l.id);
  const ignoradosRecentes = ids.length - elegiveis.length;
  if (elegiveis.length === 0) return { ok: true, limpos: 0, ignoradosRecentes };
  const { error } = await admin
    .from("alertas")
    .update({
      status: "limpo",
      resolvido_em: new Date().toISOString(),
      operador_id: opId,
      origem_acao: "limpar_massa",
      ...STRIP_PESADO,
    })
    .in("id", elegiveis);
  if (error) return { erro: "Não foi possível limpar os alertas." };
  revalidatePath("/");
  return { ok: true, limpos: elegiveis.length, ignoradosRecentes };
}
```

- [ ] **Step 5: Typecheck**

Run: `npx tsc --noEmit`
Expected: limpo. (Este arquivo é `"use server"`, sem teste unitário direto — mesmo padrão já existente pras outras funções dele; a Task 4 faz a verificação end-to-end em produção real.)

- [ ] **Step 6: Commit**

```bash
git add "src/app/(app)/acoes-alertas.ts"
git commit -m "feat(desvio): servidor recusa fechar alerta recente em ação em massa"
```

---

### Task 3: Guard no cliente + aviso visual (`MonitorV2.tsx`)

**Files:**
- Modify: `src/app/(app)/central-v2/MonitorV2.tsx`

**Interfaces:**
- Consumes: `IDADE_MINIMA_ACAO_MASSA_MIN` (Task 1), `minutosDesde` (já existe no arquivo, linha 111 atual).

- [ ] **Step 1: Importar a constante**

Linha 9 atual, atualizar o import de `detectores`:

```typescript
import { formatarProgressoDestino, formatarPlacarSombra, formatarConfiabilidadeDetector, IDADE_MINIMA_ACAO_MASSA_MIN, elegivelParaAcaoMassa } from "@/lib/detectores";
```

- [ ] **Step 2: Novo estado pro aviso**

Logo depois de `const [limpandoTodos, startLimpar] = useTransition();` (linha 546 atual):

```typescript
  const [avisoRecentes, setAvisoRecentes] = useState<{ acao: "resolver" | "limpar"; quantidade: number } | null>(null);
```

- [ ] **Step 3: Filtrar por idade em `handleResolverTodos`**

Substituir a função inteira (linhas 1087-1104 atuais) por:

```typescript
  const handleResolverTodos = useCallback(() => {
    const alvos = alertasFiltrados;
    if (alvos.length === 0) return;
    setAvisoRecentes(null);
    // Guard de idade minima (achado real 08/08, caso TTH-3C94): alerta
    // recem-nascido nunca some da tela por acao em massa -- ver
    // docs/superpowers/specs/2026-08-09-idade-minima-acao-massa-design.md.
    // Espelha o guard do servidor (acoes-alertas.ts) pra nunca nem piscar
    // um alerta jovem como removido -- servidor continua sendo a
    // autoridade final, isso e' so pra UX consistente.
    // elegivelParaAcaoMassa (nao minutosDesde, que arredonda pra exibicao)
    // -- reusa a MESMA funcao pura do servidor, evita o servidor rejeitar
    // um id que o cliente achou elegivel por causa de arredondamento no
    // limite exato dos 5min (minutosDesde arredonda: 4min36s vira "5min"
    // no texto do card, mas o servidor compara sem arredondar).
    const agora = new Date();
    const elegiveis = alvos.filter(a => elegivelParaAcaoMassa(a.desde, agora));
    const recentes = alvos.length - elegiveis.length;
    if (elegiveis.length === 0) {
      if (recentes > 0) setAvisoRecentes({ acao: "resolver", quantidade: recentes });
      setConfirmarResolver(false);
      return;
    }
    startResolver(async () => {
      const ids = new Set(elegiveis.map(a => a.id));
      const cvsResolvidos = new Set(elegiveis.map(a => a.cv));
      setAlertas(a => {
        const restante = a.filter(x => !ids.has(x.id));
        const cvsAindaComAlerta = new Set(restante.map(x => x.cv));
        setVeiculosMapa(vs => vs.map(v =>
          cvsResolvidos.has(v.cv) && !cvsAindaComAlerta.has(v.cv) ? { ...v, nivel: null, tipo: null } : v
        ));
        return restante;
      });
      await resolverVarios(elegiveis.map(a => a.id));
      if (recentes > 0) setAvisoRecentes({ acao: "resolver", quantidade: recentes });
      setConfirmarResolver(false);
    });
  }, [alertasFiltrados]);
```

- [ ] **Step 4: Mesmo filtro em `handleLimparTodos`**

Substituir a função inteira (linhas 1110-1127 atuais) por:

```typescript
  const handleLimparTodos = useCallback(() => {
    const alvos = alertasFiltrados;
    if (alvos.length === 0) return;
    setAvisoRecentes(null);
    // Mesmo guard de idade minima de handleResolverTodos acima.
    // elegivelParaAcaoMassa (nao minutosDesde, que arredonda pra exibicao)
    // -- reusa a MESMA funcao pura do servidor, evita o servidor rejeitar
    // um id que o cliente achou elegivel por causa de arredondamento no
    // limite exato dos 5min (minutosDesde arredonda: 4min36s vira "5min"
    // no texto do card, mas o servidor compara sem arredondar).
    const agora = new Date();
    const elegiveis = alvos.filter(a => elegivelParaAcaoMassa(a.desde, agora));
    const recentes = alvos.length - elegiveis.length;
    if (elegiveis.length === 0) {
      if (recentes > 0) setAvisoRecentes({ acao: "limpar", quantidade: recentes });
      setConfirmarLimpar(false);
      return;
    }
    startLimpar(async () => {
      const ids = new Set(elegiveis.map(a => a.id));
      const cvsLimpos = new Set(elegiveis.map(a => a.cv));
      setAlertas(a => {
        const restante = a.filter(x => !ids.has(x.id));
        const cvsAindaComAlerta = new Set(restante.map(x => x.cv));
        setVeiculosMapa(vs => vs.map(v =>
          cvsLimpos.has(v.cv) && !cvsAindaComAlerta.has(v.cv) ? { ...v, nivel: null, tipo: null } : v
        ));
        return restante;
      });
      await limparVarios(elegiveis.map(a => a.id));
      if (recentes > 0) setAvisoRecentes({ acao: "limpar", quantidade: recentes });
      setConfirmarLimpar(false);
    });
  }, [alertasFiltrados]);
```

- [ ] **Step 5: Renderizar o aviso**

Logo depois do bloco `{!splitView && alertasFiltrados.length > 0 && ( ... )}` dos botões Resolver/Limpar (fecha na linha 2301 atual), antes do comentário "Alert list":

```typescript
          {avisoRecentes && (
            <div style={{ padding: "5px 8px", fontSize: 10, color: T.dim, borderBottom: `1px solid ${T.border}` }}>
              {avisoRecentes.quantidade} alerta{avisoRecentes.quantidade > 1 ? "s" : ""} recente{avisoRecentes.quantidade > 1 ? "s" : ""} (menos de {IDADE_MINIMA_ACAO_MASSA_MIN}min) {avisoRecentes.quantidade > 1 ? "ficaram" : "ficou"} de fora d{avisoRecentes.acao === "resolver" ? "a resolução" : "a limpeza"} em massa — revise individualmente.
            </div>
          )}
```

- [ ] **Step 6: Rodar dev server e validar visualmente**

Run: `npm run dev` (background, use outra porta se 3000 já estiver ocupada por outro processo — NÃO mate processos que você não subiu). Abrir `/`, confirmar que carrega sem erro de console e que os botões Resolver/Limpar ainda aparecem normalmente.

- [ ] **Step 7: Typecheck e suite completa**

Run: `npx tsc --noEmit && npx vitest run`
Expected: limpo.

- [ ] **Step 8: Commit**

```bash
git add "src/app/(app)/central-v2/MonitorV2.tsx"
git commit -m "feat(desvio): cliente não remove alerta recente ao resolver/limpar em massa"
```

---

### Task 4: Replicar pro repo espelho + deploy + verificação end-to-end real

**Files:**
- Nenhum arquivo novo — cópia exata dos diffs das Tasks 1-3 pro repo `MONITORAMENTO transmonseg`.

**Interfaces:**
- Consumes: commits das Tasks 1-3 (repo `MONITORAMENTO TEMP`).
- Produces: mesma mudança de código rodando em produção real — encerra o plano.

- [ ] **Step 1: Confirmar que os repos não divergiram antes desta mudança**

```bash
cd ~/Projects/Transmonseg/monitoramento
diff "MONITORAMENTO TEMP/src/lib/detectores.ts" "MONITORAMENTO transmonseg/src/lib/detectores.ts"
diff "MONITORAMENTO TEMP/src/app/(app)/acoes-alertas.ts" "MONITORAMENTO transmonseg/src/app/(app)/acoes-alertas.ts"
diff "MONITORAMENTO TEMP/src/app/(app)/central-v2/MonitorV2.tsx" "MONITORAMENTO transmonseg/src/app/(app)/central-v2/MonitorV2.tsx"
```

Se algum diff não estiver vazio (fora as mudanças das Tasks 1-3 recém-feitas só no TEMP), pare e reporte BLOCKED.

- [ ] **Step 2: Copiar os 3 arquivos tocados + docs**

```bash
cp "MONITORAMENTO TEMP/src/lib/detectores.ts" "MONITORAMENTO transmonseg/src/lib/detectores.ts"
cp "MONITORAMENTO TEMP/src/lib/detectores.test.ts" "MONITORAMENTO transmonseg/src/lib/detectores.test.ts"
cp "MONITORAMENTO TEMP/src/app/(app)/acoes-alertas.ts" "MONITORAMENTO transmonseg/src/app/(app)/acoes-alertas.ts"
cp "MONITORAMENTO TEMP/src/app/(app)/central-v2/MonitorV2.tsx" "MONITORAMENTO transmonseg/src/app/(app)/central-v2/MonitorV2.tsx"
cp "MONITORAMENTO TEMP/docs/superpowers/specs/2026-08-09-idade-minima-acao-massa-design.md" "MONITORAMENTO transmonseg/docs/superpowers/specs/"
cp "MONITORAMENTO TEMP/docs/superpowers/plans/2026-08-09-idade-minima-acao-massa.md" "MONITORAMENTO transmonseg/docs/superpowers/plans/"
```

- [ ] **Step 3: Testes e typecheck no repo espelho**

```bash
cd "MONITORAMENTO transmonseg"
npx tsc --noEmit
npx vitest run
```

- [ ] **Step 4: Commit e push dos dois repos**

```bash
git add -A
git commit -m "feat(desvio): guard de idade mínima pra ações em massa (replica de MONITORAMENTO TEMP)"
git push origin main
cd "../MONITORAMENTO TEMP"
git push origin master
```

- [ ] **Step 5: Deploy manual no Contabo**

```bash
ssh transmonseg-vps "cd /srv/transmonseg/temp && git pull && npm ci && npm run build && pm2 restart transmonseg-temp --update-env"
ssh transmonseg-vps "cd /srv/transmonseg/definitivo && git pull && npm ci && npm run build && pm2 restart transmonseg-definitivo --update-env"
```

- [ ] **Step 6: Confirmar não regressão**

```bash
ssh transmonseg-vps "pm2 jlist | node -e 'let d=\"\"; process.stdin.on(\"data\",c=>d+=c); process.stdin.on(\"end\",()=>{JSON.parse(d).forEach(p=>console.log(p.name, p.pid, p.pm2_env.status, p.pm2_env.restart_time))})'"
```

- [ ] **Step 7: Verificação end-to-end REAL em produção**

Esta é uma mudança de comportamento real (fecha ou não fecha alerta), não só exibição — a verificação precisa confirmar de fato, não só "não quebrou nada":

1. Achar (ou esperar aparecer) um alerta de desvio ativo com menos de 5 minutos de idade:
```bash
ssh transmonseg-vps "sudo -u postgres psql -d transmonseg -c \"select id, motivo, desde, extract(epoch from (now() - desde))/60 as idade_min from alertas where tipo='desvio' and status='ativo' order by desde desc limit 5;\""
```
2. Logar (via QA descartável, mesmo processo das tasks anteriores) e tentar "Limpar avisos" com esse alerta jovem na lista visível.
3. Confirmar via SQL que o `status` desse alerta específico **continua `ativo`** depois da ação (não virou `limpo`), enquanto os alertas mais antigos na mesma leva viraram `limpo` normalmente.
4. Confirmar visualmente que o aviso "N alerta(s) recente(s)... ficou(ficaram) de fora" apareceu na tela.
5. Repetir o teste, dessa vez esperando o alerta passar dos 5 minutos, confirmar que ação em massa agora O ALCANÇA normalmente (não fica preso pra sempre).
