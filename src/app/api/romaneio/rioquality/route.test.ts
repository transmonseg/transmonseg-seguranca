// src/app/api/romaneio/rioquality/route.test.ts
//
// Endpoint estruturado que recebe o romaneio da Rio Quality do KPI
// (servidor-a-servidor, x-motor-key). Insere em romaneio_pontos com a DATA
// RECEBIDA (nunca inferida) e deixa o geocode pro cron (lat/lng nulos,
// geocode_status 'pendente'), igual ao /upload. Testa roteamento/validação
// via mock do client, sem banco real. Mesmo padrão de mock do upload.
import { describe, it, expect, vi, beforeEach } from "vitest";

const mockNormalizarPlaca = vi.fn((p: string) => p.toUpperCase().replace(/[^A-Z0-9]/g, ""));
vi.mock("@/lib/romaneio", () => ({ normalizarPlaca: mockNormalizarPlaca }));

const mockGetUser = vi.fn();
vi.mock("@/lib/supabase/server", () => ({
  createClient: async () => ({ auth: { getUser: mockGetUser } }),
}));

let ultimasLinhasUpsert: Record<string, unknown>[] = [];
let ultimoOnConflict: string | undefined;
const mockUpsertSelect = vi.fn();
const mockUpsert = vi.fn((linhas: Record<string, unknown>[], opcoes?: { onConflict?: string }) => {
  ultimasLinhasUpsert = linhas;
  ultimoOnConflict = opcoes?.onConflict;
  mockUpsertSelect.mockImplementation(async () => ({ data: linhas.map((_, i) => ({ id: `l-${i}` })), error: null }));
  return { select: mockUpsertSelect };
});
const mockVeiculosIn = vi.fn();
vi.mock("@/lib/supabase/admin", () => ({
  createAdminClient: () => ({
    from: (tabela: string) => {
      if (tabela === "veiculos") return { select: () => ({ in: mockVeiculosIn }) };
      return { upsert: mockUpsert };
    },
  }),
}));

async function postJson(body: unknown, headers: Record<string, string> = {}) {
  const { POST } = await import("./route");
  const req = new Request("http://localhost/api/romaneio/rioquality", {
    method: "POST", headers: { "content-type": "application/json", ...headers },
    body: JSON.stringify(body),
  });
  const res = await POST(req);
  return { status: res.status, json: (await res.json()) as Record<string, unknown> };
}

describe("POST /api/romaneio/rioquality", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    process.env.MOTOR_SECRET = "segredo";
    mockGetUser.mockResolvedValue({ data: { user: null } });
    mockVeiculosIn.mockResolvedValue({ data: [{ id: "v1", placa: "RQU8A12" }], error: null });
    ultimasLinhasUpsert = [];
    ultimoOnConflict = undefined;
  });

  it("401 sem x-motor-key", async () => {
    const r = await postJson({ data: "2026-10-13", linhas: [] });
    expect(r.status).toBe(401);
  });

  it("insere as linhas com a data recebida e casa placa->veiculo", async () => {
    const r = await postJson(
      { data: "2026-10-13", linhas: [
        { placa: "RQU8A12", nf: "123", clienteNome: "LOJA A", enderecoBruto: "RUA X, 1" },
        { placa: "RQV9Z99", nf: "456", clienteNome: "LOJA B", enderecoBruto: "RUA Y, 2" },
      ] },
      { "x-motor-key": "segredo" },
    );
    expect(r.status).toBe(200);
    expect(r.json.ok).toBe(true);
    expect(r.json.linhasInseridas).toBe(2);
    expect(r.json.placasNaoEncontradas).toEqual(["RQV9Z99"]);
    // data recebida, geocode pendente, origem romaneio, veiculo casado
    expect(ultimasLinhasUpsert[0]).toMatchObject({
      romaneio_data: "2026-10-13", placa: "RQU8A12", nf: "123",
      veiculo_id: "v1", lat: null, lng: null, geocode_status: "pendente",
      modo_teste: false, origem: "romaneio",
    });
    expect(ultimasLinhasUpsert[1]).toMatchObject({ placa: "RQV9Z99", veiculo_id: null });
    expect(ultimoOnConflict).toBe("romaneio_data,placa,nf,modo_teste,origem");
  });

  it("400 se payload inválido (sem data ou linhas não-array)", async () => {
    const r = await postJson({ linhas: "x" }, { "x-motor-key": "segredo" });
    expect(r.status).toBe(400);
  });
});
