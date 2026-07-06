import { describe, it, expect } from "vitest";
import { indicesDeSaltosGrandes } from "./rastro-matching";

describe("indicesDeSaltosGrandes", () => {
  it("nao encontra saltos em pontos proximos (amostragem normal)", () => {
    const pontos = [
      { lat: -22.9000, lng: -43.2000 },
      { lat: -22.9005, lng: -43.2003 },
      { lat: -22.9010, lng: -43.2005 },
    ];
    expect(indicesDeSaltosGrandes(pontos)).toEqual([]);
  });

  it("identifica o indice do salto grande (>400m)", () => {
    const pontos = [
      { lat: -22.9000, lng: -43.2000 },
      { lat: -22.9050, lng: -43.2000 }, // ~555m ao norte
      { lat: -22.9052, lng: -43.2001 },
    ];
    expect(indicesDeSaltosGrandes(pontos)).toEqual([0]);
  });

  it("identifica multiplos saltos grandes na ordem", () => {
    const pontos = [
      { lat: -22.9000, lng: -43.2000 },
      { lat: -22.9050, lng: -43.2000 }, // salto 1: indice 0->1
      { lat: -22.9052, lng: -43.2001 }, // sem salto
      { lat: -22.9100, lng: -43.2001 }, // salto 2: indice 2->3
    ];
    expect(indicesDeSaltosGrandes(pontos)).toEqual([0, 2]);
  });

  it("lista curta (< 2 pontos) nao gera indices", () => {
    expect(indicesDeSaltosGrandes([{ lat: -22.9, lng: -43.2 }])).toEqual([]);
    expect(indicesDeSaltosGrandes([])).toEqual([]);
  });
});
