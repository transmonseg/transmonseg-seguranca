// Cliente da API Unitrac (aberta, sem autenticação).
// Base: https://datalayer.portalunitrac.com
// Nunca importe nada de 'next' aqui — lib pura Node/TypeScript.

const BASE_URL = "https://datalayer.portalunitrac.com";

export type PosicaoNormalizada = {
  cv: string;
  placa: string;
  lat: number;
  lng: number;
  velocidade: number;
  ignicao: boolean;
  atraso: number;
  panico: boolean;
  bau: boolean;
  datagps: string;
  fresco: boolean;
  evento: string | null; // tipevnome bruto da Unitrac (ex.: "IGNIÇÃO LIGADA", "BAÚ TRAVADO", "TRANSMISSÃO TEMPORIZADA")
};

// Retorna lista de veículos de um codUser Unitrac.
// GET /veiculos/masn/{cod}
export async function buscarVeiculos(cod: string): Promise<unknown[]> {
  const res = await fetch(`${BASE_URL}/veiculos/masn/${cod}`, {
    headers: { accept: "application/json" },
  });
  if (!res.ok) {
    throw new Error(`buscarVeiculos HTTP ${res.status}`);
  }
  const data = (await res.json()) as { veiculos: unknown[] };
  return data.veiculos;
}

// Retorna posições de uma lista de CVs (códigos de veículo como strings).
// POST /mapa_servicos/posicoes/N/N
export async function buscarPosicoes(cvs: string[]): Promise<unknown[]> {
  const res = await fetch(`${BASE_URL}/mapa_servicos/posicoes/N/N`, {
    method: "POST",
    headers: {
      accept: "application/json",
      "content-type": "application/json",
    },
    body: JSON.stringify(cvs),
  });
  if (!res.ok) {
    throw new Error(`buscarPosicoes HTTP ${res.status}`);
  }
  const data = (await res.json()) as { Posicoes: unknown[] };
  return data.Posicoes;
}

// Tipo retornado pela API de alvos (/mapa_servicos/alvos).
// Cada alvo é um PONTO de entrega da rota do veículo, com coordenadas,
// ordem na rota e situação (feito/pendente).
export type AlvoUnitrac = {
  placa: string;
  alvosituacaoservico: number; // 0=pendente, 1=realizado (feito), 98=esteve no local (confirmado com a operacao)
  alvocodigo?: number; // id estavel da entrega, unico por linha (NF)
  pontocodigo?: number; // id estavel do PONTO/endereco — varias linhas (NFs) podem compartilhar o mesmo pontocodigo
  pontolatitude?: number;
  pontolongitude?: number;
  pontoraio?: number; // raio do ponto em metros (ex.: 50)
  pontonome?: string;
  alvoordem?: number;
  alvodocumento?: string;
  pontoidentificador?: string;
  alvodatainicio?: string;
  alvodatarealizado?: string;
  alvoobservacoes?: string | null;
  alvorota?: string;
  [key: string]: unknown;
};

// Resultado agrupado por placa.
export type EntregasPlaca = {
  feitos: number;
  total: number;
};

// Um ponto de entrega da rota planejada do veículo.
export type PontoEntrega = {
  lat: number;
  lng: number;
  raio: number; // metros
  ordem: number;
  nome: string;
  feito: boolean; // true quando situacao !== 0 (realizado ou esteve no local)
  situacao: number; // codigo bruto da Unitrac: 0=pendente, 1=realizado, 98=esteve no local
  codigo: number | null; // alvocodigo da Unitrac — id estavel pra usar como key de lista
  pontoCodigo: number | null; // pontocodigo da Unitrac — varios alvos (NFs) podem compartilhar o mesmo ponto/endereco
  documento: string | null;
  identificador: string | null;
  dataInicio: string | null;
  dataRealizado: string | null;
  observacoes: string | null;
  rota: string | null;
  placa?: string;
};

