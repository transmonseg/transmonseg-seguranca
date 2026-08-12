// src/lib/detectores-teste.ts
//
// Motor de desvio do "modo teste" (spec
// docs/superpowers/specs/2026-08-11-modo-teste-desvio-zero-design.md).
//
// HISTORICO DO DIA (11/08) -- por que a regra mudou de arquitetura duas
// vezes, nao so' de parametro (ver docs/analise-desvio-raiz-2026-08-11.md
// pro detalhe completo de cada etapa):
// 1-4. Scoring por distancia (linha reta, depois rota real via OSRM) --
//    melhorou muito (939 -> 161), mas revisao visual dos casos restantes
//    ainda achou ambiguidade genuina.
// 5. Trocado pra verificarCorredor ("esta em cima de estrada real que
//    leva a algum pendente?") como regra PRIMARIA -- mais robusto em
//    teoria, mas o teste de dia inteiro/frota inteira mostrou PIOR (380
//    disparos, 66% da frota). Revisao visual achou dois modos de falha
//    REAIS, nao ruido de calibracao: (a) disparo com 0 pendentes
//    carregados (transito normal antes de ter entrega atribuida); (b)
//    disparo em rota de entrega legitima com MULTIPLAS paradas --
//    verificarCorredor traca origem->CADA destino individualmente a
//    partir de um ponto congelado, nao modela "ja visitei 2 paradas,
//    agora vou pra proxima da sequencia real".
// 6. ESTA VERSAO: mantem verificarCorredor (a pergunta continua certa),
//    mas corrige os dois modos de falha: (a) sem destino nenhum
//    carregado, nao avalia (nao dispara, nao acumula); (b) usa OSRM
//    /trip (sequenciaOtimizadaOSRM) pra ordenar os pendentes a partir da
//    posicao atual, testa o corredor perna-a-perna contra as PROXIMAS
//    paradas da sequencia (nao todos os destinos de uma vez), e reancora
//    a origem quando o veiculo chega de verdade numa parada da sequencia
//    (nao so' quando "esta dentro de algum corredor generico").

import { verificarCorredor, sequenciaOtimizadaOSRM } from "./corredor-verificacao";
import { haversineM } from "./unitrac";

export type EstadoDesvioTeste = {
  // Ultima parada REAL confirmada (chegou fisicamente perto, raioVisitaM)
  // -- e' a origem usada pra tracar a rota na proxima verificacao.
  // Precisa ser um ponto do PASSADO (nunca a posicao atual), senao a
  // checagem vira tautologica -- ver corredor-verificacao.ts:180-188.
  ultimaParadaReal: { lat: number; lng: number };
  foraStreak: number;
  // Sequencia otimizada (ids dos destinos, na ordem de visita sugerida
  // pelo OSRM /trip), cacheada entre ciclos -- recalcular todo ciclo
  // seria caro e desnecessario, so' fica invalida quando o conjunto de
  // destinos muda ou passa tempo demais.
  sequenciaIds: string[] | null;
  sequenciaAtualizadaEm: string | null;
};

export type ParametrosDesvioTeste = {
  // Quantos ciclos seguidos "fora de qualquer corredor" pra disparar.
  streakMinParaDisparar: number;
  // Raio (m) pra considerar que o veiculo chegou DE VERDADE numa parada
  // da sequencia -- reancora a origem e avanca a sequencia. Mesmo
  // principio da geofence de chegada existente (suspenderPorChegada).
  raioVisitaM: number;
  // Quantas proximas paradas da sequencia testar no corredor por ciclo
  // -- >1 da' tolerancia a pequenos desvios de ORDEM (motorista visita
  // fora da ordem sugerida) sem tratar isso como desvio de ROTA.
  nProximasParadasTestadas: number;
  // Minutos antes de recalcular a sequencia mesmo sem mudanca no
  // conjunto de destinos -- rede pode ter falhado silenciosamente antes
  // e ficado presa num cache velho.
  sequenciaValidadeMin: number;
};

export const PARAMS_DESVIO_TESTE_PADRAO: ParametrosDesvioTeste = {
  streakMinParaDisparar: 3,
  raioVisitaM: 100,
  nProximasParadasTestadas: 2,
  sequenciaValidadeMin: 20,
};

function sequenciaAindaValida(
  sequenciaIds: string[] | null,
  sequenciaAtualizadaEm: string | null,
  idsAtuais: Set<string>,
  validadeMin: number
): boolean {
  if (sequenciaIds === null || sequenciaAtualizadaEm === null) return false;
  if (sequenciaIds.length !== idsAtuais.size) return false;
  if (!sequenciaIds.every((id) => idsAtuais.has(id))) return false;
  return Date.now() - new Date(sequenciaAtualizadaEm).getTime() < validadeMin * 60000;
}

