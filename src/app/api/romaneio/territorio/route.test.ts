import { describe, it, expect, vi, beforeEach } from "vitest";

// Mundo de mentira: Rio de Janeiro (3304557) a oeste de lng -43, Niteroi
// (3303302) a leste; bairro CENTRO fica a 0 m de quem esta' com lat > -22.91,
// senao a 5 km.
vi.mock("@/lib/supabase/admin", () => ({ createAdminClient: () => ({}) }));
vi.mock("../geocode/territorio-deps", () => ({
  montarDepsTerritorio: () => ({
    municipioDaCoordenada: async (_lat: number, lng: number) => (lng < -43 ? "3304557" : "3303302"),
    distanciaAoBairro: async (lat: number) => (lat > -22.91 ? 0 : 5000),
  }),
}));

import { POST } from "./route";

const req = (body: unknown, chave = "segredo") =>
  new Request("http://x/api/romaneio/territorio", { method: "POST", headers: { "x-motor-key": chave }, body: JSON.stringify(body) });

describe("POST /api/romaneio/territorio", () => {
  beforeEach(() => { process.env.MOTOR_SECRET = "segredo"; });

  it("sem a chave da ponte: 401", async () => {
    expect((await POST(req({ pontos: [] }, "errada"))).status).toBe(401);
  });

  it("corpo sem pontos: 400", async () => {
    expect((await POST(req({}))).status).toBe(400);
  });

  it("diz se cada ponto cai no municipio e no bairro do endereco", async () => {
    const r = await POST(req({ pontos: [
      { id: "a", lat: -22.90, lng: -43.18, endereco: "RUA X, 10 - CENTRO, RIO DE JANEIRO - 20000000" },
      { id: "b", lat: -22.90, lng: -42.90, endereco: "RUA X, 10 - CENTRO, RIO DE JANEIRO - 20000000" },
      { id: "c", lat: -22.95, lng: -43.18, endereco: "RUA X, 10 - CENTRO, RIO DE JANEIRO - 20000000" },
    ] }));
    expect(await r.json()).toEqual({ resultados: [
      { id: "a", ok: true },
      { id: "b", ok: false, motivo: "municipio_divergente" },
      { id: "c", ok: false, motivo: "bairro_divergente" },
    ] });
  });

  it("ponto com coordenada invalida volta sem veredito (null)", async () => {
    const r = await POST(req({ pontos: [{ id: "x", lat: "a", lng: 1, endereco: "Y" }] }));
    expect(await r.json()).toEqual({ resultados: [{ id: "x", ok: null }] });
  });
});
