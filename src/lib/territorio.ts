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
  /** Localidade (bairro) do endereco CNEFE mais proximo do ponto, com a
   *  distancia ate ele -- null quando nao ha nenhum. */
  bairroDaCoordenada: (lat: number, lng: number) => Promise<{ localidade: string; distanciaM: number } | null>;
};

/** Acima disso o vizinho CNEFE mais proximo nao diz nada util sobre o bairro
 *  do ponto -- area rural ou trecho sem cobertura do Censo tem vizinho unico a
 *  quilometros, de qualquer bairro. Conservador de proposito: a checagem de
 *  bairro compara NOME (localidade do CNEFE contra o bairro do romaneio) e
 *  nome de bairro varia de grafia, entao ela so' pode marcar suspeita quando a
 *  evidencia e' inequivoca. */
export const RAIO_MAXIMO_VIZINHO_CNEFE_M = 300;

function normalizarBairro(s: string): string {
  return s
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .toUpperCase()
    .replace(/\s+/g, " ")
    .trim();
}

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

  if (esperado.bairro) {
    let vizinho: { localidade: string; distanciaM: number } | null;
    try {
      vizinho = await deps.bairroDaCoordenada(ponto.lat, ponto.lng);
    } catch {
      return { ok: true };
    }
    if (
      vizinho &&
      vizinho.distanciaM <= RAIO_MAXIMO_VIZINHO_CNEFE_M &&
      normalizarBairro(vizinho.localidade) !== normalizarBairro(esperado.bairro)
    ) {
      return { ok: false, motivo: "bairro_divergente" };
    }
  }

  return { ok: true };
}
