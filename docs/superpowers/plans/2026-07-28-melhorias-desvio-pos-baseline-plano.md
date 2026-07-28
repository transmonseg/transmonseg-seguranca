# Melhorias de desvio pós-baseline (calibração, rua estreita, rumo-diverge) — Plano

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development pra rodar este plano tarefa por tarefa.

**Goal:** Corrigir as causas concretas por trás do volume de falso positivo de hoje (28/07) que NÃO são o bug de `baseline_veiculo` (já corrigido e em produção): calibração desatualizada, o auto-resolve de rua-estreita que não dispara a tempo, um padrão de "acabou de sair de parada" não filtrado, uma assimetria de retenção de dado diagnóstico, e dois gaps reais na regra de rumo-diverge (falta de dado persistido + falta de corroboração contra rota real).

**Contexto importante — investigação prévia corrigiu 3 suposições erradas** (não confiar em resumos anteriores sem reconferir contra o código real, mesma lição do bug do baseline):
1. "Rua estreita" (classe_viaria) **já tem** segmento de calibração próprio (`origem:classe_viaria`) — o problema não é falta de granularidade, é a **frequência** do refresh (hoje semanal, `recalibrar-desvio-semanal`, seg 3h).
2. "Rumo diverge" (comportamental, sem corredor) **não tem** segmento próprio — cai sempre no balde grosseiro `tipo:desvio`, misturado com outras sub-regras. Esse sim precisa de segmento novo.
3. Já existe um mecanismo de corroboração contra rota real (`verificarCorredor`, OSRM/Valhalla) — só não está ligado à regra de rumo-diverge. Ligá-lo resolve ao mesmo tempo o problema de "curva/rodovia" e o de "muitos destinos" (itens que pareciam precisar de pesquisa nova) sem precisar desenhar bearing sensível a curva do zero.

**Architecture:** Tarefas mais ou menos independentes entre si (algumas tocam `detectores.ts`/`route.ts` na mesma vizinhança, mas em blocos distintos — revisar por tarefa, não em lote). Nenhuma delas mexe em `baseline_veiculo` (já fechado).

**Tech Stack:** `scripts/migrations/contabo/`, pg_cron (Contabo), `src/lib/detectores.ts`, `src/lib/calibracao-desvio.ts`, `src/app/api/motor/route.ts`, `src/app/(app)/acoes-alertas.ts`.

**Global Constraints:**
- Toda mudança que toca `contexto`/`status`/calibração precisa de revisão independente antes de deploy (mesmo padrão desta sessão — já pegou bugs reais 2x hoje).
- Replicar pros dois repos (TEMP + `transmonseg-seguranca`/`main`) e os dois processos PM2 depois de cada commit relevante, não só no fim.
- Nenhuma migration se aplica sozinha — sempre `scp` + `psql -f` no Contabo, mesmo padrão de toda esta sessão.

---

## Task 1: Recalibração mais frequente (freshness)

**Arquivos:**
- Migration nova (via `psql` direto no Contabo, não precisa de arquivo `.sql` versionado já que é só um `cron.alter_job` — mas versionar mesmo assim por consistência): `scripts/migrations/contabo/010_recalibrar_desvio_diario.sql`

O job `recalibrar-desvio-semanal` (pg_cron) roda `0 3 * * 1` (só segunda, 3h). Isso significa que uma mudança de comportamento (como a de hoje, rua estreita saltando de 1,6% pra 77% de falso positivo) só seria refletida na calibração até 6 dias depois. Trocar pra diário:

```sql
-- scripts/migrations/contabo/010_recalibrar_desvio_diario.sql
--
-- Achado real 28/07: recalibrar-desvio rodava so semanalmente (seg 3h) --
-- uma mudanca de comportamento no meio da semana (rua estreita saltando de
-- 1.6% pra 77% de falso positivo em um unico dia) so seria refletida na
-- calibracao ate 6 dias depois. Diario reage no dia seguinte.
SELECT cron.alter_job(
  job_id := (SELECT jobid FROM cron.job WHERE jobname = 'recalibrar-desvio-semanal'),
  schedule := '0 3 * * *'
);
```

**Aplicar:** `scp` + `psql -f` no Contabo (mesmo padrão). Confirmar com `SELECT jobname, schedule FROM cron.job WHERE jobname = 'recalibrar-desvio-semanal';` que virou `0 3 * * *`. (Não precisa renomear o job, só o schedule mudou — deixar o nome como está pra não quebrar nenhuma referência.)

**Risco:** baixo — só muda frequência de um job que já roda em produção sem problema, não muda a lógica.

---

## Task 2: Segmento de calibração próprio pra rumo-diverge

**Arquivos:**
- Modificar: `src/lib/detectores.ts` (tipo `ContextoDesvio`/campo `origemDesvio`, branch da linha ~1206-1215)
- Modificar: `src/lib/calibracao-desvio.ts` (`segmentoCalibracaoPreferido`)
- Modificar: `src/lib/detectores.test.ts` e `src/lib/calibracao-desvio.test.ts` (se existir; senão criar os testes junto do arquivo de detectores)

Hoje "rumo diverge" (motivo `Direção do movimento diverge da rota esperada há N leituras...`, `detectores.ts:1206-1215`) usa `origemDesvio: "comportamental"` igual a "afastando de tudo" e ao alerta fraco de "além do raio" — só ganha segmento próprio se tiver `corredor_veredito` (raramente o caso, já que essa regra não seta `precisaVerificacaoCorredor`). Sem segmento próprio, a taxa de falso positivo dela fica escondida dentro do balde `tipo:desvio`, misturada com regras de perfil de risco bem diferente.

**Step 1:** Estender o tipo de `origemDesvio` em `src/lib/detectores.ts` (procurar `origemDesvio?:` no tipo `ContextoDesvio` ou similar) adicionando `"rumo_diverge"`:

```ts
origemDesvio?: "comportamental" | "cerca_virtual" | "saida_parada" | "classe_viaria" | "rumo_diverge";
```

