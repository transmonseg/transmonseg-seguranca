// GEO3-03 (auditoria 03/11): a ponte do KPI pulava o ponto de referencia
// quando a rua nao tinha candidato no CNEFE/OSM -- justo quando o Photon
// decide. "RUA JOSE BALBINO DA SILVA, - , PARATY - RJ" foi para PE (1.867 km).
// Cascata real; banco e rede falsos.
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { chaveCidade } from "@/lib/referencia-cidade";

const PARATY = { lat: -23.2178, lng: -44.7131 };
const PE = { lat: -7.7981, lng: -37.7944 };
let cache: Record<string, { lat: number; lng: number }> = {};

function consulta(tabela: string) {
  const b: Record<string, unknown> = {};
  let chaves: string[] | null = null;
  for (const m of ["select", "eq", "limit", "ilike", "gt", "not", "order", "maybeSingle"]) b[m] = () => b;
  b.in = (_c: string, ks: string[]) => { chaves = ks; return b; };
  b.abortSignal = () => b;
  b.then = (ok: (v: unknown) => unknown) => {
    if (tabela === "romaneio_geocode_cache" && chaves) {
      return ok({ data: chaves.filter((k) => cache[k]).map((k) => ({ endereco_normalizado: k, ...cache[k], fonte: "nominatim", validado: true })), error: null });
    }
    return ok({ data: [], error: null });
  };
  return b;
}
const admin = {
  from: (t: string) => consulta(t),
  rpc: () => { const b = { abortSignal: () => b, then: (ok: (v: unknown) => unknown) => ok({ data: [], error: null }) }; return b; },
};
vi.mock("@/lib/supabase/admin", () => ({ createAdminClient: () => admin }));

const fetchOrig = globalThis.fetch;
let urls: string[] = [];
beforeEach(() => {
  cache = {}; urls = [];
  process.env.MOTOR_SECRET = "s";
  delete process.env.GOOGLE_MAPS_API_KEY;
  // so' o throttle de 1,1 s e' instantaneo; os outros prazos seguem reais
  const st = globalThis.setTimeout;
  vi.stubGlobal("setTimeout", ((fn: () => void, ms?: number) => (ms === 1100 ? (fn(), 0) : st(fn, ms))) as unknown as typeof setTimeout);
  globalThis.fetch = (async (u: string) => {
    urls.push(String(u));
    if (String(u).includes("photon")) {
      return new Response(JSON.stringify({ features: [
        { geometry: { coordinates: [PE.lng, PE.lat] }, properties: { street: "Rua José Balbino da Silva" } },
        { geometry: { coordinates: [PARATY.lng + 0.01, PARATY.lat] }, properties: { street: "Rua José Balbino da Silva" } },
      ] }), { status: 200 });
    }
    return new Response("[]", { status: 200 });
  }) as typeof fetch;
  vi.spyOn(console, "warn").mockImplementation(() => {});
});
afterEach(() => { globalThis.fetch = fetchOrig; vi.unstubAllGlobals(); vi.restoreAllMocks(); });

const req = (enderecos: string[]) => new Request("http://l/api/romaneio/geocode", {
  method: "POST", headers: { "content-type": "application/json", "x-motor-key": "s" }, body: JSON.stringify({ enderecos }),
});

describe("ponte /api/romaneio/geocode -- referencia da cidade sempre do cache (GEO3-03)", () => {
  it("rua sem CNEFE/OSM, Photon com PE e Paraty: sai Paraty, nunca PE", async () => {
    cache[chaveCidade("Parati")] = PARATY;
    const { POST } = await import("./route");
    const corpo = await (await POST(req(["RUA JOSE BALBINO DA SILVA, - , PARATY - RJ"]))).json();
    expect(urls.some((u) => u.includes("photon"))).toBe(true);
    expect(corpo.resultados[0]).toMatchObject({ lat: PARATY.lat, lng: PARATY.lng + 0.01, fonte: "photon", validado: true });
  });

  it("sem referencia em lugar nenhum (cache e Nominatim vazios): null, Photon nao decide", async () => {
    const { POST } = await import("./route");
    const corpo = await (await POST(req(["RUA JOSE BALBINO DA SILVA, - , PARATY - RJ"]))).json();
    expect(corpo.resultados).toEqual([null]);
  });
});

// GEO3-05 (03/11): falha de rede do Photon/Nominatim era o mesmo null de
// "endereco nao existe" e o KPI gravava cache negativo de 48 h.
describe("ponte /api/romaneio/geocode -- falha de rede vai em `incompletos` (GEO3-05)", () => {
  const END = "RUA JOSE BALBINO DA SILVA, - , PARATY - RJ";
  const comPhoton = (r: () => Promise<Response>) => {
    globalThis.fetch = (async (u: string) => (String(u).includes("photon") ? r() : new Response("[]", { status: 200 }))) as typeof fetch;
  };

  it("Photon lanca TimeoutError e nada mais acha: null com o indice em `incompletos` (e em `incompletosRede`)", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    cache[chaveCidade("Parati")] = PARATY;
    comPhoton(async () => { const e = new Error("timeout"); e.name = "TimeoutError"; throw e; });
    const { POST } = await import("./route");
    const corpo = await (await POST(req(["RUA SEM PROBLEMA NENHUM, - , PARATY - RJ", END]))).json();
    expect(corpo.resultados).toEqual([null, null]);
    expect(corpo.incompletos).toEqual([0, 1]);
    expect(corpo.incompletosRede).toEqual([0, 1]);
  });

  it("Photon e Nominatim respondem normalmente sem achar: null fora de `incompletos` (KPI pode gravar o negativo)", async () => {
    cache[chaveCidade("Parati")] = PARATY;
    comPhoton(async () => new Response(JSON.stringify({ features: [] }), { status: 200 }));
    const { POST } = await import("./route");
    const corpo = await (await POST(req([END]))).json();
    expect(corpo.resultados).toEqual([null]);
    expect(corpo.incompletos).toEqual([]);
  });

  it("429 e' contado no log da requisicao", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    cache[chaveCidade("Parati")] = PARATY;
    comPhoton(async () => new Response("", { status: 429 }));
    const { POST } = await import("./route");
    const corpo = await (await POST(req([END]))).json();
    expect(corpo.incompletos).toEqual([0]);
    const linhas = warn.mock.calls.map((c) => String(c[0])).filter((l) => l.includes("[geocode] erros de rede"));
    expect(linhas).toHaveLength(1);
    expect(linhas[0]).toMatch(/photon http_429=\d+/);
  });
});
