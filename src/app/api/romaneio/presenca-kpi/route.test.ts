import { describe, it, expect, vi, beforeEach } from "vitest";

const query = vi.fn();
vi.mock("pg", () => ({ default: { Pool: vi.fn(function () { return { query, end: async () => {} }; }) } }));
vi.mock("@/lib/supabase/contabo-ca", () => ({ configPoolContabo: () => ({}) }));

import { POST } from "./route";
import { horarioChegadaIso, lerEntregasKpi } from "@/lib/presenca-kpi";

const req = (body: unknown, chave = "segredo") =>
  new Request("http://x/api/romaneio/presenca-kpi", { method: "POST", headers: { "x-motor-key": chave }, body: JSON.stringify(body) });

describe("presenca vinda do KPI", () => {
  beforeEach(() => { process.env.MOTOR_SECRET = "segredo"; query.mockReset(); });

  it("sem a chave da ponte: 401 e nao grava", async () => {
    expect((await POST(req({ data: "2026-11-06", entregas: [] }, "errada"))).status).toBe(401);
    expect(query).not.toHaveBeenCalled();
  });

  it("data invalida ou sem lista: 400", async () => {
    expect((await POST(req({ data: "06/11", entregas: [] }))).status).toBe(400);
    expect((await POST(req({ data: "2026-11-06" }))).status).toBe(400);
  });

  it("grava NF + placa sem traco + chegada em Brasilia; ignora linha sem NF ou placa", async () => {
    query.mockResolvedValue({ rowCount: 1 });
    const r = await POST(req({ data: "2026-11-06", entregas: [
      { nf: "2462420", placa: "RQU-1B50", chegada: "10:15" },
      { nf: "", placa: "RQU1B50", chegada: "10:20" },
      { nf: "2462421", placa: "", chegada: "10:20" },
      { nf: "2462422", placa: "rqu1b50", chegada: null },
    ] }));
    expect(await r.json()).toEqual({ ok: true, recebidas: 2, gravadas: 1 });
    const [sql, params] = query.mock.calls[0];
    expect(sql).toContain("presenca_confirmada_em IS NULL");
    expect(sql).toContain("presenca_metodo = 'kpi'");
    expect(params[0]).toBe("2026-11-06");
    expect(JSON.parse(params[1])).toEqual([
      { nf: "2462420", placa: "RQU1B50", ts: "2026-11-06T13:15:00.000Z" },
      { nf: "2462422", placa: "RQU1B50", ts: null },
    ]);
  });

  it("lista vazia nao abre conexao", async () => {
    const r = await POST(req({ data: "2026-11-06", entregas: [] }));
    expect(await r.json()).toEqual({ ok: true, recebidas: 0, gravadas: 0 });
    expect(query).not.toHaveBeenCalled();
  });

  it("chegada no futuro vira agora; formato estranho vira null", () => {
    const agora = new Date("2026-11-06T12:00:00Z"); // 09:00 BRT
    expect(horarioChegadaIso("2026-11-06", "10:00", agora)).toBe(agora.toISOString());
    expect(horarioChegadaIso("2026-11-06", "8:00", agora)).toBeNull();
    expect(lerEntregasKpi({ data: "2026-11-06", entregas: new Array(6001).fill({}) }, agora)).toBeNull();
  });
});