**Step 2:** No branch de rumo-diverge (`detectores.ts`, ~linha 1206-1215), trocar `origemDesvio: "comportamental"` por `origemDesvio: "rumo_diverge"`:

```ts
  if (!afastandoDeTudo && divergenciaRumoDispara(ctx.divergenciaRumoStreak)) {
    const nDestDirecao = ctx.distDestinosM.length;
    return {
      nivel: "atencao",
      tipo: "desvio",
      origemDesvio: "rumo_diverge",
      motivo: `Direção do movimento diverge da rota esperada há ${ctx.divergenciaRumoStreak} leituras, mesmo aproximando em linha reta de ${nDestDirecao} destino(s)`,
      score: 40,
    };
  }
```

**Step 3:** Em `src/lib/calibracao-desvio.ts`, estender `segmentoCalibracaoPreferido` com um branch novo (adicionar ANTES do fallback `null`, depois dos branches existentes de `saida_parada`/`classe_viaria`/`parada_fora_tapete` — mesmo padrão):

```ts
  // Achado real 28/07: "rumo diverge" (divergenciaRumoDispara) sempre caia
  // no balde generico tipo:desvio (so ganhava corredor_veredito quando
  // precisaVerificacaoCorredor=true, o que essa regra nunca seta) --
  // segmento proprio pra recalibrar-desvio aprender a taxa real dela
  // separada de "afastando de tudo" (perfil de risco bem diferente).
  if (alerta.tipo === "desvio" && alerta.origemDesvio === "rumo_diverge") {
    return "origem:rumo_diverge";
  }
```

**Step 4:** Verificar TODOS os outros lugares que fazem `alerta.origemDesvio === "comportamental"` (grep no repo) pra confirmar que nenhum deles dependia implicitamente do rumo-diverge estar classificado como "comportamental" (ex: algum bônus, alguma exclusão). Se algum depender, decidir explicitamente se deve continuar valendo pra `"rumo_diverge"` também (adicionar ao check) ou não (documentar por quê).

**Step 5:** Atualizar/adicionar testes em `detectores.test.ts` confirmando que o branch de rumo-diverge agora retorna `origemDesvio: "rumo_diverge"` (não mais `"comportamental"`), e em `calibracao-desvio.test.ts` (ou criar, se não existir arquivo de teste pra esse módulo) confirmando que `segmentoCalibracaoPreferido` retorna `"origem:rumo_diverge"` pro caso novo.

**Risco:** médio — muda um valor estrutural (`origemDesvio`) que pode ser lido em mais de um lugar; checar Step 4 com cuidado antes de considerar concluído.

---

## Task 3: Persistir `dist_destinos_m` de verdade pra rumo-diverge

**Arquivos:**
- Modificar: `src/app/api/motor/route.ts` (perto de `ehDesvio`, linha ~2528, e os dois pontos que chamam `montarContextoDesvio`, ~2573-2588 e ~2629-2644)

Achado real da investigação: o contexto de rumo-diverge só é persistido quando `desvioInicio !== null` (via `ehDesvio`), mas `desvioInicio` só é setado de forma confiável pela transição de streak da regra "afastando de tudo" (`afastando=true`) — rumo-diverge dispara justamente quando `afastando=false`, então na maioria das vezes bate contexto vazio (`{}`), não por decisão, só por acidente de estado alheio.

**Step 1:** Ler a definição completa de `ehDesvio` (route.ts, ~linha 2528) e do bloco que escolhe entre `montarContextoDesvio(...)` e `{}` (ambos os pontos, insert e update). Confirmar o texto exato antes de editar (pode ter mudado de linha desde a investigação).

**Step 2:** Estender a condição pra também persistir contexto quando o alerta vencedor tem `origemDesvio === "rumo_diverge"` (agora que a Task 2 deu esse valor próprio), independente de `desvioInicio`:

```ts
const origemRumoDiverge = alerta.origemDesvio === "rumo_diverge";
const ehDesvio = alerta.tipo === "desvio" && (desvioInicio !== null || origemRumoDiverge) && !origemClasseViaria && !origemSaidaParada;
```

Aplicar a MESMA mudança nos dois pontos que constroem contexto (insert e update) — mesmo padrão já usado pra `origemClasseViaria`/`origemSaidaParada` (verificar como aqueles dois foram tratados quando a contexto-loss bug deles foi corrigida mais cedo nesta sessão, e replicar a mesma estrutura).

**Step 3:** Confirmar que `montarContextoDesvio` (detectores.ts:627-662) recebe os campos certos mesmo quando chamado fora do caminho normal de "afastando de tudo" (ex: `divergencia_rumo_streak` deve estar disponível; `dist_destinos_m`/`dist_destinos_anterior_m` também, já que vêm do ctx geral, não de algo exclusivo de afastando-de-tudo).

**Step 4:** Testes: caso de rumo-diverge disparando SEM nenhuma "afastando de tudo" recente (`desvioInicio === null`) — confirmar que o contexto persistido agora inclui `dist_destinos_m` mesmo assim.

**Risco:** médio — toca o mesmo trecho de `ehDesvio` que já foi corrigido 1x nesta sessão pra classe_viaria/saida_parada; testar os 3 casos (classe_viaria, saida_parada, rumo_diverge) juntos pra garantir que nenhum regride.

---

## Task 4: Corroboração contra rota real (OSRM/Valhalla) pra rumo-diverge

**Arquivos:**
- Modificar: `src/lib/detectores.ts` (branch de rumo-diverge, ~linha 1206-1215)

Achado real da investigação: já existe um mecanismo pronto (`verificarCorredor`, `src/lib/corredor-verificacao.ts`) que busca a rota real via OSRM/Valhalla e checa se o veículo está dentro de um buffer da rota de verdade — hoje só ligado às branches de "afastando de tudo" (`precisaVerificacaoCorredor: true`). Ligar essa MESMA verificação em rumo-diverge resolve ao mesmo tempo o caso de rodovia com curva (bearing reto diverge da rota real que curva) e o de "muitos destinos" (a real corrobora contra o destino especifico, nao so a linha reta) — sem precisar desenhar bearing sensível a curva do zero.

