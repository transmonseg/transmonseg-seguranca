# Ativar pontos_aprendidos como correção de posição — Design

**Contexto:** conversa real no WhatsApp com o operador da Transmonseg
(10/08), motivada pela investigação de casos de "marcação errada"
(feature `motivo_falso_positivo='dado_entrada_errado'`, construída mais
cedo nesta mesma sessão). O operador relatou (áudio) que marcações de
serviço erradas são um problema real e concreto, e sugeriu uma correção
automática usando um código compartilhado entre a "bolinha" (marcador de
endereço na Unitrac) e o romaneio. O usuário percebeu, corretamente, que
corrigir a posição resolve dois problemas de uma vez: falso positivo de
desvio E falha de confirmação de entrega.

**Achado da investigação técnica (hoje):** já existe um mecanismo
construído especificamente para isso — `pontos_aprendidos`
(`scripts/migrations/contabo/028_pontos_aprendidos.sql`, 01/08) — que
aprende a posição real de cada `(cliente_id, ponto_codigo)` a partir do
acumulado de paradas reais confirmadas (`entregas_presenca`), via cron
noturno (`aprender_pontos_entrega()`, 04:20 diário). Hoje está **100% em
modo sombra** — coleta desde 03/08, mas nenhum consumidor lê a tabela.

**Dado real confirmado (query ao vivo, 10/08):** 100 pontos já aprendidos
(todos com ≥5 observações limpas). Cruzando contra a posição atual da
Unitrac (via `pendentes_snapshot_log`, últimos 2 dias, 91 pontos com
correspondência): divergência mediana de 56m, 50 pontos acima de 50m, 7
acima de 150m, nenhum acima de 300m. É sinal real e ativável, não ruído.

**Decisão explícita do usuário:** priorizar a ativação de
`pontos_aprendidos` (mais rápido, já alinhado com a decisão de 31/07 de
nunca usar a coordenada geocodificada do romaneio) em vez de construir a
correlação `cliente_codigo` (romaneio) ↔ `pontocodigo`/`alvocodigo`
(Unitrac) sugerida pelo operador — essa segunda abordagem fica
explicitamente fora de escopo desta spec (ver Não-objetivos).

## Onde aplicar a correção

**ERRATA (10/08, revisão do Task 3):** a afirmação abaixo de que corrigir
em `pendentes` "propaga a correção para todos os quatro consumidores
automaticamente" estava errada — corrigir só em `pendentes` NÃO propagava
pra `bypass_entrega`/`alvoNoRaioAgora` nem pra corroboração D1/D3, que leem
`pontosVeiculo` direto. Isso motivou a mudança real: a implementação corrige
em `pontosVeiculo`, a fonte comum de verdade — ver `route.ts:1839-1853`.

`pendentes` (montado em `route.ts:1799-1814`, filtrado de `pontosVeiculo`
vindo de `buscarAlvos()`/Unitrac) é a fonte comum consumida por:
- `distDestinosM`/`afastouDeTudo` (motor de desvio, via `destinos` =
  `pendentes + centroidesBases + escala`, `route.ts:1858`).
- `bypass_entrega` (`route.ts:2646-2708`, usa `alvoNoRaioAgora` por
  proximidade a `pt.lat/pt.lng/pt.raio`).
- `entregas_presenca` (`route.ts:2721-2740`, mesma fonte de coordenada).
- Corroboração D1/D3 do placar de desvio (`route.ts:1830-1845`).

Corrigir a posição no momento em que `pendentes` é construído propaga a
correção para todos os quatro consumidores automaticamente, sem tocar em
nenhum deles individualmente — exatamente a intuição do usuário.

## Carregamento (1x por ciclo, não por veículo)

Mesmo padrão já usado por `mapaBasesCliente` (`route.ts:759-792`): query
sem filtro de cliente (tabela pequena, 100 linhas hoje), agrupada num
`Map` em memória, carregada num bloco isolado com tratamento de erro que
não derruba o motor:

```typescript
const mapaPontosAprendidos = new Map<string, Map<number, { lat: number; lng: number }>>();

{
  const pgAprendidos = await pool.connect();
  try {
    const { rows } = await pgAprendidos.query<{
      cliente_id: string;
      ponto_codigo: number;
      lat: number;
      lng: number;
    }>(`SELECT cliente_id, ponto_codigo, lat, lng FROM pontos_aprendidos`);
    for (const r of rows) {
      const porCliente = mapaPontosAprendidos.get(r.cliente_id) ?? new Map();
      porCliente.set(r.ponto_codigo, { lat: r.lat, lng: r.lng });
      mapaPontosAprendidos.set(r.cliente_id, porCliente);
    }
  } catch (errAprendidos) {
    const msg = `Aviso: erro ao carregar pontos_aprendidos (${String(errAprendidos)})`;
    console.warn(msg);
    erros.push(msg);
  } finally {
    pgAprendidos.release();
  }
}
```

Falha nessa query degrada para o comportamento de hoje (Map vazio, nenhuma
correção aplicada) — nunca derruba o ciclo do motor, mesmo padrão de todo
outro carregamento auxiliar do arquivo.

## Aplicação da correção

Função pura nova em `src/lib/unitrac.ts` (mesmo arquivo de `PontoEntrega`
e `haversineM`):

