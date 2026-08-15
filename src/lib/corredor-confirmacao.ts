// Confirmacao de corredor real (OSRM self-hosted) como sinal de
// CORROBORACAO do desvio -- nunca supressao. Ver
// docs/superpowers/specs/2026-08-14-desvio-corredor-corroboracao-design.md.
// So roda 1x, no ciclo exato em que afastando_geral ja decidiu disparar
// (quem chama decide isso) -- nao compete por orcamento continuo com o
// resto da frota, por isso sem throttle/fallback publico/rotacao de
// orcamento que o corredor antigo (corredor-verificacao.ts, removido no
// commit 6643bee/f695308..492f140) precisava.
import { distanciaAoSegmentoM } from "./unitrac";

type Ponto = { lat: number; lng: number };

// Buffer adaptativo por contexto de via (sem mapa de vias): velocidade
// alta ~ rodovia, onde a estrada real serpenteia mais longe da polilinha
// ideal -- buffer maior. Valores herdados do corredor antigo (11/07,
// reduzidos de 300/600 por diretiva explicita: falso positivo aceitavel,
// nunca perder desvio real).
export function bufferPorVelocidade(velKmH: number): number {
  return velKmH >= 60 ? 200 : 120;
}

// Distancia minima do ponto a qualquer segmento da polilinha <= buffer?
export function dentroDoCorredor(pos: Ponto, polilinha: Ponto[], bufferM: number): boolean {
  if (polilinha.length < 2) return false;
  for (let i = 0; i < polilinha.length - 1; i++) {
    if (distanciaAoSegmentoM(pos, polilinha[i], polilinha[i + 1]) <= bufferM) return true;
  }
  return false;
}

const OSRM_LOCAL_URL = process.env.OSRM_LOCAL_URL ?? "http://127.0.0.1:5001";
// Deadline TOTAL do loop (checado a cada iteracao, nao por chamada
// individual) -- mais curto que os 5s do corredor antigo porque aqui nao
// ha fallback publico pra esperar, e a funcao roda 1x por disparo ja
// formado, nao continuamente por toda a frota suspeita.
const DEADLINE_TOTAL_MS = 3000;

type OsrmRouteResponse = {
  code: string;
  routes?: { geometry?: { coordinates?: [number, number][] } }[];
};

async function rotaOSRMLocal(a: Ponto, b: Ponto): Promise<Ponto[] | null> {
  const res = await fetch(
    `${OSRM_LOCAL_URL}/route/v1/driving/${a.lng},${a.lat};${b.lng},${b.lat}?geometries=geojson&overview=full`,
    { signal: AbortSignal.timeout(1000) }
  );
  if (!res.ok) return null;
  const data = (await res.json()) as OsrmRouteResponse;
  const coords = data.routes?.[0]?.geometry?.coordinates;
  if (data.code !== "Ok" || !coords || coords.length < 2) return null;
  return coords.map(([lng, lat]) => ({ lat, lng }));
}

// Traca a rota real de `origem` (ponto do PASSADO -- nunca a posicao
// atual, senao a checagem e tautologica: toda rota comeca no seu proprio
// ponto de partida) ate cada destino, e confirma se NENHUMA delas passa
// perto o suficiente de `posAtual`. So retorna confirmaFora=true quando
// pelo menos uma rota foi calculada com sucesso e nenhuma bateu -- se
// nenhuma rota resolveu (OSRM indisponivel), fail-open: sem confirmacao,
// sem bonus, nunca bloqueia o alerta que ja ia disparar.
export async function verificarCorredorFora(
  origem: Ponto,
  posAtual: Ponto & { velocidade: number },
  destinos: Ponto[]
): Promise<{ confirmaFora: boolean }> {
  if (destinos.length === 0) return { confirmaFora: false };
  const buffer = bufferPorVelocidade(posAtual.velocidade);
  const inicio = Date.now();
  let algumaRotaSucesso = false;
  for (const destino of destinos) {
    if (Date.now() - inicio > DEADLINE_TOTAL_MS) break;
    let rota: Ponto[] | null = null;
    try {
      rota = await rotaOSRMLocal(origem, destino);
    } catch {
      // Falha pontual de rede num destino -- segue pro proximo, nao aborta.
    }
    if (!rota) continue;
    algumaRotaSucesso = true;
    if (dentroDoCorredor(posAtual, rota, buffer)) {
      return { confirmaFora: false };
    }
  }
  return { confirmaFora: algumaRotaSucesso };
}
