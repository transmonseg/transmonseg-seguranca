// src/lib/distancias-osrm.ts
//
// Distancia REAL de rua (nao linha reta) pra um veiculo ate varios
// destinos de uma vez, via OSRM self-hosted no Contabo (mesma instancia
// ja usada por src/lib/corredor-verificacao.ts -- ver
// docs/superpowers/specs/2026-08-09-osrm-self-hosted-design.md). Usa o
// endpoint /table (matriz), 1 chamada HTTP por veiculo por ciclo, em vez
// de N chamadas /route -- muito mais barato pra "distancia ate todos os
// pendentes" do que pra "rota completa ate um destino" (que e' o caso de
// uso de corredor-verificacao.ts, por isso os dois nao compartilham
// codigo apesar de falarem com o mesmo OSRM).
//
// Achado real 11/08 (docs/analise-desvio-raiz-2026-08-11.md): os
// "desvios reais" mais fortes encontrados pelo modo teste usando linha
// reta nao disparavam mais quando testados com distancia de rua de
// verdade -- linha reta mente sobre o quanto o carro andou (baias,
// morros, ruas de mao unica no Rio). Essa funcao existe pra resolver
// exatamente isso.

const OSRM_LOCAL_URL = process.env.OSRM_LOCAL_URL ?? "http://127.0.0.1:5001";
const TIMEOUT_MS = 3000;

export type PontoComId = { id: string; lat: number; lng: number };

export async function distanciasReaisOSRM(
  origem: { lat: number; lng: number },
  destinos: PontoComId[]
): Promise<Record<string, number>> {
  if (destinos.length === 0) return {};

  const coords = [`${origem.lng},${origem.lat}`, ...destinos.map((d) => `${d.lng},${d.lat}`)].join(";");
  const url = `${OSRM_LOCAL_URL}/table/v1/driving/${coords}?sources=0&annotations=distance`;

  const resp = await fetch(url, { signal: AbortSignal.timeout(TIMEOUT_MS) });
  if (!resp.ok) throw new Error(`OSRM table respondeu ${resp.status}`);
  const json = (await resp.json()) as { code: string; distances?: number[][] };
  if (json.code !== "Ok" || !json.distances) throw new Error(`OSRM table falhou: ${json.code}`);

  const linhaDaOrigem = json.distances[0]; // [distancia ate a propria origem (0), depois um valor por destino]
  const distancias: Record<string, number> = {};
  destinos.forEach((d, i) => {
    const dist = linhaDaOrigem[i + 1];
    if (dist != null) distancias[d.id] = dist;
  });
  return distancias;
}
