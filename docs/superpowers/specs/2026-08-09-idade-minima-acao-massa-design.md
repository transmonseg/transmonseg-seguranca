# Idade mínima pra ações em massa (Resolver todos / Limpar avisos) — Design

**Contexto:** investigação de um caso relatado como "sistema atrasou 65min
pra detectar" (TTH-3C94, grupo WhatsApp DESVIO DE ROTA, 08/08) achou que o
sistema NÃO atrasou — o alerta disparou às 12:17, mas foi apagado 80
segundos depois pela ação **"limpar em massa"** (botão "Limpar avisos"),
antes de qualquer humano poder revisar. Disparou de novo às 13:03 e só aí
ficou visível até ser marcado falso positivo. O que pareceu "miss/atraso"
era na verdade um alerta real apagado em bloco por engano.

Puxando os últimos 7 dias: **22 alertas de tipo desvio foram fechados por
ação em massa (`limpar_massa`/`resolver_massa`) em menos de 2 minutos**
depois de nascer — tempo zero pra qualquer revisão. As ações individuais
(`resolver_individual`/`falso_individual`) nunca fecham tão rápido (0 casos
abaixo de 2min nos mesmos 7 dias) — só as de massa têm esse risco.

Hipótese de causa raiz: o alto volume de falso positivo (classe_viaria 66%,
etc. — ver `docs/superpowers/specs/2026-08-08-confiabilidade-detector-anotacao-design.md`)
empurra o operador pro botão "limpar tudo" pra desentupir a tela, e esse
botão não distingue "isso é lixo de dias atrás" de "isso nasceu há 40
segundos e ainda pode ser real". É a mesma causa raiz dos dois problemas
que pareciam separados (ruído E "miss") — não corrigir a causa (ruído,
trabalho maior, sem sinal disponível hoje — ver spec citada acima), mas dar
uma rede de segurança imediata contra o efeito colateral mais grave.

**Goal:** ações em massa (`resolverVarios`/`limparVarios`) nunca fecham um
alerta recém-nascido sem review individual — dão uma janela mínima pra ele
"amadurecer" (escalar, ser visto) antes de virar elegível pra bloco.

**Arquitetura:** guard de idade mínima, aplicado nos DOIS lados
(defesa em profundidade — cliente pra UX consistente, servidor como
autoridade final, nunca confia só no cliente pra uma ação que fecha
alerta): servidor filtra por `desde` antes de fazer o update; cliente
filtra `alertasFiltrados` pela mesma idade antes de remover otimisticamente
da tela e antes de montar a lista de ids enviada. Alertas jovens demais
simplesmente **ficam de fora** da ação em massa — continuam ativos, visíveis,
elegíveis pra ação individual a qualquer momento. Nenhuma mudança em
`nivel`/disparo/detecção — isso é só sobre QUANDO uma ação de fechamento em
massa pode alcançar um alerta.

## Escolha do limiar: 5 minutos

- Maior que a janela mínima de escalação do detector mais rápido
  (`afastando_de_tudo` exige 2-3 leituras seguidas, ~60-90s, pra virar
  crítico) — cobre com folga o período em que o alerta ainda pode estar se
  formando/escalando.
- Bem menor que o tempo médio de review individual real
  (`falso_individual` ~875s/14,6min, `resolver_individual` ~1399s/23min) —
  não é "forçar review completo", só um respiro mínimo.
- Cobre com folga generosa os 22 casos reais encontrados (todos < 2min).

## Mudanças

### `src/lib/detectores.ts`

Nova constante exportada (arquivo puro, importável tanto do server action
quanto do client component — `acoes-alertas.ts` tem `"use server"` no topo
e por regra do Next.js só pode exportar funções async, não pode ser dona
da constante compartilhada):

```typescript
// Idade minima (minutos) pra um alerta virar elegivel pra acao em massa
// (Resolver todos / Limpar avisos) -- ver
// docs/superpowers/specs/2026-08-09-idade-minima-acao-massa-design.md.
// Achado real 08/08 (caso TTH-3C94): alerta real fechado por "limpar em
// massa" 80s depois de nascer, antes de qualquer revisao humana -- 22
// casos assim nos ultimos 7 dias (todos < 2min), 0 casos assim em acao
// INDIVIDUAL no mesmo periodo. So acoes em massa tem esse risco.
export const IDADE_MINIMA_ACAO_MASSA_MIN = 5;
```

### `src/app/(app)/acoes-alertas.ts`

Em `resolverVarios` e `limparVarios`: antes do update, buscar `desde` dos
`ids` recebidos, dividir em elegíveis (`desde <= now - 5min`) e recentes
demais (`desde > now - 5min`). Só os elegíveis entram no
`.update()...in("id", ...)` e em `registrarCasosDesvioRevisao` (onde
aplicável — `limparVarios` já não chama isso). Retorno ganha um campo novo
pra o cliente saber quantos ficaram de fora:

```typescript
export type ResultadoAcao = { ok?: boolean; erro?: string };
```
vira (adiciona campo opcional, não quebra os outros usos de `ResultadoAcao`):
```typescript
export type ResultadoAcao = { ok?: boolean; erro?: string; ignoradosRecentes?: number };
```

`resolverVarios`/`limparVarios` passam a retornar `ignoradosRecentes: N`
junto com `resolvidos`/`limpos` (agora contando só os elegíveis realmente
fechados).

### `src/app/(app)/central-v2/MonitorV2.tsx`

`handleResolverTodos`/`handleLimparTodos`: filtrar `alertasFiltrados` em
`elegiveis` (idade >= `IDADE_MINIMA_ACAO_MASSA_MIN`, usando a função
`minutosDesde` já existente no arquivo) e `recentes` (idade < limiar) ANTES
de montar `ids`/fazer a remoção otimista do estado local — os recentes
continuam na tela, visíveis, normalmente. Se `recentes.length > 0`, mostrar
um aviso curto pro operador (mesmo padrão de texto informativo do resto do
projeto, sem alarmismo) informando quantos ficaram de fora por serem
recentes demais pra ação em massa.

## Testes

`acoes-alertas.ts` não tem arquivo de teste hoje (é `"use server"`, só
testado via integração/produção real neste projeto, mesmo padrão já
estabelecido pras outras funções desse arquivo). A cobertura desta
mudança vem de: (1) verificação manual em produção real (criar um alerta
de teste recente, confirmar que ação em massa não o alcança, confirmar
que um alerta antigo é alcançado normalmente); (2) teste unitário da
constante/threshold não faz sentido isolado (é só um número), mas se
alguma lógica de filtro por idade for extraída como função pura
(recomendado — ex: `elegivelParaAcaoMassa(desde: string, agora: Date):
boolean`), essa função pura ganha teste em `detectores.test.ts` cobrindo:
exatamente no limiar, 1s antes do limiar, 1s depois, idade zero.

## Escopo

Aplica aos DOIS botões de massa (`resolverVarios`/`limparVarios`) —
qualquer um deles fechando algo recém-nascido é o mesmo risco. NÃO se
aplica às ações individuais (`resolverAlerta`/`marcarFalsoPositivo`) — um
operador escolhendo fechar 1 alerta específico já está, por definição,
revisando aquele caso; o risco que motivou esta mudança é exclusivo de
fechar em bloco sem olhar.
