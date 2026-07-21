# Rotação justa do orçamento de verificação de corredor, Design

**Data:** 2026-07-21
**Status:** aprovado pelo usuário, indo para plano

## Problema

Investigação sistemática (usuário reportou 2 casos reais, com print do Unitrac,
onde um desvio real e visível não gerou nenhum alerta no sistema — placas
TTF-5I09 e RQV-6C22) encontrou a causa raiz: a verificação de corredor (cerca
virtual, `src/lib/corredor-verificacao.ts` + `src/app/api/motor/route.ts`) chama
o servidor público do OSRM (`router.project-osrm.org`, failover Valhalla), que
tem um limite real de **1 requisição/segundo, política deles, não nossa**. Por
causa disso existem dois orçamentos hardcoded de **3 verificações por ciclo**
(`CERCA_SEEDS_POR_CICLO`, linha 150, e `MAX_VERIFICACOES_POR_CICLO`, linha 128),
ambos **globais** — compartilhados entre TODOS os clientes, não por
veículo/cliente.

Medido ao vivo em 21/07: **75 veículos em movimento simultâneo**. Com um
orçamento de 3-4 verificações por ciclo (~30s), a cobertura teórica já seria
insuficiente — mas o problema real é pior: a query que lista os veículos do
cliente (`from("veiculos").select("id, cv, grupo")...`, sem `.order()`) não tem
ordenação explícita, e o resultado fica cacheado por minutos
(`CACHE_FROTA_MS`). Isso significa que a ordem de iteração é **estável e
arbitrária** ciclo após ciclo — não é um orçamento pequeno distribuído de forma
justa entre a frota, é **sempre o mesmo pequeno subconjunto de veículos**
(primeiros nessa ordem estável) vencendo a disputa pelo orçamento, enquanto o
resto da frota praticamente nunca recebe uma verificação de corredor contra a
estrada real.

## Decisão

Sem mudar nenhuma lógica de detecção (nem os limiares, nem o próprio limite de
1 req/s do OSRM — decisão explícita do usuário: sem infraestrutura nova por
enquanto, `docs/superpowers/specs/` desta sessão), adiciona **rotação justa**:
um mapa em memória do processo, `ultimaVerificacaoCorredorPorVeiculo: Map<string,
number>`, grava o timestamp da última vez que um veículo efetivamente consumiu
uma chamada de OSRM/Valhalla — nas duas frentes que hoje competem pelo mesmo
throttle global (semeadura/recuperação da cerca virtual, linhas ~1444-1481; e a
confirmação do gatilho comportamental, linhas ~1709-1717). Antes do loop
principal por veículo (`for (const raw of posicoesRaw)`, linha ~1004), a lista é
reordenada por "há mais tempo sem verificação" (nunca verificado = prioridade
máxima, entra primeiro).

Isso não aumenta o orçamento (continua obedecendo ao 1 req/s do OSRM público) —
só garante que, ao longo de algumas dezenas de ciclos (minutos), **todo
veículo** eventualmente recebe sua verificação, em vez de um subconjunto fixo
vencer pra sempre e o resto nunca ser coberto. Mesmo padrão de cache em memória
já usado no arquivo (`cacheCercaPorVeiculo`, `cacheFrotaPorCliente`) — reinicia
"do zero" (todo mundo maximamente prioritário) se o processo reiniciar, o que é
auto-corretivo e aceitável (mesmo comportamento que os caches existentes já
têm).

## Escopo

1. **Nova função pura testável** em `src/lib/corredor-verificacao.ts`:
   `ordenarPorPrioridadeVerificacao<T extends { veiculo_id: string }>(veiculos:
   T[], ultimaVerificacao: Map<string, number>): T[]` — ordena ascendente por
   timestamp da última verificação (entradas ausentes no mapa tratadas como
   `0`, ou seja, máxima prioridade). Mesmo padrão de `ordenarPendentesPorDistancia`
   já existente no arquivo — função pura, sem I/O, 100% testável isoladamente.
2. **`src/app/api/motor/route.ts`**:
   - Novo mapa de módulo `const ultimaVerificacaoCorredorPorVeiculo = new
     Map<string, number>()`, ao lado dos outros caches em memória já existentes
     (`cacheCercaPorVeiculo`, etc — mesmo escopo/ciclo de vida).
   - Antes do `for (const raw of posicoesRaw)` (linha ~1004), a lista é
     reordenada com `ordenarPorPrioridadeVerificacao`.
   - Nos DOIS pontos onde uma chamada de `verificarCorredor` é efetivamente
     disparada (linha ~1446/1472 — cerca virtual; linha ~1717 — confirmação
     comportamental), grava `ultimaVerificacaoCorredorPorVeiculo.set(veiculo_id,
     Date.now())` logo após a chamada (independente do veredito retornado —
     "consumiu o orçamento" é o que importa pra rotação, não o resultado).
3. **Verificação de não-regressão**: confirmar que a pré-passada de detecção de
   congestionamento (coleta veículos parados/frescos, roda ANTES do loop
   principal, em outro trecho do ciclo) não depende da ordem de
   `posicoesRaw` do loop principal — são passes distintos, reordenar um não
   deve afetar o outro, mas vale conferir explicitamente no plano.

Fora de escopo (decisão explícita do usuário nesta sessão): aumentar o
orçamento total de verificações por ciclo; self-hospedar OSRM/Valhalla numa VM
própria (mencionado como opção futura, mas fora de escopo agora — usuário
recusou usar o Contabo existente, que é de outro projeto, e não quis abrir uma
frente de infraestrutura nova agora); separar o orçamento por cliente (não
levantado como necessidade nesta sessão, fica pra revisitar se a rotação justa
sozinha não for suficiente).

## Testes

- `ordenarPorPrioridadeVerificacao`: testes unitários puros — lista com
  timestamps variados (incluindo veículos nunca vistos no mapa) ordena
  corretamente ascendente; empate de timestamp mantém alguma ordem estável
  (não precisa ser específica, só determinística).
- Validação manual isolada (mesma cautela de sempre — nunca rodar o motor de
  produção pra testar): script Node avulso simulando N ciclos com um mapa de
  "última verificação" e uma lista de veículos, confirmando que depois de
  `ceil(N_veiculos / orçamento_por_ciclo)` ciclos simulados, todo veículo foi
  verificado pelo menos uma vez.
- `tsc`/`eslint`/suite completa/`build` limpos nos dois repos antes do push
  (mesma disciplina de sempre).