Confirmado com dado real hoje (TTK-4D14, 84-88km/h no momento do disparo — perfil de rodovia, nao de rua local) que esse e exatamente o padrao que se beneficia da checagem de corredor real.

**Step 1:** No branch de rumo-diverge (`detectores.ts`, ja com `origemDesvio: "rumo_diverge"` da Task 2), adicionar `precisaVerificacaoCorredor: true`, mesmo padrao das branches de afastando-de-tudo:

```ts
  if (!afastandoDeTudo && divergenciaRumoDispara(ctx.divergenciaRumoStreak)) {
    const nDestDirecao = ctx.distDestinosM.length;
    return {
      nivel: "atencao",
      tipo: "desvio",
      origemDesvio: "rumo_diverge",
      motivo: `Direção do movimento diverge da rota esperada há ${ctx.divergenciaRumoStreak} leituras, mesmo aproximando em linha reta de ${nDestDirecao} destino(s)`,
      score: 40,
      precisaVerificacaoCorredor: true,
    };
  }
```

**Step 2:** Ler como `precisaVerificacaoCorredor`/`verificarCorredor` sao consumidos em `route.ts` (pontos ~1835, 1866, 2098, 2132) pra confirmar que o fluxo de dispatch (fila, timeout, o que acontece se OSRM falhar) já cobre esse novo consumidor sem mudança adicional — é so mais um alerta entrando na MESMA fila que "afastando de tudo" já usa, não deveria precisar de nenhuma mudança em `route.ts` além do que a Task 2/3 já tocaram por perto.

**Step 3 (decisão a tomar, não assumir):** as branches de "afastando de tudo" também setam `exigeConfirmacaoCorredor: semHistorico || undefined` (exige confirmação positiva do corredor antes de aceitar, quando o veículo não tem histórico na via). Ler o que esse campo faz exatamente e decidir se rumo-diverge deveria ter o mesmo comportamento ou não — rumo-diverge dispara com critério mais fraco (nível "atencao", não "critico"), então pode fazer sentido NÃO exigir confirmação (só usar o corredor como corroboração opcional que abaixa o score/severidade se dentro do corredor, sem bloquear o alerta se a verificação falhar/demorar). Documentar a decisão tomada com a razão.

**Step 4:** Testes cobrindo: rumo-diverge dispara → corredor confirma que está na rota real → o quê muda (score? nível? algo é suprimido?); rumo-diverge dispara → corredor NÃO confirma (fora da rota real) → o que muda. Usar como referência os testes já existentes pras branches de afastando-de-tudo com `precisaVerificacaoCorredor`.

**Risco:** médio-alto — depende de entender bem o consumo existente de `precisaVerificacaoCorredor` antes de decidir o Step 3; não pular a leitura.

---

## Task 5: Auto-resolve de rua-estreita — corrigir os 2 padrões que impedem disparo a tempo

**Arquivos:**
- Modificar: `src/lib/detectores.ts` (`deveAutoResolverRuaEstranha`, `RUA_ESTRANHA_JANELA_AUTORESOLVE_MIN`)
- Modificar: `src/app/api/motor/route.ts` (wiring do auto-resolve de rua-estreita)

Causa raiz confirmada hoje com dado real de posição/velocidade de 3 casos (TTI-6E43 33min, TB466437 18min, TTD-7H14 10.6min):

- **Padrão A:** a janela de auto-resolve (`RUA_ESTRANHA_JANELA_AUTORESOLVE_MIN = 5`) é contada a partir da CRIAÇÃO do alerta (`idadeAlertaMin`), não do momento em que o veículo realmente fica parado. Se o veículo continua andando mais alguns minutos (normal, terminando a manobra) antes de parar de verdade, a janela já fechou quando ele finalmente satisfaz `paradoMin>=2`.
- **Padrão B:** o timer de "parado contínuo" (`paradoMin`, `route.ts:1236-1258`) zera com QUALQUER leitura de velocidade≠0, mesmo um único blip de 6-10km/h — em trânsito parado-e-anda, nunca acumula os 2min seguidos.

**Decisão de design:** seguir o MESMO padrão já validado e revisado nesta sessão pro auto-resolve de rota-concluída (que não tem janela de tempo nenhuma, só as condições de segurança — risco baixo, parado confirmado). Remover a janela de tempo do rua-estreita (`RUA_ESTRANHA_JANELA_AUTORESOLVE_MIN`) resolve o Padrão A por completo, e é consistente com o outro mecanismo já em produção. Pro Padrão B, em vez de mudar `paradoMin` (usado por MUITOS outros consumidores no motor — risco de blast radius), criar um sinal PRÓPRIO e mais tolerante, só pro auto-resolve de rua-estreita.

**Step 1:** Em `src/lib/detectores.ts`, remover o parâmetro/checagem de `idadeAlertaMin` de `deveAutoResolverRuaEstranha` (ou deixar o parâmetro mas nunca usá-lo como bloqueio — decidir olhando a assinatura atual e escolher a forma mais simples, sem deixar parâmetro morto). Atualizar o teste que cobre esse comportamento.

**Step 2:** Criar um sinal tolerante-a-blip, análogo a `paradoMin` mas que não zera com uma única leitura de velocidade baixa não-zero. Em `route.ts`, ao lado de onde `paradoMin`/`parado_desde` são calculados (~linha 1234-1258), adicionar uma variável paralela só usada pelo auto-resolve de rua-estreita — por exemplo, considerar "efetivamente parado" quando a velocidade está abaixo de um limiar pequeno (ex: `<= 10km/h`, mesma ordem de grandeza do gate de rumo-diverge) em vez de estritamente `=== 0`, ou manter o `parado_desde` mesmo que uma leitura isolada tenha velocidade baixa não-zero entre duas leituras paradas. Escolher a implementação mais simples que resolve o padrão observado (trânsito parado-e-anda: 0,6,7,7,0,0,0,10,10,0,0,20,20,0...) sem introduzir um novo parâmetro incontrolável — documentar a escolha com o caso real (TTD-7H14) como referência.

