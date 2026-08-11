// scripts/backtest-desvio/candidatos.ts
//
// Candidatos de regra "afastamento suficiente" pra substituir o
// afastouDeTudo atual (exige TODOS os destinos crescerem, ver
// docs/superpowers/specs/2026-08-10-afastando-tudo-harness-design.md).
// Cada candidato precisa se comportar EXATAMENTE como ALL quando N e'
// pequeno (2-3 destinos) -- senao reabre o incidente de 06/07 (motorista
// entregando pro cliente nao-mais-proximo disparando falso desvio).

const AFASTAMENTO_MARGEM_M = 50;
const AFASTAMENTO_N_PEQUENO_MAX = 3;

export type CandidatoRegra = (distAtualM: number[], distAnteriorM: number[]) => boolean;

function cresceuAlemDaMargem(atual: number, anterior: number): boolean {
  return atual > anterior + AFASTAMENTO_MARGEM_M;
}

function validarEntrada(distAtualM: number[], distAnteriorM: number[]): boolean {
  return distAtualM.length > 0 && distAtualM.length === distAnteriorM.length;
}

export function all(distAtualM: number[], distAnteriorM: number[]): boolean {
  if (!validarEntrada(distAtualM, distAnteriorM)) return false;
  return distAtualM.every((d, i) => cresceuAlemDaMargem(d, distAnteriorM[i]));
}

function topK(k: number): CandidatoRegra {
  return (distAtualM, distAnteriorM) => {
    if (!validarEntrada(distAtualM, distAnteriorM)) return false;
    const kEfetivo = Math.min(k, distAnteriorM.length);
    const indicesMaisProximos = distAnteriorM
      .map((d, i) => [d, i] as const)
      .sort((a, b) => a[0] - b[0])
      .slice(0, kEfetivo)
      .map(([, i]) => i);
    return indicesMaisProximos.every((i) => cresceuAlemDaMargem(distAtualM[i], distAnteriorM[i]));
  };
}

function percentual(pct: number): CandidatoRegra {
  return (distAtualM, distAnteriorM) => {
    if (!validarEntrada(distAtualM, distAnteriorM)) return false;
    const n = distAtualM.length;
    const cresceram = distAtualM.filter((d, i) => cresceuAlemDaMargem(d, distAnteriorM[i])).length;
    const minimoNecessario = n <= 3 ? n : Math.ceil(pct * n);
    return cresceram >= minimoNecessario;
  };
}

// Achado real 11/08 (TOS-2B69, falso positivo ao vivo com pct80 em
// producao): deslocamento real de 80m gerou crescimento de 76-80m em TODOS
// os 22 destinos que "cresceram" -- clusterizados quase identicos ao
// proprio deslocamento (projecao vetorial: destino muito mais longe que o
// deslocamento, delta de distancia tende ao proprio deslocamento
// independente da direcao). pct80 sozinho nao distingue "80m de
// reposicionamento perto de onde ja entregou" de um afastamento real --
// so a AMPLITUDE (quantos destinos) e' avaliada, nunca a MAGNITUDE.
// Candidato: mesma amplitude do pct80, mais um piso na mediana do
// crescimento dos destinos que contam como "cresceram" -- filtra
// deslocamento pequeno (ruido/reposicionamento) mantendo a mesma cobertura
// pra deslocamento real (que em desvio de verdade tende a ser bem maior,
// ver casos historicos SRQ-9F05 52km, 631m fora da rota).
function percentualComPisoMagnitude(pct: number, pisoMedianaM: number): CandidatoRegra {
  return (distAtualM, distAnteriorM) => {
    if (!validarEntrada(distAtualM, distAnteriorM)) return false;
    const n = distAtualM.length;
    const deltasCresceram = distAtualM
      .map((d, i) => d - distAnteriorM[i])
      .filter((delta) => delta > AFASTAMENTO_MARGEM_M);
    const minimoNecessario = n <= 3 ? n : Math.ceil(pct * n);
    if (deltasCresceram.length < minimoNecessario) return false;
    // N pequeno (<=3): identico a ALL/pct80, sem piso -- achado real
    // (primeira versao deste candidato aplicava o piso incondicional e
    // regrediu recall no segmento baixoN de 74.8% pra 71.1%/66.5%/61.5%,
    // exatamente a propriedade de seguranca contra o incidente de 06/07
    // que pct80 existe pra preservar). O piso so faz sentido pro caso que
    // motivou este candidato -- N grande e disperso, onde deslocamento
    // pequeno pode inflar a amplitude sem magnitude real.
    if (n <= AFASTAMENTO_N_PEQUENO_MAX) return true;
    const ordenado = [...deltasCresceram].sort((a, b) => a - b);
    const mediana = ordenado[Math.floor(ordenado.length / 2)];
    return mediana >= pisoMedianaM;
  };
}

export const CANDIDATOS: Map<string, CandidatoRegra> = new Map([
  ["all", all],
  ["top3", topK(3)],
  ["top5", topK(5)],
  ["top8", topK(8)],
  ["pct60", percentual(0.6)],
  ["pct80", percentual(0.8)],
  ["pct80_piso100", percentualComPisoMagnitude(0.8, 100)],
  ["pct80_piso150", percentualComPisoMagnitude(0.8, 150)],
  ["pct80_piso200", percentualComPisoMagnitude(0.8, 200)],
]);
