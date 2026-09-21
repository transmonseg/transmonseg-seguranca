// Gates de supressao de desvio da Central Unitrac (salto de reconciliacao,
// retorno a base + horario avancado, saida da base) reaplicados na Central
// Romaneio (src/app/api/motor-romaneio/route.ts). Regra de ouro do arquivo
// original: "e' tudo igual, so' muda a fonte dos pontos" -- este modulo NAO
// reimplementa nenhuma regra: so' monta as entradas a partir dos dados que a
// Central Romaneio tem (pendentes do romaneio, bases do cliente, janela de
// posicoes_historico) e chama as MESMAS funcoes puras de @/lib/desvio.
//
// Recall primeiro: tudo aqui e' fail-open. Dado ausente/invalido => NAO
// suprime. Nenhum gate mexe no streak (o chamador so' anula o alerta do ciclo).
import {
  ehRetornoABaseHorarioAvancado,
  ehRetornoSustentadoABase,
  ehSaidaDeBaseSemDestinoAvaliavel,
  ehSaltoDeReconciliacaoDeAtraso,
  type LeituraRetornoBase,
} from "./desvio";
import { haversineM } from "./unitrac";

type Ponto = { lat: number; lng: number };

// Espelha o GATE_SAIDA_BASE_ATIVO local de motor/route.ts (reativado 01/09 por
// decisao do usuario). Mantido aqui so' porque motor/route.ts nao exporta a
// constante; se um dia ela for exportada, este valor deve passar a importa-la.
export const GATE_SAIDA_BASE_ATIVO = true;

// Periodo do ciclo do motor usado no limite superior do intervalo do par de
// leituras (mesmo valor de PERIODO_CICLO_MOTOR_S em motor/route.ts).
export const PERIODO_CICLO_MOTOR_S = 60;

export type TipoSupressaoDesvio = "suprimido_retorno_base" | "suprimido_saida_base";

// Intervalo do par (anterior, atual) pro gate de salto de reconciliacao, no
// mesmo formato da Central: LIMITE SUPERIOR do intervalo real (tempo desde a
// gravacao da leitura anterior + 1 periodo de ciclo), o que da' um LIMITE
// INFERIOR da velocidade implicita e erra pro lado de NAO suprimir. Sem
// timestamp valido devolve null (o gate entao nao age).
export function calcularDtParSegundos(
  agoraMs: number,
  anteriorGravadoEmMs: number | null | undefined,
  periodoCicloS: number
): number | null {
  if (anteriorGravadoEmMs == null || !Number.isFinite(anteriorGravadoEmMs) || !Number.isFinite(agoraMs)) {
    return null;
  }
  return (agoraMs - anteriorGravadoEmMs) / 1000 + periodoCicloS;
}

// Gate 1 (28/08): mesma chamada da Central. So' embrulha pra dar um ponto de
// teste com os nomes de campo daqui.
export function ehSaltoDeReconciliacaoRomaneio(args: {
  atrasoAnteriorMin: number | null | undefined;
  atrasoAtualMin: number | null | undefined;
  movimentoRealM: number | null | undefined;
  dtParSegundos: number | null | undefined;
}): boolean {
  return ehSaltoDeReconciliacaoDeAtraso(
    args.atrasoAnteriorMin,
    args.atrasoAtualMin,
    args.movimentoRealM,
    args.dtParSegundos
  );
}

export function distanciaBaseMaisProximaM(pos: Ponto, bases: Ponto[]): number | null {
  if (bases.length === 0) return null;
  return Math.min(...bases.map((b) => haversineM(pos.lat, pos.lng, b.lat, b.lng)));
}

// Leituras da janela de retorno a base: distancia (linha reta) ate a base mais
// proxima + deslocamento entre leituras consecutivas -- identico ao montado
// em motor/route.ts. `janela` em ordem cronologica, ja' com a leitura ATUAL no
// fim (ela ainda nao esta em posicoes_historico no meio do ciclo).
export function montarLeiturasRetornoBase(
  janela: Array<Ponto & { t: number }>,
  bases: Ponto[]
): LeituraRetornoBase[] {
  return janela.map((p, i) => ({
    tSegundos: p.t,
    distBaseM: Math.min(...bases.map((b) => haversineM(p.lat, p.lng, b.lat, b.lng))),
    deslocamentoM: i === 0 ? 0 : haversineM(janela[i - 1].lat, janela[i - 1].lng, p.lat, p.lng),
  }));
}

