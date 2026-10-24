import { describe, it, expect, vi } from "vitest";
import { escolherGrupoBairro, normalizarLocalidadeBairro, buscarCentroideBairro, type GrupoBairro } from "./cnefe-bairro-centroide";

// F4-01 (GEO-26, plano mestre 23/10). Grupos reais do CNEFE (producao, 24/10:
// count/avg por municipio_codigo + localidade).
const g = (localidade_norm: string, n_pontos: number, lat: number, lng: number): GrupoBairro => ({ localidade_norm, n_pontos, lat, lng });

const RIO_MARE = [
  g("COMPLEXO DA MARE", 4146, -22.854445, -43.242604),
  g("FAVELA PARQUE MARE", 941, -22.853884, -43.24357),
  g("MARE", 39142, -22.864185, -43.240363),
  g("MARECHAL HERMES", 19085, -22.860396, -43.370572),
  g("PARQUE MARE", 167, -22.857359, -43.245347),
  g("SUMARE", 87, -22.933626, -43.212395),
  g("VILA DO PINHEIRO MARE", 1581, -22.867074, -43.236843),
];

describe("normalizarLocalidadeBairro", () => {
  it("sem acento, maiusculo, espacos colapsados (mesma chave de localidade_norm)", () => {
    expect(normalizarLocalidadeBairro("  Vila  do Pinheiro (Maré) ")).toBe("VILA DO PINHEIRO (MARE)");
  });
});

describe("escolherGrupoBairro (F4-01 GEO-26)", () => {
  // O ILIKE '%MARE%' antigo juntava 15 localidades (74.629 pontos, Marechal
  // Hermes incluso) e o centroide ficava a 8,1 km do da Mare.
  it("MARE (Rio): igualdade -- so' a localidade MARE, nunca Marechal Hermes/Sumare", () => {
    expect(escolherGrupoBairro("MARE", RIO_MARE)).toMatchObject({ grupo: { localidade_norm: "MARE", n_pontos: 39142 }, modo: "igual" });
  });

  it("CANAA (Arraial do Cabo): sem igualdade, unica localidade que contem a palavra -> VILA CANAA", () => {
    const r = escolherGrupoBairro("CANAA", [g("VILA CANAA", 1944, -22.977282, -42.027725)]);
    expect(r).toMatchObject({ grupo: { localidade_norm: "VILA CANAA" }, modo: "contido" });
  });

  it("MORADA (Barra Mansa): varias localidades contem a palavra -> nenhuma (ambiguo, antes misturava 7)", () => {
    const r = escolherGrupoBairro("MORADA", [
      g("MORADA DA COLONIA I", 89, -22.535184, -44.201169),
      g("MORADA DA COLONIA II", 190, -22.535137, -44.217025),
      g("MORADA DA GRANJA I", 313, -22.536327, -44.11946),
      g("MORADA DO VALE", 421, -22.532142, -44.199087),
      g("MORADA VERDE", 279, -22.542641, -44.198187),
    ]);
    expect(r).toBeNull();
  });

  it("palavra so' como pedaco de outra palavra nao conta (ABRAAO x ABRAAOZINHO)", () => {
    const r = escolherGrupoBairro("ABRAAO", [g("ABRAAOZINHO", 7, -23.14, -44.15), g("PRAIA DO ABRAAOZINHO", 19, -23.13, -44.15), g("VILA DO ABRAAO", 1662, -23.137, -44.168)]);
    expect(r).toMatchObject({ grupo: { localidade_norm: "VILA DO ABRAAO" }, modo: "contido" });
  });

  it("bairro cortado no romaneio (GRANJA DOS CAVALEIRO, Macae): unica localidade que comeca com ele -> GRANJA DOS CAVALEIROS", () => {
    const r = escolherGrupoBairro("GRANJA DOS CAVALEIRO", [g("GRANJA DOS CAVALEIROS", 2335, -22.399445, -41.816803)]);
    expect(r).toMatchObject({ grupo: { localidade_norm: "GRANJA DOS CAVALEIROS" }, modo: "prefixo" });
  });

  it("prefixo curto (< 10 letras) nao completa sozinho", () => {
    expect(escolherGrupoBairro("JARDIM", [g("JARDIMXYZ", 50, -22, -43)])).toBeNull();
  });

  it("igualdade com menos de 10 pontos nao vale; cai na unica que contem (SAO JOAO DA BARRA, 7 pontos)", () => {
    const r = escolherGrupoBairro("SAO JOAO DA BARRA", [g("NOVA SAO JOAO DA BARRA", 832, -21.639004, -41.044754), g("SAO JOAO DA BARRA", 7, -21.635913, -41.039077)]);
    expect(r).toMatchObject({ grupo: { localidade_norm: "NOVA SAO JOAO DA BARRA" }, modo: "contido" });
  });

  it("sem grupo nenhum: null", () => {
    expect(escolherGrupoBairro("INEXISTENTE", [])).toBeNull();
  });
});

