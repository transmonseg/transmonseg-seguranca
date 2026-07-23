// Verificação do desvio contra a ESTRADA REAL (ver design
// docs/plans/2026-07-09-desvio-corredor-verificacao-design.md): quando a
// Camada 1 esta prestes a alertar, traça a rota da posição atual até os
// pendentes mais próximos (OSRM público, failover Valhalla) e só deixa o
// alerta passar se o veículo NÃO estiver em nenhuma estrada que leve a um
// destino legítimo. Restrições da pesquisa 09/07: OSRM público = 1 req/s
// GLOBAL, fail-open sempre (API fora = comporta como hoje, nunca segura
// alerta). Nunca importe nada de 'next' aqui — lib pura + fetch.
import { distanciaAoSegmentoM, haversineM, difAngulo, rumoGraus } from "./unitrac";

type Ponto = { lat: number; lng: number };

// Buffer adaptativo (pesquisa 09/07: buffer por contexto de via). Proxy de
// contexto sem mapa de vias: velocidade >= 60 km/h ~ rodovia/serra, onde a
// estrada real serpenteia longe da polilinha ideal e o GPS espaça mais —
// buffer MAIOR pra rota do OSRM cobrir o trajeto com folga. Abaixo disso,
// urbano: buffer estreito o suficiente pra pegar desvio de ~100-150m.
// Reduzido de 300/600 pra 120/200 em 11/07 (diretiva explicita do usuario:
// falso positivo aceitavel, prioridade total e nunca perder desvio real).
//
// Achado real 15/07 (caso 3C94, 13:20): o OSRM/Valhalla roteia so ate a via
// publica mais proxima do destino, nunca ate a portaria/doca real -- na
// manobra final de chegada (~200-300m) e normal e legitimo o veiculo se
// afastar mais da polilinha do que o buffer de transito permite. Buffer
// alargado so nessa zona, mantendo o buffer apertado no resto do trajeto
// (onde o risco de desvio de verdade importa mais).
//
// Achado da auditoria de 22/07: esse mesmo alargamento tambem cobre a area
// de MAIOR risco (perto do cliente, onde ocorre a descarga) -- um desvio
// real de ate 250m nessa zona especifica (ex.: descarregar em outro lugar)
// fica com deteccao mais fraca. Decisao consciente: reduzir o buffer
// aumentaria falso positivo em toda manobra legitima de chegada, e nao ha
// dado disponivel (endereco de portaria/doca) pra distinguir os dois casos
// com precisao. Risco aceito, nao descuido.
const RAIO_CHEGADA_M = 300;
const BUFFER_CHEGADA_M = 250;

export function bufferPorVelocidade(velKmH: number, distDestinoMaisPertoM?: number): number {
  if (distDestinoMaisPertoM !== undefined && distDestinoMaisPertoM <= RAIO_CHEGADA_M) {
    return BUFFER_CHEGADA_M;
  }
  return velKmH >= 60 ? 200 : 120;
}

// Distância mínima do ponto a qualquer segmento da polilinha <= buffer?
export function dentroDoCorredor(pos: Ponto, polilinha: Ponto[], bufferM: number): boolean {
  if (polilinha.length < 2) return false;
  for (let i = 0; i < polilinha.length - 1; i++) {
    if (distanciaAoSegmentoM(pos, polilinha[i], polilinha[i + 1]) <= bufferM) return true;
  }
  return false;
}

// Faixa de "empate" angular: candidatos cuja diferenca de rumo em relacao ao
// deslocamento atual do veiculo cai na mesma faixa de 30 graus sao tratados
// como igualmente alinhados e desempatados por distancia -- evita que um
// candidato 1 grau mais alinhado, mas muito mais longe, roube a prioridade
// de um candidato quase tao alinhado e bem mais perto.
const ANGULO_EMPATE_GRAUS = 30;

// Substitui o corte fixo em "3 mais proximos" usado ate 11/07 na cerca
// virtual -- pressupunha que o motorista vai pro pendente mais perto, mas
// nao ha ordem de entrega definida (o motorista escolhe livremente). Ordena
// por distancia como heuristica pratica de prioridade dentro do orcamento
// de chamadas (quem chama decide quantos tentar), sem descartar nenhum.
//
// Achado real 15/07: com o orcamento de chamadas limitado pelo throttle de
// 1 req/s do OSRM publico (~4-5 candidatos testaveis por verificacao) e
// clientes com mediana de 11 pendentes (Nutry Max), o destino real do
// motorista pode nunca ser testado se so a distancia em linha reta manda --
// rio/rodovia/mao unica separam distancia real de distancia em linha reta
// (caso 3C94). rumoAtual (rumo de deslocamento do ciclo anterior->atual, ja
// calculado no motor como `rumoMovimento`) prioriza candidatos "na frente"
// do veiculo primeiro, sem gastar mais chamadas de API -- so muda a ORDEM.
export function ordenarPendentesPorDistancia<T extends { lat: number; lng: number }>(
  pos: { lat: number; lng: number },
  pendentes: T[],
  rumoAtual: number | null = null
): T[] {
  if (rumoAtual === null) {
    return [...pendentes].sort(
      (a, b) => haversineM(pos.lat, pos.lng, a.lat, a.lng) - haversineM(pos.lat, pos.lng, b.lat, b.lng)
    );
  }
  return pendentes
    .map((p) => {
      const dist = haversineM(pos.lat, pos.lng, p.lat, p.lng);
      const rumoAoPonto = rumoGraus(pos.lat, pos.lng, p.lat, p.lng);
      const faixaAngular = Math.floor(difAngulo(rumoAtual, rumoAoPonto) / ANGULO_EMPATE_GRAUS);
      return { p, dist, faixaAngular };
    })
    .sort((a, b) => a.faixaAngular - b.faixaAngular || a.dist - b.dist)
    .map((x) => x.p);
}

