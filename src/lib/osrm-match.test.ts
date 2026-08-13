import { describe, it, expect, vi, afterEach } from "vitest";
import { corrigirPosicoesComMatch } from "./osrm-match";

function mockFetchOnce(body: unknown, ok = true) {
  vi.stubGlobal(
    "fetch",
    vi.fn().mockResolvedValue({ ok, json: async () => body })
  );
}

const PONTOS = [
  { lat: -22.649233, lng: -42.003758, timestamp: new Date("2026-08-13T14:04:12Z") },
  { lat: -22.650163, lng: -42.004082, timestamp: new Date("2026-08-13T14:08:43Z") },
  { lat: -22.648532, lng: -42.00391, timestamp: new Date("2026-08-13T14:09:48Z") },
];

describe("corrigirPosicoesComMatch", () => {
  afterEach(() => vi.unstubAllGlobals());

  it("retorna null com menos de 2 pontos (sem chamar rede)", async () => {
    const fetchSpy = vi.fn();
    vi.stubGlobal("fetch", fetchSpy);
    const r = await corrigirPosicoesComMatch([PONTOS[0]]);
    expect(r).toBeNull();
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("corrige com sucesso: pega os 2 ultimos tracepoints nao-nulos + confidence da matching certa", async () => {
    mockFetchOnce({
      code: "Ok",
      matchings: [{ confidence: 0.87 }],
      tracepoints: [
        { location: [-42.0038, -22.6493], matchings_index: 0 },
        { location: [-42.0041, -22.6502], matchings_index: 0 },
        { location: [-42.0039, -22.6485], matchings_index: 0 },
      ],
    });
    const r = await corrigirPosicoesComMatch(PONTOS);
    expect(r).toEqual({
      anterior: { lat: -22.6502, lng: -42.0041 },
      atual: { lat: -22.6485, lng: -42.0039 },
      confidence: 0.87,
    });
  });

  it("pula tracepoints nulos (outliers descartados) ao escolher os 2 ultimos", async () => {
    mockFetchOnce({
      code: "Ok",
      matchings: [{ confidence: 0.5 }],
      tracepoints: [
        { location: [-42.0038, -22.6493], matchings_index: 0 },
        { location: [-42.0041, -22.6502], matchings_index: 0 },
        null,
      ],
    });
    const r = await corrigirPosicoesComMatch(PONTOS);
    expect(r).toEqual({
      anterior: { lat: -22.6493, lng: -42.0038 },
      atual: { lat: -22.6502, lng: -42.0041 },
      confidence: 0.5,
    });
  });

  it("retorna null se a resposta HTTP nao for ok", async () => {
    mockFetchOnce({}, false);
    expect(await corrigirPosicoesComMatch(PONTOS)).toBeNull();
  });

  it("retorna null se code != Ok", async () => {
    mockFetchOnce({ code: "NoMatch" });
    expect(await corrigirPosicoesComMatch(PONTOS)).toBeNull();
  });

  it("retorna null se houver menos de 2 tracepoints nao-nulos", async () => {
    mockFetchOnce({
      code: "Ok",
      matchings: [{ confidence: 0.9 }],
      tracepoints: [null, null, { location: [-42.0039, -22.6485], matchings_index: 0 }],
    });
    expect(await corrigirPosicoesComMatch(PONTOS)).toBeNull();
  });

  it("retorna null em erro de rede (nunca lanca excecao)", async () => {
    vi.stubGlobal("fetch", vi.fn().mockRejectedValue(new Error("timeout")));
    await expect(corrigirPosicoesComMatch(PONTOS)).resolves.toBeNull();
  });
});
