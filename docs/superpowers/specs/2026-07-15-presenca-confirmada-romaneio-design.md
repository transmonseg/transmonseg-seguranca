# Presença confirmada por permanência (romaneio), Design

**Data:** 2026-07-15
**Status:** aprovado pelo usuário, indo para plano

## Problema

Com o romaneio como fonte de coordenada (spec
`docs/superpowers/specs/2026-07-15-romaneio-pontos-entrega-design.md`), a coordenada
que o MOTOR usa pra detecção agora é confiável (geocodificada, ou excluída se não
geocodificar — nunca mais a coordenada da Unitrac). Mas o STATUS `feito`/`pendente`
continua vindo só da Unitrac (decisão da spec anterior, mantida). O usuário identificou
um problema real: **a coordenada errada da Unitrac afeta a CONFIRMAÇÃO dela própria,
não só a exibição.** Se o raio de confirmação da Unitrac está centrado no ponto errado,
um caminhão que entrega de verdade no endereço certo (nosso ponto, geocodificado)
nunca entra no raio *dela*, e a NF fica "pendente" pra sempre — mesmo com o dwell
mostrando claramente que o veículo parou lá.

**Histórico importante (não repetir o erro de 08/07):** uma feature parecida
("confirmação de entrega por proximidade") foi implementada e revertida no mesmo dia,
a pedido do próprio cliente (ver `docs/analise-deteccao.md` §7.1). Na época, a solução
criava uma decisão de negócio (banda "Confirmar/Descartar" pro operador) que competia
com a Unitrac. O que o cliente descreveu como ideal na época — "criar um perímetro,
falar quanto tempo ele tá no cliente" — virou o painel informativo "parado no cliente"
que existe hoje (§7.4), sem decisão automática nenhuma.

**Decisão desta sessão, para não repetir o erro:** o sinal aqui é **estritamente
interno à detecção** — nunca aparece pro operador como "entregue", nunca sobrescreve
o status oficial da Unitrac, nunca afasta o contador `entregas_feitas`/`entregas_total`
exibido na tela (que vem de uma fonte totalmente separada — `agruparAlvosPorPlaca`,
direto dos alvos brutos da Unitrac). Só serve pra parar de deixar um ponto
fantasma-pendente (que na prática já foi visitado) influenciar os detectores de
desvio (Camada 1) e a supressão de alerta de favela — os únicos dois lugares do motor
que hoje leem `pontosVeiculo`/`PontoEntrega.feito` internamente (confirmado lendo o
código: `veiculoIdToAlvos` só é usado nesses dois pontos, nunca exposto em API/UI).

## Infraestrutura já existente reaproveitada

O motor já rastreia, por veículo e a cada ciclo, dentro de qual ponto (`pontoCodigo`)
o veículo está e há quanto tempo, acumulando segundos de permanência SÓ quando devagar
(`route.ts` ~1513-1540: `noRaioAlvoCodigo`, `noRaioDesde`, `noRaioDwellSegundos`,
persistidos em `posicoes_atuais.no_raio_dwell_segundos` etc.) — hoje usado só pelo
`detectarBypassEntrega` (dispara se sair do raio com menos de
`BYPASS_ENTREGA_DWELL_MINIMO_SEGUNDOS=120s` de permanência). **Esse dwell já é
calculado contra `pontosVeiculo`, que já vem do romaneio quando existe** (Task 7 da
spec anterior) — ou seja, a coordenada usada pra medir "está no raio" já é a boa.

**Limitação do dwell ao vivo:** ele zera assim que o veículo sai do raio
(`route.ts:1527-1532`) — é um contador "estou aqui agora", não uma memória de "estive
aqui hoje". Pra sobreviver depois que o veículo for embora (o caso que importa: o
caminhão entrega e SEGUE viagem), precisa de um registro persistente novo.

## Escopo

1. Migration: `romaneio_pontos.presenca_confirmada_em timestamptz` (nullable).
2. No motor: quando o dwell (já calculado) cruza o limiar de confiança
   (reaproveita `BYPASS_ENTREGA_DWELL_MINIMO_SEGUNDOS=120s` — o mesmo valor que já
   diferencia "parou de verdade" de "só passou"), e o ponto é originado do romaneio,
   marca `presenca_confirmada_em = now()` (uma vez, idempotente) na linha
   correspondente de `romaneio_pontos`.
3. `montarPontosDeRomaneio` passa a considerar `feito: true` quando
   `presencaConfirmadaEm !== null`, ALÉM do status da Unitrac (`alvo?.feito`) — union
   dos dois sinais, nunca um substituindo o outro.
4. Nada mais muda: `entregas_feitas`/`entregas_total` (contador exibido), o campo
   `feito`/`situacao` gravado em qualquer lugar visível, e o status oficial da NF na
   Unitrac continuam exatamente como estão hoje.

Fora de escopo: qualquer UI nova, qualquer mudança em como a Unitrac é consultada,
qualquer decisão automática visível ao operador.

## Detalhe técnico

**Identificação da linha certa em `romaneio_pontos`:** por `(veiculo_id, romaneio_data,
nf)` — `nf` já está disponível em `PontoEntrega.documento` (é o mesmo campo usado pra
casar com `alvodocumento` da Unitrac em `montarPontosDeRomaneio`), não precisa expor
o `id` interno da tabela pro resto do motor.

**Só se aplica a pontos do romaneio.** Quando não há romaneio de hoje pro veículo
(rede de segurança da spec anterior), o motor já confia direto na coordenada da
Unitrac — não há o problema de coordenada errada afetando a própria confirmação
nesse caminho, então não há necessidade de presença confirmada ali.

**Escrita em lote, não por veículo.** Segue o mesmo padrão já usado por
`amostrasBaselineCiclo` (`route.ts:619`, flush em lote no fim do ciclo,
`Promise.allSettled`) — coleta as marcações do ciclo num array e grava tudo de uma vez
no fim, em vez de um UPDATE síncrono por veículo no meio do loop (mesma disciplina de
egress/latência que motivou a investigação de cota do Supabase nesta mesma sessão).

## Testes

- `montarPontosDeRomaneio`: novo teste — `presencaConfirmadaEm` não-nulo faz `feito:
  true` mesmo com `alvo.feito === false` (ou sem alvo correspondente); `alvo.feito ===
  true` sem presença confirmada continua `feito: true` (union, não troca uma fonte
  pela outra).
- Suite completa + `tsc`/`eslint`/`build` limpos nos dois repos antes do push.
