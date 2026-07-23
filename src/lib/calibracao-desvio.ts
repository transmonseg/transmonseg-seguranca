// Shrinkage bayesiano simples (Beta-Binomial com prior = taxa global) pra
// calibrar a taxa de falso positivo por segmento sem overfitting quando ha
// poucos dados. O prior tem peso equivalente a `minAmostras` observacoes
// fantasmas com a taxa global -- segmento com poucos rotulos fica quase
// identico ao global; com muitos rotulos, converge pro observado.
export function taxaFalsoPositivoCalibrada(
  nAmostras: number,
  nFalsoPositivo: number,
  taxaGlobal: number,
  minAmostras: number
): number {
  const alphaPrior = taxaGlobal * minAmostras;
  const betaPrior = (1 - taxaGlobal) * minAmostras;
  return (alphaPrior + nFalsoPositivo) / (alphaPrior + betaPrior + nAmostras);
}

// Fator ao vivo aplicado ao score final, derivado direto da taxa de falso
// positivo ja calibrada (nao precisa de uma coluna "score_ajustado"
// separada -- alertas do MESMO tipo tem scores base muito diferentes, 45 a
// 85 so pro desvio, entao um valor absoluto por segmento nao se aplica
// igual a todos; o FATOR proporcional sim). taxa=0 mantem o score igual;
// taxa=1 zeraria (na pratica nunca chega la, protegido pelo shrinkage
// bayesiano em taxaFalsoPositivoCalibrada).
export function aplicarFatorCalibrado(scoreBase: number, taxaFalsoPositivo: number): number {
  return Math.round(scoreBase * (1 - taxaFalsoPositivo));
}

// Qual chave de segmento usar pra buscar a taxa calibrada de um alerta
// "desvio" vencedor da arbitragem. Achado real 12/07 (auditoria
// adversarial): corredorInfo so descreve o desvio COMPORTAMENTAL
// (detectarDesvio) -- se o vencedor final veio do alertaCerca (mesmo tipo
// "desvio", fonte e veredito de corredor totalmente separados), usar
// corredorInfo pra calibracao misturaria amostras de fontes diferentes sob
// a mesma chave de segmento. Retorna null quando o segmento mais
// especifico (por veredito de corredor) nao se aplica -- quem chama cai
// pro fallback `tipo:${alerta.tipo}`. Desde 22/07 (auditoria): a origem e
// lida do campo estrutural `origemDesvio` em vez de comparar
// `motivo.startsWith(...)` -- esse matching por string quebrava
// silenciosamente toda vez que o texto do motivo mudava (ja mudou 3 vezes
// so nesta sessao).
export function segmentoCalibracaoPreferido(
  alerta: { tipo: string; origemDesvio?: "comportamental" | "cerca_virtual" },
  corredorVeredito: string | null | undefined
): string | null {
  if (alerta.tipo === "desvio" && alerta.origemDesvio === "comportamental" && corredorVeredito) {
    return `corredor_veredito:${corredorVeredito}`;
  }
  return null;
}
