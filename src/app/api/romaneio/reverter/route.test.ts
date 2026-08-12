import { describe, it, expect, vi, beforeEach } from "vitest";

const mockGetUser = vi.fn();
vi.mock("@/lib/supabase/server", () => ({
  createClient: async () => ({ auth: { getUser: mockGetUser } }),
}));

const mockEq = vi.fn();
const mockSelect = vi.fn();
const mockDelete = vi.fn();
vi.mock("@/lib/supabase/admin", () => ({
  createAdminClient: () => ({
    from: () => ({ delete: mockDelete }),
  }),
}));

function criarRequisicao(body: unknown) {
  return new Request("http://localhost/api/romaneio/reverter", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
}

describe("POST /api/romaneio/reverter", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockGetUser.mockResolvedValue({ data: { user: { id: "u1", email: "op@x.com" } } });
    // encadeamento delete().eq().eq().select() -- cada .eq devolve o mesmo
    // objeto pra permitir chamada em cadeia, so' o ultimo (.select) resolve.
    mockDelete.mockReturnValue({ eq: mockEq });
    mockEq.mockImplementation(() => ({ eq: mockEq, select: mockSelect }));
    mockSelect.mockResolvedValue({ data: [{ id: "1" }, { id: "2" }], error: null });
  });

  it("escopa o delete por modo_teste=false quando modoTeste nao vem no corpo (reset do romaneio real)", async () => {
    const { POST } = await import("./route");
    const res = await POST(criarRequisicao({ romaneioData: "2026-08-12" }));
    expect(res.status).toBe(200);
    expect(mockEq).toHaveBeenCalledWith("romaneio_data", "2026-08-12");
    expect(mockEq).toHaveBeenCalledWith("modo_teste", false);
  });

  it("escopa o delete por modo_teste=true quando modoTeste=true (reset do romaneio de teste, nao apaga o real)", async () => {
    const { POST } = await import("./route");
    const res = await POST(criarRequisicao({ romaneioData: "2026-08-12", modoTeste: true }));
    expect(res.status).toBe(200);
    expect(mockEq).toHaveBeenCalledWith("romaneio_data", "2026-08-12");
    expect(mockEq).toHaveBeenCalledWith("modo_teste", true);
  });

  it("rejeita sem romaneioData", async () => {
    const { POST } = await import("./route");
    const res = await POST(criarRequisicao({}));
    expect(res.status).toBe(400);
    expect(mockDelete).not.toHaveBeenCalled();
  });
});
