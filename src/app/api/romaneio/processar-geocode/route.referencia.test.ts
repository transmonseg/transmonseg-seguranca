// GEO3-02 (auditoria 03/11): a retentativa de texto das linhas "falhou" rodava
// sem ponto de referencia (os pontos so' eram montados para as linhas
// reivindicadas no ciclo) e aceitava a primeira rua homonima do pais --
// "RUA ANTONIO PIO TEIXEIRA, MAGE" foi para MG (684 km), gravada no cache.
// Aqui a cascata e' a real; so' o banco e a rede sao falsos.
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { chaveCidade } from "@/lib/referencia-cidade";

const END_MAGE = "RUA ANTONIO PIO TEIXEIRA, - , MAGE - RJ";
const MAGE = { lat: -22.6043, lng: -43.1081 };
const MG = { lat: -18.6785, lng: -48.1692 };

let alvos: unknown[] = [];
let municipioDoPonto: string | null = null;
vi.mock("@/lib/unitrac", async (orig) => ({
  ...(await orig<typeof import("@/lib/unitrac")>()),
  buscarAlvos: vi.fn(async () => alvos),
  deveCorrigirComRomaneio: vi.fn(() => false),
}));

type Op = { metodo: string; args: unknown[] };
let chamadas: { tabela: string; ops: Op[] }[] = [];
let cache: Record<string, { lat: number; lng: number; fonte: string; validado?: boolean }> = {};
let linhasFalhou: unknown[] = [];
let veiculos: unknown[] = [];

function admin() {
  return {
    from(tabela: string) {
      const ops: Op[] = [];
      chamadas.push({ tabela, ops });
      const b: Record<string, unknown> = {};
      for (const m of ["select", "eq", "in", "lt", "or", "order", "limit", "not", "maybeSingle", "upsert", "update", "insert"]) {
        b[m] = (...args: unknown[]) => { ops.push({ metodo: m, args }); return b; };
      }
      b.then = (ok: (v: unknown) => unknown) => {
        const primeiro = ops[0]?.metodo;
        let data: unknown = primeiro === "select" ? [] : null;
        if (primeiro === "select" && tabela === "romaneio_geocode_cache") {
          const inOp = ops.find((o) => o.metodo === "in");
          const eqOp = ops.find((o) => o.metodo === "eq");
          const chaves = inOp ? (inOp.args[1] as string[]) : [eqOp!.args[1] as string];
          const rows = chaves.filter((c) => cache[c]).map((c) => ({ endereco_normalizado: c, ...cache[c] }));
          data = ops.some((o) => o.metodo === "maybeSingle") ? rows[0] ?? null : rows;
        } else if (primeiro === "select" && tabela === "romaneio_pontos") {
          // 1a: pendentes (vazio); 2a: falhou
          const n = chamadas.filter((c) => c.tabela === "romaneio_pontos" && c.ops[0]?.metodo === "select").indexOf(chamadas.find((c) => c.ops === ops)!);
          data = n === 0 ? [] : linhasFalhou;
        } else if (primeiro === "select" && tabela === "veiculos") {
          data = veiculos;
        }
        return Promise.resolve({ data, error: null }).then(ok);
      };
      return b;
    },
    rpc: vi.fn(async (nome: string) => ({ data: nome === "municipio_da_coordenada" && municipioDoPonto ? [{ municipio_codigo: municipioDoPonto }] : [], error: null })),
  };
}
vi.mock("@/lib/supabase/admin", () => ({ createAdminClient: () => admin() }));

const fetchOrig = globalThis.fetch;
const timeoutOrig = globalThis.setTimeout;
let urls: string[] = [];

beforeEach(() => {
  vi.resetModules();
  chamadas = []; cache = {}; urls = []; veiculos = []; alvos = []; municipioDoPonto = null;
  process.env.MOTOR_SECRET = "s";
  delete process.env.GOOGLE_MAPS_API_KEY;
  // throttle de 1,1 s do Photon/Nominatim sem esperar de verdade
  // so' o throttle de 1,1 s e' instantaneo; os outros prazos seguem reais
  const st = globalThis.setTimeout;
  vi.stubGlobal("setTimeout", ((fn: () => void, ms?: number) => (ms === 1100 ? (fn(), 0) : st(fn, ms))) as unknown as typeof setTimeout);
  globalThis.fetch = (async (u: string) => {
    urls.push(String(u));
    if (String(u).includes("photon")) {
      return new Response(JSON.stringify({ features: [{ geometry: { coordinates: [MG.lng, MG.lat] }, properties: { street: "Rua Antônio Pio Teixeira" } }] }), { status: 200 });
    }
    return new Response("[]", { status: 200 });
  }) as typeof fetch;
  vi.spyOn(console, "warn").mockImplementation(() => {});
});
afterEach(() => {
  globalThis.fetch = fetchOrig;
  vi.unstubAllGlobals();
  globalThis.setTimeout = timeoutOrig;
  vi.restoreAllMocks();
});

const req = () => new Request("http://l/api/romaneio/processar-geocode", { method: "POST", headers: { "x-motor-key": "s" } });
const upsertsCache = () => chamadas.filter((c) => c.tabela === "romaneio_geocode_cache" && c.ops[0]?.metodo === "upsert");
const viraramOk = () => chamadas.filter((c) => c.tabela === "romaneio_pontos" && c.ops[0]?.metodo === "update" && (c.ops[0].args[0] as { geocode_status?: string }).geocode_status === "ok");

