// Geocodificacao de enderecos do romaneio (endereco -> coordenada), com
// cache e cadeia de fallback. Espelha o padrao ja usado no motor pro
// geocode REVERSO (coordenada -> endereco, ver geocodeReverso em
// api/motor/route.ts) -- mesma chave do Google, mesmo User-Agent do
// Nominatim -- so na direcao contraria.

export function normalizarEndereco(enderecoBruto: string): string {
  return enderecoBruto.trim().toUpperCase().replace(/\s+/g, " ");
}

// SEM fallback pra coordenada da Unitrac de proposito -- achado real 15/07:
// no romaneio de teste (22 pontos, veiculo TUL1C38), 18 cairiam no fallback
// da Unitrac (Nominatim gratuito nao cobre a maioria das ruas de cidade
// pequena do interior, e GOOGLE_MAPS_API_KEY server-side nao esta
// configurada) -- ou seja, a MAIORIA dos pontos continuaria usando a
// coordenada "as vezes errada" que o romaneio existe pra evitar. Decisao
// explicita do usuario: se nao geocodificar, o ponto fica sem coordenada
// (excluido da lista de pendentes pelo motor) em vez de reusar a Unitrac.
export type ResultadoGeocode = { lat: number; lng: number; fonte: "google" | "nominatim" } | null;

type Deps = {
  buscarCache: (chave: string) => Promise<{ lat: number; lng: number; fonte: string } | null>;
  salvarCache: (chave: string, r: { lat: number; lng: number; fonte: string }) => Promise<void>;
  geocodificarGoogle: (enderecoBruto: string) => Promise<{ lat: number; lng: number } | null>;
  geocodificarNominatim: (enderecoBruto: string) => Promise<{ lat: number; lng: number } | null>;
};

export async function geocodificarEndereco(enderecoBruto: string, deps: Deps): Promise<ResultadoGeocode> {
  const chave = normalizarEndereco(enderecoBruto);
  const doCache = await deps.buscarCache(chave);
  if (doCache) return { lat: doCache.lat, lng: doCache.lng, fonte: doCache.fonte as "google" | "nominatim" };

  const google = await deps.geocodificarGoogle(enderecoBruto);
  if (google) {
    await deps.salvarCache(chave, { ...google, fonte: "google" });
    return { ...google, fonte: "google" };
  }
  const nominatim = await deps.geocodificarNominatim(enderecoBruto);
  if (nominatim) {
    await deps.salvarCache(chave, { ...nominatim, fonte: "nominatim" });
    return { ...nominatim, fonte: "nominatim" };
  }
  return null;
}

// Chamadas HTTP reais -- SEM cache/fallback, isso fica por conta de
// geocodificarEndereco acima. Nao testadas por teste automatizado (chamada
// de rede real); validadas manualmente na Task 5 contra enderecos reais do
// romaneio.
export async function geocodificarGoogle(enderecoBruto: string): Promise<{ lat: number; lng: number } | null> {
  const chave = process.env.GOOGLE_MAPS_API_KEY;
  if (!chave) return null;
  try {
    const url = `https://maps.googleapis.com/maps/api/geocode/json?address=${encodeURIComponent(enderecoBruto)}&language=pt-BR&region=br&key=${chave}`;
    const res = await fetch(url, { signal: AbortSignal.timeout(4000) });
    if (!res.ok) return null;
    const data = (await res.json()) as { results?: { geometry?: { location?: { lat: number; lng: number } } }[] };
    const loc = data.results?.[0]?.geometry?.location;
    return loc ? { lat: loc.lat, lng: loc.lng } : null;
  } catch {
    return null;
  }
}

export async function geocodificarNominatim(enderecoBruto: string): Promise<{ lat: number; lng: number } | null> {
  try {
    const url = `https://nominatim.openstreetmap.org/search?q=${encodeURIComponent(enderecoBruto)}&format=json&limit=1&countrycodes=br`;
    const res = await fetch(url, {
      headers: { "User-Agent": "TransmonsegCentral/1.0" },
      signal: AbortSignal.timeout(3000),
    });
    if (!res.ok) return null;
    const data = (await res.json()) as { lat?: string; lon?: string }[];
    const primeiro = data[0];
    if (!primeiro?.lat || !primeiro?.lon) return null;
    return { lat: parseFloat(primeiro.lat), lng: parseFloat(primeiro.lon) };
  } catch {
    return null;
  }
}
