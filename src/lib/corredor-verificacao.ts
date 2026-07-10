// Verificação do desvio contra a ESTRADA REAL (ver design
// docs/plans/2026-07-09-desvio-corredor-verificacao-design.md): quando a
// Camada 1 esta prestes a alertar, traça a rota da posição atual até os
// pendentes mais próximos (OSRM público, failover Valhalla) e só deixa o
// alerta passar se o veículo NÃO estiver em nenhuma estrada que leve a um
// destino legítimo. Restrições da pesquisa 09/07: OSRM público = 1 req/s
// GLOBAL, fail-open sempre (API fora = comporta como hoje, nunca segura
// alerta). Nunca importe nada de 'next' aqui — lib pura + fetch.
import { distanciaAoSegmentoM } from "./unitrac";

type Ponto = { lat: number; lng: number };

// Buffer adaptativo (pesquisa 09/07: buffer por contexto de via). Proxy de
// contexto sem mapa de vias: velocidade >= 60 km/h ~ rodovia/serra, onde a
// estrada real serpenteia longe da polilinha ideal e o GPS espaça mais —
// buffer MAIOR pra rota do OSRM cobrir o trajeto com folga. Abaixo disso,
// urbano: 300m já acomoda quarteirão + erro de GPS sem engolir desvio real.
export function bufferPorVelocidade(velKmH: number): number {
  return velKmH >= 60 ? 600 : 300;
}

// Distância mínima do ponto a qualquer segmento da polilinha <= buffer?
export function dentroDoCorredor(pos: Ponto, polilinha: Ponto[], bufferM: number): boolean {
  if (polilinha.length < 2) return false;
  for (let i = 0; i < polilinha.length - 1; i++) {
    if (distanciaAoSegmentoM(pos, polilinha[i], polilinha[i + 1]) <= bufferM) return true;
  }
  return false;
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
