import { describe, it, expect } from "vitest";
import { carregarCentralInicial } from "./central-inicial";

// F1-15 (AC-02): a home baixava os alertas ativos de TODOS os clientes
// (76 MB, 3,1-3,4 s a cada abertura, quase tudo favela da Benassi) e so'
// depois filtrava no Node. Agora resolve o cliente primeiro e busca so' o
// dele, como /api/alertas ja' faz.
type Filtro = [string, string, unknown];
function supabaseFalso(tabelas: Record<string, unknown[]>) {
  const consultas: { tabela: string; filtros: Filtro[] }[] = [];
  return {
    consultas,
    from(tabela: string) {
      const c = { tabela, filtros: [] as Filtro[] };
      consultas.push(c);
      const linhas = () => (tabelas[tabela] ?? []).filter((l) =>
        c.filtros.every(([op, col, val]) => {
          const v = (l as Record<string, unknown>)[col];
          if (op === "eq") return v === val;
          if (op === "in") return (val as unknown[]).includes(v);
          return true;
        }));
      const q = {
        select: () => q,
        order: () => q,
        eq: (col: string, val: unknown) => { c.filtros.push(["eq", col, val]); return q; },
        in: (col: string, val: unknown[]) => { c.filtros.push(["in", col, val]); return q; },
        then: (ok: (r: { data: unknown[]; error: null }) => unknown) => Promise.resolve({ data: linhas(), error: null }).then(ok),
      };
      return q;
    },
  };
}

const base = {
  clientes: [
    { id: "nutry", nome: "Nutry Max", cod_user_unitrac: "4096", ativo: true },
    { id: "rq", nome: "Rio Quality", cod_user_unitrac: "5000", ativo: true },
  ],
  veiculos: [
    { id: "v1", cliente_id: "nutry", placa: "TOS-5E38", cv: "1", ativo: true },
    { id: "v2", cliente_id: "rq", placa: "RQR-2G85", cv: "2", ativo: true },
  ],
  posicoes_atuais: [{ veiculo_id: "v1", lat: 1, lng: 2 }, { veiculo_id: "v2", lat: 3, lng: 4 }],
  alertas: [
    { id: "a1", cliente_id: "nutry", veiculo_id: "v1", modo_teste: false, status: "ativo", nivel: "critico", tipo: "desvio" },
    { id: "a2", cliente_id: "benassi", veiculo_id: "vb", modo_teste: false, status: "ativo", nivel: "critico", tipo: "favela" },
    { id: "a3", cliente_id: "rq", veiculo_id: "v2", modo_teste: false, status: "ativo", nivel: "critico", tipo: "desvio" },
  ],
};

describe("carregarCentralInicial", () => {
  it("busca so' os alertas do cliente aberto (filtro no banco, nao no Node)", async () => {
    const sb = supabaseFalso(base);
    const r = await carregarCentralInicial(sb as never, { tipo: "todos" }, undefined);
    expect(r?.clienteAtivo.id).toBe("nutry");
    const alertas = sb.consultas.find((c) => c.tabela === "alertas")!;
    expect(alertas.filtros).toContainEqual(["eq", "cliente_id", "nutry"]);
    expect(r?.alertas.map((a) => a.id)).toEqual(["a1"]);
  });

  it("?cliente=5000 abre a Rio Quality e busca so' a frota e os alertas dela", async () => {
    const sb = supabaseFalso(base);
    const r = await carregarCentralInicial(sb as never, { tipo: "todos" }, "5000");
    expect(r?.clienteAtivo.id).toBe("rq");
    expect(sb.consultas.find((c) => c.tabela === "alertas")!.filtros).toContainEqual(["eq", "cliente_id", "rq"]);
    expect(sb.consultas.find((c) => c.tabela === "veiculos")!.filtros).toContainEqual(["eq", "cliente_id", "rq"]);
    expect(r?.posicoes.map((p) => p.veiculo_id)).toEqual(["v2"]);
  });

  it("conta de um cliente so' nao abre outro pelo ?cliente= (cai no dela)", async () => {
    const sb = supabaseFalso(base);
    const r = await carregarCentralInicial(sb as never, { tipo: "um", clienteId: "nutry" }, "5000");
    expect(r?.clienteAtivo.id).toBe("nutry");
    expect(r?.clientes.map((c) => c.id)).toEqual(["nutry"]);
  });

  it("sem cliente visivel: null e nenhum alerta baixado", async () => {
    const sb = supabaseFalso(base);
    const r = await carregarCentralInicial(sb as never, { tipo: "nenhum" }, undefined);
    expect(r).toBeNull();
    expect(sb.consultas.some((c) => c.tabela === "alertas")).toBe(false);
  });
});
