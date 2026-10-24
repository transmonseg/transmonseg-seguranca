// F2-15 (MON-12): o KPI manda a frota da RQ (kpi_rioquality_frota) depois de
// cada varredura de cv; aqui so' entra o cv que falta. Banco falso em memoria.
import { describe, it, expect, vi, beforeEach } from "vitest";

type Linha = Record<string, unknown>;
const db = { clientes: [] as Linha[], veiculos: [] as Linha[], inserts: [] as Linha[][] };

function consulta(tabela: string) {
  const filtros: ((r: Linha) => boolean)[] = [];
  const linhas = () => (tabela === "clientes" ? db.clientes : db.veiculos);
  const q: Record<string, unknown> = {};
  q.select = () => q;
  q.eq = (c: string, v: unknown) => { filtros.push((r) => r[c] === v); return q; };
  q.or = () => q;
  q.in = (c: string, vs: unknown[]) => { filtros.push((r) => vs.includes(r[c])); return q; };
  q.maybeSingle = async () => ({ data: linhas().filter((r) => filtros.every((f) => f(r)))[0] ?? null, error: null });
  q.insert = (ls: Linha[]) => { db.inserts.push(ls); db.veiculos.push(...ls.map((l, i) => ({ id: `novo${i}`, ...l }))); return { select: async () => ({ data: ls.map((l) => ({ placa: l.placa })), error: null }) }; };
  q.then = (ok: (r: unknown) => unknown) => Promise.resolve({ data: linhas().filter((r) => filtros.every((f) => f(r))).map((r) => ({ ...r })), error: null }).then(ok);
  return q;
}
vi.mock("@/lib/supabase/admin", () => ({ createAdminClient: () => ({ from: (t: string) => consulta(t) }) }));

async function post(body: unknown, headers: Record<string, string> = {}) {
  const { POST } = await import("./route");
  const res = await POST(new Request("http://localhost/api/veiculos/rioquality", {
    method: "POST", headers: { "content-type": "application/json", ...headers }, body: JSON.stringify(body),
  }));
  return { status: res.status, json: (await res.json()) as Record<string, unknown> };
}
const CHAVE = { "x-motor-key": "segredo" };

describe("POST /api/veiculos/rioquality", () => {
  beforeEach(() => {
    process.env.MOTOR_SECRET = "segredo";
    db.clientes = [{ id: "cli-rq", cod_user_unitrac: "598" }, { id: "cli-nutry", cod_user_unitrac: "4096" }];
    db.veiculos = [
      { id: "a", cliente_id: "cli-rq", cv: "19364", placa: "LTU-7C95" },
      { id: "n", cliente_id: "cli-nutry", cv: "18785", placa: "TTT-1E20" },
    ];
    db.inserts = [];
  });
  it("401 sem a chave do motor (so' servidor-a-servidor)", async () => {
    expect((await post({ veiculos: [] })).status).toBe(401);
    expect((await post({ veiculos: [] }, { "x-motor-key": "errada" })).status).toBe(401);
  });
  it("400 sem lista de veiculos", async () => {
    expect((await post({ veiculos: "x" }, CHAVE)).status).toBe(400);
  });
  it("insere so' o cv novo da RQ e devolve o que ja' existia e os conflitos", async () => {
    const r = await post({ veiculos: [
      { placa: "LTU7C95", cv: "19364" }, { placa: "TUP0B49", cv: "24410" }, { placa: "TTT1E20", cv: "99999" },
    ] }, CHAVE);
    expect(r.status).toBe(200);
    expect(r.json).toMatchObject({ ok: true, inseridos: ["TUP-0B49"], jaExistiam: 1 });
    expect((r.json.conflitos as unknown[]).length).toBe(1);
    expect(db.inserts).toEqual([[{ cliente_id: "cli-rq", cv: "24410", placa: "TUP-0B49", perfil: "auto", ativo: true }]]);
  });
  it("simular: devolve o plano sem gravar", async () => {
    const r = await post({ simular: true, veiculos: [{ placa: "TUP0B49", cv: "24410" }] }, CHAVE);
    expect(r.json).toMatchObject({ ok: true, simulado: true, inseridos: ["TUP-0B49"] });
    expect(db.inserts).toEqual([]);
  });
});
