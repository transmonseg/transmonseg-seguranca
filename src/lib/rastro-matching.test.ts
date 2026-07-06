import { describe, it, expect, vi, afterEach } from "vitest";
import { indicesDeSaltosGrandes, ajustarRastroParaRuas } from "./rastro-matching";

function mockOsrmRoute(distance: number) {
  return {
    ok: true,
    json: async () => ({
      code: "Ok",
      routes: [{ distance, geometry: { coordinates: [[-43.2, -22.9], [-43.201, -22.901]] } }],
    }),
  };
}

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

describe("ajustarRastroParaRuas (rejeita rota desproporcional)", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("aceita rota real quando a razao rota/reta e razoavel (~1x)", async () => {
    // ~555m de reta (mesmo par usado no teste de indicesDeSaltosGrandes)
    const pontos = [
      { lat: -22.9000, lng: -43.2000 },
      { lat: -22.9050, lng: -43.2000 },
    ];
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(mockOsrmRoute(600))); // 600/555 ~= 1.08x
    const ajustado = await ajustarRastroParaRuas(pontos);
    expect(ajustado.length).toBeGreaterThan(pontos.length);
  });

  it("rejeita e mantem a reta quando a rota e desproporcional (>2.5x) — achado real 06/07", async () => {
    const pontos = [
      { lat: -22.9000, lng: -43.2000 },
      { lat: -22.9050, lng: -43.2000 }, // reta ~555m
    ];
    // Caso real observado: reta de 555m virou rota OSRM de 7430m (13x) —
    // desenhar isso parecia um "tiro" pior que a propria reta.
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(mockOsrmRoute(7430)));
    const ajustado = await ajustarRastroParaRuas(pontos);
    expect(ajustado).toEqual(pontos);
  });
});
