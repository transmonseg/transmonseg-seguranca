// Geocodificacao de enderecos do romaneio (endereco -> coordenada), com
// cache e cadeia de fallback. Espelha o padrao ja usado no motor pro
// geocode REVERSO (coordenada -> endereco, ver geocodeReverso em
// api/motor/route.ts) -- mesma chave do Google, mesmo User-Agent do
// Nominatim -- so na direcao contraria.

import { extrairRuaDoEndereco, extrairNumeroDoEndereco, normalizarNomeRua, montarEnderecoParaGeocode } from "./romaneio-geocode-local";
import { haversineM } from "./unitrac";

export function normalizarEndereco(enderecoBruto: string): string {
  return enderecoBruto.trim().toUpperCase().replace(/\s+/g, " ");
}

const DISTANCIA_MAX_MATCH_LOCAL_M = 30_000; // 30km -- nome bateu, mas e outra regiao

// Compartilhado entre geocodificarLocal (OSM) e geocodificarCnefe (IBGE) --
// quando ha mais de um candidato (rua repetida em cidades diferentes),
// escolhe o mais proximo do ponto de referencia da cidade (resolvido 1x
// por lote, ver processar-geocode/route.ts).
//
// Desvio deliberado da spec original do match OSM (que so checava
// distancia com 2+ candidatos, deixando candidato UNICO passar direto):
// candidato unico TAMBEM e checado contra o ponto de cidade quando ele
// existe. Motivo descoberto durante essa feature (ver achado lateral da
// Task 5 de 22/07): nome de cidade pode ser ambiguo no Brasil inteiro
// (ex.: "Natividade" existe no RJ E no Tocantins, ~1500km de distancia)
// -- se a resolucao de cidade (Nominatim) acertar a cidade ERRADA, um
// candidato local UNICO e "correto" segundo o nome ainda estaria a
// milhares de km do ponto de cidade (tambem errado) resolvido nesse
// ciclo. Checar sempre que ha ponto de cidade disponivel pega esse caso;
// SEM ponto de cidade, nao ha nada pra comparar, entao o candidato unico
// passa direto como antes.
function escolherCandidatoMaisProximo(
  candidatos: { lat: number; lng: number }[],
  pontoCidade: { lat: number; lng: number } | null
): { lat: number; lng: number } | null {
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

// Geocodificacao LOCAL via extrato OSM (vias_nomes) -- ver
// docs/superpowers/specs/2026-07-22-geocodificacao-local-romaneio-design.md.
// Bate o nome da rua contra candidatos ja ingeridos.
export async function geocodificarLocal(
  enderecoBruto: string,
  pontoCidade: { lat: number; lng: number } | null,
  buscarCandidatosPorNome: (nomeNormalizado: string) => Promise<{ lat: number; lng: number }[]>
): Promise<{ lat: number; lng: number } | null> {
  const rua = extrairRuaDoEndereco(enderecoBruto);
  const nomeNormalizado = normalizarNomeRua(rua);
  const candidatos = await buscarCandidatosPorNome(nomeNormalizado);
  return escolherCandidatoMaisProximo(candidatos, pontoCidade);
}

// Geocodificacao via CNEFE (IBGE, Censo 2022) -- achado real 31/07, ver
// migration contabo/022_cnefe_enderecos.sql. Endereco+coordenada real
// coletado por recenseador em campo, mais preciso que o extrato OSM (que
// so tem nome de rua + ponto medio do trecho) pra rua de cidade pequena/
// bairro informal -- por isso roda ANTES do match OSM na cadeia de
// geocodificarEndereco. Tres niveis, do mais preciso pro mais amplo:
// (1) rua+numero exato (imovel especifico), (2) so rua (qualquer numero
// naquela rua), (3) similaridade de nome via pg_trgm (pega variacao tipo
// abreviacao -- "FRANCISCO" vs "F." -- que nem o match exato da rua
// resolve). Cada nivel so roda se o anterior nao achou nada.
export async function geocodificarCnefe(
  enderecoBruto: string,
  pontoCidade: { lat: number; lng: number } | null,
  deps: {
    buscarPorRuaNumero: (nomeNormalizado: string, numero: string) => Promise<{ lat: number; lng: number }[]>;
    buscarPorRua: (nomeNormalizado: string) => Promise<{ lat: number; lng: number }[]>;
    buscarPorSimilaridade: (nomeNormalizado: string) => Promise<{ lat: number; lng: number }[]>;
  }
): Promise<{ lat: number; lng: number } | null> {
  const rua = extrairRuaDoEndereco(enderecoBruto);
  const nomeNormalizado = normalizarNomeRua(rua);
  const numero = extrairNumeroDoEndereco(enderecoBruto);

  if (numero && !/^S\/?N$/i.test(numero)) {
    const porRuaNumero = await deps.buscarPorRuaNumero(nomeNormalizado, numero);
    const resultado = escolherCandidatoMaisProximo(porRuaNumero, pontoCidade);
    if (resultado) return resultado;
  }

  const porRua = await deps.buscarPorRua(nomeNormalizado);
  const resultadoRua = escolherCandidatoMaisProximo(porRua, pontoCidade);
  if (resultadoRua) return resultadoRua;

  const porSimilaridade = await deps.buscarPorSimilaridade(nomeNormalizado);
  return escolherCandidatoMaisProximo(porSimilaridade, pontoCidade);
}

// SEM fallback pra coordenada da Unitrac de proposito -- achado real 15/07:
// no romaneio de teste (22 pontos, veiculo TUL1C38), 18 cairiam no fallback
// da Unitrac (Nominatim gratuito nao cobre a maioria das ruas de cidade
// pequena do interior, e GOOGLE_MAPS_API_KEY server-side nao esta
// configurada) -- ou seja, a MAIORIA dos pontos continuaria usando a
// coordenada "as vezes errada" que o romaneio existe pra evitar. Decisao
// explicita do usuario: se nao geocodificar, o ponto fica sem coordenada
// (excluido da lista de pendentes pelo motor) em vez de reusar a Unitrac.
export type ResultadoGeocode = { lat: number; lng: number; fonte: "google" | "nominatim" | "local" | "cnefe" } | null;

type Deps = {
  buscarCache: (chave: string) => Promise<{ lat: number; lng: number; fonte: string } | null>;
  salvarCache: (chave: string, r: { lat: number; lng: number; fonte: string }) => Promise<void>;
  geocodificarCnefeDep: (enderecoBruto: string, pontoCidade: { lat: number; lng: number } | null) => Promise<{ lat: number; lng: number } | null>;
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
  if (doCache) return { lat: doCache.lat, lng: doCache.lng, fonte: doCache.fonte as "google" | "nominatim" | "local" | "cnefe" };

  // CNEFE roda ANTES do OSM (geocodificarLocalDep) -- achado real 31/07:
  // endereco+coordenada real de campo (IBGE) e' mais preciso que o extrato
  // OSM (nome de rua + ponto medio) pra rua de cidade pequena/bairro
  // informal, exatamente o gargalo que restava depois de descartar Google
  // Geocoding (usuario recusou vincular faturamento).
  const cnefe = await deps.geocodificarCnefeDep(enderecoBruto, pontoCidade);
  if (cnefe) {
    await deps.salvarCache(chave, { ...cnefe, fonte: "cnefe" });
    return { ...cnefe, fonte: "cnefe" };
  }

  const local = await deps.geocodificarLocalDep(enderecoBruto, pontoCidade);
  if (local) {
    await deps.salvarCache(chave, { ...local, fonte: "local" });
    return { ...local, fonte: "local" };
  }
  // Google/Nominatim recebem uma string enxuta (rua+numero, bairro, cidade
  // -- com cidade cortada ja expandida -- RJ, Brasil), SEM o sufixo de
  // complemento de entrega do romaneio (ex. "LOJA 02", "KM 270 QUADRA F
  // 101") -- achado real 31/07: mandar isso pro geocoder direto atrapalha
  // mais do que ajuda. geocodificarLocalDep acima usa enderecoBruto original
  // de proposito (so extrai a rua, sufixo nao atrapalha esse parsing).
  const enderecoParaGeocode = montarEnderecoParaGeocode(enderecoBruto);
  const google = await deps.geocodificarGoogle(enderecoParaGeocode);
  if (google) {
    await deps.salvarCache(chave, { ...google, fonte: "google" });
    return { ...google, fonte: "google" };
  }
  const nominatim = await deps.geocodificarNominatim(enderecoParaGeocode);
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