// Busca alvos (paradas/entregas) de uma lista de CVs.
// POST /mapa_servicos/alvos — body = array de CV como strings.
export async function buscarAlvos(cvs: string[]): Promise<AlvoUnitrac[]> {
  const res = await fetch(`${BASE_URL}/mapa_servicos/alvos`, {
    method: "POST",
    headers: {
      accept: "application/json",
      "content-type": "application/json",
    },
    body: JSON.stringify(cvs),
  });
  if (!res.ok) {
    throw new Error(`buscarAlvos HTTP ${res.status}`);
  }
  const data = (await res.json()) as { alvos?: AlvoUnitrac[] };
  return data.alvos ?? [];
}

// Agrupa alvos retornados pela API por placa.
// Retorna Map<placa, { feitos, total }>.
export function agruparAlvosPorPlaca(alvos: AlvoUnitrac[]): Map<string, EntregasPlaca> {
  const mapa = new Map<string, EntregasPlaca>();
  for (const alvo of alvos) {
    const placa = alvo.placa;
    const entrada = mapa.get(placa) ?? { feitos: 0, total: 0 };
    entrada.total += 1;
    // situacao 0 = pendente; qualquer outro valor (1=feito, 98=outro) significa que ja foi encerrado.
    if (alvo.alvosituacaoservico !== 0) {
      entrada.feitos += 1;
    }
    mapa.set(placa, entrada);
  }
  return mapa;
}

// Agrupa os alvos em PONTOS DE ENTREGA por placa (a rota planejada do veículo).
// Só inclui pontos com coordenadas válidas. Ordena por alvoordem.
export function agruparPontosPorPlaca(alvos: AlvoUnitrac[]): Map<string, PontoEntrega[]> {
  const mapa = new Map<string, PontoEntrega[]>();
  for (const a of alvos) {
    const lat = typeof a.pontolatitude === "number" ? a.pontolatitude : parseFloat(String(a.pontolatitude));
    const lng = typeof a.pontolongitude === "number" ? a.pontolongitude : parseFloat(String(a.pontolongitude));
    // Mantém pontos sem coordenada (lat/lng 0) para exibir na lista — só filtra NaN/Infinity
    if (!Number.isFinite(lat) || !Number.isFinite(lng)) continue;
    const lista = mapa.get(a.placa) ?? [];
    lista.push({
      lat,
      lng,
      raio: Number(a.pontoraio) || 50,
      ordem: Number(a.alvoordem) || 0,
      nome: String(a.pontonome ?? ""),
      feito: a.alvosituacaoservico !== 0,
      situacao: Number(a.alvosituacaoservico) || 0,
      codigo: typeof a.alvocodigo === "number" ? a.alvocodigo : null,
      pontoCodigo: typeof a.pontocodigo === "number" ? a.pontocodigo : null,
      placa: a.placa,
      documento: a.alvodocumento ? String(a.alvodocumento) : null,
      identificador: a.pontoidentificador ? String(a.pontoidentificador) : null,
      dataInicio:
        a.alvodatainicio && !String(a.alvodatainicio).startsWith("0001")
          ? String(a.alvodatainicio)
          : null,
      dataRealizado:
        a.alvodatarealizado && !String(a.alvodatarealizado).startsWith("0001")
          ? String(a.alvodatarealizado)
          : null,
      observacoes: a.alvoobservacoes != null ? String(a.alvoobservacoes) : null,
      rota: a.alvorota ? String(a.alvorota) : null,
    });
    mapa.set(a.placa, lista);
  }
  for (const lista of mapa.values()) lista.sort((x, y) => x.ordem - y.ordem);
  return mapa;
}

