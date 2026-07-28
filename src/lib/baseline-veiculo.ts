// Baseline comportamental incremental por veiculo (Welford, media/variancia
// sem guardar amostras cruas -- nao existe tabela de historico bruto de
// posicoes no banco, so resumos incrementais, mesmo padrao ja usado em
// rota_perfil). Substitui a ideia original de comparar contra o historico
// da MESMA rota/par especifico: dado real mostrou que so 1,2% dos pares
// origem-destino repetem em 2+ dias (corredor_celulas, 11/07/2026),
// insuficiente. Agregando por VEICULO (nao por rota) ha muito mais dado
// disponivel, ja que o veiculo opera todo dia independente do destino.
export type Baseline = {
  n: number;
  media: number;
  variancia: number;
};

// Achado real 28/07: dezenas de veiculos na frota tinham baseline "urbano"
// travado com variancia ~0 (ex: RQV-9B26, n=581, media=6km/h,
// desvio=0.08km/h -- qualquer velocidade normal virava "589 desvios do
// padrao"). Causa raiz: Welford acumulativo sem teto -- com n na casa dos
// milhares/dezenas de milhares (GVH-1397: n=40765), cada amostra nova move
// a media/variancia quase nada, e a exclusao de leituras "anomalas" (ver
// route.ts, guarda anti-autopoluicao de 12/07) trava o baseline pra sempre
// assim que ele fica estreito demais: toda leitura normal futura passa a
// parecer anomala e e excluida, entao nada nunca mais entra de novo.
// BASELINE_N_MAXIMO tampa o peso acumulado (efeito de janela deslizante:
// uma vez saturado, cada amostra nova sempre pesa pelo menos 1/N_MAXIMO,
// entao o baseline volta a se mover em vez de travar por anos).
export const BASELINE_N_MAXIMO = 500;

// Piso de desvio-padrao: mediana real da frota (28/07, veiculos com
// n>=100) e ~13.5km/h urbano / ~6.8km/h rodoviario -- 3km/h fica bem
// abaixo dos dois, longe o bastante pra nao distorcer baseline saudavel,
// mas alto o bastante pra matar as explosoes de z-score tipo "589 desvios".
export const BASELINE_DESVIO_MINIMO_KMH = 3;

// Tempo maximo que uma leitura pode ficar sendo excluida (por parecer
// anomala) antes de ser forcada de volta pro baseline. 4h da bastante
// margem sobre o caso que motivou a exclusao original (TTH-6G37, 12/07:
// anomalia real durou so ~10min) -- um baseline genuinamente travado
// comeca a se recuperar dentro do mesmo dia, sem reabrir aquele problema.
export const BASELINE_EXCLUSAO_MAX_MS = 4 * 60 * 60 * 1000;

export function atualizarBaselineWelford(atual: Baseline, novoValor: number): Baseline {
  const nEfetivo = Math.min(atual.n, BASELINE_N_MAXIMO);
  const n = Math.min(nEfetivo + 1, BASELINE_N_MAXIMO);
  const delta = novoValor - atual.media;
  const media = atual.media + delta / n;
  const delta2 = novoValor - media;
  const m2Anterior = atual.variancia * nEfetivo;
  const variancia = (m2Anterior + delta * delta2) / n;
  return { n, media, variancia };
}

// null = amostras insuficientes ainda (cold start), quem chama decide o
// fallback (baseline da frota inteira, ver classificarTipoViagem/route.ts).
export function zScoreBaseline(valor: number, baseline: Baseline, minAmostras: number): number | null {
  if (baseline.n < minAmostras) return null;
  const desvio = Math.max(Math.sqrt(baseline.variancia), BASELINE_DESVIO_MINIMO_KMH);
  return (valor - baseline.media) / desvio;
}

// Achado real 28/07 (ver BASELINE_N_MAXIMO acima): sem isso, um baseline
// travado (variancia ~0) exclui toda leitura normal futura pra sempre,
// porque toda leitura normal parece anomala em relacao a ele. Se ja faz
// BASELINE_EXCLUSAO_MAX_MS que uma leitura deste veiculo/tipo vem sendo
// excluida, forca a proxima de volta pro baseline mesmo que ainda pareca
// anomala -- e a unica forma dele se corrigir sozinho.
export function deveForcarReadmissaoBaseline(
  excluidaDesde: string | null,
  agora: Date,
  limiarMs: number = BASELINE_EXCLUSAO_MAX_MS
): boolean {
  if (excluidaDesde === null) return false;
  return agora.getTime() - new Date(excluidaDesde).getTime() >= limiarMs;
}

// Classificacao deliberadamente simples (regra, nao clustering) -- so por
// velocidade media da viagem, sem depender de classificacao de via do OSM
// (descartada como sinal: rua de bairro e normal no Rio, nao e anomalia).
export function classificarTipoViagem(velocidadeMediaKmh: number): "urbano" | "rodoviario" {
  return velocidadeMediaKmh >= 60 ? "rodoviario" : "urbano";
}
