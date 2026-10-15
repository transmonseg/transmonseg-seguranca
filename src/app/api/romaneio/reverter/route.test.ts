import { describe, it, expect, vi, beforeEach } from "vitest";

const mockGetUser = vi.fn();
vi.mock("@/lib/supabase/server", () => ({
  createClient: async () => ({ auth: { getUser: mockGetUser } }),
}));

const mockAcesso = vi.fn();
vi.mock("@/lib/acesso-cliente", () => ({ acessoDoUsuario: () => mockAcesso() }));
const mockIdsVeiculos = vi.fn();
vi.mock("@/lib/acesso-guardas", () => ({ idsVeiculosDoCliente: (a: unknown) => mockIdsVeiculos(a) }));

const mockEq = vi.fn();
const mockIn = vi.fn();
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
    mockEq.mockImplementation(() => ({ eq: mockEq, in: mockIn, select: mockSelect }));
    mockIn.mockImplementation(() => ({ select: mockSelect }));
    mockAcesso.mockResolvedValue({ tipo: "todos" });
    mockIdsVeiculos.mockResolvedValue(null);
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

  // ─── OP-10 (auditoria 15/10): conta de cliente so' desfaz a propria frota.

  it("conta de um cliente: apaga so' os veiculos dela, em lotes de 50", async () => {
    mockAcesso.mockResolvedValue({ tipo: "um", clienteId: "nutry" });
    mockIdsVeiculos.mockResolvedValue(Array.from({ length: 120 }, (_, i) => `v${i}`));
    const { POST } = await import("./route");
    const res = await POST(criarRequisicao({ romaneioData: "2026-10-15" }));
    expect(res.status).toBe(200);
    expect(mockIn).toHaveBeenCalledTimes(3);
    expect(mockIn.mock.calls[0][1]).toHaveLength(50);
    expect(mockIn.mock.calls[2][1]).toHaveLength(20);
    expect((await res.json()).linhasRemovidas).toBe(6);
  });

  it("central: nao filtra por veiculo", async () => {
    const { POST } = await import("./route");
    await POST(criarRequisicao({ romaneioData: "2026-10-15" }));
    expect(mockIn).not.toHaveBeenCalled();
  });

  it("sem operador cadastrado: 403 e nao apaga nada", async () => {
    mockAcesso.mockResolvedValue({ tipo: "nenhum" });
    const { POST } = await import("./route");
    const res = await POST(criarRequisicao({ romaneioData: "2026-10-15" }));
    expect(res.status).toBe(403);
    expect(mockDelete).not.toHaveBeenCalled();
  });
});
