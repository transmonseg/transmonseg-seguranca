import { describe, it, expect, vi, afterEach, beforeEach } from "vitest";
import type pg from "pg";
import { temPOIProximo, _resetarCircuitoOverpassParaTeste } from "./overpass";

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

beforeEach(() => {
  _resetarCircuitoOverpassParaTeste();
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.useRealTimers();
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
    // Achado real 30/08: a API Overpass devolve tags.total como STRING
    // (ex: "3"), nunca number -- confirmado com chamada real ao serviço.
    // Estes mocks usam string de propósito, pra não repetir o "espelho"
    // que escondeu o bug original (typeof total === "number" nunca batia
    // com o contrato real, e o teste antigo usava number, então nunca
    // pegava isso).
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ elements: [{ tags: { total: "3" } }] }),
    }));
    const { pool } = poolFalso();
    await expect(temPOIProximo(-22.9, -43.2, pool)).resolves.toBe(true);

    vi.stubGlobal("fetch", vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ elements: [{ tags: { total: "0" } }] }),
    }));
    const { pool: pool2 } = poolFalso();
    await expect(temPOIProximo(-22.9, -43.2, pool2)).resolves.toBe(false);
  });

  it("regressao real 30/08: total='0' (string) nao pode virar temPoi=true", async () => {
    // Esta é a assinatura EXATA da resposta real do Overpass pra `out
    // count;` quando não há nenhum POI: elements sempre tem 1 item (o
    // pseudo-nó de contagem), mesmo com total=0. Antes do fix, isso caía
    // no fallback `elements.length > 0` (sempre true) porque `typeof "0"
    // === "number"` é false. Prova que o fix não depende só do valor
    // numérico, mas de realmente ler o total como string.
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({
        elements: [{ type: "count", id: 0, tags: { nodes: "0", ways: "0", relations: "0", total: "0" } }],
      }),
    }));
    const { pool } = poolFalso();
    await expect(temPOIProximo(-22.9, -43.2, pool)).resolves.toBe(false);
  });

  it("cache fresco responde sem tocar na rede", async () => {
    const fetchSpy = vi.fn();
    vi.stubGlobal("fetch", fetchSpy);
    const { pool } = poolFalso([{ tem_poi: true, atualizado_em: new Date() }]);
    await expect(temPOIProximo(-22.9, -43.2, pool)).resolves.toBe(true);
    expect(fetchSpy).not.toHaveBeenCalled();
  });
});

describe("circuito do Overpass (auditoria 15/10, DM-02): fora do ar nao trava o ciclo", () => {
  it("3 falhas seguidas abrem o circuito: a 4a chamada nem toca na rede", async () => {
    const fetchSpy = vi.fn().mockRejectedValue(new Error("ETIMEDOUT"));
    vi.stubGlobal("fetch", fetchSpy);
    const { pool } = poolFalso();
    for (let i = 0; i < 3; i++) await expect(temPOIProximo(-22.9, -43.2, pool)).rejects.toThrow();
    await expect(temPOIProximo(-22.9, -43.2, pool)).rejects.toThrow(/circuito aberto/);
    expect(fetchSpy).toHaveBeenCalledTimes(3);
  });

  it("depois da pausa de 5 min volta a tentar", async () => {
    vi.useFakeTimers();
    const fetchSpy = vi.fn().mockRejectedValue(new Error("ETIMEDOUT"));
    vi.stubGlobal("fetch", fetchSpy);
    const { pool } = poolFalso();
    for (let i = 0; i < 3; i++) await expect(temPOIProximo(-22.9, -43.2, pool)).rejects.toThrow();
    vi.advanceTimersByTime(5 * 60_000 + 1);
    await expect(temPOIProximo(-22.9, -43.2, pool)).rejects.toThrow(/ETIMEDOUT/);
    expect(fetchSpy).toHaveBeenCalledTimes(4);
  });

  it("um sucesso zera a contagem de falhas", async () => {
    const ruim = vi.fn().mockRejectedValue(new Error("ETIMEDOUT"));
    const bom = vi.fn().mockResolvedValue({ ok: true, json: async () => ({ elements: [{ tags: { total: "0" } }] }) });
    const { pool } = poolFalso();
    vi.stubGlobal("fetch", ruim);
    for (let i = 0; i < 2; i++) await expect(temPOIProximo(-22.9, -43.2, pool)).rejects.toThrow();
    vi.stubGlobal("fetch", bom);
    await expect(temPOIProximo(-22.9, -43.2, pool)).resolves.toBe(false);
    vi.stubGlobal("fetch", ruim);
    for (let i = 0; i < 2; i++) await expect(temPOIProximo(-22.9, -43.2, pool)).rejects.toThrow(/ETIMEDOUT/);
  });

  it("cache fresco passa pelo circuito aberto", async () => {
    vi.stubGlobal("fetch", vi.fn().mockRejectedValue(new Error("x")));
    const { pool } = poolFalso();
    for (let i = 0; i < 3; i++) await expect(temPOIProximo(-22.9, -43.2, pool)).rejects.toThrow();
    const { pool: comCache } = poolFalso([{ tem_poi: true, atualizado_em: new Date() }]);
    await expect(temPOIProximo(-22.9, -43.2, comCache)).resolves.toBe(true);
  });
});