// Fake do cliente Supabase: registra as consultas e responde por tabela.
function fakeAdmin(opts: {
  tabela?: "existe" | "nao_existe" | "timeout";
  igual?: GrupoBairro[];
  contem?: GrupoBairro[];
  legado?: { lat: number; lng: number }[];
  legadoTimeout?: boolean;
}) {
  const consultas: { tabela: string; filtros: [string, string, unknown][]; sinal: boolean }[] = [];
  const admin = {
    from(tabela: string) {
      const q = { tabela, filtros: [] as [string, string, unknown][], sinal: false };
      consultas.push(q);
      const b: Record<string, unknown> = {};
      for (const op of ["eq", "ilike", "like"]) b[op] = (col: string, v: unknown) => { q.filtros.push([op, col, v]); return b; };
      b.select = () => b;
      b.limit = () => b;
      b.order = () => b;
      b.abortSignal = (s: AbortSignal) => { q.sinal = true; (b as { _s?: AbortSignal })._s = s; return b; };
      b.then = (ok: (v: unknown) => unknown, err?: (e: unknown) => unknown) => {
        const exec = async () => {
          if (tabela === "cnefe_bairros_centroide") {
            if (opts.tabela === "nao_existe") return { data: null, error: { code: "PGRST205", message: "Could not find the table 'public.cnefe_bairros_centroide' in the schema cache" } };
            if (opts.tabela === "timeout") return { data: null, error: { code: "20", message: "AbortError: This operation was aborted" } };
            const ehIgual = q.filtros.some(([op, col]) => op === "eq" && col === "localidade_norm");
            return { data: ehIgual ? (opts.igual ?? []) : (opts.contem ?? []), error: null };
          }
          if (tabela === "cnefe_enderecos") {
            if (opts.legadoTimeout) return { data: null, error: { code: "20", message: "AbortError: This operation was aborted" } };
            return { data: opts.legado ?? [], error: null };
          }
          return { data: [], error: null };
        };
        return exec().then(ok, err);
      };
      return b;
    },
  };
  return { admin, consultas };
}

describe("buscarCentroideBairro (F4-01 GEO-26)", () => {
  it("com a tabela cnefe_bairros_centroide: igualdade por (municipio_codigo, localidade_norm), sem tocar em cnefe_enderecos", async () => {
    const { admin, consultas } = fakeAdmin({ tabela: "existe", igual: [g("MARE", 39142, -22.864185, -43.240363)] });
    const r = await buscarCentroideBairro(admin as never, "Maré", "3304557");
    expect(r).toEqual({ status: "ok", data: { lat: -22.864185, lng: -43.240363, qtd: 39142 } });
    expect(consultas.map((c) => c.tabela)).toEqual(["cnefe_bairros_centroide"]);
    expect(consultas[0].filtros).toEqual([["eq", "municipio_codigo", "3304557"], ["eq", "localidade_norm", "MARE"]]);
    expect(consultas[0].sinal).toBe(true);
  });

  it("sem igualdade: segunda consulta so' no municipio, por localidade que contem o bairro", async () => {
    const { admin, consultas } = fakeAdmin({ tabela: "existe", igual: [], contem: [g("VILA CANAA", 1944, -22.977282, -42.027725)] });
    const r = await buscarCentroideBairro(admin as never, "CANAA", "3300258");
    expect(r).toEqual({ status: "ok", data: { lat: -22.977282, lng: -42.027725, qtd: 1944 } });
    expect(consultas[1].filtros).toEqual([["eq", "municipio_codigo", "3300258"], ["ilike", "localidade_norm", "%CANAA%"]]);
  });

  it("migration ainda nao aplicada (PGRST205): cai na consulta antiga (ILIKE em cnefe_enderecos, media no Node), agora com prazo", async () => {
    const { admin, consultas } = fakeAdmin({ tabela: "nao_existe", legado: [{ lat: -22.4, lng: -41.8 }, { lat: -22.6, lng: -41.6 }] });
    const r = await buscarCentroideBairro(admin as never, "GRANJA DOS CAVALEIRO", "3302403");
    expect(r.status).toBe("ok");
    expect(r.status === "ok" && r.data).toMatchObject({ qtd: 2 });
    expect(r.status === "ok" && r.data!.lat).toBeCloseTo(-22.5, 6);
    const legado = consultas.find((c) => c.tabela === "cnefe_enderecos")!;
    expect(legado.filtros).toEqual([["eq", "municipio_codigo", "3302403"], ["ilike", "localidade", "%GRANJA DOS CAVALEIRO%"]]);
    expect(legado.sinal).toBe(true);
  });

  it("consulta antiga estourando o prazo: status timeout (o chamador marca o endereco como incompleto)", async () => {
    const erro = vi.spyOn(console, "error").mockImplementation(() => {});
    const { admin } = fakeAdmin({ tabela: "nao_existe", legadoTimeout: true });
    const r = await buscarCentroideBairro(admin as never, "CAMPO GRANDE", "3304557");
    expect(r.status).toBe("timeout");
    erro.mockRestore();
  });

  it("tabela nova estourando o prazo: timeout, sem cair na consulta antiga de 50 s", async () => {
    const erro = vi.spyOn(console, "error").mockImplementation(() => {});
    const { admin, consultas } = fakeAdmin({ tabela: "timeout" });
    const r = await buscarCentroideBairro(admin as never, "CAMPO GRANDE", "3304557");
    expect(r.status).toBe("timeout");
    expect(consultas.some((c) => c.tabela === "cnefe_enderecos")).toBe(false);
    erro.mockRestore();
  });
});
