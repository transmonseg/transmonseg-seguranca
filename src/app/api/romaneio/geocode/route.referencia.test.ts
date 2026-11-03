// GEO3-03 (auditoria 03/11): a ponte do KPI pulava o ponto de referencia
// quando a rua nao tinha candidato no CNEFE/OSM -- justo quando o Photon
// decide. "RUA JOSE BALBINO DA SILVA, - , PARATY - RJ" foi para PE (1.867 km).
// Cascata real; banco e rede falsos.
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { chaveCidade } from "@/lib/referencia-cidade";

const PARATY = { lat: -23.2178, lng: -44.7131 };
const PE = { lat: -7.7981, lng: -37.7944 };
let cache: Record<string, { lat: number; lng: number }> = {};
let leiturasCache = 0;

function consulta(tabela: string) {
  const b: Record<string, unknown> = {};
  let chaves: string[] | null = null;
  for (const m of ["select", "eq", "limit", "ilike", "gt", "not", "order", "maybeSingle"]) b[m] = () => b;
  b.in = (_c: string, ks: string[]) => { chaves = ks; return b; };
  b.abortSignal = () => b;
  b.then = (ok: (v: unknown) => unknown) => {
    if (tabela === "romaneio_geocode_cache" && chaves) {
      leiturasCache++;
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
  cache = {}; urls = []; leiturasCache = 0;
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
