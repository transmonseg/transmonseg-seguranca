// Resolve o destino (cidade/regiao, sem endereco) de uma linha da escala
// de rota pra uma coordenada aproximada -- ver
// docs/superpowers/specs/2026-08-09-escala-rota-design.md. Raio largo de
// proposito (cidade toda, nao rua): a escala nao tem precisao de
// endereco, entao o destino resultante tambem nao deveria fingir ter.
export const RAIO_ESCALA_M = 10_000;

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
  if (google) return google;
  return deps.geocodificarNominatimDep(consulta);
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
