// GEO3-01 (auditoria 03/11): com a chave do Google no .env e o billing
// desligado, o Google responde REQUEST_DENIED (HTTP 200, results vazio), o
// motor nunca caía no Nominatim e o rótulo "local" do veículo ficava velho.
import { describe, it, expect, vi, beforeEach } from "vitest";
import { geocodeReverso, atualizacaoDeLocais, _resetGeocodeReverso } from "./geocode-reverso";

function poolFalso() {
  const queries: { sql: string; params: unknown[] }[] = [];
  return {
    queries,
    pool: { connect: async () => ({ query: async (sql: string, params: unknown[]) => { queries.push({ sql, params }); return { rows: [] }; }, release: () => {} }) },
  };
}
const json = (corpo: unknown, status = 200) => new Response(JSON.stringify(corpo), { status });

beforeEach(() => {
  _resetGeocodeReverso();
  process.env.GOOGLE_MAPS_API_KEY = "chave";
});

describe("geocodeReverso", () => {
  it("Google REQUEST_DENIED => chama o Nominatim, devolve o rótulo e loga 'google negado'", async () => {
    const urls: string[] = [];
    const fetchF = vi.fn(async (u: string) => {
      urls.push(u);
      if (u.includes("googleapis")) return json({ status: "REQUEST_DENIED", results: [], error_message: "You must enable Billing" });
      return json({ display_name: "Avenida Brasil, Penha, Rio de Janeiro, RJ, Brasil" });
    });
    const log = vi.spyOn(console, "warn").mockImplementation(() => {});
    const { pool, queries } = poolFalso();
    const r = await geocodeReverso(-22.86, -43.52, pool, { valor: 0 }, new Map(), { fetch: fetchF, dormir: async () => {} });
    expect(r).toEqual({ status: "ok", endereco: "Avenida Brasil, Penha, Rio de Janeiro" });
    expect(urls.some((u) => u.includes("nominatim"))).toBe(true);
    expect(log).toHaveBeenCalledWith(expect.stringContaining("[geocode-reverso] google negado"));
    expect(queries.some((q) => q.sql.includes("INSERT INTO geocode_cache"))).toBe(true);
    log.mockRestore();
  });

  it("depois do negado, o Google fica desligado por um tempo (não gasta chamada a cada veículo)", async () => {
    const urls: string[] = [];
    const fetchF = vi.fn(async (u: string) => {
      urls.push(u);
      if (u.includes("googleapis")) return json({ status: "REQUEST_DENIED", results: [] });
      return json({ display_name: "Rua A, Centro, Niterói" });
    });
    vi.spyOn(console, "warn").mockImplementation(() => {});
    const { pool } = poolFalso();
    await geocodeReverso(-22.86, -43.52, pool, { valor: 0 }, new Map(), { fetch: fetchF, dormir: async () => {} });
    await geocodeReverso(-22.87, -43.53, pool, { valor: 0 }, new Map(), { fetch: fetchF, dormir: async () => {} });
    expect(urls.filter((u) => u.includes("googleapis"))).toHaveLength(1);
  });

  it("os dois falham => status 'falhou' (não 'sem orçamento')", async () => {
    const fetchF = vi.fn(async (u: string) => (u.includes("googleapis") ? json({ status: "REQUEST_DENIED", results: [] }) : json({}, 503)));
    vi.spyOn(console, "warn").mockImplementation(() => {});
    const { pool } = poolFalso();
    const r = await geocodeReverso(-22.86, -43.52, pool, { valor: 0 }, new Map(), { fetch: fetchF, dormir: async () => {} });
    expect(r).toEqual({ status: "falhou" });
  });

  it("orçamento do ciclo esgotado => 'sem_orcamento' sem chamar rede", async () => {
    const fetchF = vi.fn();
    const { pool } = poolFalso();
    const r = await geocodeReverso(-22.86, -43.52, pool, { valor: 999 }, new Map(), { fetch: fetchF, dormir: async () => {} });
    expect(r).toEqual({ status: "sem_orcamento" });
    expect(fetchF).not.toHaveBeenCalled();
  });

  it("Nominatim respeita 1 req/s (espera entre chamadas)", async () => {
    delete process.env.GOOGLE_MAPS_API_KEY;
    let relogio = 1_000_000;
    const esperas: number[] = [];
    const fetchF = vi.fn(async () => json({ display_name: "Rua B, Bairro, Cidade" }));
    const { pool } = poolFalso();
    const deps = { fetch: fetchF, agora: () => relogio, dormir: async (ms: number) => { esperas.push(ms); relogio += ms; } };
    await geocodeReverso(-22.1, -43.1, pool, { valor: 0 }, new Map(), deps);
    await geocodeReverso(-22.2, -43.2, pool, { valor: 0 }, new Map(), deps);
    expect(esperas.at(-1)).toBeGreaterThanOrEqual(1000);
  });
});

describe("atualizacaoDeLocais", () => {
  it("ok grava o rótulo; falhou limpa o rótulo velho (null); sem orçamento não mexe", () => {
    const u = atualizacaoDeLocais([
      { veiculo_id: "a", r: { status: "ok", endereco: "Rua X, Bairro" } },
      { veiculo_id: "b", r: { status: "falhou" } },
      { veiculo_id: "c", r: { status: "sem_orcamento" } },
    ]);
    expect(u).toEqual({ veiculoIds: ["a", "b"], locais: ["Rua X, Bairro", null] });
  });
});
