# OSRM self-hosted no Contabo — Design

**Contexto:** investigação do padrão recorrente "desvio falso chegando no
cliente / voltando pra base" (relatado pela equipe no grupo WhatsApp,
08-09/08) achou a causa raiz real em `src/lib/corredor-verificacao.ts`: a
checagem de corredor (compara a posição atual contra a estrada real via
OSRM) usa o servidor **público** do OSRM, que tem limite de **1
requisição/segundo pro mundo inteiro** (política do projeto OSRM). Com
esse orçamento, `verificarCorredor` só consegue testar ~3-5 candidatos por
verificação (`DEADLINE_VERIFICACAO_MS = 5000`, throttle de 1,1s entre
chamadas) — mas os clientes têm mediana de 11 destinos pendentes
(Nutry Max). Na prática, o destino real do motorista frequentemente nunca é
testado, e o veículo é marcado `veredito: "fora"` não porque saiu de
qualquer rota legítima, mas porque a verificação ficou sem orçamento antes
de chegar no candidato certo.

Dado real de calibração (`calibracao_desvio`, ver spec de 08/08): segmento
`corredor_veredito:fora` tem ~17-19% de falso positivo — pior que a média
geral de `afastando_de_tudo` (~9%), consistente com essa causa raiz.

**Goal:** eliminar o throttle de 1 req/s pra verificação de corredor,
hospedando o próprio OSRM no Contabo — permite testar TODOS os destinos
pendentes (não só 3-5) a cada verificação, sem limite artificial de
orçamento.

## Escopo geográfico

Extrato do **Brasil inteiro** (não só Rio de Janeiro) — decisão do usuário
após ver o dado real: posições dos últimos 30 dias em produção cobrem de
-27° a -20° de latitude e -53° a -41° de longitude (RJ, SP, MG, ES e mais
longe), não só a região metropolitana do Rio. Um extrato só de RJ deixaria
essas rotas reais fora, caindo sempre no fallback público (sem ganho
nenhum pra elas).

## Arquitetura

Servidor VPS `transmonseg-vps` (Contabo, confirmado: 11GB RAM, 6 CPUs,
167GB disco livre — folga generosa pro extrato do Brasil, que tipicamente
usa poucos GB durante o pré-processamento e roda com pegada de memória
menor via mmap depois de pronto).

- **Motor**: `osrm-backend` (open source, mesmo formato de resposta HTTP
  que o código já consome hoje — `rotaOSRM` em `corredor-verificacao.ts`
  não muda o parsing, só a URL base).
- **Distribuição**: imagem Docker oficial (`ghcr.io/project-osrm/osrm-backend`)
  — Docker não está instalado na VPS hoje (`which docker` confirmou);
  instalação única, isolada, não conflita com os serviços nativos
  (systemd/PM2) já rodando lá.
- **Algoritmo**: MLD (multi-level Dijkstra) — mais leve em memória que CH
  pra extrato do tamanho do Brasil, ainda rápido o suficiente pra consulta
  de rota em tempo real.
- **Pipeline de pré-processamento** (uma vez, refeito periodicamente
  conforme o mapa OSM for atualizado — não a cada deploy):
  1. Baixar extrato `brazil-latest.osm.pbf` (Geofabrik).
  2. `osrm-extract -p car.lua brazil-latest.osm.pbf`
  3. `osrm-partition brazil-latest.osrm`
  4. `osrm-customize brazil-latest.osrm`
  5. `osrm-routed --algorithm mld brazil-latest.osrm` — serve HTTP na porta
     **5001** (livre — não colide com nenhuma porta já em uso pelo projeto:
     3000/3001/3002/3010/3020 dos apps Next, 5000 do Storage-API,
     8000/9998/9999 do stack Supabase self-hosted).
- Roda como serviço systemd (`osrm-transmonseg.service`) OU container
  Docker com restart automático — decisão de implementação na Task de
  infra, não muda o comportamento do código.

## Mudanças de código (`src/lib/corredor-verificacao.ts`)

### Cadeia de fallback: self-hosted vira a PRIMEIRA tentativa

Hoje: `rotaOSRM` (público) → `rotaValhalla` (público). Depois desta
mudança: `rotaOSRMLocal` (self-hosted, sem throttle) → `rotaOSRM`
(público, com throttle) → `rotaValhalla` (público, com throttle) — a
cadeia atual continua existindo INTEIRA como fallback, nunca removida.
Isso preserva a propriedade de segurança já documentada no arquivo
("fail-open sempre... nunca segura alerta"): se o self-hosted cair por
qualquer motivo, o comportamento é EXATAMENTE o de hoje, nunca pior.

```typescript
const OSRM_LOCAL_URL = process.env.OSRM_LOCAL_URL ?? "http://127.0.0.1:5001";

async function rotaOSRMLocal(a: Ponto, b: Ponto): Promise<Ponto[] | null> {
  const res = await fetch(
    `${OSRM_LOCAL_URL}/route/v1/driving/${a.lng},${a.lat};${b.lng},${b.lat}?geometries=geojson&overview=full`,
    { signal: AbortSignal.timeout(1000) } // local: timeout curto, sem desculpa pra demorar
  );
  if (!res.ok) return null;
  const data = (await res.json()) as OsrmRouteResponse;
  const coords = data.routes?.[0]?.geometry?.coordinates;
  if (data.code !== "Ok" || !coords || coords.length < 2) return null;
  return coords.map(([lng, lat]) => ({ lat, lng }));
}
```

### Sem throttle pro self-hosted; SEM candidatos limitados a 3

