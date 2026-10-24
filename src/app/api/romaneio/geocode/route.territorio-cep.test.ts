import { describe, it, expect, vi, beforeEach } from "vitest";

// F4-05 (GEO-14, plano mestre 23/10): a guarda territorial da ponte nao
// reprova por bairro o ponto CNEFE exato cujo numero e CEP especifico batem
// com o romaneio. Dados reais do CNEFE em producao (24/10, so' leitura).
const REBOLLAS = { lat: -22.545158, lng: -44.204038 };
const SAVIO = { lat: -22.494773, lng: -44.095926 };
const CNEFE: Record<string, { lat: number; lng: number; numero: string; cep: string; localidade: string }[]> = {
  "JOSE GONCALVES REBOLLAS|2411": [
    { ...REBOLLAS, numero: "2411", cep: "27350390", localidade: "SIDERLANDIA" },
    { lat: -22.545141, lng: -44.204076, numero: "2411", cep: "27350390", localidade: "SIDERLANDIA" },
  ],
  "SAVIO COTA ALMEIDA GAMA|595": [{ ...SAVIO, numero: "595", cep: "27283527", localidade: "VALE DO PARAIBA" }],
};
const DIST_BAIRRO: Record<string, number> = { BOCAININHA: 1329.92, RETIRO: 3009.69 };
const MUNICIPIO_DO_PONTO: Record<string, string> = { [`${REBOLLAS.lat}`]: "3300407", [`${SAVIO.lat}`]: "3306305" };
const estado = { consultasCnefe: 0, ponto: REBOLLAS as { lat: number; lng: number }, precisao: "exato" as string };

function consulta(tabela: string) {
  const filtros: Record<string, unknown> = {};
  const b: Record<string, unknown> = {};
  for (const m of ["select", "limit", "ilike", "gt", "not", "order"]) b[m] = () => b;
  b.eq = (col: string, v: unknown) => { filtros[col] = v; return b; };
  b.in = (_c: string, chaves: string[]) => ({
    then: (ok: (v: unknown) => unknown) => ok({
      data: chaves.filter((c) => c.startsWith("CIDADE:") || c.startsWith("BAIRRO:"))
        .map((c) => ({ endereco_normalizado: c, ...estado.ponto, fonte: "nominatim", validado: true })),
      error: null,
    }),
  });
  b.then = (ok: (v: unknown) => unknown) => {
    if (tabela === "cnefe_enderecos" && filtros.numero != null) {
      estado.consultasCnefe++;
      return ok({ data: CNEFE[`${filtros.nome_normalizado}|${filtros.numero}`] ?? [], error: null });
    }
    return ok({ data: [], error: null });
  };
  return b;
}

const admin = {
  from: (t: string) => consulta(t),
  rpc: (nome: string, args: Record<string, unknown>) => {
    const executar = async () => {
      if (nome === "municipio_da_coordenada") return { data: [{ municipio_codigo: MUNICIPIO_DO_PONTO[`${args.p_lat}`] }], error: null };
      if (nome === "distancia_ao_bairro") return { data: DIST_BAIRRO[String(args.p_bairro)] ?? null, error: null };
      return { data: [], error: null };
    };
    let p: Promise<unknown> | null = null;
    const b = { abortSignal: () => b, then: (ok: (v: unknown) => unknown, err?: (e: unknown) => unknown) => (p ??= executar()).then(ok, err) };
    return b;
  },
};
vi.mock("@/lib/supabase/admin", () => ({ createAdminClient: () => admin }));

// A cascata em si e' testada em romaneio-geocode.test.ts: aqui ela devolve o
// ponto CNEFE como a producao gravou no cache do KPI (exato).
vi.mock("@/lib/romaneio-geocode", async (orig) => {
  const real = await orig<typeof import("@/lib/romaneio-geocode")>();
  return {
    ...real,
    geocodificarEndereco: async () => ({ ...estado.ponto, fonte: "cnefe", validado: true, precisao: estado.precisao, raioM: 30 }),
  };
});

import { POST } from "./route";

const req = (enderecos: string[]) => new Request("http://local/api/romaneio/geocode", {
  method: "POST",
  headers: { "content-type": "application/json", "x-motor-key": "segredo" },
  body: JSON.stringify({ enderecos, validarTerritorio: true }),
});

beforeEach(() => {
  process.env.MOTOR_SECRET = "segredo";
  Object.assign(estado, { consultasCnefe: 0, ponto: REBOLLAS, precisao: "exato" });
});

describe("POST /api/romaneio/geocode -- F4-05 guarda territorial x CEP confirmado", () => {
  it("RUA JOSE GONCALVES REBOLLAS, 2411 - BOCAININHA, BARRA MANSA - 27350-390: exato no CEP do romaneio -> validado, sem bairro_divergente", async () => {
    const corpo = await (await POST(req(["RUA JOSE GONCALVES REBOLLAS, 2411 - BOCAININHA, BARRA MANSA - LOJA - 27350390"]))).json();
    expect(corpo.resultados[0]).toMatchObject({ ...REBOLLAS, fonte: "cnefe", validado: true, precisao: "exato" });
    expect(corpo.resultados[0].motivo).toBeUndefined();
    expect(estado.consultasCnefe).toBe(1);
  });

  it("REBOLLAS sem CEP no texto (ponte antiga do KPI): reprova por bairro como antes", async () => {
    const corpo = await (await POST(req(["RUA JOSE GONCALVES REBOLLAS, 2411 - BOCAININHA, BARRA MANSA - LOJA"]))).json();
    expect(corpo.resultados[0]).toMatchObject({ validado: false, motivo: "bairro_divergente" });
  });

  it("REBOLLAS com precisao interpolado: nao consulta o CEP, reprova por bairro como antes", async () => {
    estado.precisao = "interpolado";
    const corpo = await (await POST(req(["RUA JOSE GONCALVES REBOLLAS, 2411 - BOCAININHA, BARRA MANSA - LOJA - 27350390"]))).json();
    expect(corpo.resultados[0]).toMatchObject({ validado: false, motivo: "bairro_divergente" });
    expect(estado.consultasCnefe).toBe(0);
  });

  it("AV SAVIO COTA DE ALMEIDA GAMA, 595 - RETIRO, VOLTA REDONDA - 27281-421: CEP do CNEFE e' outro -> continua bairro_divergente", async () => {
    estado.ponto = SAVIO;
    const corpo = await (await POST(req(["AV SAVIO COTA DE ALMEIDA GAMA, 595 - RETIRO, VOLTA REDONDA - LOJA - 27281421"]))).json();
    expect(corpo.resultados[0]).toMatchObject({ validado: false, motivo: "bairro_divergente" });
  });
});
