// Tapete historico de celulas: grade de ~100m usada pela camada 2 da
// deteccao de desvio. Celula = lat/lng arredondados a 3 casas decimais
// (~111m x ~102m na latitude do RJ). Funcoes PURAS, sem I/O.

import { haversineM } from "./unitrac";

// Passo da interpolacao ao longo de um segmento entre duas leituras de GPS.
const PASSO_M = 80;
// Acima disso o "segmento" e salto de GPS/reconexao, nao trajeto real.
const SEGMENTO_MAX_M = 2500;

export function celulaDe(lat: number, lng: number): string {
  return `${Math.round(lat * 1000)}:${Math.round(lng * 1000)}`;
}

// As 9 celulas (3x3) em volta do ponto: tolerancia a GPS na beirada da via.
export function vizinhanca3x3(lat: number, lng: number): string[] {
  const la = Math.round(lat * 1000);
  const lo = Math.round(lng * 1000);
  const out: string[] = [];
  for (let di = -1; di <= 1; di++) {
    for (let dj = -1; dj <= 1; dj++) {
      out.push(`${la + di}:${lo + dj}`);
    }
  }
  return out;
}

// Celulas cobertas pelo trajeto entre duas leituras consecutivas.
// A 70km/h com amostra de 1min o veiculo cruza ~11 celulas: sem interpolar,
// o tapete fica esburacado e a checagem 3x3 da falso "fora do tapete".
export function celulasDoSegmento(
  latA: number, lngA: number, latB: number, lngB: number
): string[] {
  const dist = haversineM(latA, lngA, latB, lngB);
  if (dist > SEGMENTO_MAX_M) return [celulaDe(latB, lngB)];
  const n = Math.max(1, Math.ceil(dist / PASSO_M));
  const set = new Set<string>();
  for (let i = 0; i <= n; i++) {
    const t = i / n;
    set.add(celulaDe(latA + (latB - latA) * t, lngA + (lngB - lngA) * t));
  }
  return [...set];
}
