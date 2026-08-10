// scripts/backtest-desvio/candidatos.ts
//
// Candidatos de regra "afastamento suficiente" pra substituir o
// afastouDeTudo atual (exige TODOS os destinos crescerem, ver
// docs/superpowers/specs/2026-08-10-afastando-tudo-harness-design.md).
// Cada candidato precisa se comportar EXATAMENTE como ALL quando N e'
// pequeno (2-3 destinos) -- senao reabre o incidente de 06/07 (motorista
// entregando pro cliente nao-mais-proximo disparando falso desvio).

const AFASTAMENTO_MARGEM_M = 50;

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
    const cresceram = distAtualM.filter((d, i) => cresceuAlemDaMargem(d, distAnteriorM[i])).length;
    const minimoNecessario = Math.ceil(pct * distAtualM.length);
    return cresceram >= minimoNecessario;
  };
}

export const CANDIDATOS: Map<string, CandidatoRegra> = new Map([
  ["all", all],
  ["top3", topK(3)],
  ["top5", topK(5)],
  ["top8", topK(8)],
  ["pct60", percentual(0.6)],
  ["pct80", percentual(0.8)],
]);
