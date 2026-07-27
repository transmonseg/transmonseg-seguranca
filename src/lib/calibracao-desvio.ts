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
  alerta: { tipo: string; origemDesvio?: "comportamental" | "cerca_virtual" | "saida_parada" | "classe_viaria" },
  corredorVeredito: string | null | undefined
): string | null {
  if (alerta.tipo === "desvio" && alerta.origemDesvio === "comportamental" && corredorVeredito) {
    return `corredor_veredito:${corredorVeredito}`;
  }
  // Achado real 26/07 (Fase 2): segmento proprio pra regra nova de virada
  // errada saindo de parada -- permite medir com o tempo, via
  // recalibrar-desvio, se ESTA regra especifica (dispara com 1 leitura so)
  // e' confiavel ou gera ruido, sem misturar com a regra geral (que exige
  // streak>=2) nem com o corredor.
  if (alerta.tipo === "desvio" && alerta.origemDesvio === "saida_parada") {
    return "origem:saida_parada";
  }
  // Achado real 27/07 (pedido explicito do usuario): quedaClasseViaria
  // passou a disparar alerta SOZINHA (antes so reforcava outro alerta via
  // aplicarBonusClasseViaria). E o sinal mais "largo" hoje -- risco real de
  // gerar mais ruido que os outros -- por isso segmento proprio, pra
  // recalibrar-desvio-semanal aprender sozinho, com o tempo, se essa regra
  // especifica e' confiavel, sem misturar com as demais.
  if (alerta.tipo === "desvio" && alerta.origemDesvio === "classe_viaria") {
    return "origem:classe_viaria";
  }
  // Achado real 27/07 (caso TTK-4D14, revisado na mesma sessao apos
  // auditoria adversarial): gatilho "parado fora do tapete" (ver
  // detectarParadaForaTapete, detectores.ts) dispara com posicao ESTATICA,
  // sem depender de nenhum streak de movimento -- perfil de falso positivo
  // bem diferente das demais origens (nenhuma delas exige velocidade===0).
  // Originalmente modelado como tipo="desvio" + origemDesvio=
  // "parada_fora_tapete" (checado aqui do mesmo jeito que os branches
  // acima); a revisao adversarial encontrou que reusar tipo="desvio" fazia
  // este alerta ocupar a mesma vaga (1-por-veiculo-por-tipo) da familia de
  // desvio comportamental, arriscando bloquear um desvio real subsequente
  // -- corrigido dando tipo PROPRIO ("parada_fora_tapete", ver
  // detectores.ts). Este branch agora checa o TIPO diretamente (nao mais
  // origemDesvio, que nunca e' setado por este detector) -- mesmo segmento
  // de saida ("origem:parada_fora_tapete"), pra recalibrar-desvio-semanal
  // continuar aprendendo sozinho, com o tempo, se esta regra especifica e'
  // confiavel, sem misturar com as demais.
  if (alerta.tipo === "parada_fora_tapete") {
    return "origem:parada_fora_tapete";
  }
  return null;
}