// Distância perpendicular (metros) de um ponto até o SEGMENTO de reta entre
// origem e destino — aproximação planar (equirretangular, projeta lat/lng em
// metros locais usando a latitude média como referência pra escala de
// longitude). Precisa o suficiente pra poucos km em escala urbana (erro
// desprezível frente aos limiares de km usados aqui). Clampa a projeção a
// [0,1] no segmento — não deixa "perpendicular infinita" antes da origem ou
// depois do destino, o que faria a distância disparar por geometria, não
// por desvio real.
export function distanciaAoSegmentoM(
  ponto: { lat: number; lng: number },
  origem: { lat: number; lng: number },
  destino: { lat: number; lng: number }
): number {
  const latRef = (origem.lat + destino.lat + ponto.lat) / 3;
  const mPorGrauLat = 111320;
  const mPorGrauLng = 111320 * Math.cos((latRef * Math.PI) / 180);

  const toXY = (p: { lat: number; lng: number }) => ({
    x: (p.lng - origem.lng) * mPorGrauLng,
    y: (p.lat - origem.lat) * mPorGrauLat,
  });

  const d = toXY(destino);
  const p = toXY(ponto);

  const lenSq = d.x * d.x + d.y * d.y;
  if (lenSq === 0) return Math.sqrt(p.x * p.x + p.y * p.y); // origem === destino

  let t = (p.x * d.x + p.y * d.y) / lenSq;
  t = Math.max(0, Math.min(1, t));

  const projX = t * d.x;
  const projY = t * d.y;
  return Math.sqrt((p.x - projX) ** 2 + (p.y - projY) ** 2);
}

// Distância em metros entre dois pontos (Haversine).
export function haversineM(aLat: number, aLng: number, bLat: number, bLng: number): number {
  const R = 6371000;
  const toR = (d: number) => (d * Math.PI) / 180;
  const dLat = toR(bLat - aLat);
  const dLng = toR(bLng - aLng);
  const h =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(toR(aLat)) * Math.cos(toR(bLat)) * Math.sin(dLng / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(h));
}

// Menor distância (m) de uma posição aos pontos de entrega PENDENTES.
// Retorna null se não houver pendentes (nada pra onde ir).
export function distAlvoPendenteMaisProximoM(
  lat: number,
  lng: number,
  pontos: PontoEntrega[] | undefined
): number | null {
  return alvoPendenteMaisProximo(lat, lng, pontos)?.distM ?? null;
}

// Ponto de entrega PENDENTE mais próximo (o ponto + a distância em metros).
// Precisamos do ponto, não só da distância, para calcular o rumo até ele.
export function alvoPendenteMaisProximo(
  lat: number,
  lng: number,
  pontos: PontoEntrega[] | undefined
): { ponto: PontoEntrega; distM: number } | null {
  if (!pontos || pontos.length === 0) return null;
  let melhor: { ponto: PontoEntrega; distM: number } | null = null;
  for (const p of pontos) {
    if (p.feito) continue;
    const d = haversineM(lat, lng, p.lat, p.lng);
    if (melhor === null || d < melhor.distM) melhor = { ponto: p, distM: d };
  }
  return melhor;
}

// Rumo inicial (graus, 0=Norte, 90=Leste) de A para B.
export function rumoGraus(aLat: number, aLng: number, bLat: number, bLng: number): number {
  const toR = (d: number) => (d * Math.PI) / 180;
  const toG = (r: number) => (r * 180) / Math.PI;
  const y = Math.sin(toR(bLng - aLng)) * Math.cos(toR(bLat));
  const x =
    Math.cos(toR(aLat)) * Math.sin(toR(bLat)) -
    Math.sin(toR(aLat)) * Math.cos(toR(bLat)) * Math.cos(toR(bLng - aLng));
  return (toG(Math.atan2(y, x)) + 360) % 360;
}

// Diferença angular absoluta entre dois rumos (0..180 graus).
export function difAngulo(a: number, b: number): number {
  const d = Math.abs(a - b) % 360;
  return d > 180 ? 360 - d : d;
}

const DIVERGENCIA_RUMO_VELOCIDADE_MIN_KMH = 10;
const DIVERGENCIA_RUMO_LIMIAR_GRAUS = 100;
const DIVERGENCIA_RUMO_STREAK_MIN = 2;

