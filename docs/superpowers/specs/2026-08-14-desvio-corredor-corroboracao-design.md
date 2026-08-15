# Corredor de rota real como corroboração do desvio, Design

**Data:** 2026-08-14
**Status:** em revisão com o usuário

## Contexto

Depois da reescrita completa de 12/08 (`docs/superpowers/specs/2026-08-12-desvio-de-rota-v2-design.md`),
o detector de desvio ficou reduzido a 1 sinal ativo hoje (`afastando_geral`, distância real de
rua via OSRM `/table`; o segundo sinal, `rua_rara_frota`, foi desligado em 13/08 por decisão do
usuário após medir 0 confirmações individuais em 14 casos checados). Investigação de 14/08
(sessão longa, ver histórico de conversa) reconstruiu o que existia antes da reescrita:

- **12/07**: sistema de "fusão de sinais" (spec `2026-07-12-desvio-fusao-calibracao-design.md`)
  — múltiplos detectores (jammer, desvio comportamental, `bypass_entrega`, `baseline_veiculo`)
  corroborando via `arbitrarCandidatos` (bônus +15 por tipo adicional presente no mesmo ciclo),
  mais um mitigador de trânsito inferido pela frota. **Confirmado como "Melhorou" pelo operador
  em 13/07** (mensagem real do grupo do WhatsApp, não do usuário do sistema).
- Essa arquitetura de fusão **nunca foi removida** — `arbitrarCandidatos`,
  `TIPOS_CORROBORANTES`, `reduzirPorTransitoInferido` continuam ativos hoje, e `jammer`
  (334 alertas/14 dias), `bypass_entrega` (329) e `baseline_veiculo` (3327) continuam disparando
  de verdade pra Nutry Max. 20 alertas de desvio reais dos últimos 14 dias já saíram com
  "corroborado por: baseline_veiculo" no motivo.
