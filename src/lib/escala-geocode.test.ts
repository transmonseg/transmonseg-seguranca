import { describe, it, expect, vi } from "vitest";
import { resolverDestinoEscala, RAIO_ESCALA_M } from "./escala-geocode";

const mockDeps = (overrides: Partial<{
  geocodificarGoogleDep: (e: string) => Promise<{ lat: number; lng: number } | null>;
  geocodificarNominatimDep: (e: string) => Promise<{ lat: number; lng: number } | null>;
  buscarApelidoDep: (t: string) => Promise<string | null>;
}> = {}) => ({
  geocodificarGoogleDep: vi.fn(overrides.geocodificarGoogleDep ?? (async () => null)),
  geocodificarNominatimDep: vi.fn(overrides.geocodificarNominatimDep ?? (async () => null)),
  buscarApelidoDep: vi.fn(overrides.buscarApelidoDep ?? (async () => null)),
});

describe("resolverDestinoEscala", () => {
  it("cidade real resolve direto no Google: via=cidade, raio fixo", async () => {
    const deps = mockDeps({ geocodificarGoogleDep: async () => ({ lat: -21.75, lng: -41.32 }) });
    const r = await resolverDestinoEscala("CAMPOS", deps);
    expect(r).toEqual({ via: "cidade", lat: -21.75, lng: -41.32, raioM: RAIO_ESCALA_M });
    expect(deps.buscarApelidoDep).not.toHaveBeenCalled();
  });

  it("Google falha, Nominatim resolve: ainda via=cidade", async () => {
    const deps = mockDeps({ geocodificarNominatimDep: async () => ({ lat: -22.0, lng: -42.5 }) });
    const r = await resolverDestinoEscala("ITAPERUNA", deps);
    expect(r).toEqual({ via: "cidade", lat: -22.0, lng: -42.5, raioM: RAIO_ESCALA_M });
  });

  it("nem Google nem Nominatim reconhecem como cidade, mas ha apelido cadastrado: resolve a cidade do apelido", async () => {
    const deps = mockDeps({
      buscarApelidoDep: async (t) => (t === "JEITO CASEIRO" ? "Volta Redonda" : null),
      geocodificarGoogleDep: async (e) => (e.startsWith("Volta Redonda") ? { lat: -22.5, lng: -44.1 } : null),
    });
    const r = await resolverDestinoEscala("JEITO CASEIRO", deps);
    expect(r).toEqual({ via: "apelido", lat: -22.5, lng: -44.1, raioM: RAIO_ESCALA_M });
  });

  it("nao e cidade, nao tem apelido: nao_resolvido", async () => {
    const deps = mockDeps();
    const r = await resolverDestinoEscala("ROTA FANTASIA", deps);
    expect(r).toEqual({ via: "nao_resolvido" });
  });

  it("tem apelido mas a cidade do apelido tambem nao geocodifica: nao_resolvido", async () => {
    const deps = mockDeps({ buscarApelidoDep: async () => "Cidade Que Nao Existe" });
    const r = await resolverDestinoEscala("APELIDO QUEBRADO", deps);
    expect(r).toEqual({ via: "nao_resolvido" });
  });

  it("Google devolve coordenada fora do RJ (match ambiguo de mesmo nome em outro estado): rejeita e tenta Nominatim", async () => {
    const deps = mockDeps({
      geocodificarGoogleDep: async () => ({ lat: -10.2, lng: -48.3 }), // Tocantins, fora do RJ
      geocodificarNominatimDep: async () => ({ lat: -21.75, lng: -41.3 }), // RJ de verdade
    });
    const r = await resolverDestinoEscala("NATIVIDADE", deps);
    expect(r).toEqual({ via: "cidade", lat: -21.75, lng: -41.3, raioM: RAIO_ESCALA_M });
  });

  it("nem Google nem Nominatim caem dentro do RJ: nao_resolvido, nao aceita match de outro estado", async () => {
    const deps = mockDeps({
      geocodificarGoogleDep: async () => ({ lat: -10.2, lng: -48.3 }),
      geocodificarNominatimDep: async () => ({ lat: -10.3, lng: -48.4 }),
    });
    const r = await resolverDestinoEscala("NATIVIDADE", deps);
    expect(r).toEqual({ via: "nao_resolvido" });
  });
});
