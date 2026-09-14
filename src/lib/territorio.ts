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
// distancia_ao_bairro mede a distancia do ponto ate esse hull. Calibracao
// ORIGINAL (083, SEM filtro de municipio -- defeito conhecido, ver comentario
// em 083_distancia_ao_bairro.sql), contra 100 enderecos comprovados errados
// por geocodificacao reversa (Task 4b, 12/09):
//   0m: pega 87/100, tambem marca 1443
//   1000m: pega 82/100, tambem marca 761   <- escolhido na epoca
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
//
// RECALIBRACAO (Fase 2, 13/09, apos Fix 1 -- migration 084 adiciona o filtro
// de municipio que faltava em 083): a hipotese de entrada era que filtrar por
// municipio so' PODE aumentar a distancia medida (o min() passa a rodar sobre
// um subconjunto de hulls, nunca um superconjunto) -- e isso e' verdade linha
// a linha, mas o efeito agregado tem uma segunda forca na direcao oposta: com
// o municipio fixado, ha enderecos cujo bairro existe no CNEFE em ALGUM
// municipio mas nao no municipio certo (cobertura irregular do Censo por
// municipio pequeno) -- esses viram distancia NULL (fail-open, nunca mais
// flagrados) em vez de um numero pequeno por coincidencia de outro
// municipio. As duas forcas quase se cancelam. Medido de novo contra o cache
// real (dump de 14/09, 8.372 enderecos formato Nutry Max, apos o municipio
// ja filtrado):
//   enderecos com distancia medida (bairro existe no CNEFE do municipio certo): 7.295
//   sem bairro no CNEFE do municipio certo (fail-open, null): 1.077 (era 942 na calibracao antiga, sem filtro)
//   limiar_m -> flagrados (> limiar), sobre os 7.295 medidos:
//     0m     -> 1360  (18,6%)
//     500m   ->  847  (11,6%)
//     1000m  ->  678  ( 9,3%)  <- MANTIDO
//     1500m  ->  605  ( 8,3%)
//     2000m  ->  554  ( 7,6%)
//     3000m  ->  459  ( 6,3%)
//     4000m  ->  377  ( 5,2%)
//     5000m  ->  326  ( 4,5%)
//     7000m  ->  268  ( 3,7%)
//     10000m ->  195  ( 2,7%)
//   percentis da distancia medida: p50=0m p75=0m p90=812m p95=4206m p97=8969m
// Decisao: MANTER 1000m. Com o filtro de municipio, 1000m flagra 678 --
// MENOS do que os 761-843 do regime antigo (municipio-blind), nao mais --
// entao a hipotese "o mesmo limiar vai flagrar mais" NAO se confirmou nesta
// medicao; o efeito liquido foi uma leve reducao, pela razao explicada acima.
// Nao ha, nesta sessao, acesso ao conjunto de 100 enderecos comprovados por
// geocodificacao reversa (Task 4b) pra re-validar taxa de acerto contra
// ground truth -- essa recalibracao usa APENAS a distribuicao agregada, nao
// uma nova validacao ponto-a-ponto. Ponderando os dois erros (falso positivo
// custa uma conclusao "nao foi ao cliente" perdida; falso negativo custa
// acusar um motorista errado) e o achado de que uma auditoria de 352 casos
// reais deu 12 falsos alarmes contra 11 perdidos com o limiar antigo
// (proximo de equilibrado) -- manter 1000m e' a escolha que nao move esse
// equilibrio, dado que a contagem de flagrados nao subiu. Se uma auditoria
// futura tiver acesso a mais casos comprovados, revisitar com validacao
// ponto-a-ponto, nao so' agregada.

export type MotivoTerritorio = "municipio_divergente" | "bairro_divergente";

export type ResultadoTerritorio = { ok: true } | { ok: false; motivo: MotivoTerritorio };

export type DepsTerritorio = {
  /** Codigo IBGE de 7 digitos do municipio que CONTEM o ponto, ou null se
   *  nenhum poligono da malha carregada o contiver. */
  municipioDaCoordenada: (lat: number, lng: number) => Promise<string | null>;
  /** Distancia em metros do ponto ate o bairro que o romaneio pediu, ou null
   *  quando esse bairro nao existe no CNEFE (nada a comparar).
   *  municipioCodigo restringe a busca do hull ao municipio esperado --
   *  Fix 1 (Fase 2, 13/09): sem isso, bairros homonimos em outros municipios
   *  (CENTRO existe em 92, BOA VISTA em 29) tornavam a checagem quase um
   *  no-op. Passar null mantem o comportamento antigo (busca em todos os
   *  municipios) -- fail-open quando o municipio esperado e' desconhecido. */
  distanciaAoBairro: (
    lat: number,
    lng: number,
    bairroNormalizado: string,
    municipioCodigo: string | null,
  ) => Promise<number | null>;
};

/** Acima disso o ponto esta longe demais do hull do bairro pedido pra ser
 *  o mesmo lugar. Calibrado originalmente contra 100 casos comprovados por
 *  geocodificacao reversa (Task 4b); RECALIBRADO na Fase 2 (13/09) apos o
 *  Fix 1 (filtro de municipio em distancia_ao_bairro) -- mantido em 1000m,
 *  a contagem de flagrados nao subiu com o filtro. Ver comentario no topo
 *  do arquivo pra tabela completa e raciocinio. */
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
    } catch (err) {
      // Fix 2 (Fase 2, 13/09): fail-open continua igual, mas agora e'
      // AUDIVEL -- silencioso ja escondeu 3 quebras reais no mesmo dia (deps
      // orfa com metodo faltando, RPC ambigua por migration duplicada). So'
      // dispara quando a consulta de fato lanca excecao -- resposta normal
      // "sem poligono" (municipioDaCoordenada resolvendo null) fica quieta.
      console.error("[validarTerritorio] municipioDaCoordenada falhou -- aprovando por fail-open", err);
      return { ok: true };
    }
    if (real && real !== esperado.municipioCodigo) {
      return { ok: false, motivo: "municipio_divergente" };
    }
  }

  if (esperado.bairro) {
    let distanciaM: number | null;
    try {
      distanciaM = await deps.distanciaAoBairro(
        ponto.lat,
        ponto.lng,
        normalizarBairro(esperado.bairro),
        esperado.municipioCodigo,
      );
    } catch (err) {
      // Mesmo raciocinio de municipioDaCoordenada acima -- fail-open audivel,
      // nunca dispara pra distancia null vinda de resposta normal (bairro
      // genuinamente ausente do CNEFE, 942 enderecos, caso esperado e comum).
      console.error("[validarTerritorio] distanciaAoBairro falhou -- aprovando por fail-open", err);
      return { ok: true };
    }
    if (distanciaM !== null && distanciaM > LIMIAR_DISTANCIA_BAIRRO_M) {
      return { ok: false, motivo: "bairro_divergente" };
    }
  }

  return { ok: true };
}
