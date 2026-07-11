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

export function atualizarBaselineWelford(atual: Baseline, novoValor: number): Baseline {
  const n = atual.n + 1;
  const delta = novoValor - atual.media;
  const media = atual.media + delta / n;
  const delta2 = novoValor - media;
  const m2Anterior = atual.variancia * atual.n;
  const variancia = (m2Anterior + delta * delta2) / n;
  return { n, media, variancia };
}

// null = amostras insuficientes ainda (cold start), quem chama decide o
// fallback (baseline da frota inteira, ver classificarTipoViagem/route.ts).
export function zScoreBaseline(valor: number, baseline: Baseline, minAmostras: number): number | null {
  if (baseline.n < minAmostras) return null;
  const desvio = Math.sqrt(baseline.variancia);
  if (desvio < 1e-6) return valor === baseline.media ? 0 : (valor > baseline.media ? 1 : -1) * Infinity;
  return (valor - baseline.media) / desvio;
}

// Classificacao deliberadamente simples (regra, nao clustering) -- so por
// velocidade media da viagem, sem depender de classificacao de via do OSM
// (descartada como sinal: rua de bairro e normal no Rio, nao e anomalia).
export function classificarTipoViagem(velocidadeMediaKmh: number): "urbano" | "rodoviario" {
  return velocidadeMediaKmh >= 60 ? "rodoviario" : "urbano";
}
