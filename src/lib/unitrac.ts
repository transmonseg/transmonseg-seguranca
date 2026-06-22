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
export type AlvoUnitrac = {
  placa: string;
  alvosituacaoservico: number; // 1 = feito, 0 = pendente
  [key: string]: unknown;
};

// Resultado agrupado por placa.
export type EntregasPlaca = {
  feitos: number;
  total: number;
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
