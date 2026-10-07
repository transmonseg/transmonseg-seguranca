// Filtro de transmissao da Central (06/10, tia Erica: "na Unitrac eu tenho a
// opcao de clicar em carros sem transmitir e carros transmitindo").
// atraso_min = minutos desde a ultima posicao recebida da Unitrac.
export type FiltroTransmissao = "todos" | "transmitindo" | "sem";

/** Mesmo corte do icone "sem comunicacao" do mapa (MapaLeafletV2). */
export const SEM_TRANSMISSAO_MIN = 60;

export function filtrarTransmissao<T extends { atraso_min: number }>(vs: T[], f: FiltroTransmissao): T[] {
  if (f === "transmitindo") return vs.filter((v) => v.atraso_min <= SEM_TRANSMISSAO_MIN);
  if (f === "sem") return vs.filter((v) => v.atraso_min > SEM_TRANSMISSAO_MIN);
  return vs;
}

export function contarTransmissao(vs: { atraso_min: number }[]): { transmitindo: number; sem: number } {
  const sem = vs.filter((v) => v.atraso_min > SEM_TRANSMISSAO_MIN).length;
  return { transmitindo: vs.length - sem, sem };
}
