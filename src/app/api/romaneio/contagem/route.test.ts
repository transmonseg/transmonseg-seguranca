import { describe, it, expect, vi, beforeEach } from "vitest";

let resultado: { count: number | null; error: unknown } = { count: 0, error: null };
// F2-04: contagem da RQ soma as linhas sem veiculo gravadas pela ponte da RQ.
let contagemPorConsulta: ((f: [string, unknown][]) => number) | null = null;
const consultas: [string, unknown][][] = [];
const filtros: [string, unknown][] = [];
const filtrosCliente: [string, unknown][] = [];
let colunasSelecionadas = "";
let clienteDoCod: { id: string } | null = { id: "cli-nutry" };
vi.mock("@/lib/supabase/admin", () => ({
  createAdminClient: () => ({
    from: (tabela: string) => {
      const q: Record<string, unknown> = {};
      const ehClientes = tabela === "clientes";
      const meus: [string, unknown][] = [];
      if (!ehClientes) consultas.push(meus);
      q.is = (c: string, v: unknown) => { meus.push([`is:${c}`, v]); return q; };
      q.like = (c: string, v: unknown) => { meus.push([`like:${c}`, v]); return q; };
      q.select = (cols: string) => { if (!ehClientes) colunasSelecionadas = cols; return q; };
      q.eq = (c: string, v: unknown) => { (ehClientes ? filtrosCliente : filtros).push([c, v]); if (!ehClientes) meus.push([c, v]); return q; };
      q.maybeSingle = async () => ({ data: clienteDoCod, error: null });
      q.then = (ok: (r: unknown) => unknown) => Promise.resolve(contagemPorConsulta ? { count: contagemPorConsulta(meus), error: null } : resultado).then(ok);
      return q;
    },
  }),
}));

import { GET } from "./route";

const req = (qs: string, chave = "segredo") =>
  new Request(`http://x/api/romaneio/contagem${qs}`, { headers: { "x-motor-key": chave } });

describe("GET /api/romaneio/contagem", () => {
  beforeEach(() => {
    process.env.MOTOR_SECRET = "segredo"; resultado = { count: 0, error: null };
    filtros.length = 0; filtrosCliente.length = 0; colunasSelecionadas = ""; clienteDoCod = { id: "cli-nutry" };
    contagemPorConsulta = null; consultas.length = 0;
  });

  it("sem a chave da ponte: 401", async () => {
    expect((await GET(req("?data=2026-10-10", "errada"))).status).toBe(401);
  });

  it("data ausente ou invalida: 400", async () => {
    expect((await GET(req(""))).status).toBe(400);
    expect((await GET(req("?data=10/10"))).status).toBe(400);
  });

  it("devolve {data, linhas} so' do modo real e origem romaneio", async () => {
    resultado = { count: 42, error: null };
    const r = await GET(req("?data=2026-10-10"));
    expect(await r.json()).toEqual({ data: "2026-10-10", linhas: 42 });
    expect(filtros).toEqual([["romaneio_data", "2026-10-10"], ["modo_teste", false], ["origem", "romaneio"]]);
  });

  it("erro de consulta: 500, nunca zero", async () => {
    resultado = { count: null, error: { message: "x" } };
    expect((await GET(req("?data=2026-10-10"))).status).toBe(500);
  });

  // KP-04 (auditoria 15/10): a contagem somava Nutry + Rio Quality, entao o
  // reparo e o aviso diario nunca viam a Nutry sem romaneio.
  it("sem cod: conta o dia inteiro como antes (KPI antigo continua funcionando)", async () => {
    resultado = { count: 7, error: null };
    await GET(req("?data=2026-10-15"));
    expect(colunasSelecionadas).toBe("id");
    expect(filtros.some(([c]) => c === "veiculos.cliente_id")).toBe(false);
  });

  it("com cod: conta so' as linhas de veiculos do cliente", async () => {
    resultado = { count: 5, error: null };
    const r = await GET(req("?data=2026-10-15&cod=4096"));
    expect(await r.json()).toEqual({ data: "2026-10-15", linhas: 5 });
    expect(colunasSelecionadas).toContain("veiculos!inner");
    expect(filtrosCliente).toContainEqual(["cod_user_unitrac", "4096"]);
    expect(filtros).toContainEqual(["veiculos.cliente_id", "cli-nutry"]);
  });

  it("cod desconhecido: 404, nunca conta o dia inteiro", async () => {
    clienteDoCod = null;
    expect((await GET(req("?data=2026-10-15&cod=9999"))).status).toBe(404);
  });

  it("cod malformado: 400", async () => {
    expect((await GET(req("?data=2026-10-15&cod=abc"))).status).toBe(400);
  });

  // F2-04: o tick do KPI compara a contagem com as NFs do dia da RQ. 23/10:
  // 2.803 linhas na frota da RQ + 21 de placas fora do cadastro (veiculo nulo).
  it("cod + rq=1: soma as linhas sem veiculo enviadas pela ponte da RQ (formato antigo e novo)", async () => {
    clienteDoCod = { id: "cli-rq" };
    contagemPorConsulta = f => f.some(([c]) => c === "veiculos.cliente_id") ? 2803
      : f.some(([c, v]) => c === "enviado_por" && v === "cron-fusion (pelo Ao vivo do KPI)") ? 21
      : f.some(([c]) => c === "like:enviado_por") ? 3 : 999;
    const r = await GET(req("?data=2026-10-23&cod=598&rq=1"));
    expect(await r.json()).toEqual({ data: "2026-10-23", linhas: 2827 });
    const semVeiculo = consultas.filter(f => f.some(([c]) => c === "is:veiculo_id"));
    expect(semVeiculo).toHaveLength(2);
    for (const f of semVeiculo) expect(f).toEqual(expect.arrayContaining([["romaneio_data", "2026-10-23"], ["modo_teste", false], ["origem", "romaneio"]]));
    expect(semVeiculo[1]).toContainEqual(["like:enviado_por", "%(Rio Quality pelo Ao vivo do KPI)"]);
  });

  it("rq=1 sem cod: 400 (precisa saber qual frota)", async () => {
    expect((await GET(req("?data=2026-10-23&rq=1"))).status).toBe(400);
  });
});
