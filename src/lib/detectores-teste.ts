// src/lib/detectores-teste.ts
//
// Motor de desvio do "modo teste" (spec
// docs/superpowers/specs/2026-08-11-modo-teste-desvio-zero-design.md,
// secao 2). Codigo proprio, isolado -- NAO importa nada de
// src/lib/detectores.ts.
//
// Historico de achados reais (revisao caso a caso com dado de um dia
// inteiro de producao, 11/08, ver docs/analise-desvio-raiz-2026-08-11.md):
// - "menor distancia global" e' insegura (falso-positiva ao passar reto
//   por um cliente rumo a outro).
// - "todos os destinos precisam crescer" e' segura mas conservadora
//   demais (nunca dispara em desvio real).
// - "media simples de TODOS os pendentes" (validada no harness com
//   76.1%/47.2%) passou no harness mas, revisada caso a caso, mostrou 3
//   causas de falso positivo: pendentes longe diluindo a media, volta pra
//   base nao contando como destino, cliente visitado mas nao confirmado
//   continuando a pesar. Corrigidas com peso por proximidade +
//   visitados + base incluida (ver historico abaixo).
// - ACHADO CRITICO (11/08, mesmo dia): mesmo com as 3 correcoes acima, a
//   distancia usada era sempre EM LINHA RETA (haversine). Testado com
//   distancia REAL de rua (OSRM) nos casos mais fortes de "desvio real"
//   do dia: nenhum deles disparou com rota real -- todos eram artefato de
//   linha reta (geografia do Rio -- baias, morros, ruas de mao unica --
//   faz a reta mentir sobre o quanto o carro andou de verdade). Por isso
//   esta funcao NAO calcula distancia internamente -- recebe distancias
//   JA CALCULADAS (rota real, via src/lib/distancias-osrm.ts) do
//   chamador. Mantida pura/sem rede pra continuar testavel sem OSRM.
//
// Regra: MEDIA PONDERADA do delta de distancia entre os destinos
// pendentes que existiam tanto no ciclo anterior quanto no atual (casados
// por id) -- cada destino pesa PROPORCIONAL A SUA PROXIMIDADE (perto pesa
// quase 1, longe pesa quase 0, decaimento suave, sem corte duro tipo
// top-K). Destinos "visitados" (chegou a menos de raioVisitaM em algum
// momento) saem do calculo dali em diante, mesmo que ainda apareçam na
// lista de pendentes. Bases devem ser passadas como destinos normais pelo
// chamador -- essa funcao nao distingue base de cliente, e' so mais um
// ponto.

export type EstadoDesvioTeste = {
  score: number;
  distanciasAnteriores: Record<string, number>;
  visitados: Record<string, true>;
};

export type ParametrosDesvioTeste = {
  margemRuidoM: number;
  decay: number;
  limiar: number;
  escalaProximidadeM: number; // peso de cada destino = 1/(1 + distAtual/escala) -- quanto menor, mais rapido o peso cai com a distancia
  raioVisitaM: number; // destino a essa distancia ou menos vira "visitado", sai do calculo dali em diante
  contribMaxM: number; // satura a media ponderada -- uma media grande nao dispara sozinha num ciclo so
};

// Valores herdados da fase "linha reta" (11/08) -- precisam de nova
// rodada de validacao (harness + dia real) agora que a distancia vem de
// rota real via OSRM, nao mais haversine. A escala muda completamente:
// distancia de rua tende a ser MAIOR que linha reta pro mesmo par de
// pontos (nunca menor), entao os limiares abaixo sao só ponto de partida.
export const PARAMS_DESVIO_TESTE_PADRAO: ParametrosDesvioTeste = {
  margemRuidoM: 50,
  decay: 0.6,
  limiar: 2.1,
  escalaProximidadeM: 1000,
  raioVisitaM: 100,
  contribMaxM: 80,
};

export function avaliarDesvioTeste(
  distanciasAtuais: Record<string, number>,
  estadoAnterior: EstadoDesvioTeste | null,
  params: ParametrosDesvioTeste = PARAMS_DESVIO_TESTE_PADRAO
): { estado: EstadoDesvioTeste; disparouAgora: boolean } {
  const scoreAnterior = estadoAnterior?.score ?? 0;
  const distanciasAnteriores = estadoAnterior?.distanciasAnteriores ?? {};
  const visitados: Record<string, true> = { ...(estadoAnterior?.visitados ?? {}) };

  let somaPesos = 0;
  let somaPesoVezesDelta = 0;

  for (const [id, distAtual] of Object.entries(distanciasAtuais)) {
    if (distAtual <= params.raioVisitaM) {
      visitados[id] = true;
    }
    if (visitados[id]) continue; // "quase resolvido" -- nao pesa mais na media

    const distAnterior = distanciasAnteriores[id];
    if (distAnterior === undefined) continue; // primeira vez que aparece, sem delta ainda

    const delta = distAtual - distAnterior;
    const peso = 1 / (1 + distAtual / params.escalaProximidadeM);
    somaPesos += peso;
    somaPesoVezesDelta += peso * delta;
  }

  let novoScore = scoreAnterior * params.decay;
  if (somaPesos > 0) {
    const mediaDelta = somaPesoVezesDelta / somaPesos;
    if (mediaDelta > params.margemRuidoM) {
      const contribuicao = Math.min(mediaDelta, params.contribMaxM) / params.contribMaxM;
      novoScore = scoreAnterior * params.decay + contribuicao;
    }
  }

  const disparouAgora = scoreAnterior < params.limiar && novoScore >= params.limiar;

  return {
    estado: { score: novoScore, distanciasAnteriores: distanciasAtuais, visitados },
    disparouAgora,
  };
}
