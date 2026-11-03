// GEO3-08 (auditoria 03/11): o ponto da Nutry no monitoramento divergia do
// KPI (44% das NFs a mais de 150 m). O KPI passa a mandar, junto do PDF do
// romaneio, o ponto confiável que ele já resolveu por NF (campo `coordenadas`
// do /api/romaneio/upload, só pela ponte x-motor-key). Mesmo princípio da RQ:
// uma fonte só de ponto para o Ao vivo e para o desvio.
import { normalizarPlaca } from "./romaneio";

export type CoordenadaKpi = { placa: string; nf: string; lat: number; lng: number };

const coordValida = (lat: unknown, lng: unknown): boolean =>
  typeof lat === "number" && typeof lng === "number" && Number.isFinite(lat) && Number.isFinite(lng)
  && lat >= -34 && lat <= 6 && lng >= -75 && lng <= -28 && !(lat === 0 && lng === 0);

const chave = (placa: string, nf: string) => `${normalizarPlaca(placa).replace(/[^A-Z0-9]/g, "")}|${nf.trim()}`;

/** Lê o campo `coordenadas` (JSON) do formulário. Inválido ou ausente = mapa vazio (fail-open: geocodifica como antes). */
export function lerCoordenadasKpi(bruto: unknown): Map<string, { lat: number; lng: number }> {
  const mapa = new Map<string, { lat: number; lng: number }>();
  if (typeof bruto !== "string" || !bruto) return mapa;
  let lista: unknown;
  try { lista = JSON.parse(bruto); } catch { return mapa; }
  if (!Array.isArray(lista)) return mapa;
  for (const c of lista as Partial<CoordenadaKpi>[]) {
    if (!c || typeof c.placa !== "string" || typeof c.nf !== "string" || !c.nf.trim()) continue;
    if (!coordValida(c.lat, c.lng)) continue;
    mapa.set(chave(c.placa, c.nf), { lat: c.lat as number, lng: c.lng as number });
  }
  return mapa;
}

/** Ponto do KPI para a linha (placa do documento + NF), ou null. */
export function coordenadaDoKpi(
  mapa: Map<string, { lat: number; lng: number }>, placaBruta: string, nf: string,
): { lat: number; lng: number } | null {
  if (!mapa.size) return null;
  return mapa.get(chave(placaBruta, nf)) ?? null;
}
