import { describe, it, expect, beforeEach, vi } from "vitest";
import { conferirNoKpi, lerConferenciaKpi, nfConferivel, frotaKpi } from "./conferencia-kpi";

describe("conferência no KPI pela tela de entrega", () => {
  beforeEach(() => { process.env.MOTOR_SECRET = "s"; process.env.KPI_URL = "http://kpi"; });
  it("NF conferível", () => {
    expect(nfConferivel("nutrimax", "2467473")).toBe(true);
    expect(nfConferivel("nutrimax", "SEMNF-1")).toBe(false);
    expect(nfConferivel("rioquality", "RQP5I85-3")).toBe(false);
    expect(frotaKpi("x")).toBeNull();
  });
  it("posta no KPI com a chave e o responsável", async () => {
    const f = vi.fn(async () => new Response(JSON.stringify({ ok: true, conferencia: { id: 1, nf: "2467473", resolucao: "confirmada_operacao", responsavel: "e@x", criadoEm: "t", observacao: null } })));
    const r = await conferirNoKpi({ frota: "nutrimax", data: "2026-11-09", nf: "2467473", acao: "confirmar", responsavel: "e@x" }, f as unknown as typeof fetch);
    expect(r.ok).toBe(true);
    const [url, init] = f.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe("http://kpi/api/kpi/conferencia-externa");
    expect((init.headers as Record<string, string>)["x-motor-key"]).toBe("s");
    expect(JSON.parse(init.body as string)).toMatchObject({ cliente: "nutrimax", nf: "2467473", acao: "confirmar", responsavel: "e@x" });
  });
  it("erro do KPI volta com a mensagem", async () => {
    const f = vi.fn(async () => new Response(JSON.stringify({ erro: "A NF 1 não está no KPI deste dia." }), { status: 404 }));
    const r = await conferirNoKpi({ frota: "nutrimax", data: "2026-11-09", nf: "1", acao: "confirmar", responsavel: "e" }, f as unknown as typeof fetch);
    expect(r).toEqual({ ok: false, status: 404, erro: "A NF 1 não está no KPI deste dia." });
  });
  it("leitura falha vira null (tela segue)", async () => {
    const f = vi.fn(async () => { throw new Error("ECONNREFUSED"); });
    expect(await lerConferenciaKpi("nutrimax", "2026-11-09", "1", f as unknown as typeof fetch)).toBeNull();
  });
});
