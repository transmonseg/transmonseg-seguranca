import { describe, it, expect, vi, beforeEach } from "vitest";

const estado = vi.hoisted(() => ({ update: null as null | Record<string, unknown>, filtros: [] as unknown[] }));
vi.mock("@/lib/supabase/admin", () => ({
  createAdminClient: () => ({
    from: (t: string) => {
      if (t === "veiculos") return { select: async () => ({ data: [{ id: "v1", placa: "TTK-8A87" }, { id: "v2", placa: "RQR-2G85" }], error: null }) };
      const q = {
        update: (u: Record<string, unknown>) => { estado.update = u; return q; },
        eq: (...a: unknown[]) => { estado.filtros.push(["eq", ...a]); return q; },
        in: (...a: unknown[]) => { estado.filtros.push(["in", ...a]); return q; },
        select: async () => ({ data: [{ id: 1 }, { id: 2 }], error: null }),
      };
      return q;
    },
  }),
}));

import { POST } from "./route";

const req = (body: unknown, chave = "segredo") => new Request("http://x/api/romaneio/trocar-veiculo", { method: "POST", headers: { "x-motor-key": chave }, body: JSON.stringify(body) });

describe("POST /api/romaneio/trocar-veiculo", () => {
  beforeEach(() => { process.env.MOTOR_SECRET = "segredo"; estado.update = null; estado.filtros = []; });

  it("sem a chave da ponte: 401", async () => {
    expect((await POST(req({}, "errada"))).status).toBe(401);
  });

  it("troca as entregas do dia do carro da escala pro carro real (placas sem traco tambem)", async () => {
    const r = await POST(req({ data: "2026-10-06", placaDe: "TTK8A87", placaPara: "RQR2G85" }));
    expect(await r.json()).toEqual({ ok: true, pontos: 2, para: "RQR-2G85" });
    expect(estado.update).toEqual({ veiculo_id: "v2", placa: "RQR-2G85" });
    expect(estado.filtros).toContainEqual(["eq", "romaneio_data", "2026-10-06"]);
    expect(estado.filtros).toContainEqual(["in", "placa", ["TTK-8A87", "TTK8A87"]]);
  });

  it("placa nova fora da frota: 404", async () => {
    expect((await POST(req({ data: "2026-10-06", placaDe: "TTK8A87", placaPara: "AAA0000" }))).status).toBe(404);
  });

  it("com nfs (troca mutua 07/10): so' as notas da carga mudam de carro", async () => {
    const r = await POST(req({ data: "2026-10-07", placaDe: "TTK8A87", placaPara: "RQR2G85", nfs: ["2410175", "2410176"] }));
    expect((await r.json()).ok).toBe(true);
    expect(estado.filtros).toContainEqual(["in", "nf", ["2410175", "2410176"]]);
  });

  it("sem nfs: troca a placa inteira (sem filtro de nota)", async () => {
    await POST(req({ data: "2026-10-07", placaDe: "TTK8A87", placaPara: "RQR2G85" }));
    expect(estado.filtros.some((f) => Array.isArray(f) && f[1] === "nf")).toBe(false);
  });

  it("nfs vazio: 400 (nao vira troca da placa inteira por engano)", async () => {
    expect((await POST(req({ data: "2026-10-07", placaDe: "TTK8A87", placaPara: "RQR2G85", nfs: [] }))).status).toBe(400);
  });
});