- O que **foi** removido em 12/08 foi só o método de detecção comportamental em si — a Camada 2
  do redesenho de 11/07 (`src/lib/corredor-verificacao.ts`, "a defesa principal contra o ponto
  cego geométrico da Camada 1"): traçava a rota real (OSRM) de um ponto fixo do passado até cada
  destino pendente e confirmava se a posição atual caía dentro de um buffer de qualquer trecho
  dessa rota — checagem de geometria de caminho, não de tendência de distância.
- Motivo real da remoção (não foi descuido): usar o corredor como regra **primária** sem
  sequenciamento de paradas foi testado em 11/08 e deu 380 disparos em 66% da frota — depois que
  o veículo visita 1-2 paradas reais, a rota da âncora antiga até o PRÓXIMO destino não bate mais
  com o trajeto real. Corrigir isso exigia OSRM `/trip` (TSP), banido explicitamente do requisito
  7 da reescrita de 12/08 depois de 2 meses de complexidade acumulada que nunca convergiu.

Pesquisa externa (GitHub, patentes, project44) não achou uma solução de mercado pronta pro caso
específico (sem rota fixa, sem repetição de histórico suficiente — 1,2% dos pares
origem-destino repetem em 2+ dias, medido em 11/07). O achado mais próximo (project44: dois
sinais independentes, distância + padrão temporal, calibrados por lane a partir de histórico) não
se aplica direto por falta de repetição, mas confirma que o padrão "checagem geométrica de
corredor como camada separada da checagem de distância" é prática de mercado real, não
invenção isolada do projeto.

## Decisão

Trazer o corredor de volta, mas em um papel estruturalmente diferente do que falhou em 11/08:
**corroboração, nunca supressão**. Decisão explícita do usuário (14/08), alinhada com o
princípio já escrito no spec de 12/08 ("recall sobre precisão — nunca perder desvio real"):

- O corredor roda **depois** que `afastando_geral` já decidiu disparar (streak bateu o limiar),
  nunca antes. Não pode impedir um alerta de existir — só ajusta o score pra cima quando
  confirma "fora de qualquer rota legítima".
- Se o corredor confirmar "dentro" de uma rota legítima, ou ficar indisponível, o alerta
  dispara do mesmo jeito, sem ajuste. Fail-open total, sem exceção — diferente do papel
  original de 11/07, aqui não existe caminho onde o corredor apaga ou baixa a prioridade de um
  alerta.
- Isso evita por construção o modo de falha medido em 11/08: mesmo que a âncora da rota esteja
  "velha" depois de 1-2 paradas reais e o corredor erre a checagem, o pior caso é um alerta sem
  o bônus de corroboração — nunca um alerta perdido.

## Arquitetura

Reaproveita `arbitrarCandidatos`/`TIPOS_CORROBORANTES` (`src/lib/detectores.ts`) o mínimo
possível: como o corredor não é um alerta independente (é uma confirmação especificamente sobre
o candidato de desvio), ele **não** entra como um 5º tipo em `TIPOS_CORROBORANTES` — mistura mal
com "conte quantos tipos distintos" quando o próprio corredor não gera alerta próprio. Em vez
disso, segue o padrão já usado por `aplicarFatorCalibrado` (calibração) e
`reduzirPorTransitoInferido` (trânsito): uma função pura que ajusta o score de `alertaDesvioV2`
diretamente, chamada uma vez, só quando `alertaDesvioV2` já existe.

Novo módulo `src/lib/corredor-confirmacao.ts` (funções puras + 1 função de I/O isolada, mesmo
padrão de `osrm-match.ts` de ontem — sem importar nada de `next`):

```
verificarCorredorFora(origem: Ponto, posAtual: Ponto & {velocidade:number}, destinos: Ponto[]):
  Promise<{ confirmaFora: boolean }>
```

- Chama OSRM `/route` self-hosted (mesma `OSRM_LOCAL_URL` já usada por `distancia-real.ts` e
  `osrm-match.ts`) pra cada destino em `destinos` (já filtrado a 50km pelo chamador, mesmo
  conjunto que `afastando_geral` avaliou), sem cortar em 3 nem rotacionar orçamento — só roda no
  exato ciclo do disparo (não continuamente pra frota inteira), então não compete por throttle.
- Sem fallback público (Valhalla/OSRM público) — decisão consciente de simplicidade: como o
  papel é só somar um bônus opcional, uma falha aqui já cai no fail-open natural (`confirmaFora:
  false`, sem ajuste), não precisa de camada de contingência extra pra isso.
- `dentroDoCorredor`/`bufferPorVelocidade` (buffer 120m urbano / 200m rodovia) reaproveitados
  tal qual existiam em `corredor-verificacao.ts` antes da remoção — lógica pura já validada,
  sem mudança.
- Deadline TOTAL do loop (checado a cada iteração, mesmo padrão do antigo
  `DEADLINE_VERIFICACAO_MS`, não por chamada individual): 3s, mais curto que o antigo 5s — sem
  fallback público pra esperar, e roda 1x por disparo, não por ciclo de todo veículo suspeito.
  Destinos ainda não testados quando o deadline estoura ficam de fora dessa verificação
  (`confirmaFora` só considera o que deu tempo de checar; nunca espera além do teto).

**Âncora da rota** — ponto de partida da checagem, nunca a posição atual (evita tautologia,
mesma razão documentada no código original): posição do veículo no **primeiro ciclo do streak
atual**, buscada em `posicoes_historico` pela janela de tempo equivalente a
`afastandoStreak * 30s` atrás (30s = intervalo real do ciclo do motor, `motor-tick-30s` no
pg_cron) — mesmo padrão de busca por janela já usado pelo `/match` de ontem (`osrm-match.ts`),
não precisa de coluna nova.

## Onde entra no motor (`route.ts`)

Logo após `montarAlertaDesvio` retornar `alertaDesvioV2` não-nulo (mesmo ponto onde a calibração
já roda hoje), antes de empurrar pra `candidatosCore`:

```
if (alertaDesvioV2) {
  // calibração (já existe)
  // NOVO: corredor
  try {
    const anteriorDoStreak = /* busca em posicoes_historico pela janela do streak */;
    if (anteriorDoStreak) {
      const { confirmaFora } = await verificarCorredorFora(anteriorDoStreak, pos, destinosRelevantes);
      if (confirmaFora) {
        alertaDesvioV2 = {
          ...alertaDesvioV2,
          score: Math.min(100, alertaDesvioV2.score + BONUS_CORROBORACAO_POR_SINAL),
          motivo: `${alertaDesvioV2.motivo} (corroborado por: corredor real fora de rota)`,
        };
      }
    }
  } catch (errCorredor) {
    erros.push(`Aviso: falha ao verificar corredor pro veiculo ${veiculo_id}: ${String(errCorredor)}`);
  }
}
```

Reaproveita `BONUS_CORROBORACAO_POR_SINAL` (já `15`, exportado de `detectores.ts`) em vez de um
número novo — consistência com o resto da fusão.

`desvio_disparo_log` ganha uma coluna nova, `corredor_confirmou boolean`, mesmo padrão de
`posicao_corrigida` (migration de ontem) — pra dar visibilidade e permitir medir depois quantos
disparos reais o corredor de fato corroborou, sem precisar reconstruir do `motivo` em texto.

## Erros / fail-open

- OSRM self-hosted indisponível, timeout, ou nenhum destino roteável → `confirmaFora: false`,
  sem ajuste de score. Nunca bloqueia a gravação do alerta.
- Falha ao buscar a âncora em `posicoes_historico` (streak recém-formado, sem histórico
  suficiente na janela) → pula a checagem de corredor pra esse ciclo, mesmo efeito de
  indisponibilidade.
- Todo o bloco envolto em try/catch (mesmo padrão do `/match` de ontem) — uma falha aqui nunca
  aborta o ciclo do veículo.

## Testes e validação

- TDD nas funções puras novas (`verificarCorredorFora` já teria contraparte testável isolando o
  fetch; `dentroDoCorredor`/`bufferPorVelocidade` só precisam ser portadas de volta com seus
  testes originais, já existiam e passavam).
- Antes de produção: rodar contra os 20 disparos reais dos últimos 14 dias que já têm
  "corroborado por: baseline_veiculo" no motivo, mais os 830 disparos de desvio dos últimos 14
  dias em geral — medir quantos o corredor teria corroborado, sem mudar nenhum comportamento de
  disparo (só o score muda), então o risco de rodar contra dado real é mínimo por construção.
- Confirmar que nenhum alerta de desvio deixa de disparar por causa dessa mudança — teste
  automatizado que garante `verificarCorredorFora` nunca é chamado antes de `alertaDesvioV2`
  já existir, e que uma falha simulada da função nunca impede o alerta de ser gravado.

## Fora de escopo (não decidido/adiado)

- Sinal de "padrão temporal" (oscilação/regressão em direção à origem) encontrado na pesquisa
  de mercado (project44) — sinal novo, mais barato (sem OSRM extra), mas não decidido nesta
  rodada; registrado pra avaliação futura separada.
- OSRM `/trip` (sequenciamento real de paradas) continua fora de escopo — não é necessário pro
  papel de corroboração (só roda 1x por disparo já formado, âncora "velha" pesa muito menos que
  no papel de regra primária que falhou em 11/08).
- Reintroduzir o corredor como sinal independente em `TIPOS_CORROBORANTES` — decidido contra,
  porque ele não gera alerta próprio, mistura mal com a contagem "quantos tipos distintos"
  existente.
