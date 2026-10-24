import { describe, it, expect, vi, beforeEach } from "vitest";

const resultado = { data: [] as { id: string }[] };
const chamadas: { tabela?: string; filtros: [string, unknown][] } = { filtros: [] };

vi.mock("@/lib/supabase/admin", () => ({
  createAdminClient: () => ({
    from: (tabela: string) => {
      chamadas.tabela = tabela;
      const b: Record<string, unknown> = {};
      b.select = () => b;
      b.eq = (c: string, v: unknown) => { chamadas.filtros.push([c, v]); return b; };
      b.not = (c: string, op: string, v: unknown) => { chamadas.filtros.push([`not.${c}.${op}`, v]); return b; };
      b.in = (c: string, v: unknown) => { chamadas.filtros.push([c, v]); return Promise.resolve(resultado); };
      // select().eq() sem .in() (veiculos do cliente) também resolve
      (b as { then?: unknown }).then = (res: (v: unknown) => unknown) => Promise.resolve(resultado).then(res);
      return b;
    },
  }),
}));

import { ehCentral, idsAlertaPermitidos, idsVeiculosDoCliente } from "./acesso-guardas";

const NUTRY = "cfcb52f5-fd01-47c7-988c-d13a10f0d8fd";

beforeEach(() => { chamadas.filtros = []; chamadas.tabela = undefined; resultado.data = []; });

describe("acesso-guardas", () => {
  it("central devolve os ids como vieram, sem consultar o banco", async () => {
    expect(await idsAlertaPermitidos({ tipo: "todos" }, "alertas", ["a", "b"])).toEqual(["a", "b"]);
    expect(chamadas.tabela).toBeUndefined();
    expect(ehCentral({ tipo: "todos" })).toBe(true);
    expect(ehCentral({ tipo: "um", clienteId: NUTRY })).toBe(false);
  });
  it("sem operador não passa nada", async () => {
    expect(await idsAlertaPermitidos({ tipo: "nenhum" }, "alertas", ["a"])).toEqual([]);
    expect(await idsVeiculosDoCliente({ tipo: "nenhum" })).toEqual([]);
  });
  it("conta de um cliente só recebe os ids do cliente dela", async () => {
    resultado.data = [{ id: "b" }];
    const ok = await idsAlertaPermitidos({ tipo: "um", clienteId: NUTRY }, "alertas_romaneio", ["a", "b"]);
    expect(ok).toEqual(["b"]);
    expect(chamadas.tabela).toBe("alertas_romaneio");
    expect(chamadas.filtros[0]).toEqual(["cliente_id", NUTRY]);
  });
  it("R-F3-09-01: conta de cliente não age sobre alerta interno (rastreador_mudo_com_carga) em alertas_romaneio", async () => {
    resultado.data = [{ id: "b" }];
    await idsAlertaPermitidos({ tipo: "um", clienteId: NUTRY }, "alertas_romaneio", ["a", "b"]);
    // Revisao F3-07 (R2): romaneio_ausente agregado tambem e' interno.
    expect(chamadas.filtros).toContainEqual(["not.tipo.in", "(rastreador_mudo_com_carga,romaneio_ausente)"]);
  });
  it("central continua agindo sobre alerta interno; tabela alertas não ganha o filtro", async () => {
    expect(await idsAlertaPermitidos({ tipo: "todos" }, "alertas_romaneio", ["a"])).toEqual(["a"]);
    await idsAlertaPermitidos({ tipo: "um", clienteId: NUTRY }, "alertas", ["a"]);
    expect(chamadas.filtros.some(([c]) => c.startsWith("not."))).toBe(false);
  });
  it("central não tem filtro de veículos (null)", async () => {
    expect(await idsVeiculosDoCliente({ tipo: "todos" })).toBeNull();
  });
  it("lista vazia nunca consulta", async () => {
    expect(await idsAlertaPermitidos({ tipo: "um", clienteId: NUTRY }, "alertas", [])).toEqual([]);
    expect(chamadas.tabela).toBeUndefined();
  });
});
