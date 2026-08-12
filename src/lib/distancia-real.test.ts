import { describe, it, expect, vi, afterEach } from "vitest";
import { buscarDistanciasReais } from "./distancia-real";

describe("buscarDistanciasReais", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("retorna array vazio sem chamar a rede quando não há destinos", async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    const r = await buscarDistanciasReais({ lat: -22.9, lng: -43.2 }, []);
    expect(r).toEqual([]);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("retorna as distâncias reais quando o OSRM responde Ok", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue({
        ok: true,
        json: async () => ({ code: "Ok", distances: [[1200, 800]] }),
      })
    );
    const r = await buscarDistanciasReais(
      { lat: -22.9, lng: -43.2 },
      [{ lat: -22.91, lng: -43.21 }, { lat: -22.92, lng: -43.22 }]
    );
    expect(r).toEqual([1200, 800]);
  });

  it("retorna null se o OSRM responder HTTP não-ok", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue({ ok: false }));
    const r = await buscarDistanciasReais({ lat: -22.9, lng: -43.2 }, [{ lat: -22.91, lng: -43.21 }]);
    expect(r).toBeNull();
  });

  it("retorna null se code !== 'Ok'", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue({ ok: true, json: async () => ({ code: "NoRoute" }) })
    );
    const r = await buscarDistanciasReais({ lat: -22.9, lng: -43.2 }, [{ lat: -22.91, lng: -43.21 }]);
    expect(r).toBeNull();
  });

  it("retorna null se alguma distância vier null (destino inalcançável)", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue({ ok: true, json: async () => ({ code: "Ok", distances: [[1200, null]] }) })
    );
    const r = await buscarDistanciasReais(
      { lat: -22.9, lng: -43.2 },
      [{ lat: -22.91, lng: -43.21 }, { lat: -22.92, lng: -43.22 }]
    );
    expect(r).toBeNull();
  });

  it("retorna null se o fetch lançar (rede fora do ar)", async () => {
    vi.stubGlobal("fetch", vi.fn().mockRejectedValue(new Error("ECONNREFUSED")));
    const r = await buscarDistanciasReais({ lat: -22.9, lng: -43.2 }, [{ lat: -22.91, lng: -43.21 }]);
    expect(r).toBeNull();
  });
});
