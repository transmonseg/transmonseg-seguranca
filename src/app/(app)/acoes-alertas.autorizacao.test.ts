import { describe, it, expect, vi, beforeEach } from "vitest";

const mockUpsert = vi.fn(async () => ({ error: null }));
const mockUpdate = vi.fn();
const mockAcesso = vi.fn();
const mockPermitidos = vi.fn();

vi.mock("next/cache", () => ({ revalidatePath: vi.fn() }));
vi.mock("@/lib/supabase/server", () => ({
  createClient: async () => ({ auth: { getUser: async () => ({ data: { user: { id: "u1", email: "c@x.com" } } }) } }),
}));
vi.mock("@/lib/supabase/admin", () => ({
  createAdminClient: () => ({
    from: (t: string) => t === "operadores"
      ? { upsert: mockUpsert }
      : { update: (p: unknown) => { mockUpdate(p); return { eq: async () => ({ error: null }) }; } },
  }),
}));
vi.mock("@/lib/casos-desvio-revisao", () => ({ registrarCasosDesvioRevisao: vi.fn() }));
vi.mock("@/lib/detectores", () => ({ IDADE_MINIMA_ACAO_MASSA_MIN: 10 }));
vi.mock("@/app/api/alertas/route", () => ({ invalidarCacheAlertas: vi.fn() }));
vi.mock("@/app/api/alertas-romaneio/route", () => ({ invalidarCacheAlertasRomaneio: vi.fn() }));
vi.mock("@/app/api/mapa/route", () => ({ invalidarCacheMapa: vi.fn() }));
vi.mock("@/lib/acesso-cliente", () => ({ acessoDoUsuario: () => mockAcesso() }));
vi.mock("@/lib/acesso-guardas", () => ({ idsAlertaPermitidos: (...a: unknown[]) => mockPermitidos(...a) }));

import { resolverAlerta, reconhecerAlerta } from "./acoes-alertas";

describe("acoes-alertas -- autorizacao (OP-09, revisao 15/10)", () => {
  beforeEach(() => { vi.clearAllMocks(); mockPermitidos.mockImplementation(async (_a, _t, ids) => ids); });

  it("conta sem registro em operadores: nega e NAO cria a linha (antes virava central no 1o clique)", async () => {
    mockAcesso.mockResolvedValue({ tipo: "nenhum" });
    const r = await resolverAlerta("a1");
    expect(r.erro).toMatch(/permiss/i);
    expect(mockUpsert).not.toHaveBeenCalled();
    expect(mockUpdate).not.toHaveBeenCalled();
  });

  it("conta de cliente com alerta de OUTRO cliente: nega sem atualizar", async () => {
    mockAcesso.mockResolvedValue({ tipo: "um", clienteId: "nutry" });
    mockPermitidos.mockResolvedValue([]);
    const r = await reconhecerAlerta("alerta-da-rq");
    expect(r.erro).toMatch(/permiss/i);
    expect(mockUpdate).not.toHaveBeenCalled();
  });

  it("central: atualiza", async () => {
    mockAcesso.mockResolvedValue({ tipo: "todos" });
    const r = await reconhecerAlerta("a1");
    expect(r.ok).toBe(true);
    expect(mockUpdate).toHaveBeenCalled();
  });
});
