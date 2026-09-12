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
//
// Task 4b (mesmo dia, substitui a checagem de bairro das Tasks 4/5/7): a regra
// anterior comparava a `localidade` do endereco CNEFE mais proximo contra o
// bairro do romaneio. Isso e' conceitualmente errado -- `localidade` no CNEFE
// e' mais fina que bairro (inclui loteamento, conjunto, comunidade). A 16
// metros uma da outra ha pontos com localidade "PARADA DE LUCAS" e
// "PARQUE JARDIM BEIRA MAR", dois valores de localidade dentro do MESMO
// bairro. Rodando contra o cache real, aquela regra marcava 3.251 dos 8.744
// enderecos (37%) como nao confiaveis -- a maioria falso alarme de nomenclatura,
// nao erro de geocodificacao.
//
// A pergunta certa nao e' "esse ponto tem a localidade exata do bairro
// pedido?", e sim "esse ponto esta perto de onde o bairro pedido realmente
// fica?". `cnefe_bairros` (migration 082) agrupa todo endereco do CNEFE por
// (municipio, localidade normalizada) e guarda o hull convexo dos pontos.
// distancia_ao_bairro (migration 083) mede a distancia do ponto ate esse
// hull. Limiar calibrado contra 100 enderecos comprovados errados por
// geocodificacao reversa (ver relatorio da Task 4b):
//   0m: pega 87/100, tambem marca 1443
//   1000m: pega 82/100, tambem marca 761   <- escolhido
//   3000m: pega 70/100, tambem marca 538
//   5000m: pega 59/100, tambem marca 404
// Amostra de 30 dos marcados a >1000m fora do conjunto comprovado: 28
// divergiam de fato, 0 batiam, 2 indeterminados -- sao desvios reais.
//
// Limitacao conhecida, sem correcao possivel neste nivel: a coordenada ruim
// da Ilha da Gigoia (22.792m do lugar real) fica a 122m do hull de BARRA DA
// TIJUCA -- dentro do limiar, portanto NAO e' flagrada. E' um erro de
// geocodificacao *dentro* do bairro correto; nenhuma checagem em nivel de
// bairro consegue pegar isso. Nao e' bug, e' o teto deste tipo de regra.

export type MotivoTerritorio = "municipio_divergente" | "bairro_divergente";

export type ResultadoTerritorio = { ok: true } | { ok: false; motivo: MotivoTerritorio };

export type DepsTerritorio = {
  /** Codigo IBGE de 7 digitos do municipio que CONTEM o ponto, ou null se
   *  nenhum poligono da malha carregada o contiver. */
  municipioDaCoordenada: (lat: number, lng: number) => Promise<string | null>;
  /** Distancia em metros do ponto ate o bairro que o romaneio pediu, ou null
   *  quando esse bairro nao existe no CNEFE (nada a comparar). */
  distanciaAoBairro: (lat: number, lng: number, bairroNormalizado: string) => Promise<number | null>;
};

/** Acima disso o ponto esta longe demais do hull do bairro pedido pra ser
 *  o mesmo lugar. Calibrado contra 100 casos comprovados por geocodificacao
 *  reversa -- ver comentario no topo do arquivo. */
export const LIMIAR_DISTANCIA_BAIRRO_M = 1000;

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
    let distanciaM: number | null;
    try {
      distanciaM = await deps.distanciaAoBairro(ponto.lat, ponto.lng, normalizarBairro(esperado.bairro));
    } catch {
      return { ok: true };
    }
    if (distanciaM !== null && distanciaM > LIMIAR_DISTANCIA_BAIRRO_M) {
      return { ok: false, motivo: "bairro_divergente" };
    }
  }

  return { ok: true };
}
