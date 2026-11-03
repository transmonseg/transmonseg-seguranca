import { describe, it, expect } from "vitest";
// @ts-expect-error -- script .mjs sem tipos
import { municipioEsperadoDaChave, classificar } from "./pontos-fora-do-municipio.mjs";

const MAGE = "3302502";

describe("pontos-fora-do-municipio (G3, so' leitura)", () => {
  it("municipio esperado: endereco, CIDADE: e BAIRRO:", () => {
    expect(municipioEsperadoDaChave("RUA ANTONIO PIO TEIXEIRA, - , MAGE - RJ")).toEqual({ tipo: "endereco", municipio: MAGE });
    expect(municipioEsperadoDaChave("CIDADE:MAGÉ, RJ, BRASIL")).toEqual({ tipo: "cidade", municipio: MAGE });
    expect(municipioEsperadoDaChave("BAIRRO:CENTRO:MAGÉ, RJ, BRASIL")).toEqual({ tipo: "bairro", municipio: MAGE });
    expect(municipioEsperadoDaChave("RUA SEM CIDADE").municipio).toBeNull();
  });

  it("classifica: outro municipio, fora da malha a mais de 2 km, e o que fica de fora da lista", () => {
    expect(classificar({ tipo: "endereco", esperado: MAGE, doPonto: "3303906", distanciaM: 50_000 })).toBe("outro_municipio");
    expect(classificar({ tipo: "endereco", esperado: MAGE, doPonto: null, distanciaM: 684_000 })).toBe("fora_da_malha");
    expect(classificar({ tipo: "endereco", esperado: MAGE, doPonto: null, distanciaM: 900 })).toBeNull(); // praia/ilha
    expect(classificar({ tipo: "endereco", esperado: MAGE, doPonto: MAGE, distanciaM: 0 })).toBeNull();
    expect(classificar({ tipo: "endereco", esperado: null, doPonto: "3303906", distanciaM: null })).toBeNull();
    // bairro de referencia so' vale dentro do municipio (GEO3-04)
    expect(classificar({ tipo: "bairro", esperado: MAGE, doPonto: null, distanciaM: 300 })).toBe("fora_da_malha");
  });
});
