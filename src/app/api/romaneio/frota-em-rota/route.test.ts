// F3-07 (ACH-04): ponte do KPI para o aviso interno das 06:30/07:30 -- o KPI
// pergunta se a frota do cliente esta' rodando (mesma regra do card
// romaneio_ausente: GPS fresco, ignicao, mais de 5 km da base).
import { describe, it, expect, vi, beforeEach } from "vitest";

const estado = vi.hoisted(() => ({
  rows: [] as Record<string, unknown>[],
  params: [] as unknown[][],
  falhar: false,
}));

vi.mock("pg", () => ({
  default: {
    Pool: vi.fn().mockImplementation(function () {
      return {
        query: vi.fn(async (_sql: string, params: unknown[]) => {
          estado.params.push(params);
          if (estado.falhar) throw new Error("timeout");
          return { rows: estado.rows };
        }),
        end: vi.fn(async () => {}),
      };
    }),
  },
}));

const { GET } = await import("./route");

const req = (qs: string, chave: string | null = "segredo") =>
  new Request(`http://x/api/romaneio/frota-em-rota?${qs}`, { headers: chave ? { "x-motor-key": chave } : {} });

beforeEach(() => {
  estado.rows = []; estado.params = []; estado.falhar = false;
  process.env.MOTOR_SECRET = "segredo";
});

describe("GET /api/romaneio/frota-em-rota", () => {
  it("sem a chave da ponte => 401", async () => {
    expect((await GET(req("data=2026-10-21&cod=4096", null))).status).toBe(401);
    expect((await GET(req("data=2026-10-21&cod=4096", "outra"))).status).toBe(401);
  });

  it("parametros invalidos => 400", async () => {
    expect((await GET(req("data=21/10&cod=4096"))).status).toBe(400);
    expect((await GET(req("data=2026-10-21&cod=abc"))).status).toBe(400);
  });

  it("21/10 07:00: 3 carros da Nutry em rota, 1 ja' com romaneio => emRota 3, semRomaneio 2 com as placas", async () => {
    estado.rows = [
      { placa: "RQU-1B50", tem_romaneio: false },
      { placa: "OXE-7D03", tem_romaneio: false },
      { placa: "TTI-6E43", tem_romaneio: true },
    ];
    const r = await GET(req("data=2026-10-21&cod=4096"));
    expect(r.status).toBe(200);
    expect(await r.json()).toEqual({ data: "2026-10-21", cod: "4096", emRota: 3, semRomaneio: 2, placasSemRomaneio: ["OXE-7D03", "RQU-1B50"] });
    expect(estado.params[0]).toEqual([["4096"], 60, "2026-10-21", 5000]);
  });

  it("falha na consulta => 500 (o KPI trata como 'nao sei', nunca como frota parada)", async () => {
    estado.falhar = true;
    expect((await GET(req("data=2026-10-21&cod=598"))).status).toBe(500);
  });
});