// Achado empirico 11/07/2026: so 1,2% dos pares origem-destino repetem em
// 2+ dias (corredor_celulas, 6 dias de dado real da Nutry). O historico por
// par so deve ser confiavel a partir de 3+ dias distintos vistos -- liga
// sozinho por par conforme o dado acumular, sem decisao manual.
export function parOrigemDestinoTemHistoricoSuficiente(diasDistintos: number, minDias: number): boolean {
  return diasDistintos >= minDias;
}

// Decoder do formato polyline precisao 1e-6 (shape do Valhalla).
export function decodePolyline6(encoded: string): Ponto[] {
  const pontos: Ponto[] = [];
  let index = 0, lat = 0, lng = 0;
  while (index < encoded.length) {
    for (const alvo of ["lat", "lng"] as const) {
      let result = 0, shift = 0, b: number;
      do {
        b = encoded.charCodeAt(index++) - 63;
        result |= (b & 0x1f) << shift;
        shift += 5;
      } while (b >= 0x20);
      const delta = result & 1 ? ~(result >> 1) : result >> 1;
      if (alvo === "lat") lat += delta; else lng += delta;
    }
    pontos.push({ lat: lat / 1e6, lng: lng / 1e6 });
  }
  return pontos;
}

// ─── Throttle GLOBAL de 1 req/s (politica do OSRM publico e do Valhalla
// FOSSGIS). Fila implicita via promise encadeada; deadline total de 5s por
// verificacao — estourou = "indisponivel" (fail-open, quem chama dispara
// o alerta como hoje; NUNCA segura alerta esperando API).
let ultimaChamadaEm = 0;
let filaThrottle: Promise<void> = Promise.resolve();
const INTERVALO_MIN_MS = 1100;
const DEADLINE_VERIFICACAO_MS = 5000;

async function esperarVaga(): Promise<void> {
  const minhaVez = filaThrottle.then(async () => {
    const espera = ultimaChamadaEm + INTERVALO_MIN_MS - Date.now();
    if (espera > 0) await new Promise((r) => setTimeout(r, espera));
    ultimaChamadaEm = Date.now();
  });
  filaThrottle = minhaVez.catch(() => {});
  return minhaVez;
}

type OsrmRouteResponse = {
  code: string;
  routes?: { geometry?: { coordinates?: [number, number][] }; distance?: number }[];
};
type ValhallaResponse = { trip?: { legs?: { shape?: string }[] } };

async function rotaOSRM(a: Ponto, b: Ponto): Promise<Ponto[] | null> {
  const res = await fetch(
    `https://router.project-osrm.org/route/v1/driving/${a.lng},${a.lat};${b.lng},${b.lat}?geometries=geojson&overview=full`,
    { signal: AbortSignal.timeout(3500) }
  );
  if (!res.ok) return null;
  const data = (await res.json()) as OsrmRouteResponse;
  const coords = data.routes?.[0]?.geometry?.coordinates;
  if (data.code !== "Ok" || !coords || coords.length < 2) return null;
  return coords.map(([lng, lat]) => ({ lat, lng }));
}

async function rotaValhalla(a: Ponto, b: Ponto): Promise<Ponto[] | null> {
  const res = await fetch("https://valhalla1.openstreetmap.de/route", {
    method: "POST",
    headers: { "content-type": "application/json", "X-Client-Id": "transmonseg-central" },
    body: JSON.stringify({ locations: [{ lat: a.lat, lon: a.lng }, { lat: b.lat, lon: b.lng }], costing: "auto" }),
    signal: AbortSignal.timeout(3500),
  });
  if (!res.ok) return null;
  const data = (await res.json()) as ValhallaResponse;
  const shape = data.trip?.legs?.[0]?.shape;
  if (!shape) return null;
  const pontos = decodePolyline6(shape);
  return pontos.length >= 2 ? pontos : null;
}