// Achado real 25/07: compara o rumo REAL do movimento (posicao anterior ->
// atual) contra o rumo ESPERADO (posicao atual -> destino legitimo mais
// proximo). Divergencia alta = veiculo indo numa direcao que nao leva a
// nenhum destino legitimo, mesmo que a distancia reta ainda esteja caindo
// (pega o ponto cego do contorno de lagoa/baia, achado real 25/07). Piso de
// velocidade: abaixo de 10km/h o rumo calculado a partir de 2 pontos GPS e
// essencialmente ruido (deslocamento de poucos metros, erro do GPS domina).
export function divergenciaRumoGraus(
  anteriorLat: number,
  anteriorLng: number,
  atualLat: number,
  atualLng: number,
  destinoLat: number,
  destinoLng: number,
  velocidadeKmH: number = 999
): number | null {
  if (velocidadeKmH < DIVERGENCIA_RUMO_VELOCIDADE_MIN_KMH) return null;
  const rumoReal = rumoGraus(anteriorLat, anteriorLng, atualLat, atualLng);
  const rumoEsperado = rumoGraus(atualLat, atualLng, destinoLat, destinoLng);
  return difAngulo(rumoReal, rumoEsperado);
}

// Decide se o streak acumulado de divergencia (persistido pelo motor,
// mesmo padrao de fora_tapete_streak) e suficiente pra disparar. SEM
// amortecimento por familiaridade (decisao revista pelo usuario 25/07,
// depois da primeira versao ter proposto amortecer -- diretriz explicita:
// "qualquer desvio de rota a gente vai identificar agora, mesmo que seja
// falso"). Piso sempre 2, independente de o veiculo ja conhecer a area.
export function divergenciaRumoDispara(streak: number): boolean {
  return streak >= DIVERGENCIA_RUMO_STREAK_MIN;
}

export function divergenciaRumoAcimaDoLimiar(divergencia: number | null): boolean {
  return divergencia !== null && divergencia > DIVERGENCIA_RUMO_LIMIAR_GRAUS;
}

// Ponto de entrega (feito OU pendente) mais proximo da posicao informada.
// Diferente de alvoPendenteMaisProximo, considera TODOS os pontos da rota,
// inclusive os ja concluidos. Serve para saber se o caminhao esta dentro
// do raio de qualquer cliente (checagem "veiculo no cliente").
export function alvoMaisProximoQualquer(
  lat: number,
  lng: number,
  pontos: PontoEntrega[] | undefined
): { ponto: PontoEntrega; distM: number } | null {
  if (!pontos || pontos.length === 0) return null;
  let melhor: { ponto: PontoEntrega; distM: number } | null = null;
  for (const p of pontos) {
    const d = haversineM(lat, lng, p.lat, p.lng);
    if (melhor === null || d < melhor.distM) melhor = { ponto: p, distM: d };
  }
  return melhor;
}

// Achado real 25/07 (redesign do detector de desvio): substitui a
// heuristica "distancia liquida caindo cancela suspeita" (que gerava falso
// positivo perto de cliente/base e escondia desvio real por rua errada
// enquanto ainda se aproximava em linha reta). Em vez de confiar na
// TENDENCIA de distancia, confia em geofence real: dentro do raio de
// qualquer destino legitimo (mesmo piso de 150m ja usado em
// alvoMaisProximoQualquer) OU dentro de um ponto_seguro (posto de
// gasolina) -- nos dois casos, a checagem de desvio e suspensa neste ciclo.
export function suspenderPorChegada(
  distDestinoMaisPertoM: number,
  raioDestinoMaisPerto: number,
  emPontoSeguro: boolean
): boolean {
  if (emPontoSeguro) return true;
  const raio = Math.max(raioDestinoMaisPerto, 150);
  return distDestinoMaisPertoM <= raio;
}

