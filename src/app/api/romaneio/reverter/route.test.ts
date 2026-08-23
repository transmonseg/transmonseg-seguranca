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

  // ─── Reset por origem (migration 059). Regra que importa: `origem` e'
  // opcional e, quando vem errada, e' 400 -- num DELETE, filtro ignorado
  // apaga MAIS do que a tela pediu.

  it("sem origem no corpo: nao filtra por origem (reset do dia inteiro, comportamento de antes)", async () => {
    const { POST } = await import("./route");
    const res = await POST(criarRequisicao({ romaneioData: "2026-08-23" }));
    expect(res.status).toBe(200);
    expect(mockEq).not.toHaveBeenCalledWith("origem", expect.anything());
  });

  it("origem valida: escopa o delete tambem por origem", async () => {
    const { POST } = await import("./route");
    const res = await POST(criarRequisicao({ romaneioData: "2026-08-23", origem: "escala_pao" }));
    expect(res.status).toBe(200);
    expect(mockEq).toHaveBeenCalledWith("romaneio_data", "2026-08-23");
    expect(mockEq).toHaveBeenCalledWith("modo_teste", false);
    expect(mockEq).toHaveBeenCalledWith("origem", "escala_pao");
  });

  it("origem fora da allowlist: 400 e NAO apaga nada", async () => {
    const { POST } = await import("./route");
    const res = await POST(criarRequisicao({ romaneioData: "2026-08-23", origem: "tudo" }));
    expect(res.status).toBe(400);
    expect(mockDelete).not.toHaveBeenCalled();
  });

  it("rejeita sem romaneioData", async () => {
    const { POST } = await import("./route");
    const res = await POST(criarRequisicao({}));
    expect(res.status).toBe(400);
    expect(mockDelete).not.toHaveBeenCalled();
  });
});