describe("processar-geocode -- retentativa com a referencia da cidade (GEO3-02)", () => {
  it.each([
    ["orfa (sem veiculo)", null],
    ["com veiculo", "v1"],
  ])("linha %s de Mage, 0 pendentes, Photon em MG: continua falhou e o cache nao e' gravado", async (_n, veiculoId) => {
    cache[chaveCidade("MAGE")] = { ...MAGE, fonte: "nominatim" };
    linhasFalhou = [{ id: "p1", nf: "6086408", placa: "TTU9G21", veiculo_id: veiculoId, geocode_tentativas: 0, endereco_bruto: END_MAGE }];
    veiculos = veiculoId ? [{ id: veiculoId, cv: "CV1", cliente_id: "c1" }] : [];
    const { POST } = await import("./route");
    const corpo = await (await POST(req())).json();
    expect(urls.some((u) => u.includes("photon"))).toBe(true);
    expect(corpo.resolvidoViaRetentativaTexto).toBe(0);
    expect(viraramOk()).toHaveLength(0);
    expect(upsertsCache()).toHaveLength(0);
    // GEO3-11: o hit de cache de endereco le `validado` (antes todo hit virava true)
    const leituraEndereco = chamadas.find((c) => c.tabela === "romaneio_geocode_cache" && c.ops.some((o) => o.metodo === "eq"));
    expect(String(leituraEndereco?.ops[0].args[0])).toContain("validado");
  });

  it("Photon dentro de Mage: resolve pela retentativa usando a referencia lida do cache", async () => {
    cache[chaveCidade("MAGE")] = { ...MAGE, fonte: "nominatim" };
    linhasFalhou = [{ id: "p1", nf: "1", placa: "AAA0A00", veiculo_id: null, geocode_tentativas: 0, endereco_bruto: END_MAGE }];
    globalThis.fetch = (async (u: string) => String(u).includes("photon")
      ? new Response(JSON.stringify({ features: [{ geometry: { coordinates: [MAGE.lng + 0.01, MAGE.lat] }, properties: { street: "Rua Antônio Pio Teixeira" } }] }), { status: 200 })
      : new Response("[]", { status: 200 })) as typeof fetch;
    const { POST } = await import("./route");
    const corpo = await (await POST(req())).json();
    expect(corpo.resolvidoViaRetentativaTexto).toBe(1);
    expect(upsertsCache()).toHaveLength(1);
    expect(upsertsCache()[0].ops[0].args[0]).toMatchObject({ fonte: "photon", validado: true });
  });
});

// GEO3-11 (03/11): o ponto do alvo Unitrac era aprendido no cache de endereco
// sem checar o municipio, e sempre com validado=true ("RUA MARQUESA DE SANTOS,
// PARATI" -> Sao Paulo, 198 km, reusado na NF 5568799).
describe("processar-geocode -- unitrac_aprendido com o municipio conferido (GEO3-11)", () => {
  const END_PARATI = "RUA MARQUESA DE SANTOS, - VILA DOM PEDRO I, PARATI - RJ";
  const linha = { id: "p1", nf: "5568799", placa: "AAA1B23", veiculo_id: "v1", geocode_tentativas: 0, endereco_bruto: END_PARATI };
  const aprendido = () => upsertsCache().map((c) => c.ops[0].args[0] as Record<string, unknown>).find((r) => r.fonte === "unitrac_aprendido");

  it.each([
    ["fora do RJ (Sao Paulo, nenhum poligono)", { pontolatitude: -23.6055, pontolongitude: -46.6118 }, null, false],
    ["em outro municipio do RJ", { pontolatitude: -22.9, pontolongitude: -43.2 }, "3304557", false],
    ["dentro de Parati", { pontolatitude: -23.22, pontolongitude: -44.72 }, "3303807", true],
  ])("alvo %s ", async (_n, ponto, mun, esperado) => {
    linhasFalhou = [linha];
    veiculos = [{ id: "v1", cv: "CV1", cliente_id: "c1" }];
    alvos = [{ placa: linha.placa, alvodocumento: linha.nf, ...ponto }];
    municipioDoPonto = mun;
    const { POST } = await import("./route");
    const corpo = await (await POST(req())).json();
    expect(corpo.fallbackUnitrac).toBe(1);
    expect(aprendido()).toMatchObject({ lat: ponto.pontolatitude, lng: ponto.pontolongitude, validado: esperado });
  });
});

describe("processar-geocode -- falhas de rede contadas no log do ciclo (GEO3-05)", () => {
  it("Photon 429 na retentativa: 1 linha de log com a contagem por motivo", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    cache[chaveCidade("MAGE")] = { ...MAGE, fonte: "nominatim" };
    linhasFalhou = [{ id: "p1", nf: "1", placa: "AAA0A00", veiculo_id: null, geocode_tentativas: 0, endereco_bruto: END_MAGE }];
    globalThis.fetch = (async (u: string) => (String(u).includes("photon") ? new Response("", { status: 429 }) : new Response("[]", { status: 200 }))) as typeof fetch;
    const { POST } = await import("./route");
    await POST(req());
    const linhas = warn.mock.calls.map((c) => String(c[0])).filter((l) => l.includes("[geocode] erros de rede"));
    expect(linhas).toHaveLength(1);
    expect(linhas[0]).toMatch(/photon http_429=\d+/);
  });
});
