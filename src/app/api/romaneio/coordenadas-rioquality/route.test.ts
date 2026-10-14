// src/app/api/romaneio/coordenadas-rioquality/route.test.ts
//
// Devolve pro KPI as coordenadas que o Monitoramento ja' geocodificou pros
// pontos do dia (cascata completa + fallback Unitrac). O KPI casa so' as
// placas+nf da Rio Quality (nao colidem com Nutry Max). GET, x-motor-key.
import { describe, it, expect, vi, beforeEach } from "vitest";

const mockGetUser = vi.fn();
vi.mock("@/lib/supabase/server", () => ({ createClient: async () => ({ auth: { getUser: mockGetUser } }) }));

const mockNot = vi.fn();
const mockEq = vi.fn(() => ({ not: mockNot }));
const mockSelect = vi.fn(() => ({ eq: mockEq }));
vi.mock("@/lib/supabase/admin", () => ({
  createAdminClient: () => ({ from: () => ({ select: mockSelect }) }),
}));

async function get(url: string, headers: Record<string, string> = {}) {
  const { GET } = await import("./route");
  const res = await GET(new Request(url, { headers }));
  return { status: res.status, json: (await res.json()) as Record<string, unknown> };
}

describe("GET /api/romaneio/coordenadas-rioquality", () => {
  beforeEach(() => { vi.clearAllMocks(); process.env.MOTOR_SECRET = "s"; mockGetUser.mockResolvedValue({ data: { user: null } }); });

  it("401 sem x-motor-key", async () => {
    const r = await get("http://x/api/romaneio/coordenadas-rioquality?data=2026-10-13");
    expect(r.status).toBe(401);
  });

  it("400 sem data valida", async () => {
    const r = await get("http://x/api/romaneio/coordenadas-rioquality", { "x-motor-key": "s" });
    expect(r.status).toBe(400);
  });

  it("devolve placa/nf/lat/lng dos pontos geocodificados do dia", async () => {
    mockNot.mockResolvedValue({ data: [{ placa: "RQU8A12", nf: "123", lat: -22.9, lng: -43.1 }], error: null });
    const r = await get("http://x/api/romaneio/coordenadas-rioquality?data=2026-10-13", { "x-motor-key": "s" });
    expect(r.status).toBe(200);
    expect(r.json.ok).toBe(true);
    expect(r.json.pontos).toEqual([{ placa: "RQU8A12", nf: "123", lat: -22.9, lng: -43.1 }]);
    expect(mockSelect).toHaveBeenCalledWith("placa, nf, lat, lng");
    expect(mockEq).toHaveBeenCalledWith("romaneio_data", "2026-10-13");
    expect(mockNot).toHaveBeenCalledWith("lat", "is", null);
  });
});