**Step 3:** Testes cobrindo os 3 casos reais (TTI-6E43-style: só precisa remover a janela; TTD-7H14-style: precisa do timer tolerante) — usar as sequências reais de velocidade já levantadas nesta sessão como fixtures.

**Risco:** alto — mexe no mecanismo de auto-resolve já revisado 4x nesta sessão; qualquer regressão aqui reabre um dos bugs já corrigidos (silenciamento de tipo, poluição de calibração, contexto perdido). Revisão independente obrigatória, mesmo nível de rigor da primeira versão.

---

## Task 5b: Fix round 1 — achados da revisão independente (APPROVE WITH MINOR FIXES, mas 1 achado invalida o caso real motivador)

Revisão (opus, independente) achou 3 problemas reais. O mais sério: **o acumulador de Padrão B, do jeito implementado, NÃO resolve o caso real que motivou ele.**

### 5b.1 — CRÍTICO NA PRÁTICA: `mesmoPonto` não é o gate certo pro acumulador

`calcularParadaToleranteSegundos` usa `mesmoPonto` (célula de 4 casas decimais, mesma lógica de `parado_desde`) pra decidir se acumula ou reseta. Conferi o lat/lng REAL do caso TTD-7H14 (não só a velocidade, que já tinha sido checada) e o veículo está se deslocando uns 10-30m a cada leitura o tempo todo — `mesmoPonto` fica FALSE quase todo ciclo. Com o gate atual, o acumulador reseta quase toda leitura, exatamente como o bug original (`parado_desde`) — **não corrige o caso que ele foi construído pra corrigir**.

**Fix:** tirar `mesmoPonto` do acumulador inteiramente. Usar só velocidade: acumula enquanto `velocidade <= RUA_ESTRANHA_VELOCIDADE_TOLERANTE_KMH`, reseta pra 0 quando excede. Isso é seguro porque o gate de decisão final (`route.ts`, `if (pos.fresco && pos.velocidade === 0)`) continua EXIGINDO velocidade exatamente 0 no ciclo da decisão — um veículo genuinamente cruzando uma rua a 15-18km/h sem nunca realmente parar jamais dispara a decisão, não importa o valor do acumulador.

```ts
export function calcularParadaToleranteSegundos(ctx: {
  velocidade: number;
  anteriorSegundos: number;
}): number {
  if (ctx.velocidade > RUA_ESTRANHA_VELOCIDADE_TOLERANTE_KMH) return 0;
  return ctx.anteriorSegundos + 30;
}
```

Remover o parâmetro `mesmoPonto` da assinatura e do call site em `route.ts` (a variável `mesmoPonto` continua existindo pra `parado_desde`, só não é mais passada pra esta função). Atualizar o comentário que hoje diz "mesmoPonto é calculado por route.ts... recebido pronto aqui" — não é mais verdade.

**Teste com dado REAL de verdade** (a fixture atual tem `mesmoPonto: true` hardcoded, o que a revisão provou ser fisicamente incompatível com o lat/lng real do caso — substituir):

```ts
it("caso real TTD-7H14 (28/07): velocidade oscila mas nunca excede o limiar tolerante -- acumula ate o threshold usando SO velocidade, sem depender de posicao", () => {
  const velocidades = [0,6,7,7,7,7,0,0,0,0,0,7,7,0,0,10,10,0,0,20,20,0,0,19];
  let segundos = 0;
  for (const v of velocidades) segundos = calcularParadaToleranteSegundos({ velocidade: v, anteriorSegundos: segundos });
  expect(segundos).toBeGreaterThanOrEqual(RUA_ESTRANHA_PARADO_MIN_MIN * 60);
});
```

### 5b.2 — IMPORTANTE: falta o guard `!alertaJammer` (presente no mecanismo irmão)

O auto-resolve de rota-concluída (`route.ts`, bloco logo antes) tem `!alertaJammer` explicitamente pra evitar que uma posição CONGELADA por jamming acumule "parado" só pelo relógio de parede durante um possível sequestro em andamento. O bloco de rua-estreita não tem esse guard — e agora que a Task 5b.3 abaixo bounded a idade do alerta em vez de removê-la sem limite, ainda vale fechar esta brecha (jammer pode travar a posição por até ~1h dentro da janela nova). Adicionar `!alertaJammer` ao `if` que guarda o loop de auto-resolve de rua-estreita, mesmo padrão do irmão.

### 5b.3 — IMPORTANTE: remover a janela de tempo por completo destrava alertas de qualquer idade

Sem NENHUM teto, um alerta de rua-estreita aberto há dias (o cron `expirar-alertas-ativos-esquecidos` só fecha depois de 7 dias) pode ser auto-resolvido silenciosamente na primeira parada de 2min com risco baixo — mesmo que o que aconteceu ENTRE a criação e essa parada seja completamente desconhecido (ex: sequestro real, veículo levado 25km, estacionado numa área sem nenhum sinal de risco corroborado). Os casos reais observados (TTI-6E43 33min, TB466437 18min, TTD-7H14 10.6min) NUNCA passaram de 33 minutos — não precisa de teto ilimitado pra cobrir o padrão real.

**Fix:** teto generoso ancorado na criação do alerta (mais simples e seguro que tentar ancorar num novo timestamp de "elegibilidade", que exigiria mais um campo persistido): 60 minutos — folga de quase 2x sobre o pior caso real observado, sem deixar alerta de dias/semanas ser fechado sem revisão.

