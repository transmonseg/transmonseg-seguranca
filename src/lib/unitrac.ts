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
    if (!Number.isFinite(lat) || !Number.isFinite(lng) || (lat === 0 && lng === 0)) continue;
    const lista = mapa.get(a.placa) ?? [];
    lista.push({
      lat,
      lng,
      raio: Number(a.pontoraio) || 50,
      ordem: Number(a.alvoordem) || 0,
      nome: String(a.pontonome ?? ""),
      feito: a.alvosituacaoservico === 1,
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
  if (!pontos || pontos.length === 0) return null;
  let menor: number | null = null;
  for (const p of pontos) {
    if (p.feito) continue;
    const d = haversineM(lat, lng, p.lat, p.lng);
    if (menor === null || d < menor) menor = d;
  }
  return menor;
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
