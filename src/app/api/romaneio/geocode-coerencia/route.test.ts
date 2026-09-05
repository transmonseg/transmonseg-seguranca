import { describe, it, expect, vi, beforeEach } from "vitest";

// Mocka o admin do Supabase: so' a rpc() e' usada por esta rota.
const rpcMock = vi.fn();
vi.mock("@/lib/supabase/admin", () => ({
  createAdminClient: () => ({ rpc: rpcMock }),
}));

import { POST } from "./route";

const RIO = "3304557";
const CAXIAS = "3301702";

function req(body: unknown, chave: string | null = "segredo") {
  const headers: Record<string, string> = { "content-type": "application/json" };
  if (chave) headers["x-motor-key"] = chave;
  return new Request("http://local/api/romaneio/geocode-coerencia", {
    method: "POST",
    headers,
    body: typeof body === "string" ? body : JSON.stringify(body),
  });
}

beforeEach(() => {
  process.env.MOTOR_SECRET = "segredo";
  rpcMock.mockReset();
});

describe("POST /api/romaneio/geocode-coerencia", () => {
  it("401 sem x-motor-key", async () => {
    const res = await POST(req({ grupos: [] }, null));
    expect(res.status).toBe(401);
  });

  it("400 se grupos mal formados", async () => {
    const res = await POST(req({ grupos: [{ id: 1, ruas: "x" }] }));
    expect(res.status).toBe(400);
  });

  it("400 se zona desconhecida (lista as validas)", async () => {
    const res = await POST(req({ grupos: [{ id: "a", zona: "MARTE", ruas: ["RUA X"] }] }));
    expect(res.status).toBe(400);
    expect((await res.json()).erro).toMatch(/CAPITAL/);
  });

  it("normaliza os nomes (inclusive 'AV.' com ponto), busca candidatos exatos em UMA rpc e resolve por coerencia", async () => {
    rpcMock.mockImplementation(async (fn: string, args: Record<string, unknown>) => {
      if (fn === "cnefe_candidatos_por_rua") {
        expect((args.nomes as string[]).sort()).toEqual(["AUTOMOVEL CLUBE", "NOVE"]);
        return {
          data: [
            { nome: "AUTOMOVEL CLUBE", municipio_codigo: CAXIAS, lat: -22.79, lng: -43.30, qtd: 50 },
            { nome: "NOVE", municipio_codigo: RIO, lat: -22.86, lng: -43.245, qtd: 200 },
            { nome: "NOVE", municipio_codigo: CAXIAS, lat: -22.792, lng: -43.302, qtd: 30 },
          ],
          error: null,
        };
      }
      throw new Error("rpc inesperada " + fn);
    });
    const res = await POST(req({ grupos: [{ id: "RJM5B51", zona: "BAIXADA", ruas: ["AV. AUTOMOVEL CLUBE", "RUA NOVE"] }] }));
    expect(res.status).toBe(200);
    const json = await res.json();
    expect(json.grupos).toHaveLength(1);
    expect(json.grupos[0].id).toBe("RJM5B51");
    const [ac, nove] = json.grupos[0].resultados;
    expect(ac).toMatchObject({ municipioCodigo: CAXIAS, confianca: "alta", ancora: true });
    expect(nove).toMatchObject({ municipioCodigo: CAXIAS, lat: -22.792, confianca: "alta" });
    expect(rpcMock).toHaveBeenCalledTimes(1); // nada foi pra similaridade
  });

  it("nome sem match exato vai pra similaridade (uma rpc por nome), e nome curto (<6) nao vai", async () => {
    rpcMock.mockImplementation(async (fn: string, args: Record<string, unknown>) => {
      if (fn === "cnefe_candidatos_por_rua") return { data: [], error: null };
      if (fn === "cnefe_candidatos_por_similaridade") {
        expect(args.nome).toBe("RENATO MONTEIRO X");
        return {
          data: [
            { nome_cnefe: "RENATO MONTEIRO", similaridade: 0.8, municipio_codigo: CAXIAS, lat: -22.73, lng: -43.35, qtd: 25 },
            { nome_cnefe: "RENATA MONTEIRO", similaridade: 0.62, municipio_codigo: RIO, lat: -22.9, lng: -43.2, qtd: 5 },
          ],
          error: null,
        };
      }
      throw new Error("rpc inesperada " + fn);
    });
    const res = await POST(req({ grupos: [{ id: "g", ruas: ["AV. RENATO MONTEIRO X", "RUA P"] }] }));
    const json = await res.json();
    const [renato, p] = json.grupos[0].resultados;
    // so' o nome CNEFE mais parecido entra (0.62 fica de fora), e similaridade nunca da' "alta"
    expect(renato).toMatchObject({ municipioCodigo: CAXIAS, candidatos: 1, ancora: false });
    expect(["media", "baixa", "isolado"]).toContain(renato.confianca);
    expect(p).toMatchObject({ lat: null, confianca: "sem_candidato" });
    expect(rpcMock).toHaveBeenCalledTimes(2);
    expect(json.meta.viaSimilaridade).toBe(1);
  });

  // Achado real 05/09 (conferencia manual de 20 entregas da Rio Quality):
  // "RUA RAIMUNDO CORREIA" (rota SUL 1 = capital, e' rua de Copacabana) foi
  // parar em Duque de Caxias. Motivo: o CNEFE grafa "RAIMUNDO CORREA" (sem o
  // "i") no Rio, entao NAO ha match exato na capital -- mas ha match exato em
  // Duque de Caxias, Macae, Belford Roxo... Como so' buscavamos similaridade
  // pra nome SEM NENHUM match exato, o exato de fora da zona ganhava do
  // parecido de dentro. Regra certa: match exato FORA da zona nao ganha de
  // nome parecido DENTRO da zona.
  it("nome com match exato so' FORA da zona: busca similaridade e prefere o candidato de dentro da zona", async () => {
    rpcMock.mockImplementation(async (fn: string, args: Record<string, unknown>) => {
      if (fn === "cnefe_candidatos_por_rua") {
        return { data: [{ nome: "RAIMUNDO CORREIA", municipio_codigo: CAXIAS, lat: -22.78, lng: -43.32, qtd: 235 }], error: null }
      }
      if (fn === "cnefe_candidatos_por_similaridade") {
        expect(args.nome).toBe("RAIMUNDO CORREIA")
        return { data: [{ nome_cnefe: "RAIMUNDO CORREA", similaridade: 0.94, municipio_codigo: RIO, lat: -22.9707, lng: -43.1861, qtd: 531 }], error: null }
      }
      throw new Error("rpc inesperada " + fn)
    })
    const res = await POST(req({ grupos: [{ id: "LUN8I82", zona: "CAPITAL", ruas: ["RUA RAIMUNDO CORREIA"] }] }))
    const [r] = (await res.json()).grupos[0].resultados
    expect(r.municipioCodigo).toBe(RIO)
    expect(r.lat).toBe(-22.9707)
    // veio de similaridade: nunca "alta", e nao ancora sozinho
    expect(r.ancora).toBe(false)
  })

  it("havendo match exato DENTRO da zona, nao gasta chamada de similaridade", async () => {
    rpcMock.mockImplementation(async (fn: string) => {
      if (fn === "cnefe_candidatos_por_rua") {
        return { data: [
          { nome: "NOVE", municipio_codigo: RIO, lat: -22.9, lng: -43.2, qtd: 10 },
          { nome: "NOVE", municipio_codigo: CAXIAS, lat: -22.78, lng: -43.32, qtd: 10 },
        ], error: null }
      }
      throw new Error("nao deveria chamar " + fn)
    })
    const res = await POST(req({ grupos: [{ id: "g", zona: "CAPITAL", ruas: ["RUA NOVE"] }] }))
    expect((await res.json()).grupos[0].resultados[0].municipioCodigo).toBe(RIO)
    expect(rpcMock).toHaveBeenCalledTimes(1)
  })

  it("sem zona declarada: mantem o comportamento de hoje (exato basta, nao busca similaridade)", async () => {
    rpcMock.mockImplementation(async (fn: string) => {
      if (fn === "cnefe_candidatos_por_rua") {
        return { data: [{ nome: "RAIMUNDO CORREIA", municipio_codigo: CAXIAS, lat: -22.78, lng: -43.32, qtd: 235 }], error: null }
      }
      throw new Error("nao deveria chamar " + fn)
    })
    const res = await POST(req({ grupos: [{ id: "g", ruas: ["RUA RAIMUNDO CORREIA"] }] }))
    expect((await res.json()).grupos[0].resultados[0].municipioCodigo).toBe(CAXIAS)
    expect(rpcMock).toHaveBeenCalledTimes(1)
  })

  it("500 com mensagem se a rpc de exatos falhar", async () => {
    rpcMock.mockResolvedValue({ data: null, error: { message: "boom" } });
    const res = await POST(req({ grupos: [{ id: "g", ruas: ["RUA X"] }] }));
    expect(res.status).toBe(500);
    expect((await res.json()).erro).toMatch(/boom/);
  });
});