```ts
// Task 5b.3 (revisao independente): idadeAlertaMin foi removido do PADRAO A
// (deveAutoResolverRuaEstranha nao olha mais idade -- ver comentario
// acima), mas sem NENHUM teto um alerta de dias fica elegivel pra fechar
// sozinho na primeira parada tranquila, sem ninguem saber o que aconteceu
// entre a criacao e essa parada. Teto generoso (60min, quase 2x o pior
// caso real observado: TTI-6E43 33min) ancorado na CRIACAO do alerta --
// deliberadamente mais simples que ancorar numa nova "elegibilidade"
// (exigiria mais um campo persistido). Aplicado no filtro de
// elegibilidade (nao em deveAutoResolverRuaEstranha, que continua sem
// saber de tempo -- a idade e' sobre QUAL ALERTA e' candidato, nao sobre
// as condicoes de seguranca em si).
export const RUA_ESTRANHA_IDADE_MAXIMA_AUTORESOLVE_MS = 60 * 60 * 1000;

export function alertaElegivelParaAutoResolveRuaEstranha(
  alerta: { status: string; tipo: string; motivo: string; desde: string },
  agora: Date,
  idadeMaximaMs: number = RUA_ESTRANHA_IDADE_MAXIMA_AUTORESOLVE_MS
): boolean {
  return (
    alerta.status === "ativo" &&
    alerta.tipo === "desvio" &&
    alerta.motivo === MOTIVO_RUA_ESTRANHA &&
    agora.getTime() - new Date(alerta.desde).getTime() <= idadeMaximaMs
  );
}
```

Call site em `route.ts` (~linha 2605): trocar `alertasAbertos.filter(alertaElegivelParaAutoResolveRuaEstranha)` por `alertasAbertos.filter((a) => alertaElegivelParaAutoResolveRuaEstranha(a, agora))` (`agora` já está em escopo, mesma variável usada em todo o resto do ciclo).

Testes: alerta com 30min de idade + condições de segurança OK → elegível; alerta com 90min de idade (fora do teto de 60min) + mesmas condições → NÃO elegível, mesmo com risco baixo e parado confirmado.

### 5b.4 — Verificação final

Rodar `npx vitest run`, `npx tsc --noEmit`, `npm run build` depois de TODOS os 3 fixes juntos. Confirmar que os testes antigos de `alertaElegivelParaAutoResolveRuaEstranha` (que hoje chamam a função com 1 argumento só) foram atualizados pra nova assinatura de 2-3 argumentos.

**Risco:** o achado 5b.1 é o mais sério — sem ele corrigido, a Task 5 inteira não resolve o problema real que motivou ela (só parece resolver nos testes, que usavam uma fixture idealizada). Revisão independente obrigatória de novo antes de deploy.

---

## Task 6: Exceção "acabou de sair de parada legítima" pra rua-estreita

**Arquivos:**
- Migration: `scripts/migrations/contabo/011_posicoes_atuais_saiu_parada_confirmada.sql`
- Modificar: `src/app/api/motor/route.ts`
- Modificar: `src/lib/detectores.ts` (branch de `quedaClasseViaria`)

Achado real: 36% dos casos manuais de rua-estreita eram o veículo saindo de uma parada de entrega legítima e pegando uma rua estreita logo em seguida — normal, mas a regra não sabe disso. Investigação confirmou que **não existe hoje** nenhum sinal persistido de "há quanto tempo o veículo saiu de uma parada confirmada" (`saiuDoRaioAgora` é um pulso de 1 ciclo só, não sobrevive; `dwellSegundosAcumulados` zera no mesmo ciclo da saída). Precisa de estado novo, seguindo o MESMO padrão já usado por `ultima_via_principal_em` (coluna em `posicoes_atuais`, seta na transição, lê com janela de tempo).

**Step 1:** Migration nova, adicionando coluna em `posicoes_atuais`:

```sql
-- scripts/migrations/contabo/011_posicoes_atuais_saiu_parada_confirmada.sql
--
-- Achado real 28/07: 36% dos falsos positivos manuais de rua-estreita eram
-- o veiculo saindo de uma parada de entrega legitima e entrando numa rua
-- estreita logo em seguida -- normal, mas a regra nao sabia. Nao existe
-- hoje nenhum sinal persistido de "saiu de parada confirmada ha quanto
-- tempo" (saiuDoRaioAgora e' um pulso de 1 ciclo, dwellSegundosAcumulados
-- zera no mesmo ciclo da saida) -- mesmo padrao ja usado por
-- ultima_via_principal_em (migration 026).
ALTER TABLE posicoes_atuais ADD COLUMN IF NOT EXISTS saiu_parada_confirmada_em timestamptz NULL DEFAULT NULL;

NOTIFY pgrst, 'reload schema';
```

**Step 2:** Em `route.ts`, na transição já identificada (`saiuDoRaioAgora && dwellAnterior >= BYPASS_ENTREGA_DWELL_MINIMO_SEGUNDOS`, perto de onde `saiuDoRaioAgora` é computado, ~linha 1985-1998), gravar `saiu_parada_confirmada_em = agora.toISOString()` na mesma estrutura que já persiste `no_raio_*`/`ultima_via_principal_em`. Ler esse novo campo do snapshot anterior (`anterior.saiu_parada_confirmada_em`) e propagar pra frente enquanto a janela de tempo não expirou (mesmo padrão do `ultima_via_principal_em`).

**Step 3:** No branch de `quedaClasseViaria` (`detectores.ts`, ~linha 1131-1139), adicionar um guard: se `saiuParadaConfirmadaHaMenosDe(ctx.saiuParadaConfirmadaEm, agora, JANELA_SAIDA_PARADA_MIN)` (nova função pura, janela sugerida: mesma ordem de grandeza do `JANELA_QUEDA_CLASSE_MIN` já existente, ex: 5 minutos — ajustar se o dado real pedir outra coisa), suprimir o disparo.

**Step 4:** Testes: veículo em rua estreita SEM ter saído de parada recente → dispara normal; veículo em rua estreita tendo saído de parada confirmada há 2min → suprime; há 10min (fora da janela) → dispara normal de novo.

