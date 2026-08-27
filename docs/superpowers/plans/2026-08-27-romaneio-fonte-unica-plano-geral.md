# Romaneio como fonte única de verdade + latência + parada anômala — Plano Geral

> **Para quem retomar:** REQUIRED SUB-SKILL: superpowers:executing-plans (Fase 1) / superpowers:subagent-driven-development.
> Este é um plano de PROGRAMA (várias fases), não um plano de task único. Fase 1 está no nível de detalhe de execução. Fases 2-4 são roadmap — cada uma precisa do próprio spec/plano quando for a vez, seguindo a disciplina já estabelecida neste projeto (spec → plano → SDD, nunca big-bang, sempre validar contra dia real antes de deployar).

**Contexto de origem:** pedido direto do dono do produto em 27/08 após reclamações reais no grupo "DESVIO DE ROTA" (26-27/08): atraso grande pra acusar desvio/parada, `parada_anomala` disparando com o veículo já no cliente, e a exigência explícita de que o motor pare de depender da Unitrac para saber onde fica cada cliente e passe a confiar só no romaneio.

**Escopo confirmado pelo usuário (27/08, corrige a v1 deste plano) — DUAS CENTRAIS SEPARADAS, NÃO UMA UNIÃO:**
> "A gente tem que desligar o Unitrack. Não tem que usar o Unitrack. [...] a Central Unitrack e a Central Romaneio é só romaneio, por conta que o Unitrack tem erro. A única coisa que a gente tem que trazer da Unitrack é o rastro dos caminhões e talvez até confirmações de entrega. Acabou."

Ou seja: **Central Unitrac** (motor principal, `motor/route.ts`) e **Central Romaneio** (`motor-romaneio/route.ts`) são dois sistemas paralelos e independentes, não um merge. A Central Romaneio **nunca** lê alvo/marcação da Unitrac — zero. As únicas duas coisas que ela pode puxar da Unitrac são: (1) **rastro** — posição GPS ao vivo do veículo (lat/lng/velocidade), que não tem substituto, é o provedor de rastreamento; (2) **possivelmente** confirmação de entrega (sinal auxiliar, a definir se/quando for útil). Todo o resto — onde fica cada cliente, todas as regras de desvio/parada — roda 100% sobre o romaneio geocodificado. A v1 deste plano (Fase 1 original) propunha UNIR Unitrac+romaneio no cálculo de `noCliente` — **isso foi descartado pelo usuário**, ver Fase 1 revisada abaixo.

---

## Estado real do código (levantado hoje, 27/08, não é suposição)

- **Motor principal** (`src/app/api/motor/route.ts:1613-1644`) monta `pontosVeiculo` SEMPRE a partir de Unitrac. Comentário no próprio código: *"a Central NAO PODE MAIS ser afetada pelo romaneio — decisao revertida (era 15/07)"*.
- **Motor-romaneio paralelo** (`src/app/api/motor-romaneio/route.ts:572-573`) só processa veículo que **não tem nenhum** alvo na Unitrac (`if (pontosUnitracVeiculo.length > 0) continue`). É fallback, não fonte primária.
- **Flag por cliente já existe**: `CLIENTES_COM_MOTOR_ROMANEIO_PARALELO = new Set(["4096"])` (Nutry Max), `motor/route.ts:228`. Desde **26/08** essa flag desliga `parada_longa`/`parada_anomala`/`parada_fora_tapete` pra esse cliente na Central, porque `noCliente` (`motor/route.ts:1815-1818`) só reconhece alvo Unitrac.
- **Consequência grave e não anunciada**: hoje, pra Nutry Max, NENHUM detector de parada roda — nem na Central (desligado pela flag) nem no motor-romaneio (nunca foi implementado lá). Só sobrou "desvio" comportamental. Isso viola a diretriz permanente do projeto de nunca perder desvio real (recall > precisão) — é regressão silenciosa, precisa de ação imediata, não pode esperar a Fase 4.
- **Motor-romaneio implementa hoje só**: `avaliarAfastandoDeTudo` (desvio) + corroborações (corredor OSRM, classe viária). Faltam ~10 detectores (pânico, baú, jammer, saída não autorizada, excesso de velocidade, parada no cliente, parada longa, parada anômala, parada fora do tapete, retorno tardio, ignição noturna, aceleração, bypass de entrega, parada sem marcação, baseline, tiroteio) — todos hoje dependem de conceitos só-Unitrac (`pt.feito`, `pontoCodigo`, `alvo.raio`).
- **Latência**: ciclo confirmado em 30s (pg_cron), `LIMIAR_STREAK_AFASTANDO=2` (~60s+ estrutural). Fix de 21/08 do limiar de 12min de `parada_anomala` segue correto no código. **Não existe nenhum cooldown que atrase a PRIMEIRA detecção em dezenas de minutos** — os cooldowns existentes só suprimem redisparo após tratamento humano. O próprio repo já documentou DUAS vezes esse exato padrão de queixa ("atrasou Xmin") que não era latência de detecção: uma vez era alerta real fechado 80s depois por ação em massa antes de revisão humana; outra vez a causa estava em outro ponto do pipeline. **Não mexer em parâmetro de latência sem reconstruir a timeline real primeiro** (Fase 2).
- **Geocodificação do romaneio**: doc de blindagem já existe (`docs/superpowers/specs/2026-08-26-blindagem-geocodificacao-romaneio-design.md`), item 1 (não aceitar candidato cego sem cidade+ambiguidade) já implementado (`30517ee`). Itens 2-5 pendentes.
- **Zero teste automatizado** na orquestração das duas rotas (`motor/route.ts` 4127 linhas, `motor-romaneio/route.ts` 1057 linhas) — só as funções puras de decisão têm teste. É exatamente onde vivem os bugs dos itens acima. Qualquer fase daqui pra frente que mexer nessas rotas precisa de teste novo antes, não depois.

