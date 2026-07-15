import { describe, it, expect, vi } from "vitest";
import { normalizarEndereco, geocodificarEndereco } from "./romaneio-geocode";

describe("normalizarEndereco", () => {
  it("maiuscula, sem espacos duplicados, sem espaco nas pontas", () => {
    expect(normalizarEndereco("  rua  teste,  10 - centro  ")).toBe("RUA TESTE, 10 - CENTRO");
  });
});

describe("geocodificarEndereco (fallback: cache -> google -> nominatim -- SEM fallback pra Unitrac de proposito, ver achado real 15/07)", () => {
  const mockDeps = (overrides: Partial<{
    buscarCache: () => Promise<{ lat: number; lng: number; fonte: string } | null>;
    salvarCache: () => Promise<void>;
    geocodificarGoogle: () => Promise<{ lat: number; lng: number } | null>;
    geocodificarNominatim: () => Promise<{ lat: number; lng: number } | null>;
  }> = {}) => ({
    buscarCache: vi.fn(overrides.buscarCache ?? (async () => null)),
    salvarCache: vi.fn(overrides.salvarCache ?? (async () => {})),
    geocodificarGoogle: vi.fn(overrides.geocodificarGoogle ?? (async () => null)),
    geocodificarNominatim: vi.fn(overrides.geocodificarNominatim ?? (async () => null)),
  });

  it("cache hit: nao chama nenhuma API", async () => {
    const deps = mockDeps({ buscarCache: async () => ({ lat: 1, lng: 2, fonte: "google" }) });
    const r = await geocodificarEndereco("Rua X, 1", deps);
    expect(r).toEqual({ lat: 1, lng: 2, fonte: "google" });
    expect(deps.geocodificarGoogle).not.toHaveBeenCalled();
    expect(deps.geocodificarNominatim).not.toHaveBeenCalled();
  });

  it("cache miss, Google funciona: usa Google e salva no cache", async () => {
    const deps = mockDeps({ geocodificarGoogle: async () => ({ lat: 3, lng: 4 }) });
    const r = await geocodificarEndereco("Rua X, 1", deps);
    expect(r).toEqual({ lat: 3, lng: 4, fonte: "google" });
    expect(deps.salvarCache).toHaveBeenCalledWith(expect.any(String), { lat: 3, lng: 4, fonte: "google" });
    expect(deps.geocodificarNominatim).not.toHaveBeenCalled();
  });

  it("Google falha, Nominatim funciona: usa Nominatim e salva no cache", async () => {
    const deps = mockDeps({ geocodificarNominatim: async () => ({ lat: 5, lng: 6 }) });
    const r = await geocodificarEndereco("Rua X, 1", deps);
    expect(r).toEqual({ lat: 5, lng: 6, fonte: "nominatim" });
  });

  it("Google e Nominatim falham: null (NUNCA cai pra coordenada da Unitrac -- decisao explicita do usuario, o ponto todo do romaneio e nao reusar coordenada que pode estar errada)", async () => {
    const deps = mockDeps();
    const r = await geocodificarEndereco("Rua X, 1", deps);
    expect(r).toBeNull();
  });
});
