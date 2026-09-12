// Guarda de saida territorial -- roda DEPOIS da cascata de geocodificacao
// (romaneio-geocode.ts), nunca dentro dela.
//
// Achado real 12/09 (auditoria do KPI Nutry Max do dia 11/09): 100 coordenadas
// do cache estao em municipio diferente do que o romaneio pediu, e 294 dos 304
// enderecos suspeitos estavam marcados como confiaveis. Nove desses erros foram
// criados no proprio dia 12/09, pelo motor atual -- nao e' so' estoque velho.
//
// Por que aqui e nao na cascata: a cascata e' compartilhada com Rio Quality,
// Porte Frio e o motor de desvio de rota, e o escopo decidido e' so' Nutry Max.
// Ver docs/superpowers/specs/2026-09-12-confiabilidade-kpi-nutrimax-design.md,
// secao "Decisoes de arquitetura".
//
// FAIL-OPEN em todo caminho de duvida: sem municipio esperado resolvido, sem
// poligono contendo o ponto, ou com a consulta falhando, o resultado e' "ok".
// Uma coordenada boa nunca pode virar suspeita por falta de dado nosso.

export type MotivoTerritorio = "municipio_divergente" | "bairro_divergente";

export type ResultadoTerritorio = { ok: true } | { ok: false; motivo: MotivoTerritorio };

export type DepsTerritorio = {
  /** Codigo IBGE de 7 digitos do municipio que CONTEM o ponto, ou null se
   *  nenhum poligono da malha carregada o contiver. */
  municipioDaCoordenada: (lat: number, lng: number) => Promise<string | null>;
};

export async function validarTerritorio(
  ponto: { lat: number; lng: number },
  esperado: { municipioCodigo: string | null; bairro: string | null },
  deps: DepsTerritorio,
): Promise<ResultadoTerritorio> {
  if (esperado.municipioCodigo) {
    let real: string | null;
    try {
      real = await deps.municipioDaCoordenada(ponto.lat, ponto.lng);
    } catch {
      return { ok: true };
    }
    if (real && real !== esperado.municipioCodigo) {
      return { ok: false, motivo: "municipio_divergente" };
    }
  }
  return { ok: true };
}
