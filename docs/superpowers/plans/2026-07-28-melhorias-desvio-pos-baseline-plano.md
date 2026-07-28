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

---

## Task 8: Investigar (não corrigir às cegas) a suspeita de via mal classificada no corredor Tancredo Neves

**Arquivos:** nenhum (investigação + correção de dado, se confirmada; sem mudança de código)

Checagem prévia das células candidatas (~-22.51,-44.09, vizinhança 3x3) mostrou um padrão plausível mas AMBÍGUO: a célula central está `estreita`, vizinhas a oeste `principal`, vizinhas ao sul `intermediaria` — isso pode ser uma via realmente estreita colada numa rodovia (comum no Brasil, não seria bug) OU um segmento mal taggeado no OSM de origem. Sem as coordenadas EXATAS dos 2 casos reais que motivaram a suspeita, não dá pra confirmar — e não se corrige célula de classificação viária sem confirmar primeiro (mesmo princípio do baseline: não repetir o erro de "consertar" dado que pode estar certo).

**Step 1:** Levantar as coordenadas GPS exatas (não aproximadas) dos 2 casos que bateram 30-49km/h e ~39km/h numa via marcada estreita nesse corredor — via `posicoes_historico` dos veículos/horários específicos.

**Step 2:** Conferir a célula exata (`celula = "{round(lat*1000)}:{round(lng*1000)}"`) de cada leitura, e olhar num mapa real (Google Maps/OSM) se aquele ponto específico é de fato uma rua estreita genuína ou parte de uma via mais larga.

**Step 3 (só se confirmado como erro real):** `UPDATE vias_celulas SET classe = '<classe correta>' WHERE celula = '<celula>';` direto no Contabo, célula por célula confirmada — nunca em lote/regex sem checar cada uma. Documentar cada correção com a evidência que a justificou (mesmo padrão de todo o resto desta sessão: nunca corrigir por extrapolação).

**Risco:** nenhum se ficar só na investigação; baixo-médio se uma correção pontual for aplicada (afeta só os veículos que passam por aquela célula específica).

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

## Ordem de execução sugerida

Tarefas 1 e 9 primeiro (baixo risco, puramente cron/retenção, não dependem de nada). Depois 2→3→4 (rumo-diverge, em sequência porque 3 e 4 dependem do `origemDesvio` novo da Task 2). Depois 6 e 7 (independentes entre si e do bloco de rumo-diverge). Task 5 por último dentro do código (maior risco, mexe no mecanismo mais sensível). Task 8 pode rodar em paralelo a qualquer momento (é só investigação, sem dependência de código).

## Verificação final

- `npm test -- --run`, `npx tsc --noEmit`, `npm run build` depois de CADA tarefa que toca código (não só no final).
- Revisão independente obrigatória pra Tasks 2, 3, 4, 5, 6 (tocam contexto/calibração/mecanismo de auto-resolve). Tasks 1, 7, 8, 9 podem ter revisão mais leve (risco baixo, mudança pontual).
- Replicar pros dois repos + aplicar migrations no Contabo + deploy manual nos 2 processos PM2, a cada tarefa concluída (não em lote no fim) — mesma disciplina já estabelecida.