---

## Fase A — UX da Central Romaneio (pode rodar em paralelo às Fases 1-4, independente do backend)

**Pedido do usuário (27/08), cruzado com as próprias mensagens do grupo "DESVIO DE ROTA" de 26/08 que pediam isso mesmo** ("colocar uma aba pra escrever o motivo do falso", "aba central romaneio com 3 desvios e não aparece as paradas anômala"): aba "Desvios" mostrando junto `desvio`+`parada_anomala`, o resto numa aba "Todos", botões Limpar avisos/Resolver todos, e fluxo de Falso = escrever motivo → confirmar.

**Investigação do código atual (27/08) — já mais pronto do que parecia, mas com gaps reais:**

- **UI é compartilhada**: Central Romaneio (`src/app/(app)/central-romaneio/page.tsx`) e Central Unitrac usam o MESMO componente `MonitorV2.tsx` — só trocam `fonteAlertas`/tabela. **Qualquer mudança de UI feita ali afeta as duas Centrais ao mesmo tempo** — cuidado extra em todo item abaixo.
- **Item "Resolver todos"/"Limpar avisos"**: ✅ já existe, já funciona certo na Central Romaneio (mesma Server Action, aponta pra tabela certa desde 22/08). Nada a fazer.
- **Item aba "Desvios" (desvio+parada_anomala juntos)**: parcialmente existe, mas por acidente de reaproveitamento — é a aba "foco" (`vista==="foco"`), condicionada a um mapa hardcoded por cliente (`TIPOS_NOTIFICAM_POR_CLIENTE`/`LABEL_FOCO_POR_CLIENTE`, `MonitorV2.tsx:125-145`). Pra Nutry Max (`4096`) hoje ela já se chama "DESVIOS" mas mistura `parada_fora_tapete`+`parada_sem_marcacao` junto — o pedido é só `desvio`+`parada_anomala`, o resto vai pra "Todos". Além disso, se um cliente novo não estiver nesse mapa, ele simplesmente não ganha a 2ª aba — falha silenciosa.
- **Item aba "Todos"**: não existe com essa semântica. A aba "TUDO" de hoje é literalmente tudo (inclui desvio+parada_anomala também), não é o complemento ("o que sobrou"). O pedido implica 2 abas mutuamente exclusivas, não 1 aba geral + 1 aba subconjunto.
- **Item Falso com motivo → confirmar**: parcialmente existe. Hoje: textarea de motivo é OPCIONAL, e clicar em qualquer uma das 4 categorias já SUBMETE na hora (categoria = confirmação implícita) — não existe um botão "Confirmar" separado do clique na categoria. Já roda igual na Central Romaneio (não é exclusivo da Central Unitrac). Falta: transformar em fluxo de 2 passos reais (escolher categoria/escrever motivo → botão Confirmar explícito), como descrito pelo usuário.

**Files:**
- Modify: `src/app/(app)/central-v2/MonitorV2.tsx:125-145` (mapas de aba por cliente), `:2336-2354` (render das abas), `:1171`/`:1205`/`:2361` (filtro por `tiposFoco`)
- Modify: `src/app/(app)/components/MenuMotivoFalso.tsx` (fluxo de confirmação)
- Modify: `src/app/(app)/acoes-alertas.ts` (se o novo fluxo de confirmar precisar de ajuste na Server Action — provavelmente não, ela já aceita categoria+texto juntos)

**Task A.1 — Trocar a aba "foco" por cliente por uma aba "Desvios" fixa e sempre presente**
Decisão de design (a mais segura, não mexe no que já existe pra não quebrar Central Unitrac pra outros clientes): **não reaproveitar/redefinir "TUDO"**. Adicionar uma 3ª aba nova e fixa chamada "Desvios" com `tipos = ["desvio", "parada_anomala"]` fixo (não mais o `Record` por cliente), sempre visível independente de mapeamento, tanto na Central Unitrac quanto na Romaneio. "TUDO" continua mostrando tudo (rede de segurança, ninguém perde visibilidade). Isso cobre literalmente o pedido ("desvios" + "os outros ficam em todos") sem repurposar comportamento existente que outros clientes já usam.
*(Alternativa mais literal — fazer "TUDO"/"Todos" virar o complemento de "Desvios", removendo desvio/parada_anomala de lá — muda comportamento visível pra Benassi e outros clientes hoje; se preferir essa versão em vez da aditiva, avisar antes de codar, é decisão de produto que afeta os dois clientes.)**

**Task A.2 — Migrar `parada_fora_tapete`/`parada_sem_marcacao` (hoje misturados na aba foco da Nutry) pra fora da aba "Desvios"**
Ficam só em "TUDO" — não em "Desvios" (que passa a ser só desvio+parada_anomala) nem precisam de aba própria, a não ser que o usuário peça depois.

**Task A.3 — Escrever teste de UI (se houver suíte de componente) ou pelo menos um teste manual documentado pro filtro novo**
Confirmar que a aba "Desvios" aparece pra QUALQUER cliente (não só os hardcoded), já que isso corrige a falha silenciosa atual.

**Task A.4 — Redesenhar `MenuMotivoFalso.tsx`: separar seleção de confirmação**
Categoria vira seleção (estado local, tipo radio), textarea continua opcional, e um botão "Confirmar Falso" explícito dispara o submit (categoria + texto juntos, mesma Server Action de hoje — `marcarFalsoComCategoria`/`marcarFalsoPositivoComMotivo` em `acoes-alertas.ts`, sem mudança de assinatura esperada). Desabilitar o botão Confirmar até uma categoria estar selecionada (texto sozinho sem categoria continua não sendo permitido — é a mesma regra de hoje, só muda o momento do clique).

