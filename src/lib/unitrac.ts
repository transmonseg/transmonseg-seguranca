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
  alvosituacaoservico: number; // 1 = feito, 0 = pendente
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
  feito: boolean;
  documento: string | null;
  identificador: string | null;
  dataInicio: string | null;
  dataRealizado: string | null;
  observacoes: string | null;
  rota: string | null;
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
    if (alvo.alvosituacaoservico === 1) {
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
      feito: a.alvosituacaoservico === 1,
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
  };
}