`verificarCorredor` ganha um primeiro laço testando `rotaOSRMLocal` contra
TODOS os `destinos` recebidos (não fatiado em 3), sem chamar
`esperarVaga()` (o throttle de 1,1s é especificamente sobre a política do
serviço PÚBLICO — não se aplica a uma chamada local). Só cai pro laço
atual (throttled, limitado a quem o chamador cortar) se o self-hosted não
responder pra NENHUM candidato (indisponível de verdade).

```typescript
// Só o fallback PUBLICO respeita esse teto -- e' o mesmo limite de sempre
// (existia como o corte que o CHAMADOR fazia antes desta mudança), agora
// aplicado DENTRO da função pra não depender do chamador ter cortado
// certo. A Camada 0 (self-hosted) nunca usa essa constante -- testa
// `destinos` inteiro, sem teto, porque não tem throttle pra respeitar.
const MAX_CANDIDATOS_FALLBACK_PUBLICO = 3;

export async function verificarCorredor(
  origem: Ponto,
  posAtual: Ponto & { velocidade: number },
  destinos: Ponto[]
): Promise<{ veredito: "dentro" | "fora" | "indisponivel"; corredor: Ponto[] | null }> {
  if (destinos.length === 0) return { veredito: "indisponivel", corredor: null };
  const buffer = bufferPorVelocidade(posAtual.velocidade);

  // Camada 0 (NOVA): self-hosted, sem throttle, testa TODOS os destinos
  // recebidos -- é essa lista completa (não mais cortada em 3 pelo
  // chamador) que resolve a causa raiz (destino real nunca testado).
  let algumaLocal = false;
  for (const destino of destinos) {
    let rota: Ponto[] | null = null;
    try { rota = await rotaOSRMLocal(origem, destino); } catch { /* cai pro fallback abaixo */ }
    if (!rota) continue;
    algumaLocal = true;
    if (dentroDoCorredor(posAtual, rota, buffer)) {
      return { veredito: "dentro", corredor: rota };
    }
  }
  if (algumaLocal) return { veredito: "fora", corredor: null };

  // Camada 1 (EXISTENTE, comportamento preservado): self-hosted
  // indisponível -- cai pro público com throttle, testando só os
  // primeiros MAX_CANDIDATOS_FALLBACK_PUBLICO da mesma lista (já vem
  // ordenada por ordenarPendentesPorDistancia antes de chegar aqui) --
  // exatamente o mesmo orçamento de hoje, só que a decisão de cortar
  // agora é DESTA função, não do chamador.
  const candidatosFallback = destinos.slice(0, MAX_CANDIDATOS_FALLBACK_PUBLICO);
  const inicio = Date.now();
  let alguma = false;
  for (const destino of candidatosFallback) {
    if (Date.now() - inicio > DEADLINE_VERIFICACAO_MS) break;
    await esperarVaga();
    let rota: Ponto[] | null = null;
    try { rota = await rotaOSRM(origem, destino); } catch { /* failover abaixo */ }
    if (!rota) {
      try { rota = await rotaValhalla(origem, destino); } catch { /* segue */ }
    }
    if (!rota) continue;
    alguma = true;
    if (dentroDoCorredor(posAtual, rota, buffer)) {
      return { veredito: "dentro", corredor: rota };
    }
  }
  if (!alguma) return { veredito: "indisponivel", corredor: null };
  return { veredito: "fora", corredor: null };
}
```

### `route.ts`: parar de cortar em 3 candidatos ANTES de chamar `verificarCorredor`

Achado real (linha ~3039 hoje): `const candidatos = [...destinos]...slice(0,3)` —
esse corte existe especificamente por causa do orçamento do serviço
público, e cortava ANTES de `verificarCorredor` sequer rodar (a função
recebia só 3, nunca sabia que existiam mais). Agora o corte se move pra
DENTRO de `verificarCorredor` (`MAX_CANDIDATOS_FALLBACK_PUBLICO`, só
aplicado à Camada 1) — `route.ts` passa `destinos` (já ordenado por
`ordenarPendentesPorDistancia`) **completo**, sem fatiar. A Camada 0 usa
a lista inteira; a Camada 1, se for alcançada, corta pra 3 sozinha —
exatamente o mesmo orçamento público de hoje, só que a decisão de cortar
sai do chamador e vai pra dentro da própria função de verificação.

## Observabilidade

Log leve (nível existente do projeto, sem tabela nova) quando a Camada 0
(self-hosted) falha e o código cai pro fallback público — permite saber se
o self-hosted está saudável sem precisar caçar isso manualmente depois.

## Testes

`corredor-verificacao.test.ts` (se não existir, criar): `verificarCorredor`
mockando `fetch` pra simular (a) self-hosted respondendo com rota dentro
do buffer → `dentro`, resposta local, sem chamar throttle; (b) self-hosted
respondendo mas fora do buffer pra todos os destinos → `fora`; (c)
self-hosted indisponível (fetch rejeita/timeout) pra todos os destinos,
público responde → cai pro fallback existente, mesmo resultado de hoje;
(d) self-hosted E público indisponíveis → `indisponivel` (fail-open
preservado).

## Deploy e validação

1. Setup do OSRM na VPS (Task de infra, comandos exatos na Task de
   implementação — pipeline de pré-processamento acima).
2. Deploy do código (mesmo processo de sempre: replicar pro repo espelho,
   deploy PM2 nos 2 processos).
3. Validação real: comparar, num período de observação (ex: 24-48h),
   quantos alertas com motivo "Fora da rota esperada" e/ou
   `corredor_veredito:fora` aparecem antes vs depois — e cruzar com
   `casos_desvio_revisao` pra ver se a taxa de falso positivo desse
   segmento cai de verdade (hoje ~17-19%).