// Contexto do gate de saida da base: mesma derivacao de motor/route.ts, so'
// que sobre a lista de pendentes do romaneio (a Central usa
// `indicesRelevantes.some(i => i < pontosVeiculoParaDesvio.length)`, que e'
// exatamente "algum pendente dentro do raio de relevancia").
export function calcularContextoSaidaDeBase(args: {
  pos: Ponto;
  anterior: Ponto | null;
  pendentes: Ponto[];
  limiarDestinoRelevanteM: number;
}): {
  temPendenteRelevante: boolean;
  temPendenteForaDoRaio: boolean;
  aproximandoDePendenteForaDoRaio: boolean;
} {
  const { pos, anterior, pendentes, limiarDestinoRelevanteM } = args;
  const temPendenteRelevante = pendentes.some(
    (pt) => haversineM(pos.lat, pos.lng, pt.lat, pt.lng) <= limiarDestinoRelevanteM
  );
  const temPendenteForaDoRaio = pendentes.length > 0 && !temPendenteRelevante;
  const aproximandoDePendenteForaDoRaio =
    temPendenteForaDoRaio && anterior != null
      ? Math.min(...pendentes.map((pt) => haversineM(pos.lat, pos.lng, pt.lat, pt.lng))) <
        Math.min(...pendentes.map((pt) => haversineM(anterior.lat, anterior.lng, pt.lat, pt.lng)))
      : false;
  return { temPendenteRelevante, temPendenteForaDoRaio, aproximandoDePendenteForaDoRaio };
}

export type DecisaoSupressaoDesvio = {
  tipo: TipoSupressaoDesvio | null;
  detalhe: Record<string, unknown>;
};

// Gates 2 e 3, na MESMA ordem da Central: retorno a base primeiro; se ele
// suprimir, o de saida da base nem e' avaliado (na Central o alerta ja' e'
// null nesse ponto). Chamar so' quando o alerta do ciclo veio de
// "afastando_geral" -- o chamador filtra.
//
// `leiturasRetorno` null = janela indisponivel (query falhou / sem dado):
// o gate de retorno nao age (fail-open).
export function decidirSupressaoDesvioRomaneio(args: {
  pos: Ponto;
  anterior: Ponto | null;
  pendentes: Ponto[];
  centroidesBase: Ponto[];
  leiturasRetorno: LeituraRetornoBase[] | null;
  hora: number;
  minuto: number;
  streakAfastando: number;
  limiarDestinoRelevanteM: number;
  gateSaidaBaseAtivo: boolean;
}): DecisaoSupressaoDesvio {
  const distBaseM = distanciaBaseMaisProximaM(args.pos, args.centroidesBase);

  // Retorno sustentado a base -- so' entra quando TODAS as bases do cliente
  // estao alem do raio de relevancia (com base dentro do raio ela ja' esta em
  // destinosRelevantes e uma base se aproximando impede afastouDeTodos).
  if (
    distBaseM != null &&
    distBaseM > args.limiarDestinoRelevanteM &&
    args.leiturasRetorno != null &&
    args.leiturasRetorno.length > 0
  ) {
    const l = args.leiturasRetorno;
    if (
      ehRetornoSustentadoABase(l) ||
      ehRetornoABaseHorarioAvancado(l, { hora: args.hora, minuto: args.minuto })
    ) {
      return {
        tipo: "suprimido_retorno_base",
        detalhe: {
          distBaseMaisProximaM: Math.round(distBaseM),
          leiturasNaJanela: l.length,
          quedaM: Math.round(l[0].distBaseM - l[l.length - 1].distBaseM),
        },
      };
    }
  }

  if (args.gateSaidaBaseAtivo) {
    const ctx = calcularContextoSaidaDeBase({
      pos: args.pos,
      anterior: args.anterior,
      pendentes: args.pendentes,
      limiarDestinoRelevanteM: args.limiarDestinoRelevanteM,
    });
    if (
      ehSaidaDeBaseSemDestinoAvaliavel({
        ...ctx,
        distBaseM,
        streakAfastando: args.streakAfastando,
      })
    ) {
      return {
        tipo: "suprimido_saida_base",
        detalhe: {
          distBaseM: distBaseM == null ? null : Math.round(distBaseM),
          pendentesTotal: args.pendentes.length,
        },
      };
    }
  }

  return { tipo: null, detalhe: {} };
}