**Risco:** médio — nova coluna + novo sinal, mas isolado (só afeta o branch de classe_viaria, não toca `paradoMin` nem o auto-resolve da Task 5).

---

## Task 7: Ajuste do limiar de velocidade mínima pro cálculo de rumo (dado real, não suposição)

**Arquivos:**
- Modificar: `src/lib/unitrac.ts` (`DIVERGENCIA_RUMO_VELOCIDADE_MIN_KMH`)

**Nota importante:** a investigação prévia já existia um gate (`DIVERGENCIA_RUMO_VELOCIDADE_MIN_KMH = 10`, `unitrac.ts:268`) — a suposição original de "falta gate de quase-parado" estava parcialmente errada (mesma lição do item de calibração). Checando 3 casos reais de hoje: 2 estavam bem acima do limiar (29-88km/h, não é o padrão dominante), 1 (TTE-6D60) tinha leituras oscilando entre 8-53km/h bem perto do limiar de 10 no momento do disparo. Não há evidência forte o bastante pra justificar uma mudança grande — esta tarefa é só uma checagem/ajuste pontual, não uma nova mecânica.

**Step 1:** Antes de mudar qualquer coisa, levantar TODOS os casos de rumo-diverge falso-positivo de hoje (não só os 3 já checados) e a velocidade reportada no momento exato do disparo — confirmar se há um padrão real de disparos concentrados perto do limiar de 10km/h (jitter em baixa velocidade) que justifique subir o valor, ou se os 3 já checados já representam a distribuição real (caso em que NÃO vale subir o limiar só com base num caso).

**Step 2:** Se o levantamento confirmar um padrão real (não só 1 caso isolado), subir `DIVERGENCIA_RUMO_VELOCIDADE_MIN_KMH` pro valor sugerido pelo dado (ex: 15), com o número justificado no comentário, igual a todo outro limiar desta sessão. Se NÃO confirmar, documentar no plano/commit que a checagem foi feita e o limiar atual (10) já é adequado — não mudar por mudar.

**Risco:** baixo (é so um numero), mas a DECISAO de mudar ou nao precisa ser baseada em dado, nao em suposicao -- essa e a unica tarefa deste plano que pode legitimamente terminar em "nao mexer em nada".

**RESULTADO (28/07, concluído):** levantados os 19 falsos positivos de rumo-diverge de hoje (não só os 3 iniciais), com a velocidade reportada exata no momento do disparo:

| velocidade (km/h) | placas |
|---|---|
| 11 | TTE-6D60 |
| 15-22 | TTM-7C10, TTI-6D27, TTF-5I10 |
| 30-59 | TUL-1C38, TUC-1D15 (x2), RQQ-1B52 (x2), TTH-6H80, TTF-9C07, TOS-4J82, RQU-0B47 |
| 68-90 | TTK-4D15, TTH-3C94, TUL-1H29, TTK-4D14, RQQ-1B52, TUL-1C38 |

Só **1 de 19** (5%) está perto do limiar atual (10km/h) — o resto (95%) está bem acima, com 14/19 (74%) a 40km/h ou mais. **Não há padrão de jitter em baixa velocidade que justifique subir o limiar** — a distribuição real confirma que o problema dominante é o de rodovia/curva (Task 4/4b, corredor real), não quase-parado. **Decisão: manter `DIVERGENCIA_RUMO_VELOCIDADE_MIN_KMH = 10` sem alteração.** Nenhum código mudado nesta tarefa.

---

## Task 8: Investigar (não corrigir às cegas) a suspeita de via mal classificada no corredor Tancredo Neves

**Arquivos:** nenhum (investigação + correção de dado, se confirmada; sem mudança de código)

Checagem prévia das células candidatas (~-22.51,-44.09, vizinhança 3x3) mostrou um padrão plausível mas AMBÍGUO: a célula central está `estreita`, vizinhas a oeste `principal`, vizinhas ao sul `intermediaria` — isso pode ser uma via realmente estreita colada numa rodovia (comum no Brasil, não seria bug) OU um segmento mal taggeado no OSM de origem. Sem as coordenadas EXATAS dos 2 casos reais que motivaram a suspeita, não dá pra confirmar — e não se corrige célula de classificação viária sem confirmar primeiro (mesmo princípio do baseline: não repetir o erro de "consertar" dado que pode estar certo).

**Step 1:** Levantar as coordenadas GPS exatas (não aproximadas) dos 2 casos que bateram 30-49km/h e ~39km/h numa via marcada estreita nesse corredor — via `posicoes_historico` dos veículos/horários específicos.

**Step 2:** Conferir a célula exata (`celula = "{round(lat*1000)}:{round(lng*1000)}"`) de cada leitura, e olhar num mapa real (Google Maps/OSM) se aquele ponto específico é de fato uma rua estreita genuína ou parte de uma via mais larga.

**Step 3 (só se confirmado como erro real):** `UPDATE vias_celulas SET classe = '<classe correta>' WHERE celula = '<celula>';` direto no Contabo, célula por célula confirmada — nunca em lote/regex sem checar cada uma. Documentar cada correção com a evidência que a justificou (mesmo padrão de todo o resto desta sessão: nunca corrigir por extrapolação).

**Risco:** nenhum se ficar só na investigação; baixo-médio se uma correção pontual for aplicada (afeta só os veículos que passam por aquela célula específica).

**RESULTADO (28/07, concluído, SEM correção aplicada):** achado o candidato mais forte — TUI-0H19 com 3 leituras seguidas a 39km/h na célula `-22517:-44093` (classe `estreita`). Duas coisas descartaram a hipótese de correção:

1. **Artefato de GPS congelado:** as 3 leituras de 39km/h (12:32:41 a 12:33:37) têm o EXATO mesmo lat/lng — a posição travou enquanto o sensor de velocidade continuou reportando um valor real. Não é uma travessia limpa de 39km/h numa rua estreita, é o mesmo artefato de "posição congelada com velocidade real" já visto noutras partes desta sessão (jammer/GPS).
2. **Não é uma célula isolada, é uma área contígua grande:** o bloco `estreita` ao redor (`-22514` a `-22518`, múltiplas colunas de longitude) tem 15 células contíguas, com `principal` só na linha imediatamente ao norte (`-22513`) — padrão consistente com "rede de ruas locais genuína ao lado de uma via arterial", não com uma via mal-taggeada isoladamente.

**Decisão: nenhuma correção em `vias_celulas`.** A evidência disponível não atinge o padrão "corrigir só com evidência do caso exato" — é ambígua o bastante (contaminada por artefato de GPS, célula não-isolada) pra não justificar mexer em dado de produção. Mesmo princípio já aplicado ao caso PetroMasa mais cedo nesta sessão (fechado como "não é bug" após checar dado real).

---

## Task 9: Remover a assimetria de retenção do contexto diagnóstico

**Arquivos:**
- Migration: `scripts/migrations/contabo/012_casos_desvio_revisao_retencao_30_dias.sql`

Achado real: contexto de casos resolvidos MANUALMENTE sobrevive só em `casos_desvio_revisao`, com retenção de 14 dias; contexto de casos auto-resolvidos sobrevive direto em `alertas.contexto`, com retenção de 30 dias (a varredura intermediária que deveria zerar contexto mais cedo está morta — nunca escreve `geom`, então o guard `geom IS NOT NULL` nunca casa). Resultado: dado de revisão humana (o mais valioso pra calibração) expira 16 dias ANTES do dado auto-resolvido. Igualar as duas janelas em 30 dias é a correção mais simples e segura (só muda um intervalo de cron, não schema nem lógica).

```sql
-- scripts/migrations/contabo/012_casos_desvio_revisao_retencao_30_dias.sql
--
-- Achado real 28/07: contexto de resolucao MANUAL (casos_desvio_revisao,
-- 14 dias) expirava 16 dias ANTES do contexto de auto-resolucao
-- (alertas.contexto, 30 dias, ver retencao em route.ts) -- o dado mais
-- valioso pra calibracao (veredito humano de verdade) sumia primeiro.
-- Iguala as duas janelas em 30 dias.
UPDATE cron.job
SET command = replace(command, 'now() - interval ''14 days''', 'now() - interval ''30 days''')
WHERE jobname = 'limpar-casos-desvio-revisao';
```

**Aplicar:** `scp` + `psql -f`. Confirmar com `SELECT command FROM cron.job WHERE jobname = 'limpar-casos-desvio-revisao';` que o intervalo virou 30 dias.

**Nota:** não mexer em `limparVarios` (status `limpo`) nesta tarefa — aquele caso é estruturalmente diferente (operador não afirma nada sobre o caso, por design não deveria alimentar calibração de qualquer forma) e está fora do escopo desta assimetria especificamente.

**Risco:** baixo — só um intervalo de retenção, sem mudança de schema/lógica.

---

## Task 4b: Fix round 1 — achados da revisão independente (BLOCK)

A revisão das Tasks 2-4 achou 1 CRÍTICO + 2 IMPORTANTES. Verdict: BLOCK. Detalhe completo já discutido; aqui a correção exata.

### 4b.1 — CRÍTICO: Task 4 é wiring morto no caso exato que motivou ela

`route.ts:2101` exige `desvioInicio` não-nulo pra rodar `verificarCorredor` — mas pela própria premissa da Task 3, `desvioInicio` (o anchor da streak de "afastando de tudo") fica null quando rumo-diverge dispara sem episódio de afastamento antes (exatamente o caso TTK-4D14, rodovia, sem afastar de nada, só divergindo em linha reta). Resultado: a checagem de corredor nunca roda pro caso que ela devia cobrir.

**Fix:** criar um anchor PRÓPRIO pra streak de divergência de rumo, espelhando EXATAMENTE o padrão já usado por `desvioInicio`/`desvioStreak` (mesmo shape `DesvioInicio {lat,lng,ts,menor_dist_m}`, mesma lógica de setar na transição 0→1 e limpar quando a streak zera).

**Step 1 — Migration:** `scripts/migrations/contabo/013_divergencia_rumo_inicio.sql`
```sql
-- scripts/migrations/contabo/013_divergencia_rumo_inicio.sql
--
-- Achado CRITICO da revisao independente 28/07 (Tasks 2-4, rumo-diverge):
-- o wiring de verificarCorredor (Task 4) exigia desvioInicio nao-nulo, mas
-- esse e' o anchor da streak de AFASTANDO DE TUDO -- fica null exatamente
-- no caso que motivou a Task 4 (rodovia com curva, divergindo em linha
-- reta SEM afastar de nada). Anchor proprio, mesmo padrao de desvio_inicio,
-- pra streak de divergencia de rumo.
ALTER TABLE posicoes_atuais ADD COLUMN IF NOT EXISTS divergencia_rumo_inicio jsonb NULL DEFAULT NULL;

NOTIFY pgrst, 'reload schema';
```

**Step 2 — `route.ts`:** ler o campo novo junto com os demais (mesmo select/map que já lê `desvio_inicio`, ~linha 622-644), tipar como `DesvioInicio | null` (reusar o tipo já existente, mesmo shape).

No bloco de cálculo de `divergenciaRumoStreak` (~linha 1539-1561), espelhar exatamente a lógica de `desvioInicio` (~linha 1362, 1384-1393):

