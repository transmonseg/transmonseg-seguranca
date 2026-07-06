import { describe, it, expect } from "vitest";
import { celulaDe, vizinhanca3x3, celulasDoSegmento } from "./celulas";

describe("celulaDe", () => {
  it("arredonda lat/lng a 3 casas (celula ~100m)", () => {
    expect(celulaDe(-22.9123, -43.2456)).toBe("-22912:-43246");
  });
  it("pontos a menos de ~50m caem na mesma celula", () => {
    expect(celulaDe(-22.91231, -43.24558)).toBe(celulaDe(-22.91234, -43.24561));
  });
});

describe("vizinhanca3x3", () => {
  it("retorna 9 celulas incluindo a central", () => {
    const viz = vizinhanca3x3(-22.9123, -43.2456);
    expect(viz).toHaveLength(9);
    expect(viz).toContain("-22912:-43246");
    expect(viz).toContain("-22911:-43245");
    expect(viz).toContain("-22913:-43247");
  });
});

describe("celulasDoSegmento", () => {
  it("interpola celulas contiguas ao longo do segmento (sem buracos)", () => {
    // ~1,1km na latitude: a 70km/h e amostra de 1min isso e um salto tipico
    const celulas = celulasDoSegmento(-22.9, -43.2, -22.91, -43.2);
    expect(celulas.length).toBeGreaterThanOrEqual(10);
    expect(celulas).toContain(celulaDe(-22.9, -43.2));
    expect(celulas).toContain(celulaDe(-22.91, -43.2));
    expect(celulas).toContain(celulaDe(-22.905, -43.2));
  });
  it("nao interpola teleporte (segmento > 2,5km): so a celula do destino", () => {
    const celulas = celulasDoSegmento(-22.9, -43.2, -22.95, -43.2); // ~5,5km
    expect(celulas).toEqual([celulaDe(-22.95, -43.2)]);
  });
  it("mesmo ponto retorna uma unica celula", () => {
    expect(celulasDoSegmento(-22.9, -43.2, -22.9, -43.2)).toEqual([celulaDe(-22.9, -43.2)]);
  });
});
