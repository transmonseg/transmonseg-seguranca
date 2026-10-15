import { describe, it, expect, vi, beforeEach } from "vitest";

let resultado: { count: number | null; error: unknown } = { count: 0, error: null };
const filtros: [string, unknown][] = [];
const filtrosCliente: [string, unknown][] = [];
let colunasSelecionadas = "";
let clienteDoCod: { id: string } | null = { id: "cli-nutry" };
vi.mock("@/lib/supabase/admin", () => ({
  createAdminClient: () => ({
    from: (tabela: string) => {
      const q: Record<string, unknown> = {};
      const ehClientes = tabela === "clientes";
      q.select = (cols: string) => { if (!ehClientes) colunasSelecionadas = cols; return q; };
      q.eq = (c: string, v: unknown) => { (ehClientes ? filtrosCliente : filtros).push([c, v]); return q; };
      q.maybeSingle = async () => ({ data: clienteDoCod, error: null });
      q.then = (ok: (r: unknown) => unknown) => Promise.resolve(resultado).then(ok);
      return q;
    },
  }),
}));

import { GET } from "./route";

const req = (qs: string, chave = "segredo") =>
  new Request(`http://x/api/romaneio/contagem${qs}`, { headers: { "x-motor-key": chave } });

describe("GET /api/romaneio/contagem", () => {
  beforeEach(() => {
    process.env.MOTOR_SECRET = "segredo"; resultado = { count: 0, error: null };
    filtros.length = 0; filtrosCliente.length = 0; colunasSelecionadas = ""; clienteDoCod = { id: "cli-nutry" };
  });

  it("sem a chave da ponte: 401", async () => {
    expect((await GET(req("?data=2026-10-10", "errada"))).status).toBe(401);
  });

  it("data ausente ou invalida: 400", async () => {
    expect((await GET(req(""))).status).toBe(400);
    expect((await GET(req("?data=10/10"))).status).toBe(400);
  });

  it("devolve {data, linhas} so' do modo real e origem romaneio", async () => {
    resultado = { count: 42, error: null };
    const r = await GET(req("?data=2026-10-10"));
    expect(await r.json()).toEqual({ data: "2026-10-10", linhas: 42 });
    expect(filtros).toEqual([["romaneio_data", "2026-10-10"], ["modo_teste", false], ["origem", "romaneio"]]);
  });

  it("erro de consulta: 500, nunca zero", async () => {
    resultado = { count: null, error: { message: "x" } };
    expect((await GET(req("?data=2026-10-10"))).status).toBe(500);
  });

  // KP-04 (auditoria 15/10): a contagem somava Nutry + Rio Quality, entao o
  // reparo e o aviso diario nunca viam a Nutry sem romaneio.
  it("sem cod: conta o dia inteiro como antes (KPI antigo continua funcionando)", async () => {
    resultado = { count: 7, error: null };
    await GET(req("?data=2026-10-15"));
    expect(colunasSelecionadas).toBe("id");
    expect(filtros.some(([c]) => c === "veiculos.cliente_id")).toBe(false);
  });

  it("com cod: conta so' as linhas de veiculos do cliente", async () => {
    resultado = { count: 5, error: null };
    const r = await GET(req("?data=2026-10-15&cod=4096"));
    expect(await r.json()).toEqual({ data: "2026-10-15", linhas: 5 });
    expect(colunasSelecionadas).toContain("veiculos!inner");
    expect(filtrosCliente).toContainEqual(["cod_user_unitrac", "4096"]);
    expect(filtros).toContainEqual(["veiculos.cliente_id", "cli-nutry"]);
  });

  it("cod desconhecido: 404, nunca conta o dia inteiro", async () => {
    clienteDoCod = null;
    expect((await GET(req("?data=2026-10-15&cod=9999"))).status).toBe(404);
  });

  it("cod malformado: 400", async () => {
    expect((await GET(req("?data=2026-10-15&cod=abc"))).status).toBe(400);
  });
});