**Task A.5 — Verificar 2 bugs relatados no grupo em 26/08 antes de considerar essa fase fechada**
"Aba central romaneio com 3 desvios e não aparece as paradas anômala, e nem abre a parte TUDO" (mensagem 08-26 09:19) — reproduzir contra o código atual; pode já estar resolvido pelas mudanças de 26/08 (`parada_anomala` entrou no `TIPOS_NOTIFICAM_POR_CLIENTE`), mas o "não abre TUDO" não foi confirmado como corrigido — checar.

---

## Fase 1 — URGENTE: `noCliente` da Central Romaneio usa só romaneio (zero Unitrac)

**Objetivo:** implementar `noCliente` e os 3 detectores de parada (`parada_longa`, `parada_anomala`, `parada_fora_tapete`) **dentro da própria Central Romaneio** (`motor-romaneio/route.ts`), usando exclusivamente os pontos do romaneio geocodificado. **Não tocar em `motor/route.ts` (Central Unitrac) — ela continua existindo do jeito que está, é um sistema separado, não é fonte de dado pra Central Romaneio.**

Isso resolve os dois problemas de uma vez: o falso positivo (parada anômala disparando com o veículo já no cliente, porque hoje só a Unitrac decide "no cliente") e o falso negativo grave que existe agora (Nutry Max sem detector de parada nenhum, porque a flag de 26/08 desligou na Central Unitrac e a Central Romaneio nunca teve isso implementado).

**Files:**
- Modify: `src/app/api/motor-romaneio/route.ts` (adicionar cálculo de `noCliente` + os 3 detectores, hoje só tem desvio/Sinal A)
- Reaproveitar: `src/lib/detectores.ts` — `detectarParadaAnomala`/`detectarParadaLonga`/`detectarParadaForaTapete` já existem como funções puras testadas (168 testes em `detectores.test.ts`), só precisam ser chamadas com o dado certo. Não duplicar lógica.
- Modify: `src/app/api/motor/route.ts:228` (`CLIENTES_COM_MOTOR_ROMANEIO_PARALELO`) — manter a flag desligando esses 3 detectores na Central Unitrac pra Nutry Max (não reverter — a Central Romaneio é quem passa a cobrir isso pra esse cliente, não as duas ao mesmo tempo, senão dobra alerta).
- Test: novo arquivo de integração pra `motor-romaneio/route.ts` (hoje zero teste de rota, só as funções puras).

**Task 1.1 — Confirmar a estrutura de pontos que a Central Romaneio já usa pro Sinal A**
`motor-romaneio/route.ts` já monta uma lista de pontos do romaneio por veículo (usada por `avaliarAfastandoDeTudo`). Ler exatamente essa estrutura (campos disponíveis: raio? código do ponto? flag de entrega feita?) antes de reaproveitá-la pro `noCliente` — é a mesma fonte, só precisa virar entrada pros 3 detectores de parada também.

**Task 1.2 — Calcular `noCliente` só com pontos do romaneio**
```ts
// motor-romaneio/route.ts, no ciclo por veículo
const maisProximoQualquer = alvoMaisProximoQualquer(pos.lat, pos.lng, pontosRomaneioVeiculo);
const noCliente = pos.velocidade === 0 && maisProximoQualquer !== null &&
  maisProximoQualquer.distM <= Math.max(maisProximoQualquer.ponto.raio, 150);
```
Nenhuma referência a `pontosUnitracPorPlaca` nesse cálculo — só o rastro (posição/velocidade) vem de Unitrac, o alvo é 100% romaneio.

**Task 1.3 — Chamar os 3 detectores de parada com o `noCliente` da Task 1.2**
Reaproveitar `detectarParadaAnomala`/`detectarParadaLonga`/`detectarParadaForaTapete` de `detectores.ts` (assinatura já existe, só passar os parâmetros vindos da Central Romaneio em vez da Central Unitrac). Gravar alerta na mesma tabela `alertas` com `origem`/`modo_teste` consistente com o que a Central Romaneio já grava pro desvio hoje.

**Task 1.4 — Escrever teste de integração da rota (novo, não existe hoje)**
Criar teste cobrindo o caso real RBJ-2J67: veículo parado no ponto do romaneio, sem qualquer alvo na Unitrac (ou mesmo com um alvo Unitrac errado/ausente — não importa, a Central Romaneio nem olha pra isso) → `noCliente=true`, nenhum dos 3 detectores dispara.

**Task 1.5 — Rodar `scripts/simular-dia-desvio-v2.mjs` (ou equivalente pra Central Romaneio) contra 26/08 ANTES de deployar**
Disciplina já estabelecida neste projeto — nunca aceitar mudança no motor sem validar contra dia real primeiro. Comparar volume de alertas de parada pra Nutry Max antes/depois.

**Task 1.6 — Deploy manual nos 2 processos PM2 (Contabo) + replicar commit pro repo definitivo**
`git pull && npm ci && npm run build && pm2 restart --update-env` em `transmonseg-temp` e `transmonseg-definitivo`. Confirmar `git log --oneline -3` igual nos dois repos antes de seguir pra próxima fase.

---

## Fase 2 — Diagnóstico de latência — CONCLUÍDA (27/08, investigação pura, zero escrita)

**Veredito confirmado com dado real (26/08, 5 casos citados no grupo, 4 identificados com confiança): é a TERCEIRA vez que esse padrão de queixa se dissolve em percepção/processo, não latência de detecção.**

Fatos estruturais medidos:
- Insert do alerta no banco: **36-60s** em todos os tipos (rápido, não é o gargalo).
- Cadência de posição por veículo: **p50 67s / p90 93s / p99 122s** — piso real do rastreador, não do pg_cron (30s).
- Delta real de detecção nos casos investigados: **1,5 a 8min** (dentro do esperado pelo streak de 2 leituras + limiar de 12min da parada, ambos por design).
- Tempo até o operador tratar o alerta (`limpar_massa`): **mediana 22min, p90 76min** — é aqui que os 8-77min relatados batem.

