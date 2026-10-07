import { describe, it, expect } from "vitest";
import { filtrarTransmissao, contarTransmissao, SEM_TRANSMISSAO_MIN } from "@/lib/filtro-transmissao";

const v = (cv: string, atraso_min: number) => ({ cv, atraso_min });
const frota = [v("a", 1), v("b", 59), v("c", 61), v("d", 2000)];

describe("filtro de transmissao (06/10, tia Erica: igual a Unitrac, carros transmitindo / sem transmitir)", () => {
  it("corte de 60 min, o mesmo do icone de sem comunicacao", () => expect(SEM_TRANSMISSAO_MIN).toBe(60));
  it("todos / transmitindo / sem transmissao", () => {
    expect(filtrarTransmissao(frota, "todos").map((x) => x.cv)).toEqual(["a", "b", "c", "d"]);
    expect(filtrarTransmissao(frota, "transmitindo").map((x) => x.cv)).toEqual(["a", "b"]);
    expect(filtrarTransmissao(frota, "sem").map((x) => x.cv)).toEqual(["c", "d"]);
  });
  it("contagem pros botoes", () => expect(contarTransmissao(frota)).toEqual({ transmitindo: 2, sem: 2 }));
});