export async function avaliarDesvioTeste(
  posAtual: { lat: number; lng: number; velocidade: number },
  destinos: { id: string; lat: number; lng: number }[],
  estadoAnterior: EstadoDesvioTeste | null,
  params: ParametrosDesvioTeste = PARAMS_DESVIO_TESTE_PADRAO
): Promise<{ estado: EstadoDesvioTeste; disparouAgora: boolean }> {
  const foraStreakAnterior = estadoAnterior?.foraStreak ?? 0;

  // Fix #1 (achado real 11/08): sem NENHUM destino carregado (pendente
  // ou base), nao ha o que testar -- "fora de qualquer corredor" seria
  // trivialmente verdade e nao significa desvio. Nao dispara, nao
  // acumula streak, so' aguarda o proximo ciclo com destino de verdade.
  if (destinos.length === 0) {
    return {
      estado: {
        ultimaParadaReal: estadoAnterior?.ultimaParadaReal ?? { lat: posAtual.lat, lng: posAtual.lng },
        foraStreak: 0,
        sequenciaIds: null,
        sequenciaAtualizadaEm: null,
      },
      disparouAgora: false,
    };
  }

  // Primeira leitura (sem estado anterior): nao ha "ultima parada real"
  // conhecida ainda -- usa a propria posicao atual como origem (fail-safe
  // pro primeiro ciclo, evita disparar so' por falta de historico).
  const origem = estadoAnterior?.ultimaParadaReal ?? { lat: posAtual.lat, lng: posAtual.lng };

  const idsAtuais = new Set(destinos.map((d) => d.id));
  let sequenciaIds = estadoAnterior?.sequenciaIds ?? null;
  let sequenciaAtualizadaEm = estadoAnterior?.sequenciaAtualizadaEm ?? null;

  if (!sequenciaAindaValida(sequenciaIds, sequenciaAtualizadaEm, idsAtuais, params.sequenciaValidadeMin)) {
    const novaSequencia = await sequenciaOtimizadaOSRM(origem, destinos);
    if (novaSequencia) {
      sequenciaIds = novaSequencia;
      sequenciaAtualizadaEm = new Date().toISOString();
    } else if (sequenciaIds === null) {
      // Sem sequencia nenhuma (nem cache, nem calculo novo) -- fail-open,
      // nao dispara nem acumula, tenta de novo no proximo ciclo.
      return {
        estado: { ultimaParadaReal: origem, foraStreak: foraStreakAnterior, sequenciaIds: null, sequenciaAtualizadaEm: null },
        disparouAgora: false,
      };
    }
    // Se a chamada falhou mas ja tinha cache antigo (mesmo que com IDs
    // que sumiram do conjunto atual), segue usando o cache antigo --
    // fail-open parcial, melhor que travar a avaliacao inteira.
  }

  const mapaDestinos = new Map(destinos.map((d) => [d.id, d]));
  const proximasParadas = (sequenciaIds ?? [])
    .map((id) => mapaDestinos.get(id))
    .filter((d): d is { id: string; lat: number; lng: number } => d !== undefined)
    .slice(0, params.nProximasParadasTestadas);

  if (proximasParadas.length === 0) {
    // Sequencia cacheada nao tem mais nenhum id presente no conjunto
    // atual (mudou tudo entre ciclos) -- nao ha proxima parada valida
    // pra testar ainda, aguarda o proximo ciclo recalcular.
    return {
      estado: { ultimaParadaReal: origem, foraStreak: foraStreakAnterior, sequenciaIds, sequenciaAtualizadaEm },
      disparouAgora: false,
    };
  }

  // Fix #2 (achado real 11/08): chegou DE VERDADE na proxima parada da
  // sequencia planejada? Reancora a origem AQUI (parada real confirmada),
  // nao so' quando "dentro de algum corredor generico" -- e' isso que
  // faz a checagem acompanhar uma rota de multiplas paradas em vez de
  // continuar testando contra um ponto de origem congelado.
  const proximaParadaImediata = proximasParadas[0];
  const distanciaProximaParada = haversineM(posAtual.lat, posAtual.lng, proximaParadaImediata.lat, proximaParadaImediata.lng);
  if (distanciaProximaParada <= params.raioVisitaM) {
    return {
      estado: {
        ultimaParadaReal: { lat: posAtual.lat, lng: posAtual.lng },
        foraStreak: 0,
        sequenciaIds: (sequenciaIds ?? []).filter((id) => id !== proximaParadaImediata.id),
        sequenciaAtualizadaEm,
      },
      disparouAgora: false,
    };
  }

  const resultado = await verificarCorredor(origem, posAtual, proximasParadas);

  if (resultado.veredito === "dentro") {
    return {
      estado: { ultimaParadaReal: origem, foraStreak: 0, sequenciaIds, sequenciaAtualizadaEm },
      disparouAgora: false,
    };
  }
  if (resultado.veredito === "indisponivel") {
    // Fail-open (mesmo principio de corredor-verificacao.ts): API fora
    // do ar nao pode nem disparar nem suprimir por conta propria -- so
    // mantem o estado como estava.
    return {
      estado: { ultimaParadaReal: origem, foraStreak: foraStreakAnterior, sequenciaIds, sequenciaAtualizadaEm },
      disparouAgora: false,
    };
  }

  // "fora" -- acumula streak, origem continua sendo a ultima parada real
  // confirmada (nao a posicao atual, que e' exatamente o que esta sendo
  // questionado).
  const novoForaStreak = foraStreakAnterior + 1;
  const disparouAgora = foraStreakAnterior < params.streakMinParaDisparar && novoForaStreak >= params.streakMinParaDisparar;
  return {
    estado: { ultimaParadaReal: origem, foraStreak: novoForaStreak, sequenciaIds, sequenciaAtualizadaEm },
    disparouAgora,
  };
}