Caso mais didático: **RQS-7H76 "77 minutos de atraso"** — o alerta de `parada_anomala` disparou corretamente aos 12min (09:30:31); ficou 64min aberto sem tratamento; o "77 minutos" citado é literalmente o TEXTO do motivo do alerta ("Parada suspeita de 1h17min", a duração do evento) lido pelo operador quase 1h depois — não é o sistema atrasando, é a UI mostrando duração do evento em vez de "detectado há X min" e ninguém ter olhado a tela a tempo.

**Decisão tomada com base no dado: NÃO seguir para "trocar pg_cron por LISTEN/NOTIFY"** — ganho máximo de ~30s sobre um piso de 2-4min imposto pelo tracker, sem relação com os atrasos relatados. **NÃO mexer em `LIMIAR_STREAK_AFASTANDO`** — baixar pra 1 ganha ~70s ao custo direto de mais falso positivo, contra a diretriz de recall do projeto.

**O que o dado sustenta como próximo passo real (novo backlog, não estava no plano original):**
1. **Mostrar idade/hora de detecção no card do alerta** ("detectado 09:30 · aberto há 64min"), separado da duração do evento que já aparece no `motivo` — ataca a causa raiz nº1 (confusão entre "atraso do sistema" e "duração do evento"), barato de implementar.
2. **Destacar visualmente alerta velho sem tratamento** (ex: a partir de 10min de idade) — ataca a causa raiz nº2 (mediana de 22min, p90 76min até alguém agir).
3. **Monitorar `atraso_min` por veículo e sinalizar GPS defasado** (13,5% dos fixes de 26/08 chegaram com ≥10min de atraso, concentrado nalguns veículos específicos tipo TML-3B11/UBF-5G32/KNZ-5B07) — é a única latência tecnicamente real encontrada, vem da Unitrac na origem, hoje invisível pro operador.
4. Caso TTD-7H14 específico: avaliar se o streak deveria tolerar paradas curtas sem zerar (afastamento intermitente quebra a sequência) — reduziria o delta de 8min pra ~3min nesse padrão específico. É mudança de lógica de detecção, precisa shadow mode, não é ajuste de parâmetro — não fazer sem validação.

Relatório completo (5 casos, evidência de banco caso a caso) fica no ledger desta fase, `.superpowers/sdd/...` (workspace de sessão, não versionado).

---

## Fase 2B — UX de latência percebida (detalhada 27/08, REVISADA 27/08 após achado crítico)

**A v1 desta seção estava errada — revisão independente achou antes de qualquer código ser escrito.** Eu tinha investigado só `CardAlertaCritico.tsx` (confirmado código morto, sem importador em `src`) e concluído que a lógica de idade do alerta "não existia" no card real. **Errado**: ela existe, ao vivo, dentro do próprio `MonitorV2.tsx` — só não olhei longe o bastante no mesmo arquivo. Registrando aqui pra não repetir: antes de dizer "isso não existe", grep pelo NOME DA FUNÇÃO (`tempoAtras`, `corIdade`, etc.) no arquivo inteiro, não só no componente óbvio.

**O que já está no ar (desde 13/08, achado real de um alerta parado 19h sem revisão entre 92 ativos):**
- `MonitorV2.tsx:143-148` `tempoAtras(desde)` — formata `Xmin`/`Xh`/`Xd`.
- `MonitorV2.tsx:163-170` `corIdadeAlerta(desde, tema)` — **limiares pedidos pelo usuário em 13/08**: 3h = atenção (amarelo), 8h+ = crítico (vermelho), canal de cor separado do tipo/nível do alerta de propósito.
- Renderizado em `:1487-1494` (card da sidebar) e `:1671-1672` (chip sobre o mapa) — `{idade.cor && "⏱ "}{tempoAtras(a.desde)}`: quando o alerta é recente (`idade.cor === ""`), aparece só o número solto (ex: `12min`), **sem ícone, sem rótulo, sem tooltip** — é exatamente essa ambiguidade que gerou o caso RQS-7H76 (via texto de `motivo`, não desse indicador, mas o problema de fundo — número sem contexto — é o mesmo).
- GPS defasado (item 3 do backlog) **também já tem sinal parcial**: `MapaLeafletV2.tsx:220` muda o ícone do veículo no mapa a partir de 60min sem comunicação; `MonitorV2.tsx:2128-2135` já tem botões de filtro COMM 10min/30min/60min na barra principal; painel de detalhe (`:1808-1809`) já destaca em amarelo acima de 30min.

**Trabalho real desta fase, então, é MUITO menor do que a v1 supunha — é calibração e rótulo, não construção:**

### Task 2B.1 — Dar contexto ao número que já aparece no card (`tempoAtras`)

**Files:** `src/app/(app)/central-v2/MonitorV2.tsx:1486-1496` (card da sidebar) e `:1671-1672` (chip do mapa).

Hoje, quando `idade.cor === ""` (alerta recente, caso normal), o span renderiza só `12min` — nem o ⏱ aparece (só aparece quando já está velho). Mudança mínima, sem risco de overflow (o texto em si não cresce, só ganha ícone + tooltip):
1. Sempre renderizar o ⏱ (tirar a condição `idade.cor &&` antes do ícone) — sinaliza visualmente "isto é um relógio", mesmo quando novo.
2. Sempre setar o `title` (tooltip on-hover), não só quando `idade.cor` existe — hoje o `title` só existe pra alerta velho ("Parado sem revisao ha' muito tempo"). Pra alerta recente, `title` pode virar algo como `"Detectado há {tempoAtras(a.desde)}"` — deixa explícito que é a idade da DETECÇÃO, sem competir por espaço com o `motivo` (que pode ter a duração do evento embutida, tipo "Parada suspeita de 1h17min" — os dois números continuam visualmente separados, um é tooltip, outro é texto do card).

