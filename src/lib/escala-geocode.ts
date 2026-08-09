// Resolve o destino (cidade/regiao, sem endereco) de uma linha da escala
// de rota pra uma coordenada aproximada -- ver
// docs/superpowers/specs/2026-08-09-escala-rota-design.md. Raio largo de
// proposito (cidade toda, nao rua): a escala nao tem precisao de
// endereco, entao o destino resultante tambem nao deveria fingir ter.
export const RAIO_ESCALA_M = 10_000;

// Bounding box aproximado do estado do RJ. Achado da revisao final de
// branch: nome de cidade pode ser ambiguo no Brasil inteiro (ex.:
// "Natividade" existe no RJ E no Tocantins, ~1500km de distancia --
// mesmo problema que romaneio-geocode.ts ja documenta e resolve via
// escolherCandidatoMaisProximo/DISTANCIA_MAX_MATCH_LOCAL_M, mas que o
// caminho da escala nao reaproveitava). A escala e sempre RJ -- um
// resultado fora da caixa e quase certamente o match errado.
const RJ_LAT_MIN = -23.9;
const RJ_LAT_MAX = -20.7;
const RJ_LNG_MIN = -44.9;
const RJ_LNG_MAX = -40.9;

function dentroDoRJ(lat: number, lng: number): boolean {
  return lat >= RJ_LAT_MIN && lat <= RJ_LAT_MAX && lng >= RJ_LNG_MIN && lng <= RJ_LNG_MAX;
}

export type ResolucaoEscala =
  | { via: "cidade" | "apelido"; lat: number; lng: number; raioM: number }
  | { via: "nao_resolvido" };

export type DepsEscalaGeocode = {
  geocodificarGoogleDep: (endereco: string) => Promise<{ lat: number; lng: number } | null>;
  geocodificarNominatimDep: (endereco: string) => Promise<{ lat: number; lng: number } | null>;
  buscarApelidoDep: (texto: string) => Promise<string | null>;
};

async function geocodificarCidade(
  cidade: string,
  deps: DepsEscalaGeocode
): Promise<{ lat: number; lng: number } | null> {
  const consulta = `${cidade}, RJ, Brasil`;
  const google = await deps.geocodificarGoogleDep(consulta);
  if (google && dentroDoRJ(google.lat, google.lng)) return google;
  const nominatim = await deps.geocodificarNominatimDep(consulta);
  if (nominatim && dentroDoRJ(nominatim.lat, nominatim.lng)) return nominatim;
  return null;
}

export async function resolverDestinoEscala(
  destinoNormalizado: string,
  deps: DepsEscalaGeocode
): Promise<ResolucaoEscala> {
  const porCidade = await geocodificarCidade(destinoNormalizado, deps);
  if (porCidade) {
    return { via: "cidade", lat: porCidade.lat, lng: porCidade.lng, raioM: RAIO_ESCALA_M };
  }

  const cidadeApelido = await deps.buscarApelidoDep(destinoNormalizado);
  if (cidadeApelido) {
    const viaApelido = await geocodificarCidade(cidadeApelido, deps);
    if (viaApelido) {
      return { via: "apelido", lat: viaApelido.lat, lng: viaApelido.lng, raioM: RAIO_ESCALA_M };
    }
  }

  return { via: "nao_resolvido" };
}
