import { describe, it, expect, vi, beforeEach } from "vitest";

let resultado: { count: number | null; error: unknown } = { count: 0, error: null };
const filtros: [string, unknown][] = [];
vi.mock("@/lib/supabase/admin", () => ({
  createAdminClient: () => ({
    from: () => {
      const q: Record<string, unknown> = {};
      q.select = () => q;
      q.eq = (c: string, v: unknown) => { filtros.push([c, v]); return q; };
      q.then = (ok: (r: unknown) => unknown) => Promise.resolve(resultado).then(ok);
      return q;
    },
  }),
}));

import { GET } from "./route";

const req = (qs: string, chave = "segredo") =>
  new Request(`http://x/api/romaneio/contagem${qs}`, { headers: { "x-motor-key": chave } });

describe("GET /api/romaneio/contagem", () => {
  beforeEach(() => { process.env.MOTOR_SECRET = "segredo"; resultado = { count: 0, error: null }; filtros.length = 0; });

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
});
