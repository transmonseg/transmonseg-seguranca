# Desvio agressivo: cerca virtual ATIVA + sensibilidade máxima

> **REQUIRED SUB-SKILL:** executing-plans (execução inline, imediata, mesma sessão). Diretiva explícita do usuário: falso positivo é aceitável, prioridade total é NUNCA perder um desvio real e detectar no PRIMEIRO ciclo.

**Goal:** desvio de rota vira alerta crítico real (não mais sombra) no primeiro ciclo em que o veículo sai ~100m do corredor real, disparando o apito do operador imediatamente — sem esperar streak de 2, sem gate de calendário, sem teto de distância.

**Contexto:** a cerca virtual (`CERCA_VIRTUAL_MODO`) já roda em modo sombra desde ontem, validada com um dia inteiro de operação real (44+ veículos, 300+ momentos "fora" confirmados). Hoje a Camada 1 antiga (afastar de TODOS os destinos) é a única que gera alerta real, e ela é estruturalmente cega com muitos destinos — a cerca resolve isso.

## Global Constraints
- Falso positivo é aceitável (diretiva explícita do usuário hoje). NUNCA remover a regra "parado não fecha sozinho" (segurança inegociável de toda a sessão).
- TDD em toda função pura nova/alterada. `npx tsc --noEmit`, `npx vitest run`, `npx eslint <arquivos>`, `npm run build` limpos antes de cada push.
- Reaproveitar a infraestrutura de alerta já existente (`alertas`, ciclo de vida de resolução) — não criar tabela nova pro alerta real da cerca.

---

### Task 1: Buffer da cerca cai pra ~100m (de 300/600m)

**Files:** `src/lib/corredor-verificacao.ts`, `src/lib/corredor-verificacao.test.ts`

- [ ] Ajustar `bufferPorVelocidade`: urbano 300→**120m**, rodovia (≥60km/h) 600→**200m**. Testes existentes (`bufferPorVelocidade`) atualizados pros novos valores.
- [ ] Rodar `npx vitest run src/lib/corredor-verificacao.test.ts`, confirmar verde.
- [ ] Commit.

### Task 2: Cerca dispara no PRIMEIRO "fora" (não espera 2 leituras)

**Files:** `src/app/api/motor/route.ts`

- [ ] Hoje `cercaSombraCiclo.push(...)` só loga (linha `veredito: "fora"`, `foraStreak<=2`). Trocar: `CERCA_VIRTUAL_MODO = "ativa"` e, no branch `r.veredito === "fora"`, em vez de só empurrar pra `cercaSombraCiclo`, criar/atualizar um `Alerta` real (`tipo: "desvio"`, `nivel: "critico"`, `motivo: "Fora da rota esperada (Xm da estrada real até o próximo ponto)"`, `score: 75`, `contexto: { cerca: { bufferM, distM } }`) e inserir/gerenciar no mesmo ciclo de vida de alerta já existente (reaproveita `desvioAtivo`/`alertasGerenciados` — mesma dedupe por `tipo='desvio'` que já existe, então se a Camada 1 também disparar pro mesmo veículo no mesmo ciclo, não duplica).
- [ ] "recuperado" (voltou pro corredor) resolve o alerta da cerca no MESMO ciclo (mesmo princípio já usado no corredor da Camada 1: `estaForaDeRota = false`).
- [ ] Manter a gravação em `cerca_sombra` em paralelo (auditoria/histórico), mas agora ela reflete alerta real, não mais hipotético.
- [ ] Sem teste automatizado direto (motor não tem harness) — validar com QA ao vivo depois do deploy: forçar um veículo pra fora do corredor e confirmar alerta + apito.
- [ ] Commit.

### Task 3: Remove o gate de calendário da Camada 1 de vez

**Files:** `src/lib/detectores.ts`, `src/lib/detectores.test.ts`

- [ ] `const operando = ctx.emOperacao || ctx.sabadoDiurnoComRota === true;` vira **sempre true quando `ctx.temPendentes` for true** (se tem rota carregada, é hora de trabalho, ponto final — não importa dia/hora). Sem pendentes, mantém o `emOperacao` antigo como fallback (evita disparar pra veículo sem nenhuma rota, ex. manutenção de madrugada).
- [ ] Testes: ajustar/criar casos cobrindo domingo/madrugada COM pendentes (dispara) e SEM pendentes (não dispara, comportamento antigo preservado).
- [ ] Rodar suite completa, confirmar verde.
- [ ] Commit.

### Task 4: Teto de 25km sobe pra 80km (rotas longas da Nutry, ex. Angra/Volta Redonda são legítimas)

**Files:** `src/lib/detectores.ts`, `src/lib/detectores.test.ts`

- [ ] `DESVIO_GATILHO_TETO_M = 25000` → `80000`.
- [ ] Ajustar teste "acima do teto de deslocamento interurbano nao dispara" pra usar distância >80km em vez de >25km.
- [ ] Commit.

### Task 5: Limiar de risco de área cai 40→25

**Files:** `src/lib/detectores.ts`, `src/lib/detectores.test.ts`

- [ ] `RISCO_AREA_LIMIAR = 40` → `25`.
- [ ] Ajustar testes que dependem do valor exato do limiar (ex. "via conhecida e area de risco BAIXO" usa `RISCO_AREA_LIMIAR - 1` — segue funcionando por referência à constante, só confirmar).
- [ ] Commit.

### Task 6: Streak mínimo de disparo da Camada 1 cai 2→1 leitura

**Files:** `src/lib/detectores.ts`, `src/lib/detectores.test.ts`, `src/lib/desvio-cenarios.test.ts`

- [ ] `if (ctx.streak < 2) return null;` → `if (ctx.streak < 1) return null;`.
- [ ] Ajustar testes que hoje esperam `streak:1 → null` (vão passar a disparar) e o `nDest`/motivo (`"há 1 leituras"` — checar pluralização, ok deixar "leituras" mesmo no singular por simplicidade, mesma convenção já usada).
- [ ] Commit.

### Task 7: Validação completa e deploy

- [ ] `npx tsc --noEmit`, `npx vitest run`, `npx eslint <tudo tocado>`, `npm run build` — todos limpos.
- [ ] Push.
- [ ] Validar com dado real: checar `alertas` tipo=desvio criados pós-deploy vêm de ambas as fontes (Camada 1 e cerca, distinguíveis pelo `contexto`), e que o volume sobe (esperado e aceito).
- [ ] Atualizar `ESTADO.md`.