// Traça rota de um PONTO FIXO ANTERIOR (origem — ex. onde o veículo estava
// confirmado no trajeto antes da suspeita de desvio começar) até cada
// destino candidato, e responde se a POSIÇÃO ATUAL do veículo está em cima
// dessa estrada. CRÍTICO: origem precisa ser um ponto do PASSADO, nunca a
// posição atual — se a rota fosse traçada a partir de onde o veículo está
// agora, a checagem seria tautológica (toda rota começa no seu próprio
// ponto de partida, então "estou perto da rota que sai de mim mesmo" dá
// sempre verdadeiro, não importa o quão desviado o veículo esteja de
// verdade). Achado ao vivo 10/07, ver docs/analise-deteccao.md secao 7.6.
// destinos: até 3 mais próximos, o CHAMADOR corta.
export async function verificarCorredor(
  origem: Ponto,
  posAtual: Ponto & { velocidade: number },
  destinos: Ponto[]
): Promise<{ veredito: "dentro" | "fora" | "indisponivel"; corredor: Ponto[] | null }> {
  if (destinos.length === 0) return { veredito: "indisponivel", corredor: null };
  const buffer = bufferPorVelocidade(posAtual.velocidade);
  const inicio = Date.now();
  let alguma = false;

  for (const destino of destinos) {
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
  // Nenhuma rota calculada com sucesso = nao da pra afirmar nada (fail-open).
  if (!alguma) return { veredito: "indisponivel", corredor: null };
  return { veredito: "fora", corredor: null };
}

// Rotação justa do orçamento de verificação de corredor (achado real 21/07,
// ver docs/superpowers/specs/2026-07-21-rotacao-justa-verificacao-corredor-design.md):
// sem isso, a ordem de iteração da frota é estável e arbitrária (a query de
// veículos não tem ORDER BY e fica cacheada por minutos), então o pequeno
// orçamento de chamadas OSRM/Valhalla (throttle real de 1 req/s do servidor
// público) é sempre vencido pelos mesmos poucos veículos primeiros nessa
// ordem, deixando o resto da frota praticamente descoberto pra sempre.
// Ordena por "há mais tempo sem verificação" (nunca verificado = timestamp 0
// = prioridade máxima) -- ao longo de algumas dezenas de ciclos, todo
// veículo eventualmente é coberto. Função pura: quem chama decide quando
// gravar uma nova verificação no mapa.
export function ordenarPorPrioridadeVerificacao<T extends { veiculo_id: string }>(
  itens: T[],
  ultimaVerificacao: Map<string, number>
): T[] {
  return [...itens].sort(
    (a, b) => (ultimaVerificacao.get(a.veiculo_id) ?? 0) - (ultimaVerificacao.get(b.veiculo_id) ?? 0)
  );
}

// Economia de orcamento OSRM na recuperacao da cerca virtual (achado real
// 21/07, ver docs/superpowers/specs/2026-07-21-cerca-virtual-economia-historico-design.md):
// quando o historico (de frota OU do proprio veiculo) ja sabe que a area
// atual e conhecida, pular a chamada OSRM deste veiculo neste ciclo libera
// o orcamento pra outro veiculo genuinamente desconhecido processado
// depois no mesmo ciclo -- sem perder cobertura, porque a Camada 2/3 do
// desvio (foraTapeteStreak) continua rodando em paralelo com o MESMO dado
// e nunca deixa de disparar para sempre, so amortece. Funcao pura: so
// decide SE vale gastar o slot, nunca decide o veredito da cerca em si.
export function deveVerificarRecuperacao(
  dentroTapete: boolean | null,
  familiarVeiculo: boolean | null
): boolean {
  return dentroTapete !== true && familiarVeiculo !== true;
}

// Achado real 22/07 (auditoria): fecha o gap do design original de 09/07
// ("corredor cacheado invalida... quando veiculo para por 5+ min"), nunca
// implementado. paradoMin (route.ts) so mede parada NO ciclo atual --
// nao serve pra detectar "parou, e agora voltou a andar", que e o cenario
// real aqui (corredor foi cacheado em movimento, veiculo para, quando
// volta a andar o motor decide se reusa o cache ou revalida). Por isso
// esta funcao olha o ciclo ANTERIOR: se ele estava parado (velocidade=0)
// e ja tinha passado o limiar quando parou, invalida.
const LIMIAR_PARADA_INVALIDA_CACHE_MIN = 5;

export function paradaLongaInvalidaCache(
  anteriorVelocidade: number | null,
  anteriorParadoDesde: string | null,
  agoraMs: number
): boolean {
  if (anteriorVelocidade !== 0 || !anteriorParadoDesde) return false;
  const paradoMin = (agoraMs - new Date(anteriorParadoDesde).getTime()) / 60000;
  return paradoMin >= LIMIAR_PARADA_INVALIDA_CACHE_MIN;
}
