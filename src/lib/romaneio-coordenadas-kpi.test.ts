import { describe, it, expect } from "vitest";
import { lerCoordenadasKpi, coordenadaDoKpi } from "./romaneio-coordenadas-kpi";

describe("coordenadas do KPI no upload da Nutry (GEO3-08)", () => {
  it("casa pela placa compacta e pela NF", () => {
    const m = lerCoordenadasKpi(JSON.stringify([{ placa: "RBI1E10", nf: "123", lat: -22.9, lng: -43.2 }]));
    expect(coordenadaDoKpi(m, "RBI-1E10", "123")).toEqual({ lat: -22.9, lng: -43.2 });
    expect(coordenadaDoKpi(m, "RBI-1E10", "124")).toBeNull();
  });
  it("descarta 0,0, fora do Brasil, NaN e NF vazia", () => {
    const m = lerCoordenadasKpi(JSON.stringify([
      { placa: "AAA1A11", nf: "1", lat: 0, lng: 0 },
      { placa: "AAA1A11", nf: "2", lat: 48.8, lng: 2.3 },
      { placa: "AAA1A11", nf: "3", lat: "x", lng: -43 },
      { placa: "AAA1A11", nf: " ", lat: -22.9, lng: -43.2 },
    ]));
    expect(m.size).toBe(0);
  });
  it("campo ausente ou JSON quebrado = mapa vazio (geocodifica como antes)", () => {
    expect(lerCoordenadasKpi(null).size).toBe(0);
    expect(lerCoordenadasKpi("{nao e json").size).toBe(0);
    expect(lerCoordenadasKpi(JSON.stringify({ a: 1 })).size).toBe(0);
  });
});