Testar nos 3 layouts que apertam espaço: card normal, card com badge extra (`parada_sem_marcacao` tem "POSSÍVEL DESVIO" ao lado, `:1478-1485`), e modo compacto/split view (`:1666`, `:1110-1113`) — confirmar que não estoura.

### Task 2B.2 — Recalibrar os limiares de destaque — **PERGUNTA AO USUÁRIO, não decisão de código**

Os limiares atuais (3h atenção / 8h crítico, `MonitorV2.tsx:163-164`) foram **pedidos explicitamente pelo usuário em 13/08** — não são um valor arbitrário pra "consertar". A Fase 2 mediu mediana de 22min / p90 76min até tratamento, o que sugere um limiar bem mais baixo faria mais sentido pro problema de hoje — mas mudar isso é reabrir uma decisão de produto dele, não um ajuste técnico.

**Decisão do usuário (27/08): "faz o que for melhor pro sistema" — autorizado recalibrar.** Valores escolhidos com base no dado da Fase 2: `LIMIAR_ALERTA_ATENCAO_MIN = 30` (logo acima da mediana de 22min até tratamento — pega quem está demorando mais que o normal, sem pintar a maioria dos alertas em fluxo saudável), `LIMIAR_ALERTA_CRITICO_MIN = 90` (perto do p90 real de 76min, arredondado pra cima do lado conservador). Substitui os `3*60`/`8*60` de `MonitorV2.tsx:163-164`.

### Task 2B.3 — Badge de GPS defasado na lista/card de alerta (o gap real, depois do inventário completo)

Com o inventário completo (mapa a 60min, filtro COMM 10/30/60min, painel de detalhe a 30min), **o gap real é**: não existe indicador de GPS defasado dentro do CARD/LISTA de alertas em si (só no mapa e no painel de detalhe de um veículo já selecionado) — e o limiar visual do mapa (60min) é 6x mais alto que o achado da Fase 2 (13,5% dos fixes de 26/08 com ≥10min de atraso).

**Decisão de design já tomada (não reabrir na implementação):** não vira novo tipo em `alertas`/`alertas_romaneio` — confirmado que existe máquina real de calibração/silenciamento (`motor/route.ts:137-140`, `:3138-3142`, `:1418-1500`; `motor-romaneio/route.ts:1818-1850`) que um tipo novo ativaria sem necessidade, já que isso é sinal de qualidade de dado, não risco de desvio.

**Files:** `src/app/(app)/central-v2/MonitorV2.tsx` — adicionar um badge pequeno no card do alerta (reaproveitar `atraso_min` do veículo dono do alerta, já disponível em `veiculosMapa`) quando `atraso_min >= 10`. Não precisa reconstruir nada do mapa/filtro/painel de detalhe, que já cobrem seus próprios contextos.

### Critério de aceite (as 3 tasks)
- **Task 2B.1**: `npx vitest run` (adicionar teste pra `tempoAtras`/`corIdadeAlerta` em `MonitorV2.test.ts` — hoje ZERO teste apesar de estarem em produção desde 13/08, é a task certa pra cobrir isso), `npx tsc --noEmit`, `npm run build` limpos. Verificação manual/print nos 3 contextos de espaço apertado.
- **Task 2B.2**: só entra em execução depois da resposta do usuário. Se ele topar recalibrar, mesmo critério de teste da 2B.1 aplicado aos novos valores.
- **Task 2B.3**: badge aparece só quando `atraso_min >= 10` pro veículo do alerta, sem afetar o filtro/mapa/painel existentes (testar que os 3 continuam com seus limiares próprios intactos).

### Ordem sugerida
2B.1 primeiro (menor risco, maior clareza imediata). 2B.2 fica bloqueada até o usuário responder a pergunta de recalibração. 2B.3 é independente, pode rodar em paralelo com 2B.1.

---

## Fase 3 — Terminar a blindagem de geocodificação do romaneio + camada de CEP

**Objetivo:** antes de confiar 100% no romaneio como fonte única (Fase 4), garantir que a geocodificação dele é confiável — hoje só o item 1 dos 5 do plano de blindagem (26/08) está feito.

- Completar itens 2-5 de `docs/superpowers/specs/2026-08-26-blindagem-geocodificacao-romaneio-design.md` (auditar truncamento de cidade, investigar tier OSM local, logar geocodificação sem cidade, parar reprocessamento infinito de `pendente`).
- **Novo, da pesquisa de tecnologia**: adicionar camada de CEP como fonte primária quando o romaneio trouxer CEP (nem sempre traz, confirmar com o cliente — ele já perguntou sobre isso). Pipeline sugerido: `libpostal` normaliza o texto livre → se tiver CEP válido, resolve via base local (dataset tipo OpenCEP/`banco-ceps`, sem depender de API terceira) → só cai pro geocoder (Google/Nominatim/OSM local) atual quando não há CEP ou ele falha. Isso é aditivo ao pipeline existente, não substitui.

**STATUS (27/08, itens 2/4/5 + achado extra): COMPLETA e deployada.** Ver
`.superpowers/sdd/2026-08-27-romaneio-fonte-unica-plano-geral/task-fase3-report.md` pro relatório
completo. Resumo:
- Item 2: premissa do brief estava errada (truncamento já funcionava), mas achou 9 formas reais de
  corrupção/truncamento não cobertas (286 linhas/30d) + achado extra fora do escopo (cidade é o
  TERCEIRO segmento do endereço, não o último — erro real de ~137km corrigido).
- Item 3 (condicional, achou): cache de âncora de cidade (`romaneio_geocode_cache`, chaves
  `CIDADE:*`) tinha 53/178 entradas fora do bounding box do RJ (ex: Natividade/TO em vez de
  Natividade/RJ, ~1500km) — a régua de validação de distância estava envenenada em produção. Fix
  qualifica cidade reconhecida do RJ com ", RJ, Brasil" na busca E na chave de cache.
