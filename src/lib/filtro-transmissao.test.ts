import { describe, it, expect } from "vitest";
import { filtrarTransmissao, contarTransmissao } from "@/lib/filtro-transmissao";

// RAS-04 (03/11): mesmo critério do estadoSinal -- "transmitindo" = atual ou
// atrasado (até 30 min, efetivo); "sem" = sem sinal (> 30 min) ou desconhecido.
const v = (cv: string, atraso_min: number, atraso_efetivo_min?: number | null) => ({ cv, atraso_min, atraso_efetivo_min });
const frota = [v("a", 1), v("b", 29), v("c", 31), v("d", 2000), v("e", 0, 45)];

describe("filtro de transmissao (06/10, tia Erica: igual a Unitrac, carros transmitindo / sem transmitir)", () => {
  it("todos / transmitindo / sem transmissao", () => {
    expect(filtrarTransmissao(frota, "todos").map((x) => x.cv)).toEqual(["a", "b", "c", "d", "e"]);
    expect(filtrarTransmissao(frota, "transmitindo").map((x) => x.cv)).toEqual(["a", "b"]);
    expect(filtrarTransmissao(frota, "sem").map((x) => x.cv)).toEqual(["c", "d", "e"]);
  });
  it("posição congelada (atraso_min 0, efetivo 45) conta como sem transmissão", () => {
    expect(filtrarTransmissao([v("x", 0, 45)], "transmitindo")).toEqual([]);
  });
  it("contagem pros botoes", () => expect(contarTransmissao(frota)).toEqual({ transmitindo: 2, sem: 3 }));
});
