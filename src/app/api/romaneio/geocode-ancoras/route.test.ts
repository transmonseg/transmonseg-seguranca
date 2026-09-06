import { describe, it, expect, vi, beforeEach } from "vitest";

const rpcMock = vi.fn();
vi.mock("@/lib/supabase/admin", () => ({
  createAdminClient: () => ({ rpc: rpcMock }),
}));

import { POST } from "./route";

function req(body: unknown, chave: string | null = "segredo") {
  const headers: Record<string, string> = { "content-type": "application/json" };
  if (chave) headers["x-motor-key"] = chave;
  return new Request("http://local/api/romaneio/geocode-ancoras", {
    method: "POST",
    headers,
    body: typeof body === "string" ? body : JSON.stringify(body),
  });
}

beforeEach(() => {
  process.env.MOTOR_SECRET = "segredo";
  rpcMock.mockReset();
});

describe("POST /api/romaneio/geocode-ancoras", () => {
  it("401 sem x-motor-key", async () => {
    const res = await POST(req({ grupos: [] }, null));
    expect(res.status).toBe(401);
  });

  it("400 se grupos mal formados (sem ancoras)", async () => {
    const res = await POST(req({ grupos: [{ id: "a", ruas: ["RUA X"] }] }));
    expect(res.status).toBe(400);
  });

  it("400 acima do teto de ruas", async () => {
    const res = await POST(req({ grupos: [{ id: "a", ruas: Array(4001).fill("RUA X"), ancoras: [] }] }));
    expect(res.status).toBe(400);
  });

  it("grupos vazio: responde sem chamar rpc", async () => {
    const res = await POST(req({ grupos: [] }));
    expect(await res.json()).toEqual({ grupos: [] });
    expect(rpcMock).not.toHaveBeenCalled();
  });

  it("reposiciona pela ancora mais proxima, descarta candidato fora do raio, null sem candidato", async () => {
    const ancoraCampoGrande = { lat: -22.9028, lng: -43.5606 };
    const candidatoPerto = { lat: -22.903, lng: -43.561 }; // ~200m
    const candidatoLonge = { lat: -22.9068, lng: -43.1729 }; // ~40km, Centro do Rio

    rpcMock.mockImplementation(async (fn: string, args: Record<string, unknown>) => {
      if (fn === "cnefe_candidatos_por_rua") {
        expect((args.nomes as string[]).sort()).toEqual(["MATO ALTO", "SEM MATCH NENHUM"]);
        return {
          data: [
            { nome: "MATO ALTO", lat: candidatoPerto.lat, lng: candidatoPerto.lng },
            { nome: "MATO ALTO", lat: candidatoLonge.lat, lng: candidatoLonge.lng },
          ],
          error: null,
        };
      }
      throw new Error("rpc inesperada " + fn);
    });

    const res = await POST(req({
      grupos: [{ id: "JIE8C41|2026-09-05", ruas: ["ESTRADA DO MATO ALTO", "RUA SEM MATCH NENHUM"], ancoras: [ancoraCampoGrande] }],
    }));
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.grupos).toEqual([
      { id: "JIE8C41|2026-09-05", resultados: [{ lat: candidatoPerto.lat, lng: candidatoPerto.lng }, null] },
    ]);
  });

  it("sem ancora nenhuma no grupo: tudo null (nao ha com o que comparar)", async () => {
    rpcMock.mockResolvedValue({ data: [{ nome: "MATO ALTO", lat: -22.9, lng: -43.5 }], error: null });
    const res = await POST(req({ grupos: [{ id: "a", ruas: ["ESTRADA DO MATO ALTO"], ancoras: [] }] }));
    const body = await res.json();
    expect(body.grupos).toEqual([{ id: "a", resultados: [null] }]);
  });

  it("erro na rpc: 500 com a mensagem", async () => {
    rpcMock.mockResolvedValue({ data: null, error: { message: "banco fora" } });
    const res = await POST(req({ grupos: [{ id: "a", ruas: ["RUA X"], ancoras: [{ lat: 1, lng: 2 }] }] }));
    expect(res.status).toBe(500);
    expect((await res.json()).erro).toMatch(/banco fora/);
  });
});