```typescript
export const CORRECAO_APRENDIDA_DIVERGENCIA_MAX_M = 500;

export function corrigirComPontoAprendido(
  pt: PontoEntrega,
  aprendido: { lat: number; lng: number } | undefined
): PontoEntrega {
  if (!aprendido) return pt;
  const divergenciaM = haversineM(pt.lat, pt.lng, aprendido.lat, aprendido.lng);
  if (divergenciaM > CORRECAO_APRENDIDA_DIVERGENCIA_MAX_M) return pt;
  return { ...pt, lat: aprendido.lat, lng: aprendido.lng };
}
```

**Só corrige `lat`/`lng`** — `raio` (raio de chegada nominal, já usado com
piso de `RAIO_CHEGADA_MIN_M`) não muda, porque tem semântica diferente do
`raio_m` de `pontos_aprendidos` (que é "maior distância da mediana entre
as observações", não "raio de tolerância de chegada") — misturar os dois
faria o raio de chegada oscilar sem relação com o problema que resolve.

**Teto de divergência (500m):** protege contra confiar cegamente num
ponto aprendido desatualizado se o endereço real do cliente mudar no
futuro — acima do teto, a leitura atual da Unitrac diverge demais do
aprendido pra ser tratada como "mesmo lugar, correção de ruído", e o
sistema volta ao comportamento de hoje (usa a Unitrac crua). Com o dado
real de hoje (mediana 56m, máximo observado 232m), esse teto não bloqueia
nenhuma correção real — é uma proteção pro futuro, não um limitador atual.

**Ponto de integração em `route.ts`** (dentro do filtro de `pendentes`,
`route.ts:1799-1814`), aplicado depois do filtro existente:

```typescript
const pontosAprendidosCliente = mapaPontosAprendidos.get(cliente_id);
const pendentes = (pontosVeiculo ?? [])
  .filter(/* filtro existente, inalterado */)
  .map((pt) =>
    pt.pontoCodigo != null
      ? corrigirComPontoAprendido(pt, pontosAprendidosCliente?.get(pt.pontoCodigo))
      : pt
  );
```

Pontos sem `pontoCodigo` (pode ser `null`, ver `unitrac.ts:155`) passam
direto, sem correção — não há como cruzar com `pontos_aprendidos` sem o
código.

## Flag de ativação

Seguindo o padrão já estabelecido no arquivo (`SAIDA_NAO_AUTORIZADA_ATIVO`,
`ENTREGA_PRESENCA_ATIVA`, `DESVIO_SO_AFASTANDO_OU_FORA_DO_TAPETE`):

```typescript
export const PONTO_APRENDIDO_ATIVO = true;
```

Se `false`, `mapaPontosAprendidos` continua sendo carregado (custo
desprezível, 100 linhas) mas a correção não é aplicada — permite desligar
rápido em produção sem reverter deploy, mesmo padrão já usado para as
outras flags deste arquivo.

## Testes

- `src/lib/unitrac.test.ts`: casos novos para `corrigirComPontoAprendido`
  — sem correção disponível (retorna `pt` inalterado); correção dentro do
  teto (retorna `lat`/`lng` do aprendido, mantém `raio`/`nome`/demais
  campos); correção fora do teto de 500m (retorna `pt` inalterado).
- Sem teste de rota para o carregamento/wiring em `route.ts` (nenhuma API
  route deste projeto tem teste automatizado, mesmo padrão confirmado
  repetidamente nesta sessão) — verificação manual pós-deploy via SQL: (a)
  confirmar que o motor carrega `pontos_aprendidos` sem erro (log/aviso
  ausente); (b) comparar `pendentes_snapshot_log` antes/depois do deploy
  para os `ponto_codigo` com divergência conhecida (ex: `563321`, 242m de
  divergência medida hoje) e confirmar que a posição gravada passou a
  bater com `pontos_aprendidos`, não com a Unitrac crua.

## Não-objetivos

- Não constrói a correlação `cliente_codigo` (romaneio) ↔
  `pontocodigo`/`alvocodigo` (Unitrac) sugerida pelo operador no áudio —
  decisão explícita do usuário de priorizar `pontos_aprendidos` primeiro.
  Pode virar uma spec separada depois, como segunda fonte de correção
  (mais rápida que esperar 5 observações) se `pontos_aprendidos` sozinho
  não for suficiente.
- Não muda `aprender_pontos_entrega()`, o cron noturno, nem o limiar de
  ≥5 observações — reutiliza a infraestrutura de coleta exatamente como
  está.
- Não corrige `raio` (raio de chegada) — só posição (`lat`/`lng`).
- Não aplica a bases nem a pontos de escala — só a itens de `pendentes`
  vindos de alvos Unitrac com `pontoCodigo` não-nulo (bases já têm
  coordenada própria e confiável na tabela `bases`; escala não tem
  `pontoCodigo` da Unitrac, é geocodificação de cidade aproximada, fora
  do domínio deste mecanismo).
- Não constrói UI de correção manual (o "campo" mencionado no áudio, que
  a investigação confirmou não existir hoje) — fora de escopo, o usuário
  esclareceu que era uma ideia, não algo já construído.
