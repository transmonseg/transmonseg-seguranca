import { describe, it, expect, vi, beforeEach } from "vitest";

const rpcMock = vi.fn();
vi.mock("@/lib/supabase/admin", () => ({
  createAdminClient: () => ({ rpc: rpcMock }),
}));

import { POST } from "./route";

function req(body: unknown, chave: string | null = "segredo") {
  const headers: Record<string, string> = { "content-type": "application/json" };
  if (chave) headers["x-motor-key"] = chave;
  return new Request("http://local/api/romaneio/velocidade-na-parada", {
    method: "POST",
    headers,
    body: typeof body === "string" ? body : JSON.stringify(body),
  });
}

const consultaBase = {
  placa: "TUL1C38",
  lat: -22.9,
  lng: -43.5,
  raioM: 300,
  inicioIso: "2026-09-14T10:00:00.000Z",
  fimIso: "2026-09-14T10:30:00.000Z",
};

beforeEach(() => {
  process.env.MOTOR_SECRET = "segredo";
  rpcMock.mockReset();
});

describe("POST /api/romaneio/velocidade-na-parada", () => {
  it("401 sem x-motor-key", async () => {
    const res = await POST(req({ consultas: [] }, null));
    expect(res.status).toBe(401);
    expect(rpcMock).not.toHaveBeenCalled();
  });

  it("400 acima do teto de consultas por chamada", async () => {
    const res = await POST(req({ consultas: Array(301).fill(consultaBase) }));
    expect(res.status).toBe(400);
    expect(rpcMock).not.toHaveBeenCalled();
  });

  it("400 quando o corpo nao e' JSON valido", async () => {
    const res = await POST(req("nao e json"));
    expect(res.status).toBe(400);
  });

  it("400 quando 'consultas' nao e' um array", async () => {
    const res = await POST(req({ consultas: "nao e array" }));
    expect(res.status).toBe(400);
  });

  it("consultas vazio: responde sem chamar rpc", async () => {
    const res = await POST(req({ consultas: [] }));
    expect(await res.json()).toEqual({ resultados: [] });
    expect(rpcMock).not.toHaveBeenCalled();
  });

  it("entrada malformada vira null nessa posicao, sem derrubar as outras", async () => {
    rpcMock.mockResolvedValue({
      data: [{ idx: 0, tem_parada_com_velocidade: true }],
      error: null,
    });
    const res = await POST(req({
      consultas: [
        { ...consultaBase, lat: undefined },
        { placa: "SOMENTE-PLACA" },
        consultaBase,
      ],
    }));
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.resultados).toEqual([null, null, true]);
    // so' a entrada valida (idx 0 no lote enviado ao rpc) foi mandada pro banco
    const chamada = rpcMock.mock.calls[0][1] as Record<string, unknown>;
    expect((chamada.p_placas as string[]).length).toBe(1);
  });

  it("parada real com velocidade <=5 dentro do raio e da janela -> true", async () => {
    rpcMock.mockResolvedValue({
      data: [{ idx: 0, tem_parada_com_velocidade: true }],
      error: null,
    });
    const res = await POST(req({ consultas: [consultaBase] }));
    const body = await res.json();
    expect(body.resultados).toEqual([true]);
    expect(rpcMock).toHaveBeenCalledWith(
      "posicoes_velocidade_na_parada_lote",
      expect.objectContaining({
        p_placas: ["TUL-1C38"], // normalizada com hifen, como o banco guarda
        p_lats: [consultaBase.lat],
        p_lngs: [consultaBase.lng],
        p_raios: [consultaBase.raioM],
        p_inicios: [consultaBase.inicioIso],
        p_fins: [consultaBase.fimIso],
      }),
    );
  });

  it("placa nunca chega perto -> false", async () => {
    rpcMock.mockResolvedValue({
      data: [{ idx: 0, tem_parada_com_velocidade: false }],
      error: null,
    });
    const res = await POST(req({ consultas: [consultaBase] }));
    expect((await res.json()).resultados).toEqual([false]);
  });

  it("zero linhas pra placa na janela -> false, nao erro", async () => {
    // rpc devolve so' as posicoes que TEM idx correspondente com true; ausencia
    // completa de linha pro idx tambem deve virar false (nunca null).
    rpcMock.mockResolvedValue({ data: [], error: null });
    const res = await POST(req({ consultas: [consultaBase] }));
    expect(res.status).toBe(200);
    expect((await res.json()).resultados).toEqual([false]);
  });

  it("preserva a ordem de entrada mesmo com varias consultas", async () => {
    const c2 = { ...consultaBase, placa: "AAA1111", lat: -22.95 };
    const c3 = { ...consultaBase, placa: "BBB2222", lat: -23.0 };
    rpcMock.mockResolvedValue({
      data: [
        { idx: 1, tem_parada_com_velocidade: true },
        { idx: 0, tem_parada_com_velocidade: false },
      ],
      error: null,
    });
    const res = await POST(req({ consultas: [consultaBase, c2, c3] }));
    const body = await res.json();
    expect(body.resultados).toEqual([false, true, false]);
  });

  it("erro na rpc: 500 com a mensagem", async () => {
    rpcMock.mockResolvedValue({ data: null, error: { message: "banco fora" } });
    const res = await POST(req({ consultas: [consultaBase] }));
    expect(res.status).toBe(500);
    expect((await res.json()).erro).toMatch(/banco fora/);
  });
});
