// Geocodificacao de enderecos do romaneio (endereco -> coordenada), com
// cache e cadeia de fallback. Espelha o padrao ja usado no motor pro
// geocode REVERSO (coordenada -> endereco, ver geocodeReverso em
// api/motor/route.ts) -- mesma chave do Google, mesmo User-Agent do
// Nominatim -- so na direcao contraria.

import { extrairRuaDoEndereco, normalizarNomeRua } from "./romaneio-geocode-local";
import { haversineM } from "./unitrac";

export function normalizarEndereco(enderecoBruto: string): string {
  return enderecoBruto.trim().toUpperCase().replace(/\s+/g, " ");
}

const DISTANCIA_MAX_MATCH_LOCAL_M = 30_000; // 30km -- nome bateu, mas e outra regiao

// Geocodificacao LOCAL via extrato OSM (vias_nomes) -- ver
// docs/superpowers/specs/2026-07-22-geocodificacao-local-romaneio-design.md.
// Bate o nome da rua contra candidatos ja ingeridos; quando ha mais de
// um candidato (rua repetida em cidades diferentes), escolhe o mais
// proximo do ponto de referencia da cidade (resolvido 1x por lote, ver
// processar-geocode/route.ts).
//
// Desvio deliberado da spec original (que so checava distancia com 2+
// candidatos, deixando candidato UNICO passar direto): candidato unico
// TAMBEM e checado contra o ponto de cidade quando ele existe. Motivo
// descoberto durante esta mesma feature (ver achado lateral da Task 5):
// nome de cidade pode ser ambiguo no Brasil inteiro (ex.: "Natividade"
// existe no RJ E no Tocantins, ~1500km de distancia) -- se a resolucao
// de cidade (Nominatim) acertar a cidade ERRADA, um candidato local
// UNICO e "correto" segundo o nome ainda estaria a milhares de km do
// ponto de cidade (tambem errado) resolvido nesse ciclo. Checar sempre
// que ha ponto de cidade disponivel pega esse caso; SEM ponto de cidade
// (linha abaixo), nao ha nada pra comparar, entao o candidato unico
// passa direto como antes.
export async function geocodificarLocal(
  enderecoBruto: string,
  pontoCidade: { lat: number; lng: number } | null,
  buscarCandidatosPorNome: (nomeNormalizado: string) => Promise<{ lat: number; lng: number }[]>
): Promise<{ lat: number; lng: number } | null> {
  const rua = extrairRuaDoEndereco(enderecoBruto);
  const nomeNormalizado = normalizarNomeRua(rua);
  const candidatos = await buscarCandidatosPorNome(nomeNormalizado);
  if (candidatos.length === 0) return null;
  if (!pontoCidade) return candidatos[0];

  let melhor = candidatos[0];
  let menorDist = haversineM(pontoCidade.lat, pontoCidade.lng, melhor.lat, melhor.lng);
  for (const c of candidatos.slice(1)) {
    const d = haversineM(pontoCidade.lat, pontoCidade.lng, c.lat, c.lng);
    if (d < menorDist) { menorDist = d; melhor = c; }
  }
  return menorDist <= DISTANCIA_MAX_MATCH_LOCAL_M ? melhor : null;
}

// SEM fallback pra coordenada da Unitrac de proposito -- achado real 15/07:
// no romaneio de teste (22 pontos, veiculo TUL1C38), 18 cairiam no fallback
// da Unitrac (Nominatim gratuito nao cobre a maioria das ruas de cidade
// pequena do interior, e GOOGLE_MAPS_API_KEY server-side nao esta
// configurada) -- ou seja, a MAIORIA dos pontos continuaria usando a
// coordenada "as vezes errada" que o romaneio existe pra evitar. Decisao
// explicita do usuario: se nao geocodificar, o ponto fica sem coordenada
// (excluido da lista de pendentes pelo motor) em vez de reusar a Unitrac.
export type ResultadoGeocode = { lat: number; lng: number; fonte: "google" | "nominatim" | "local" } | null;

type Deps = {
  buscarCache: (chave: string) => Promise<{ lat: number; lng: number; fonte: string } | null>;
  salvarCache: (chave: string, r: { lat: number; lng: number; fonte: string }) => Promise<void>;
  geocodificarLocalDep: (enderecoBruto: string, pontoCidade: { lat: number; lng: number } | null) => Promise<{ lat: number; lng: number } | null>;
  geocodificarGoogle: (enderecoBruto: string) => Promise<{ lat: number; lng: number } | null>;
  geocodificarNominatim: (enderecoBruto: string) => Promise<{ lat: number; lng: number } | null>;
};

export async function geocodificarEndereco(
  enderecoBruto: string,
  pontoCidade: { lat: number; lng: number } | null,
  deps: Deps
): Promise<ResultadoGeocode> {
  const chave = normalizarEndereco(enderecoBruto);
  const doCache = await deps.buscarCache(chave);
  if (doCache) return { lat: doCache.lat, lng: doCache.lng, fonte: doCache.fonte as "google" | "nominatim" | "local" };

  const local = await deps.geocodificarLocalDep(enderecoBruto, pontoCidade);
  if (local) {
    await deps.salvarCache(chave, { ...local, fonte: "local" });
    return { ...local, fonte: "local" };
  }
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
