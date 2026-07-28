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

// baseline_frota agrega ~1 amostra POR VEICULO ATIVO a cada ciclo (nao 1
// amostra por ciclo como baseline_veiculo) -- achado da revisao 28/07: usar
// o mesmo teto de 500 destravaria o cold-start da frota em ~1h depois do
// deploy (vira "como a frota dirigiu nos ultimos 90s" em vez de um
// historico de verdade). Teto bem maior pra frota, mesma logica de decaimento.
export const BASELINE_FROTA_N_MAXIMO = 50_000;

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

// Achado CRITICO da revisao independente 28/07 (simulacao numerica): a
// versao anterior dividia por n TAMPADO mesmo depois de saturar, entao a
// variancia so crescia (nunca decaia) -- uma vez n===nMaximo,
// m2Anterior/n vira a variancia anterior inteira, sem termo de
// decaimento. Simulado: sd real=10 virava sd=200 depois de 200k amostras
// por veiculo (~30 dias); pra baseline_frota (que recebe ~1 amostra por
// veiculo ativo por ciclo, nao 1 por ciclo) destravava em ~1h apos
// deploy, matando o detector de anomalia pra frota inteira em silencio.
// Fix: dividir sempre pelo n BRUTO (nao-tampado) -- so o n guardado/
// retornado e tampado. nMaximo agora e parametro (default
// BASELINE_N_MAXIMO) pra permitir um teto bem maior em baseline_frota
// (ver BASELINE_FROTA_N_MAXIMO acima), que recebe muito mais amostras por
// ciclo que baseline_veiculo.
export function atualizarBaselineWelford(
  atual: Baseline,
  novoValor: number,
  nMaximo: number = BASELINE_N_MAXIMO
): Baseline {
  const nEfetivo = Math.min(atual.n, nMaximo);
  const nBruto = nEfetivo + 1; // divide sempre pelo bruto -- so o valor guardado e tampado
  const delta = novoValor - atual.media;
  const media = atual.media + delta / nBruto;
  const delta2 = novoValor - media;
  const variancia = (atual.variancia * nEfetivo + delta * delta2) / nBruto;
  return { n: Math.min(nBruto, nMaximo), media, variancia };
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

// Decide se uma leitura entra no baseline_veiculo deste ciclo, e se deve
// marcar o inicio de uma exclusao continua. Extraido pra cá (em vez de
// inline em route.ts) porque essa e a logica mais arriscada do fix de
// 28/07 -- precisa ser testavel sem subir o motor inteiro.
//
// Achado IMPORTANTE da revisao independente 28/07: so aplicar a
// exclusao/circuit-breaker quando a leitura foi medida contra o baseline
// PROPRIO do veiculo (usaBaselineProprio, mesmo limiar de
// minAmostrasProprio=20 ja usado em detectarAnomaliaBaseline) -- se ainda
// em cold-start (usando fallback da frota), SEMPRE admite. Sem isso, um
// veiculo novo que parece anomalo so contra a frota nunca acumularia
// baseline proprio (a linha em baseline_veiculo nem existe ainda, entao o
// UPDATE de marcacao afetaria 0 linhas silenciosamente) e alertaria todo
// ciclo pra sempre.
export function decidirAdmissaoBaseline(ctx: {
  usaBaselineProprio: boolean;
  ehAnomalia: boolean;
  excluidaDesde: string | null;
  agora: Date;
}): { admitir: boolean; marcarExclusaoAgora: boolean } {
  const forcarReadmissao = ctx.usaBaselineProprio && ctx.ehAnomalia &&
    deveForcarReadmissaoBaseline(ctx.excluidaDesde, ctx.agora);
  const excluir = ctx.usaBaselineProprio && ctx.ehAnomalia && !forcarReadmissao;
  return {
    admitir: !excluir,
    marcarExclusaoAgora: excluir && ctx.excluidaDesde === null,
  };
}

// Classificacao deliberadamente simples (regra, nao clustering) -- so por
// velocidade media da viagem, sem depender de classificacao de via do OSM
// (descartada como sinal: rua de bairro e normal no Rio, nao e anomalia).
export function classificarTipoViagem(velocidadeMediaKmh: number): "urbano" | "rodoviario" {
  return velocidadeMediaKmh >= 60 ? "rodoviario" : "urbano";
}