// Busca o rastro (historico de posicoes) de um veiculo nas ultimas N horas.
// GET /mapa_servicos/rastro/{cv}/{horas}
// Resposta da API: { posicoes: [{ lat, long }] }
// horas e limitado ao intervalo 1..96 por seguranca defensiva.
// Em erro HTTP ou excecao, retorna [] (falha graciosamente, nunca lanca).
export async function buscarRastro(
  cv: string,
  horas: number
): Promise<{ lat: number; lng: number }[]> {
  const horasSeguro = Math.min(96, Math.max(1, Math.round(horas)));
  try {
    const res = await fetch(
      `${BASE_URL}/mapa_servicos/rastro/${cv}/${horasSeguro}`,
      { headers: { accept: "application/json" } }
    );
    if (!res.ok) return [];
    const data = (await res.json()) as { posicoes?: { lat: unknown; long: unknown }[] };
    const posicoes = data.posicoes ?? [];
    return posicoes
      .map((p) => ({ lat: Number(p.lat), lng: Number(p.long) }))
      .filter((p) => Number.isFinite(p.lat) && Number.isFinite(p.lng) && !(p.lat === 0 && p.lng === 0));
  } catch {
    return [];
  }
}

// Acima disso (m) de distancia ao ultimo ponto ACEITO, o ponto vira
// "suspeito" — pode ser deslocamento real (rodovia) ou inicio de uma rajada
// de pico. So vira PICO de fato se, dentro do lookahead, o rastro "voltar"
// pra perto do ultimo aceito (ver RETORNO_MAX_M) — deslocamento real
// continua se afastando, nunca retorna.
const SUSPEITO_MIN_M = 300;
// Distancia (m) que conta como "voltou pra perto de onde estava" — assinatura
// geometrica de ruido de GPS (multipath sob viaduto/predio), nao de viagem.
const RETORNO_MAX_M = 200;
// Quantos pontos seguidos o filtro aceita como rajada de uma vez (rajada de
// multipath costuma durar poucas leituras, nao dezenas).
const PICO_LOOKAHEAD_MAX = 3;

// Remove picos de GPS do rastro: um ponto OU uma RAJADA de ate
// PICO_LOOKAHEAD_MAX seguidos que se afastam do ultimo ponto aceito e depois
// VOLTAM pra perto dele (multipath/ruido do receptor). Sem timestamp por
// ponto (a API nao fornece), entao a deteccao e puramente geometrica: um
// deslocamento real (ida pra rodovia, por ex.) se afasta e nao retorna nos
// proximos pontos; um pico se afasta e volta, porque o carro na verdade nunca
// saiu do lugar. Rajadas de 2+ picos na MESMA direcao nao dao pra pegar
// comparando so com o proximo ponto (ele tambem esta errado, entao nao
// parece desvio) — por isso a checagem e "ha algum ponto proximo, dentro do
// lookahead, que volta perto de onde eu estava?", nao um teste par a par.
export function removerPicosRastro(
  pontos: { lat: number; lng: number }[]
): { lat: number; lng: number }[] {
  if (pontos.length < 3) return pontos;
  const limpo: { lat: number; lng: number }[] = [pontos[0]];
  let i = 1;
  while (i < pontos.length) {
    const prev = limpo[limpo.length - 1];
    if (i === pontos.length - 1 || haversineM(prev.lat, prev.lng, pontos[i].lat, pontos[i].lng) <= SUSPEITO_MIN_M) {
      limpo.push(pontos[i]);
      i++;
      continue;
    }
    // Suspeito: procura um retorno pra perto de `prev` dentro do lookahead.
    let indiceRetorno = -1;
    const fim = Math.min(i + PICO_LOOKAHEAD_MAX, pontos.length - 1);
    for (let j = i + 1; j <= fim; j++) {
      if (haversineM(prev.lat, prev.lng, pontos[j].lat, pontos[j].lng) <= RETORNO_MAX_M) {
        indiceRetorno = j;
        break;
      }
    }
    if (indiceRetorno !== -1) {
      // pontos[i..indiceRetorno-1] sao a rajada de pico — descarta todos.
      limpo.push(pontos[indiceRetorno]);
      i = indiceRetorno + 1;
    } else {
      // Nao voltou: deslocamento real, aceita como esta.
      limpo.push(pontos[i]);
      i++;
    }
  }
  return limpo;
}