- Item 4: log de aviso quando geocodificação local/CNEFE resolve sem ponto de cidade (sem
  bloquear nada).
- Item 5: reprocessamento infinito não estava onde o plano supunha (não é `pendente`, é o fallback
  Unitrac sobre linhas `falhou`, sem `ORDER BY`, retentando pra sempre). Limite de 10 tentativas
  espaçadas 30min, migration `061` aplicada em produção.
- **Ação de dado em produção (fora do código, decisão do controller 27/08):** as 53 entradas de
  cache envenenadas foram apagadas (auto-reconstroem); migration `061` aplicada.
- **Pendências ainda abertas:** coordenadas já gravadas erradas em `romaneio_pontos` (Búzios
  ~160km, Rio das Ostras ~137km) não foram corrigidas — precisa de reprocessamento dirigido;
  `romaneio_cliente_codigo_geocode` (write-once) auditada só contra erro interestadual (0/8056),
  não contra erro intra-RJ; caso RBJ-2J67 original sem causa raiz 100% fechada.
- Camada de CEP (item novo desta fase, não do plano de blindagem original) **não foi iniciada**.

---

## Fase 4 — Central Romaneio com paridade total de detectores (a mudança estrutural grande)

**Objetivo real do pedido do usuário, confirmado:** a Central Romaneio vira o sistema completo e independente pros clientes migrados — não usa NENHUMA marcação da Unitrac, só o rastro (posição/velocidade) e possivelmente confirmação de entrega. A Central Unitrac continua existindo como está, pros clientes/casos que ainda não migraram — são dois sistemas paralelos, o usuário não pediu pra apagar a Central Unitrac.

**O que falta, concretamente:** hoje a Central Romaneio só implementa desvio (Sinal A) + as 3 paradas que entram na Fase 1. Faltam ~11 detectores que hoje só existem na Central Unitrac e dependem de conceitos Unitrac-específicos (`pt.feito`, `pontoCodigo`, `alvo.raio`, casamento por NF/código): pânico, baú, jammer, saída não autorizada, excesso de velocidade, retorno tardio, ignição noturna, aceleração, bypass de entrega, parada sem marcação, baseline de veículo, tiroteio/zona de risco. Cada um precisa ser reimplementado pra ler dado do romaneio (ou, no caso de pânico/baú/jammer/aceleração/ignição, que não dependem de "onde fica o cliente" — só de rastro/telemetria — só precisam ser plugados na Central Romaneio sem mudança de lógica nenhuma, é o subconjunto mais barato de fazer primeiro).

**Ordem sugerida dentro da Fase 4** (do mais barato/seguro pro mais arriscado):
1. Detectores que só dependem de rastro/telemetria, não de marcação de cliente (pânico, baú, jammer, aceleração, ignição noturna, excesso de velocidade) — plugar na Central Romaneio sem reescrever lógica, só trocar a fonte de posição pro pipeline dela.
2. Detectores que dependem de marcação de cliente mas não de estado "feito"/NF (parada sem marcação, retorno tardio, baseline) — adaptar pra usar pontos do romaneio.
3. Detectores que dependem de casamento por NF/código de entrega (bypass de entrega) — só depois da Fase 3 (qualidade de geocodificação) e de confirmar como fica "confirmação de entrega" vinda da Unitrac (ponto em aberto do usuário: "talvez até confirmações de entrega").
4. Zona de risco/tiroteio — já é geofence independente de cliente/Unitrac, deveria já funcionar pra qualquer veículo com posição; só confirmar que está de fato ligado na Central Romaneio.

**Disciplina obrigatória, igual às fases anteriores:**
- **Rollout por cliente**, começando por Nutry Max (já é quem tem a infra da Central Romaneio hoje).
- **Shadow mode** antes de qualquer detector novo virar alerta visível: gravar em log, comparar contra a Central Unitrac (que ainda vai estar rodando em paralelo pra esse cliente até a migração ser validada) por pelo menos 3 dias úteis reais.
- **Escrever teste de integração da rota ANTES de mexer** (não depois) — hoje não existe nenhum pra `motor-romaneio/route.ts`, é o maior risco identificado.
- Quando Nutry Max estiver com paridade completa e validada, aí sim considerar desligar a Central Unitrac pra esse cliente (não antes).

Esta fase precisa do próprio spec+plano detalhado quando for priorizada — 11 detectores é trabalho de várias semanas, não dá pra planejar linha a linha agora. Recomendo tratar cada detector (ou grupo do item 1) como seu próprio incremento com spec→plano→SDD, não um plano único gigante.

---

## Pesquisa de tecnologia (GitHub) — o que vale usar, por fase

| Necessidade | Tecnologia | Onde entra |
|---|---|---|
| CEP → coordenada sem depender de terceiro | OpenCEP / `banco-ceps` (dataset local, MIT) | Fase 3 |
| Normalizar endereço texto livre (cidade truncada, etc.) | `libpostal` (binding Node) | Fase 3 |
| Geofence (buffer + dwell time) pra corrigir falso positivo de parada | `turf.js` (`booleanPointInPolygon`, `pointToLineDistance`) — já é JS puro, roda no Next.js sem infra nova | Fase 1 (pode simplificar a Task 1.2) |
| Fuzzy match de endereço | `pg_trgm` (extensão nativa do Postgres, já disponível) | Fase 3 |
| Fuzzy match de nome de cliente | `Fuse.js` (em memória, romaneio é lista pequena por rota) | Fase 3 |
| Reduzir latência de 30s de polling | `LISTEN/NOTIFY` nativo do Postgres (troca pg_cron por evento transacional) | **Só se** a Fase 2 confirmar que é latência de detecção real |
| Re-snappar GPS ruidoso à via | `/match` do próprio OSRM (já self-hosted, zero infra nova) | Opcional, se Fase 2 achar ruído de GPS como causa |
| Referência de design de geofence engine | Traccar (github.com/traccar, Apache-2.0) — não plugar, só estudar a lógica de regra+dwell time | Leitura de referência pra Fase 4 |

