// Filtro de transmissao da Central (06/10, tia Erica: "na Unitrac eu tenho a
// opcao de clicar em carros sem transmitir e carros transmitindo").
// RAS-04 (03/11): mesmo critério do estadoSinal (@/lib/estado-sinal), sobre o
// atraso efetivo do /api/mapa. "Transmitindo" = atual ou atrasado (até 30
// min); "sem" = sem sinal ou sem posição.
import { estadoDoVeiculo } from "@/lib/estado-sinal";

export type FiltroTransmissao = "todos" | "transmitindo" | "sem";

type ComAtraso = { atraso_min: number | null; atraso_efetivo_min?: number | null };

function semTransmissao(v: ComAtraso): boolean {
  const e = estadoDoVeiculo(v);
  return e === "sem_sinal" || e === "desconhecido";
}

export function filtrarTransmissao<T extends ComAtraso>(vs: T[], f: FiltroTransmissao): T[] {
  if (f === "transmitindo") return vs.filter((v) => !semTransmissao(v));
  if (f === "sem") return vs.filter(semTransmissao);
  return vs;
}

export function contarTransmissao(vs: ComAtraso[]): { transmitindo: number; sem: number } {
  const sem = vs.filter(semTransmissao).length;
  return { transmitindo: vs.length - sem, sem };
}
