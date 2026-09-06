// Reposicionamento por ANCORAS CONHECIDAS -- passo 7 do motor de
// geolocalizacao universal (docs/superpowers/specs/
// 2026-09-05-motor-geolocalizacao-universal-design.md). A coerencia de
// grupo (romaneio-geocode-coerencia.ts) so' roda pro formato SEM cidade da
// Rio Quality e constroi as ancoras a partir de ruas UNICAS dentro do
// proprio lote. Aqui as ancoras sao ENTREGAS JA RESOLVIDAS de verdade (pela
// cascata precisa, com cidade) do MESMO caminhao no MESMO dia -- sinal mais
// forte, ja' que sao coordenadas reais, nao inferidas.
//
// Uso: endereco que a cascata precisa nao resolveu (rua truncada, erro de
// digitacao leve, CNEFE sem match exato pro numero) mas cujo NOME DA RUA
// aparece no CNEFE em algum lugar perto de onde o caminhao ja' esteve
// naquele dia -- acha o candidato mais proximo de QUALQUER entrega ja'
// confirmada por geocode daquele caminhao.
//
// Lib PURA (sem banco, sem fetch) -- mesma convencao da coerencia de grupo.

export type CandidatoRua = { lat: number; lng: number };
export type Ancora = { lat: number; lng: number };

function distanciaM(a: { lat: number; lng: number }, b: { lat: number; lng: number }): number {
  const R = 6_371_000;
  const p1 = (a.lat * Math.PI) / 180;
  const p2 = (b.lat * Math.PI) / 180;
  const dp = ((b.lat - a.lat) * Math.PI) / 180;
  const dl = ((b.lng - a.lng) * Math.PI) / 180;
  const x = Math.sin(dp / 2) ** 2 + Math.cos(p1) * Math.cos(p2) * Math.sin(dl / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(x));
}

// Mesmo raio de ancora da coerencia de grupo (RAIO_ANCORA_M em
// romaneio-geocode-coerencia.ts) -- aqui a ancora e' mais forte (coordenada
// real confirmada, nao inferida de rua unica), mas o raio continua sendo
// "mesma regiao de entrega do caminhao naquele dia", entao o mesmo valor
// se aplica.
export const RAIO_ANCORA_CONHECIDA_M = 2_500;

/** Devolve o candidato mais proximo de QUALQUER ancora, se estiver dentro
 *  do raio -- null se nao ha candidato, nao ha ancora, ou o mais proximo
 *  ainda assim fica longe demais (nao arrisca "melhor candidato disponivel"
 *  quando ele nao bate com a regiao real do caminhao). */
export function reposicionarPorAncoraMaisProxima(
  candidatos: CandidatoRua[],
  ancoras: Ancora[]
): { lat: number; lng: number } | null {
  if (candidatos.length === 0 || ancoras.length === 0) return null;
  let melhor: { candidato: CandidatoRua; dist: number } | null = null;
  for (const c of candidatos) {
    const dist = Math.min(...ancoras.map((a) => distanciaM(a, c)));
    if (!melhor || dist < melhor.dist) melhor = { candidato: c, dist };
  }
  if (!melhor || melhor.dist > RAIO_ANCORA_CONHECIDA_M) return null;
  return { lat: melhor.candidato.lat, lng: melhor.candidato.lng };
}
