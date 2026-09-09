export type MapaProvider = "google" | "fallback";
export type EventoMapaProvider = "quota_excedida" | "retry_sucesso" | "retry_falhou";

export interface MapaProviderEstado {
  provider: MapaProvider;
  quotaExcedidaEm: string | null;
  proximaTentativaEm: string | null;
}

// Ver spec 2026-09-08-mapa-fallback-quota-google-design.md, Decisao 7 --
// 20min escolhido dentro da janela 15-30min aprovada pelo usuario, equilibra
// "volta rapido quando o Google normaliza" com "nao gasta cota de novo
// tentando toda hora" (pior caso ~40-50 tentativas extras num dia inteiro
// de fallback).
export const RETRY_INTERVALO_MIN = 20;

function somarMinutos(iso: string, minutos: number): string {
  return new Date(new Date(iso).getTime() + minutos * 60_000).toISOString();
}

export function transicionar(
  estado: MapaProviderEstado,
  evento: EventoMapaProvider,
  agoraIso: string
): MapaProviderEstado {
  switch (evento) {
    case "quota_excedida":
      return {
        provider: "fallback",
        quotaExcedidaEm: estado.quotaExcedidaEm ?? agoraIso,
        proximaTentativaEm: somarMinutos(agoraIso, RETRY_INTERVALO_MIN),
      };
    case "retry_sucesso":
      return { provider: "google", quotaExcedidaEm: null, proximaTentativaEm: null };
    case "retry_falhou":
      return {
        provider: "fallback",
        quotaExcedidaEm: estado.quotaExcedidaEm,
        proximaTentativaEm: somarMinutos(agoraIso, RETRY_INTERVALO_MIN),
      };
  }
}

export function deveTentarRetryAgora(estado: MapaProviderEstado, agoraIso: string): boolean {
  if (estado.provider !== "fallback" || !estado.proximaTentativaEm) return false;
  return new Date(agoraIso).getTime() >= new Date(estado.proximaTentativaEm).getTime();
}