**Descartado conscientemente:** motores de rota alternativos (Valhalla) — não há ganho claro sobre o OSRM já em produção. Bibliotecas de "anomaly detection" com ML pra trajetória GPS — nenhuma madura o suficiente pra produção; o padrão real da indústria (Traccar incluso) é regra de geofence+dwell time, que é o que este plano já usa.

---

## Fase 2C — Jammer 20-30min + repetição de alerta (investigada 27/08, 2 bugs reais confirmados)

**Origem:** duas queixas reais do grupo (26-27/08): Natália perguntou sobre atraso de 20-30min no
jammer; mensagem separada "Sistema repetindo o veículo mesmo após concluir se é correto". Investigado
caso a caso contra o banco real (26-27/08), zero escrita.

### Jammer 20-30min — NÃO é bug, é limiar por design
`src/lib/detectores.ts:174-180`: `JAMMER_ATENCAO_MIN = 30`. O alerta só nasce quando o GPS já está
30min sem atualizar — não existe aviso entre 0-30min. Confirmado em 3 casos reais (RQV-9B26,
KRB-2J76, TML-3B11): degradação real começa, e ~30min depois (não antes) o alerta aparece — a
inserção em si é rápida (&lt;1 ciclo). **Não mexer no limiar sem medir custo de falso positivo primeiro**
(existe pra não alarmar em túnel/vão de prédio). O badge de GPS defasado (Task 2B.3, já em produção,
`>=10min`) já ataca o pedido real ("identificar a desatualização em tempo real") sem inflar alerta.

### Achado A (CRÍTICO, corrigir) — jammer nunca teve cooldown de re-disparo
`detectarJammer` não passa por nenhum mecanismo de supressão — resolver individualmente não impede
nada, o próximo ciclo de 30s reinsere. Evidência: 49 redisparos após `resolver_individual` (26-27/08),
43 em menos de 15min; `RQU-4B93` teve 25 alertas de jammer em 64min hoje. 176 alertas/dia pra 25
veículos. Bate literalmente com a queixa "não só esse veículo que está repetindo". Jammer é sinal de
possível sequestro (correlação alta com roubo de carga, ver histórico do projeto) — prioridade alta.

**Fix:** incluir `jammer` no mesmo mecanismo de cooldown por episódio que os tipos de parada já usam
(`deveSuprimirRedisparoParada`/`TIPOS_PARADA_COM_COOLDOWN`, `motor/route.ts`) — resolver individual ou
marcar falso já deveria silenciar por um período, hoje não silencia nada.

### Achado B (real, mas precisa diagnóstico antes de fix) — cooldown de 15min do desvio vaza
14 de 50 casos (26-27/08) tiveram o alerta de `desvio` reaberto DENTRO dos 15min do cooldown mesmo
após `resolver_individual` — gaps de 1s a 13min, não é race de sub-segundo. A query do cooldown
(`motor/route.ts:3243-3252`) foi replicada manualmente contra o banco no instante exato desses casos
e devolveu o dado certo — ou seja, não é bug de lógica da query, é algo intermitente na EXECUÇÃO.
Hipótese não confirmada: a query falha às vezes (pool `max: 3`, `Promise.allSettled` de toda a frota)
e o erro cai em `erros.push(...)` (`motor/route.ts:3257`) — que só existe na resposta HTTP, que o
`pg_net` descarta em 5s. **Esse erro é hoje estruturalmente invisível** (não tem log, não tem tabela).

**Fix nesta fase:** só adicionar visibilidade real (log/tabela pro erro do catch), NÃO tentar
consertar a causa às cegas — mesma disciplina já usada neste projeto (achar dado antes de mexer).
Com o log em produção por alguns dias, aí sim decide o fix real.

### Achado C (gap de design, sem impacto medido ainda) — Central Romaneio sem cooldown de desvio
`motor-romaneio/route.ts` importa `deveSuprimirRedisparoParada` mas não o equivalente pra desvio —
"Resolver/correto" num desvio da Central Romaneio não suprime nada, só "Falso" (2h). Hoje só 2
redisparos em 26-27/08 (gap mínimo 84min, sem impacto real ainda), mas o buraco existe e vai aparecer
conforme a Central Romaneio ganhar volume de desvio de verdade. Registrado, sem ação imediata.

### Explicação pro time (não é bug, é comportamento intencional documentado)
Se o alerta foi fechado por "Limpar avisos"/"Resolver todos" (ação em massa, 165+86 casos em
26-27/08 — o MAIOR volume de todos), repetir é esperado por design: ação em massa nunca silencia
(decisão de 22/08, evita coerção de motorista). Só o clique individual (Correto/Falso no card) trata
de verdade. Vale comunicar isso ao time junto com os fixes.

---

## Ordem de execução recomendada

1. **Fase 1** e **Fase A** em paralelo (urgente, esta semana — Fase 1 fecha buraco de recall real em produção; Fase A é UX pura, sem risco pro motor, pode andar ao mesmo tempo)
2. **Fase 2** (paralelo às duas acima, é só investigação, não bloqueia nada)
3. **Fase 3** (antes da Fase 4, senão constrói sobre geocodificação ruim)
4. **Fase 4** (a maior, só depois de 1-3 prontas e validadas contra dado real)

---

## Fase D — MEGA PLANO de redesign visual da Central (27/08, baseado em print real)

**Origem:** usuário mandou 2 screenshots reais da tela em produção ("Central Romaneio", aba
Desvios, e o dropdown de Configurações) com o pedido "melhora em tudo". Diferente das fases
anteriores, aqui a base de dados/tokens de cor/fonte já foram auditados (Fase de micro-interações,
mesmo dia) e estão corretos — esta fase é sobre os elementos visuais/estruturais específicos que
aparecem nos prints reais, não uma reforma de zero.