// Busca as paradas (stops) de um veiculo nas ultimas N horas.
// GET /mapa_servicos/stops/{cv}/{horas}
// Resposta da API: { paradas: [{ _data, localparada, tempoparada, latitude, longitude }] }
// horas e limitado ao intervalo 1..96. Em erro retorna [].
export async function buscarStops(
  cv: string,
  horas: number
): Promise<{ data: string; local: string; tempoMin: number; lat: number; lng: number }[]> {
  const horasSeguro = Math.min(96, Math.max(1, Math.round(horas)));
  try {
    const res = await fetch(
      `${BASE_URL}/mapa_servicos/stops/${cv}/${horasSeguro}`,
      { headers: { accept: "application/json" } }
    );
    if (!res.ok) return [];
    const raw = (await res.json()) as {
      paradas?: {
        _data: unknown;
        localparada: unknown;
        tempoparada: unknown;
        latitude: unknown;
        longitude: unknown;
      }[];
    };
    const paradas = raw.paradas ?? [];
    return paradas
      .map((p) => ({
        data: String(p._data),
        local: String(p.localparada || ""),
        tempoMin: Number(p.tempoparada) || 0,
        lat: Number(p.latitude),
        lng: Number(p.longitude),
      }))
      .filter((p) => Number.isFinite(p.lat) && Number.isFinite(p.lng) && !(p.lat === 0 && p.lng === 0));
  } catch {
    return [];
  }
}

// Busca a posicao atual (snapshot unico) de um veiculo pelo CV.
// POST /mapa_servicos/posicoes/N/N — body = [cv] (array com um elemento).
// Resposta: { Posicoes: [...] } — retorna o primeiro objeto bruto ou null.
// Campos esperados na posicao: posiclatitude, posiclongitude, posicvelocidade,
// posicignicao, tipevnome, posicentrada1..10, posicsaida1..4, panico,
// bauForaPonto, atraso, datagps. Em erro retorna null.
export async function buscarPosicaoUnica(
  cv: string
): Promise<Record<string, unknown> | null> {
  try {
    const res = await fetch(`${BASE_URL}/mapa_servicos/posicoes/N/N`, {
      method: "POST",
      headers: {
        accept: "application/json",
        "content-type": "application/json",
      },
      body: JSON.stringify([cv]),
    });
    if (!res.ok) return null;
    const data = (await res.json()) as { Posicoes?: Record<string, unknown>[] };
    return data.Posicoes?.[0] ?? null;
  } catch {
    return null;
  }
}

// Extrai o centroide aproximado de uma geometria GeoJSON (media dos vertices).
// Usado para achar o "ponto" de uma base (poligono real de garagem/CD).
type GeoJSONGeomSimple =
  | { type: "Polygon"; coordinates: number[][][] }
  | { type: "MultiPolygon"; coordinates: number[][][][] };

export function centroideGeo(
  geom: GeoJSONGeomSimple | null
): { lat: number; lng: number } | null {
  if (!geom) return null;
  const anel =
    geom.type === "Polygon"
      ? geom.coordinates[0]
      : geom.type === "MultiPolygon"
        ? geom.coordinates[0]?.[0]
        : null;
  if (!anel || anel.length === 0) return null;
  const lat = anel.reduce((s, c) => s + c[1], 0) / anel.length;
  const lng = anel.reduce((s, c) => s + c[0], 0) / anel.length;
  return { lat, lng };
}

// Normaliza uma posição bruta da Unitrac para o tipo interno.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export function normalizar(p: Record<string, any>): PosicaoNormalizada {
  const atraso = parseInt(p.atraso as string) || 0;
  return {
    cv: String(p.veicucodigo),
    placa: p.veicuplaca as string,
    lat: parseFloat(p.posiclatitude as string),
    lng: parseFloat(p.posiclongitude as string),
    velocidade: parseInt(p.posicvelocidade as string) || 0,
    ignicao: p.posicignicao === "1",
    atraso,
    panico: p.panico === "1",
    bau: p.bauForaPonto === "1",
    datagps: p.datagps as string,
    fresco: atraso < 60,
    evento: typeof p.tipevnome === "string" && p.tipevnome.trim() ? p.tipevnome.trim() : null,
  };
}
