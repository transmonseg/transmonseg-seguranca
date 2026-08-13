// Corrige posicao atual/anterior via map matching real do OSRM (/match,
// Hidden Markov Model) antes do calculo de distancia -- ver
// docs/superpowers/specs/2026-08-13-osrm-match-desvio-design.md. Ao
// contrario de /table (distancia-real.ts), que encaixa cada ponto
// independentemente na rua mais proxima, /match encaixa a TRAJETORIA
// inteira de uma vez, evitando o artefato de "delta uniforme entre
// destinos completamente diferentes" achado em 4 casos reais no dia
// 13/08 -- puramente uma chamada de rede, sem logica de decisao (quem
// chama decide QUANDO usar isso, ver route.ts).

const OSRM_LOCAL_URL = process.env.OSRM_LOCAL_URL ?? "http://127.0.0.1:5001";
const DEADLINE_MS = 5000;

export type PosicaoCorrigida = { lat: number; lng: number };
export type ResultadoMatch = { atual: PosicaoCorrigida; anterior: PosicaoCorrigida; confidence: number };

type TracePoint = { location: [number, number]; matchings_index: number } | null;
type RespostaMatch = { code: string; matchings?: { confidence: number }[]; tracepoints?: TracePoint[] };

export async function corrigirPosicoesComMatch(
  pontos: { lat: number; lng: number; timestamp: Date }[]
): Promise<ResultadoMatch | null> {
  if (pontos.length < 2) return null;

  const coords = pontos.map((p) => `${p.lng},${p.lat}`).join(";");
  const timestamps = pontos.map((p) => Math.floor(p.timestamp.getTime() / 1000)).join(";");

  try {
    const res = await fetch(
      `${OSRM_LOCAL_URL}/match/v1/driving/${coords}?timestamps=${timestamps}&annotations=false&overview=false`,
      { signal: AbortSignal.timeout(DEADLINE_MS) }
    );
    if (!res.ok) return null;

    const data = (await res.json()) as RespostaMatch;
    if (data.code !== "Ok" || !data.matchings || !data.tracepoints) return null;

    // Achado real 13/08 (revisao final, confirmado ao vivo contra o OSRM
    // real de producao): o OSRM pode descartar o(s) ULTIMO(S) ponto(s) da
    // janela como outlier e ainda assim responder code:"Ok" com confidence
    // alta (ex: 0.9386) -- tracepoints termina em null(s) (ex: [tp0, tp1,
    // null, null]). Filtrar so' os tracepoints nao-nulos e pegar os 2
    // ultimos DESSA LISTA FILTRADA (comportamento antigo, bugado) entrega
    // uma leitura de 1-2 ciclos atras como "atual" -- exatamente no cenario
    // mais comum de GPS ruidoso, que e' a razao de existir esta feature.
    // Precisa ser o ULTIMO e o PENULTIMO INDICE DO ARRAY ORIGINAL (o ponto
    // mais recente enviado ao /match e o anterior a ele), nunca de uma
    // lista filtrada -- se qualquer um dos dois vier null, nao corrige
    // (retorna null, cai no fallback bruto, seguro).
    const tpAtual = data.tracepoints[pontos.length - 1];
    const tpAnterior = data.tracepoints[pontos.length - 2];
    if (!tpAtual || !tpAnterior) return null;

    const confidence = data.matchings[tpAtual.matchings_index]?.confidence;
    if (confidence == null) return null;

    return {
      atual: { lat: tpAtual.location[1], lng: tpAtual.location[0] },
      anterior: { lat: tpAnterior.location[1], lng: tpAnterior.location[0] },
      confidence,
    };
  } catch {
    return null;
  }
}