```ts
          let divergenciaRumoStreak: number = anterior?.divergencia_rumo_streak ?? 0;
          let divergenciaRumoInicio: DesvioInicio | null = anterior?.divergencia_rumo_inicio ?? null;
          let divergenciaGrausAtual: number | null = null;
          if (pos.fresco && !saltoImplausivel && !suspensoPorChegada && podeAvancarStreaksDesvio && idxMaisProximo >= 0 && destinos[idxMaisProximo]) {
            const divergencia = divergenciaRumoGraus(
              anterior?.lat ?? pos.lat, anterior?.lng ?? pos.lng, pos.lat, pos.lng,
              destinos[idxMaisProximo].lat, destinos[idxMaisProximo].lng,
              pos.velocidade
            );
            divergenciaGrausAtual = divergencia;
            if (divergenciaRumoAcimaDoLimiar(divergencia)) {
              const streakAnterior = divergenciaRumoStreak;
              divergenciaRumoStreak += 1;
              if (streakAnterior === 0) {
                divergenciaRumoInicio = {
                  lat: anterior!.lat!,
                  lng: anterior!.lng!,
                  ts: agora.toISOString(),
                  menor_dist_m: distDestinosAnteriorM.length > 0 ? Math.min(...distDestinosAnteriorM) : 0,
                };
              }
            } else {
              divergenciaRumoStreak = 0;
              divergenciaRumoInicio = null;
            }
          } else {
            divergenciaRumoStreak = 0;
            divergenciaRumoInicio = null;
          }
```

Persistir `divergencia_rumo_inicio` no mesmo INSERT/UPSERT em lote que já grava `desvio_inicio`/`divergencia_rumo_streak` (~linha 2311, 2751-2830) — mesma serialização (`JSON.stringify(...)` se não-nulo, `null` senão).

**Step 3 — usar o anchor novo em DOIS lugares:**

(a) **Task 3 (contexto):** trocar a lógica de `desvioInicioEfetivoParaContexto` (a função que a Task 3 criou) pra, quando `origemDesvio === "rumo_diverge"`, usar `divergenciaRumoInicio` (o anchor REAL da própria streak) em vez de sintetizar da posição atual. Como rumo-diverge só dispara com `divergenciaRumoStreak >= 2` (mesmo guard de `divergenciaRumoDispara`), o anchor SEMPRE existe nesse momento (foi setado quando a streak virou 1, pelo menos 1 ciclo atrás) — elimina de vez a ambiguidade "sintético vs real" achada pela revisão (não precisa mais de dois casos/dois significados pro mesmo campo).

(b) **Task 4 (corredor):** no ponto que decide se roda `verificarCorredor` (~linha 2096-2102), quando o alerta vencedor é rumo-diverge, usar `divergenciaRumoInicio` como origem em vez de `desvioInicio` (que continua sendo usado, sem mudança, pros alertas de afastando-de-tudo). Ou seja: a escolha de qual anchor usar como origem do corredor passa a depender de QUAL regra disparou, não mais de um único `desvioInicio` compartilhado.

**Step 4 — endereçar os efeitos colaterais de `precisaVerificacaoCorredor` (achado IMPORTANTE):** ler o bloco que aplica os vereditos "dentro"/"fora" (~linha 2121-2157) — hoje ele SEMPRE mexe em `desvioStreak`/`desvioInicio` (zera em "dentro", reescreve em "fora"). Como agora um alerta de rumo-diverge também passa por esse bloco, mas o anchor relevante pra ELE é `divergenciaRumoInicio` (não `desvioInicio`), decidir explicitamente: os efeitos de "dentro"/"fora" devem mexer no anchor CORRESPONDENTE à regra que disparou (afastando-de-tudo mexe em desvioStreak/desvioInicio como já faz; rumo-diverge deveria mexer em divergenciaRumoStreak/divergenciaRumoInicio, não no do afastando-de-tudo). Implementar essa separação e documentar a decisão com um comentário explicando por que os dois streaks não podem compartilhar o mesmo efeito colateral (um alerta fraco de rumo-diverge não deveria zerar uma streak crítica de afastando-de-tudo em andamento).

**Step 5 — contenção de orçamento (achado IMPORTANTE, menor prioridade mas documentar):** `ORCAMENTO_CORREDOR_POR_CICLO`/`RESERVA_COMPORTAMENTAL_POR_CICLO` — agora que rumo-diverge realmente consome chamadas de corredor, ele disputa o mesmo orçamento que afastando-de-tudo (crítico). Não precisa resolver isso nesta rodada (o comportamento fail-open já existe — alerta sobrevive mesmo com `orcamento_estourado`), mas documentar explicitamente no código que essa disputa existe e é aceita por ora, pra não ser "descoberta" de novo numa auditoria futura.

**Step 6 — testes:** cobrir o cenário exato que motivou a Task 4 — rumo-diverge dispara SEM nenhum episódio de afastando-de-tudo (desvioInicio null), streak de divergência >= 2 (divergenciaRumoInicio não-nulo) — confirmar que a checagem de corredor RODA (não fica mais inerte). Cobrir também: efeito "dentro"/"fora" de rumo-diverge não deve mexer em desvioStreak/desvioInicio de uma streak de afastando-de-tudo em paralelo.

**Risco:** alto — é o coração do achado crítico; revisão independente obrigatória de novo antes de deploy.

---

## Ordem de execução sugerida

Tarefas 1 e 9 primeiro (baixo risco, puramente cron/retenção, não dependem de nada). Depois 2→3→4 (rumo-diverge, em sequência porque 3 e 4 dependem do `origemDesvio` novo da Task 2). Depois 6 e 7 (independentes entre si e do bloco de rumo-diverge). Task 5 por último dentro do código (maior risco, mexe no mecanismo mais sensível). Task 8 pode rodar em paralelo a qualquer momento (é só investigação, sem dependência de código).

## Verificação final

- `npm test -- --run`, `npx tsc --noEmit`, `npm run build` depois de CADA tarefa que toca código (não só no final).
- Revisão independente obrigatória pra Tasks 2, 3, 4, 5, 6 (tocam contexto/calibração/mecanismo de auto-resolve). Tasks 1, 7, 8, 9 podem ter revisão mais leve (risco baixo, mudança pontual).
- Replicar pros dois repos + aplicar migrations no Contabo + deploy manual nos 2 processos PM2, a cada tarefa concluída (não em lote no fim) — mesma disciplina já estabelecida.
