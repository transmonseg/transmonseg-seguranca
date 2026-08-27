import { describe, it, expect, vi, afterEach } from "vitest";
import type pg from "pg";
import { temPOIProximo } from "./overpass";

// Pool falso: cache sempre vazio (forca a consulta ao Overpass) e INSERT
// no-op. `queries` guarda o SQL executado pra provar que uma falha de rede
// NAO grava um veredito falso no poi_cache (o cache tem 7 dias de validade --
// gravar "nao tem POI" por causa de um timeout envenenaria a decisao por uma
// semana inteira).
function poolFalso(cacheRows: { tem_poi: boolean; atualizado_em: Date }[] = []) {
  const queries: string[] = [];
  const pool = {
    connect: async () => ({
      query: async (sql: string) => {
        queries.push(sql);
        return { rows: sql.includes("SELECT") ? cacheRows : [] };
      },
      release: () => {},
    }),
  } as unknown as pg.Pool;
  return { pool, queries };
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("temPOIProximo -- contrato de falha (achado I3 da revisao final de branch)", () => {
  it("falha de rede/timeout do fetch LANCA, nunca devolve false", async () => {
    vi.stubGlobal("fetch", vi.fn().mockRejectedValue(new Error("ETIMEDOUT")));
    const { pool } = poolFalso();
    await expect(temPOIProximo(-22.9, -43.2, pool)).rejects.toThrow(/Overpass indisponivel/);
  });

  it("HTTP de erro (429 rate limit, 504) LANCA -- nao e veredito 'sem POI'", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue({ ok: false, status: 429 }));
    const { pool } = poolFalso();
    await expect(temPOIProximo(-22.9, -43.2, pool)).rejects.toThrow(/HTTP 429/);
  });

  it("corpo invalido (JSON quebrado) LANCA", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue({
      ok: true,
      json: async () => { throw new Error("Unexpected token <"); },
    }));
    const { pool } = poolFalso();
    await expect(temPOIProximo(-22.9, -43.2, pool)).rejects.toThrow(/corpo invalido/);
  });

  it("falha de rede NAO grava veredito no poi_cache", async () => {
    vi.stubGlobal("fetch", vi.fn().mockRejectedValue(new Error("ECONNRESET")));
    const { pool, queries } = poolFalso();
    await expect(temPOIProximo(-22.9, -43.2, pool)).rejects.toThrow();
    expect(queries.some((q) => q.includes("INSERT INTO poi_cache"))).toBe(false);
  });

  it("resposta boa continua devolvendo veredito normal (sem regressao)", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ elements: [{ tags: { total: 3 } }] }),
    }));
    const { pool } = poolFalso();
    await expect(temPOIProximo(-22.9, -43.2, pool)).resolves.toBe(true);

    vi.stubGlobal("fetch", vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ elements: [{ tags: { total: 0 } }] }),
    }));
    const { pool: pool2 } = poolFalso();
    await expect(temPOIProximo(-22.9, -43.2, pool2)).resolves.toBe(false);
  });

  it("cache fresco responde sem tocar na rede", async () => {
    const fetchSpy = vi.fn();
    vi.stubGlobal("fetch", fetchSpy);
    const { pool } = poolFalso([{ tem_poi: true, atualizado_em: new Date() }]);
    await expect(temPOIProximo(-22.9, -43.2, pool)).resolves.toBe(true);
    expect(fetchSpy).not.toHaveBeenCalled();
  });
});