### Achados concretos (olhando os prints, não suposição)

1. **BUG real (não é preferência, é quebrado) — dropdown de Configurações sobreposto pelos pills
   flutuantes de alerta do mapa.** No print 2, o pill "RQV-4F38 DESVIO EM MOVIMENTO 1h" (que fica
   ancorado sobre o mapa) invade visualmente o painel "CONFIGURACOES" aberto, cortando o espaço
   onde deveria estar a opção "Modo escuro" (só "Modo claro" aparece limpo, abaixo do pill). É
   problema de camada (z-index/stacking context) — o dropdown de configurações deveria renderizar
   por cima de TUDO, incluindo os pills do mapa.

2. **Botões de ação do card de alerta sem hierarquia visual.** No print 1, cada card da sidebar
   tem 3 botões — "Focar", "Correto", "Falso" — todos com a mesma aparência (mesmo contorno cinza,
   mesmo peso). Não há diferenciação visual entre uma ação neutra (Focar), uma positiva (Correto)
   e uma negativa/correção (Falso) — o operador tem que ler o texto, não reconhece pela cor/forma.

3. **Pills flutuantes do mapa apertados, overflow pouco claro.** A fileira de pills no topo do
   mapa (RBJ-2J67, RQU-4B93, RQQ-5B81, etc.) fica espremida, e o indicador "+7" de itens que não
   couberam é um badge pequeno sem indicação clara de que é clicável/expansível.

4. **Header de estatística sem presença visual proporcional à importância.** "18 CRÍTICO / 0
   VEIC." no topo da sidebar é o número mais importante da tela (quantos alertas críticos agora) e
   está em texto plano, do mesmo peso visual que o resto da UI ao redor.

5. **Acentuação faltando em textos da UI** — "CONFIGURACOES" sem cedilha/til (devia ser
   "CONFIGURAÇÕES"). Cosmético, mas incoerente com o resto da UI que usa acentuação correta em
   outros lugares (confirmado nos próprios prints: "CRÍTICO", "VEÍCULOS" têm acento certo).

### Task D.1 — Corrigir o bug de z-index do dropdown de Configurações (CRÍTICO, primeira)

**Files:** `src/app/(app)/central-v2/MonitorV2.tsx` (achar o componente do dropdown de
Configurações e o componente dos pills flutuantes do mapa — ler o `z-index`/`zIndex` de cada um).

Garantir que o painel de Configurações (e qualquer outro dropdown/modal da aplicação, auditar
todos enquanto está nessa área do código) renderiza acima de QUALQUER elemento flutuante da tela,
incluindo os pills de alerta do mapa. Estabelecer (se não existir) uma escala de `z-index`
consistente no projeto em vez de valores arbitrários espalhados — ver a seção "Code Quality" da
skill `redesign-existing-projects` ("Arbitrary z-index values like 9999 — Establish a clean z-index
scale in the theme/variables").

### Task D.2 — Hierarquia visual dos botões Focar/Correto/Falso

Redesenhar os 3 botões do card de alerta pra terem identidade visual distinta:
- **Focar**: neutro, terciário (texto ou contorno sutil) — é navegação, não decisão.
- **Correto**: tom positivo (verde/accent, já existe `--verde` nos tokens) — confirma o alerta.
- **Falso**: tom de atenção/correção (não necessariamente vermelho agressivo — é "corrigir o
  sistema", não um erro do operador; considerar um tom neutro-mais-forte ou o `--amarelo` já
  existente) — precisa de decisão de design, não só aplicar `--vermelho` sem pensar (falso positivo
  não é uma ação "ruim", é uma correção válida e incentivada pelo projeto).

**Não mudar o fluxo de clique (já foi refeito na Task A2 desta sessão — seleção de categoria +
confirmar)** — só a aparência dos botões que abrem esse fluxo.

### Task D.3 — Polish dos pills flutuantes do mapa

Mais espaçamento/respiro entre pills, indicador de overflow ("+N") mais claro (ex: badge com fundo
diferenciado + cursor pointer + tooltip "mais N veículos com alerta"), considerar truncar texto
longo do motivo com reticências consistentes.

### Task D.4 — Header de estatística com mais presença

"18 CRÍTICO / 0 VEIC." vira um componente de destaque real (tipografia maior/peso maior pro
número, rótulo menor abaixo ou ao lado, possível uso de cor pra crítico > 0 vs = 0) — sem inventar
elemento novo de layout, só dar peso visual proporcional à importância do dado.

### Task D.5 — Acentuação e polish de texto (menor, pode entrar em qualquer rodada)

Corrigir "CONFIGURACOES" → "CONFIGURAÇÕES" e auditar rapidamente se há outros textos da UI sem
acento (grep por strings de UI sem caracteres acentuados onde deveriam ter).

### Critério de aceite geral
- D.1 é bug real — teste (se houver padrão de teste de componente aplicável) ou, no mínimo,
  verificação visual explícita depois do deploy (usuário já demonstrou que consegue mandar print
  real, usar isso pra confirmar).
- D.2-D.5: `npx vitest run`, `npx tsc --noEmit`, `npm run build` limpos. Sem mudança de tokens de
  cor/fonte fora do que já existe (`--verde`/`--amarelo`/`--vermelho`/`--accent` já estão
  definidos, reaproveitar).
- Mesma disciplina desta sessão: implementador + revisor independente antes de qualquer deploy.

### Ordem de execução
D.1 primeiro e sozinho (bug real, isolado, rápido de revisar). D.2-D.4 podem ir juntos numa
rodada (mesma área de código, cards de alerta + pills do mapa). D.5 entra de carona em qualquer
uma das rodadas acima, é trivial.
