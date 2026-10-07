// 06/10: token do Fogo Cruzado derrubado por outro login deixava a camada de
// tiroteios vazia por ate' 55 min. Com 401, pede token novo e tenta de novo.
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

describe("buscarTiroteiosRJ -- token derrubado", () => {
  beforeEach(() => {
    vi.resetModules();
    process.env.FOGO_CRUZADO_EMAIL = "x@y";
    process.env.FOGO_CRUZADO_SENHA = "s";
  });
  afterEach(() => vi.unstubAllGlobals());

  it("401 na consulta: faz login de novo e devolve os tiroteios", async () => {
    let logins = 0;
    vi.stubGlobal("fetch", vi.fn(async (url: string, init?: { headers?: Record<string, string> }) => {
      if (url.endsWith("/auth/login")) { logins++; return new Response(JSON.stringify({ data: { accessToken: `tok${logins}` } }), { status: 200 }); }
      if (init?.headers?.authorization === "Bearer tok1") return new Response("", { status: 401 });
      return new Response(JSON.stringify({ data: [{ latitude: "-22.9", longitude: "-43.2", date: new Date().toISOString(), neighborhood: { name: "CENTRO" }, city: { name: "Rio de Janeiro" } }], pageMeta: { hasNextPage: false } }), { status: 200 });
    }));
    const { buscarTiroteiosRJ } = await import("./fogocruzado");
    const t = await buscarTiroteiosRJ(1);
    expect(logins).toBe(2);
    expect(t).toHaveLength(1);
    expect(t[0].bairro).toBe("CENTRO");
  });

  it("consulta falhando sem nada guardado: devolve vazio sem guardar a falha", async () => {
    let consultas = 0;
    vi.stubGlobal("fetch", vi.fn(async (url: string) => {
      if (url.endsWith("/auth/login")) return new Response(JSON.stringify({ data: { accessToken: "tok" } }), { status: 200 });
      consultas++;
      return consultas === 1 ? new Response("", { status: 500 }) : new Response(JSON.stringify({ data: [{ latitude: "-22.9", longitude: "-43.2", date: new Date().toISOString() }], pageMeta: {} }), { status: 200 });
    }));
    const { buscarTiroteiosRJ } = await import("./fogocruzado");
    expect(await buscarTiroteiosRJ(1)).toHaveLength(0);
    expect(await buscarTiroteiosRJ(1)).toHaveLength(1);
  });
});
