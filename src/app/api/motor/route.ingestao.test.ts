// RAS-05 (auditoria 03/11): HTTP 200 sem `Posicoes` de UM cliente derrubava o
// ciclo de TODOS (TypeError fora do try por cliente, antes do upsert). Teste
// do ciclo inteiro com banco e rede falsos e permissivos: tudo que não é o
// caminho em teste responde vazio.
import { describe, it, expect, vi, beforeEach } from "vitest";

const estado = vi.hoisted(() => ({ sqls: [] as { sql: string; params: unknown[] }[], latB: "-22.9", lngB: "-43.2" }));

vi.mock("pg", () => {
  const query = vi.fn(async (sql: string, params: unknown[] = []) => {
    estado.sqls.push({ sql, params });
    if (/update motor_lease/i.test(sql) && /returning token/i.test(sql)) return { rows: [{ token: "t" }], rowCount: 1 };
    return { rows: [], rowCount: 0 };
  });
  return {
    default: {
      Pool: vi.fn().mockImplementation(function () {
        return { connect: async () => ({ query, release: () => {} }), query, end: async () => {}, on: () => {} };
      }),
    },
  };
});

// supabase-js falso: toda consulta é encadeável e resolve vazia, menos clientes e veículos.
function consulta(tabela: string) {
  const filtros: Record<string, unknown> = {};
  const resultado = () => {
    if (tabela === "clientes") return { data: [{ id: "cli-A", cod_user_unitrac: "1" }, { id: "cli-B", cod_user_unitrac: "2" }], error: null };
    if (tabela === "veiculos") {
      const cli = filtros.cliente_id;
      if (cli === "cli-A") return { data: [{ id: "vei-A", cv: "100", grupo: null }], error: null };
      if (cli === "cli-B") return { data: [{ id: "vei-B", cv: "200", grupo: null }], error: null };
      return { data: [], error: null };
    }
    return { data: [], error: null, count: 0 };
  };
  const p: Record<string, unknown> = {};
  const proxy: unknown = new Proxy(p, {
    get(_t, prop) {
      if (prop === "then") return (ok: (v: unknown) => unknown, ko: (e: unknown) => unknown) => Promise.resolve(resultado()).then(ok, ko);
      if (prop === "maybeSingle" || prop === "single") return async () => ({ data: null, error: null });
      if (prop === "eq") return (col: string, val: unknown) => { filtros[col] = val; return proxy; };
      return () => proxy;
    },
  });
  return proxy;
}
vi.mock("@/lib/supabase/admin", () => ({ createAdminClient: () => ({ from: (t: string) => consulta(t), rpc: async () => ({ data: null, error: null }) }) }));
vi.mock("@/lib/supabase/contabo-ca", async (orig) => ({ ...(await orig<Record<string, unknown>>()), configPoolContabo: () => ({}) }));

const fetchFalso = vi.fn(async (url: string, init?: { body?: string }) => {
  if (String(url).includes("/mapa_servicos/posicoes/")) {
    const cvs = JSON.parse(init?.body ?? "[]") as string[];
    if (cvs.includes("100")) return new Response(JSON.stringify({}), { status: 200 }); // cliente A: resposta sem Posicoes
    return new Response(JSON.stringify({ Posicoes: [{
      veicucodigo: "200", veicuplaca: "BBB1B11", posiclatitude: estado.latB, posiclongitude: estado.lngB,
      posicvelocidade: "30", posicignicao: "1", atraso: "0", datagps: "03/11/2026 14:00:00",
    }] }), { status: 200 });
  }
  if (String(url).includes("/mapa_servicos/alvos")) return new Response(JSON.stringify([]), { status: 200 });
  throw new Error("rede desligada no teste");
});

beforeEach(() => {
  estado.sqls = []; estado.latB = "-22.9"; estado.lngB = "-43.2";
  process.env.MOTOR_SECRET = "s";
  vi.stubGlobal("fetch", fetchFalso);
  vi.spyOn(console, "error").mockImplementation(() => {});
  vi.spyOn(console, "warn").mockImplementation(() => {});
  vi.spyOn(console, "log").mockImplementation(() => {});
});

describe("motor: um cliente com resposta ruim não derruba os outros", () => {
  it("resposta {} do cliente A => posição do cliente B é gravada e o erro do A aparece", async () => {
    const { POST } = await import("./route");
    const r = await POST(new Request("http://x/api/motor", { method: "POST", headers: { "x-motor-key": "s" } }));
    const corpo = await r.json();
    const upsert = estado.sqls.find((q) => /INSERT INTO posicoes_atuais/i.test(q.sql));
    expect(upsert, JSON.stringify(corpo).slice(0, 500)).toBeDefined();
    expect(upsert!.params[0]).toEqual(["vei-B"]);
    expect(upsert!.sql).toContain("EXCLUDED.datagps >= posicoes_atuais.datagps");
    expect(corpo.erros.join(" ")).toMatch(/cli-A.*sem lista Posicoes/);
  });

  it("leitura 0,0 do cliente B é descartada e contada, nada vai para posicoes_atuais", async () => {
    estado.latB = "0"; estado.lngB = "0";
    const { POST } = await import("./route");
    const r = await POST(new Request("http://x/api/motor", { method: "POST", headers: { "x-motor-key": "s" } }));
    const corpo = await r.json();
    expect(estado.sqls.find((q) => /INSERT INTO posicoes_atuais/i.test(q.sql))).toBeUndefined();
    expect(corpo.leiturasDescartadas).toBe(1);
  });
});
