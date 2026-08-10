# Ponto seguro só suspende desvio se o veículo estiver parado — Design

**Contexto:** investigação de 2 relatos reais no grupo WhatsApp "DESVIO DE
ROTA" hoje (10/08) — veículos TTM-7C13 e TTH-0G95, "desvio na Unitrack mas
não apareceu no sistema" — levou a uma varredura completa de todas as
regras de desvio (não só o mecanismo principal, ver spec irmã
`2026-08-10-afastando-tudo-harness-design.md`). Nessa varredura, um
mecanismo de supressão separado foi confirmado ainda quebrado.

`suspenderPorChegada` (`src/lib/unitrac.ts:385-393`, achado real 25/07) tem
um curto-circuito:

```typescript
export function suspenderPorChegada(
  distDestinoMaisPertoM: number,
  raioDestinoMaisPerto: number,
  emPontoSeguro: boolean
): boolean {
  if (emPontoSeguro) return true;
  const raio = Math.max(raioDestinoMaisPerto, 150);
  return distDestinoMaisPertoM <= raio;
}
```

`emPontoSeguro` alimenta `ctx.suspensoPorChegada`, consumido logo no topo de
`detectarDesvio` (`detectores.ts:1587`): `if (ctx.suspensoPorChegada) return
null;` — suspende TODA checagem de desvio no ciclo, para aquele veículo.

**O problema:** `emPontoSeguro` vem de uma geofence estática cobrindo TODO
posto de gasolina do estado do RJ (`route.ts:1085`,
`scripts/ingerir-pontos-seguros.mjs`, ~1.115 geofences de 80m de raio,
~22km² total, carregadas uma vez a partir do OSM, sem relação com a rota ou
o destino real do veículo). O curto-circuito dispara pela mera presença
geográfica dentro do raio — não exige que o veículo esteja parado. Um
veículo em desvio real que só passa (em movimento) perto de qualquer um dos
1.115 postos tem a checagem de desvio inteira desligada naquele ciclo.

**Intenção original confirmada** (`git show ddb1fd0`, commit de introdução,
25/07): tratar "chegou no destino OU num posto de gasolina" como pausa
legítima, para não confundir um motorista abastecendo com um desvio. É um
propósito real — só a implementação não distingue "parado abastecendo" de
"só passando por perto, em movimento, durante um desvio real".

**Achado já documentado no próprio código** (comentário "achado CRÍTICO da
revisão independente 03/08", `route.ts:2090-2103`): o mesmo bug foi
identificado antes e corrigido em UM único consumidor — o auto-resolve por
chegada (`deveAutoResolverAfastandoChegadaReal`, que usa
`chegouEmDestinoConhecido`, uma versão que força `emPontoSeguro=false`,
`route.ts:2104-2106`). O `suspensoPorChegada` bruto que de fato bloqueia o
DISPARO do alerta (`route.ts:2085-2088`) nunca recebeu a mesma correção —
o comentário da época deixa explícito que isso foi escopo consciente
daquela mudança pontual, não uma decisão de produto de manter o
comportamento assim.

**Caso real citado no próprio comentário do código:** veículo SRQ-9F05 se
afastou 52km de todos os destinos e quase teve o alerta fechado sozinho por
parar 3min num posto a 124km da base — ou seja, esse tipo de falso-negativo
silencioso já aconteceu de verdade, não é hipotético.

**Medição ao vivo feita nesta investigação** (SQL em produção,
`placar_desvio_log`, coluna `componentes->>'zeradoPorChegada'` — setada
tanto por chegada real quanto por ponto_seguro, não dá pra separar os dois
sem geometria que não é persistida): 75-99% dos ciclos do placar-sombra nos
últimos 3 dias (07/08 a 10/08) têm essa flag true. Testando
especificamente TTM-7C13 e TTH-0G95 nas últimas 4h: só 5-6 de 358 leituras
cada bateram dentro de um posto — não foi a causa principal do miss desses
2 casos (ver spec irmã), mas é um risco real e silencioso para a frota
inteira, sem log dedicado para medir o impacto isolado.

## Abordagem escolhida

Exigir que o veículo esteja PARADO (`velocidade === 0`) para o
curto-circuito de `emPontoSeguro` valer — preserva a intenção original
(não flagar quem parou de verdade para abastecer) e fecha a brecha (quem só
passa em movimento durante um desvio real não ganha mais o desconto).

Mesmo padrão já usado poucas linhas acima no mesmo arquivo para `noCliente`
(`route.ts:2060-2063`: `pos.velocidade === 0 && ...`) — não introduz
critério novo, só replica um já existente na mesma função. Não precisa de
estado de dwell/tempo mínimo parado: `afastouDeTudo`/`foraTapeteStreak` já
exigem streak mínimo de 2 leituras consecutivas para disparar qualquer
alerta (`FORA_TAPETE_STREAK_MIN = 2`, `detectores.ts:542`), o que já
absorve uma leitura isolada de `velocidade === 0` por ruído de GPS (o
próprio motor congela `desvio_streak`/`aproximando_streak` quando
`velocidade === 0`, via `devAvancarStreaksDesvio`, `detectores.ts:1491-1501`
— um veículo genuinamente ainda em movimento não fica "parado" por 2+
leituras seguidas por acaso).

## Mudança de código

`src/app/api/motor/route.ts:2085` (dentro do loop por veículo, mesmo bloco
que já calcula `noCliente` alguns lines acima):

```typescript
// Antes:
const emPontoSeguro = riscoPorVeiculo.get(veiculo_id)?.emPontoSeguro ?? false;

// Depois:
const emPontoSeguroBruto = riscoPorVeiculo.get(veiculo_id)?.emPontoSeguro ?? false;
const emPontoSeguro = emPontoSeguroBruto && pos.velocidade === 0;
```

O restante do bloco (`suspensoPorChegada`, `chegouEmDestinoConhecido`)
permanece idêntico — ambos já consomem a variável `emPontoSeguro` local,
então a correção propaga automaticamente para os dois sem precisar tocar
nas linhas 2086-2106.

`suspenderPorChegada` (`unitrac.ts:385-393`) NÃO muda de assinatura — só o
valor que entra nela nesse ponto específico de `route.ts` muda de
semântica (de "dentro do raio" para "dentro do raio E parado").

## Testes

- `src/lib/unitrac.test.ts`: `suspenderPorChegada` em si não muda de
  comportamento (continua puro, recebe `emPontoSeguro` já pronto) — os
  testes existentes (`unitrac.test.ts:201-203`, `:302-304`, describe
  `"suspenderPorChegada (achado 25/07...)"`) continuam válidos sem
  alteração, já que testam a função isolada, não o call site.
- Novo teste de integração em `src/app/api/motor/route.test.ts` (se esse
  arquivo já existir e cobrir cenários de `suspensoPorChegada` — verificar
  no plano) ou, na ausência de teste de rota, documentar explicitamente
  como verificação manual pós-deploy: simular/observar um veículo real
  passando por um posto de gasolina EM MOVIMENTO durante uma leitura com
  `desvio_streak` ativo, confirmar que o streak não é mais zerado só por
  isso.

## Não-objetivos

- Não mexe em `chegouEmDestinoConhecido` (já correto desde 03/08, já força
  `emPontoSeguro=false` incondicionalmente).
- Não adiciona um limiar de tempo mínimo parado (dwell) — `velocidade ===
  0` já é suficiente dado o streak mínimo de 2 leituras do detector
  principal, ver seção acima.
- Não reduz nem restringe a lista de 1.115 geofences de posto de gasolina
  em si — o problema não é a geofence existir, é ela suspender a checagem
  mesmo em movimento.
