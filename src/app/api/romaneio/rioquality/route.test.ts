// src/app/api/romaneio/rioquality/route.test.ts
//
// Endpoint estruturado que recebe o romaneio da Rio Quality do KPI
// (servidor-a-servidor, x-motor-key), com a DATA RECEBIDA (nunca inferida).
// F2-04 (plano mestre 23/10): a NF e' a chave; modo "substituir" troca o dia
// da RQ inteiro e nunca encosta na Nutry. Banco falso em memoria.
import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("@/lib/romaneio", () => ({
  normalizarPlaca: (p: string) => { const l = p.trim().toUpperCase(); return l.includes("-") || l.length !== 7 ? l : `${l.slice(0, 3)}-${l.slice(3)}`; },
}));

const mockGetUser = vi.fn();
vi.mock("@/lib/supabase/server", () => ({ createClient: async () => ({ auth: { getUser: mockGetUser } }) }));

type Linha = Record<string, unknown>;
const db = {
  clientes: [] as Linha[],
  veiculos: [] as Linha[],
  pontos: [] as Linha[],
  temPedidoErp: false,
  temPresencaMetodo: false,
  upserts: [] as { linhas: Linha[]; onConflict?: string; ignoreDuplicates?: boolean }[],
  deletes: [] as string[][],
};

function consulta(tabela: string) {
  const filtros: ((r: Linha) => boolean)[] = [];
  let op: "select" | "delete" = "select";
  let cols = "";
  let faixa: [number, number] | null = null;
  const q: Record<string, unknown> = {};
  const linhasDaTabela = () => (tabela === "clientes" ? db.clientes : tabela === "veiculos" ? db.veiculos : db.pontos);
  q.select = (c: string) => { if (op === "select") cols = c; return q; };
  q.eq = (c: string, v: unknown) => { filtros.push(r => r[c] === v); return q; };
  q.in = (c: string, vs: unknown[]) => { filtros.push(r => vs.includes(r[c])); return q; };
  q.order = () => q;
  q.limit = () => q;
  q.range = (a: number, b: number) => { faixa = [a, b]; return q; };
  q.delete = () => { op = "delete"; return q; };
  q.upsert = (linhas: Linha[], o?: { onConflict?: string; ignoreDuplicates?: boolean }) => {
    db.upserts.push({ linhas, onConflict: o?.onConflict, ignoreDuplicates: o?.ignoreDuplicates });
    for (const l of linhas) {
      if (o?.onConflict === "id") { const r = db.pontos.find(p => p.id === l.id); if (r) Object.assign(r, l); }
      else db.pontos.push({ id: `novo-${db.pontos.length}`, criado_em: "2026-10-24T10:00:00Z", presenca_confirmada_em: null, ...l });
    }
    return { select: async () => ({ data: linhas.map((_, i) => ({ id: `x${i}` })), error: null }), then: (ok: (r: unknown) => unknown) => Promise.resolve({ error: null }).then(ok) };
  };
  q.maybeSingle = async () => ({ data: linhasDaTabela().filter(r => filtros.every(f => f(r)))[0] ?? null, error: null });
  q.then = (ok: (r: unknown) => unknown) => {
    if (tabela === "romaneio_pontos" && cols.includes("pedido_erp") && !db.temPedidoErp) {
      return Promise.resolve({ data: null, error: { code: "42703", message: "column romaneio_pontos.pedido_erp does not exist" } }).then(ok);
    }
    if (tabela === "romaneio_pontos" && cols.includes("presenca_metodo") && !db.temPresencaMetodo) {
      return Promise.resolve({ data: null, error: { code: "42703", message: "column romaneio_pontos.presenca_metodo does not exist" } }).then(ok);
    }
    let rs = linhasDaTabela().filter(r => filtros.every(f => f(r)));
    if (op === "delete") {
      db.deletes.push(rs.map(r => r.id as string));
      db.pontos = db.pontos.filter(p => !rs.includes(p));
      return Promise.resolve({ data: rs.map(r => ({ id: r.id })), error: null }).then(ok);
    }
    if (faixa) rs = rs.slice(faixa[0], faixa[1] + 1);
    return Promise.resolve({ data: rs.map(r => ({ ...r })), error: null }).then(ok);
  };
  return q;
}
vi.mock("@/lib/supabase/admin", () => ({ createAdminClient: () => ({ from: (t: string) => consulta(t) }) }));

async function postJson(body: unknown, headers: Record<string, string> = {}) {
  const { POST } = await import("./route");
  const req = new Request("http://localhost/api/romaneio/rioquality", {
    method: "POST", headers: { "content-type": "application/json", ...headers },
    body: JSON.stringify(body),
  });
  const res = await POST(req);
  return { status: res.status, json: (await res.json()) as Record<string, unknown> };
}

const pontoBase = { romaneio_data: "2026-10-23", modo_teste: false, origem: "romaneio", lat: null, lng: null, geocode_status: "pendente", presenca_confirmada_em: null, cliente_codigo: null, pedido_erp: null, criado_em: "2026-10-23T08:01:00Z" };
const CHAVE = { "x-motor-key": "segredo" };

describe("POST /api/romaneio/rioquality", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    process.env.MOTOR_SECRET = "segredo";
    mockGetUser.mockResolvedValue({ data: { user: null } });
    db.clientes = [{ id: "cli-rq", cod_user_unitrac: "598" }, { id: "cli-nutry", cod_user_unitrac: "4096" }];
    db.veiculos = [
      { id: "v1", placa: "RQU-8A12", cliente_id: "cli-rq" },
      { id: "v-lnh", placa: "LNH-9C10", cliente_id: "cli-rq" },
      { id: "v-lun", placa: "LUN-8C28", cliente_id: "cli-rq" },
      { id: "v-nutry", placa: "RIU-1I75", cliente_id: "cli-nutry" },
    ];
    db.pontos = [];
    db.temPedidoErp = false;
    db.temPresencaMetodo = false;
    db.upserts = [];
    db.deletes = [];
  });

  it("401 sem x-motor-key", async () => {
    const r = await postJson({ data: "2026-10-13", linhas: [] });
    expect(r.status).toBe(401);
  });

  it("F2-04-b: login do monitoramento sem x-motor-key (ex.: conta só da Nutry) nao apaga nem grava o dia da RQ", async () => {
    // Caso da revisao: operador ericanutrymax (operadores.cliente_id = Nutry)
    // com o cookie de sessao manda {linhas: [], modo: 'substituir'}.
    mockGetUser.mockResolvedValue({ data: { user: { id: "u-erica", email: "ericanutrymax@x.com" } } });
    db.pontos = [{ ...pontoBase, id: "rq", placa: "LNH-9C10", veiculo_id: "v-lnh", nf: "6081346", cliente_nome: "L", endereco_bruto: "E", enviado_por: "cron-fusion (pelo Ao vivo do KPI)", presenca_confirmada_em: "2026-10-23T12:00:00Z" }];
    const r = await postJson({ data: "2026-10-23", modo: "substituir", linhas: [] });
    expect(r.status).toBe(401);
    expect(db.deletes).toEqual([]);
    expect(db.upserts).toEqual([]);
    expect(db.pontos).toHaveLength(1);
  });

  it("400 se payload inválido (sem data ou linhas não-array)", async () => {
    const r = await postJson({ linhas: "x" }, CHAVE);
    expect(r.status).toBe(400);
  });

  it("formato antigo do KPI (sem modo): insere com a data recebida, casa placa->veiculo e marca o enviado_por da RQ", async () => {
    const r = await postJson(
      { data: "2026-10-13", linhas: [
        { placa: "RQU8A12", nf: "123", clienteNome: "LOJA A", enderecoBruto: "RUA X, 1" },
        { placa: "RQV9Z99", nf: "456", clienteNome: "LOJA B", enderecoBruto: "RUA Y, 2" },
      ] },
      { ...CHAVE, "x-enviado-por": "cron-fusion" },
    );
    expect(r.status).toBe(200);
    expect(r.json).toMatchObject({ ok: true, linhasInseridas: 2, placasNaoEncontradas: ["RQV-9Z99"] });
    const ins = db.upserts.find(u => u.onConflict !== "id")!;
    expect(ins.onConflict).toBe("romaneio_data,placa,nf,modo_teste,origem");
    expect(ins.linhas[0]).toMatchObject({
      romaneio_data: "2026-10-13", placa: "RQU-8A12", nf: "123", veiculo_id: "v1", lat: null, lng: null,
      geocode_status: "pendente", modo_teste: false, origem: "romaneio", enviado_por: "cron-fusion (Rio Quality pelo Ao vivo do KPI)",
    });
    expect(ins.linhas[0]).not.toHaveProperty("pedido_erp"); // coluna ainda nao existe
    expect(ins.linhas[1]).toMatchObject({ placa: "RQV-9Z99", veiculo_id: null });
  });

  it("upload manual (substituir): troca o dia da RQ e deixa a Nutry intacta, inclusive a Nutry sem veiculo", async () => {
    db.pontos = [
      { ...pontoBase, id: "rq-fusion", placa: "LNH-9C10", veiculo_id: "v-lnh", nf: "6081346", cliente_nome: "LOJA", endereco_bruto: "RUA IMBOASSU, SAO GONCALO - RJ", enviado_por: "cron-fusion (pelo Ao vivo do KPI)", presenca_confirmada_em: "2026-10-23T12:00:00Z" },
      { ...pontoBase, id: "rq-velho", placa: "LUN-8C28", veiculo_id: "v-lun", nf: "6081999", cliente_nome: "X", endereco_bruto: "Y", enviado_por: "cron-fusion (pelo Ao vivo do KPI)" },
      { ...pontoBase, id: "rq-sem-veiculo", placa: "XYZ-1A23", veiculo_id: null, nf: "6082000", cliente_nome: "X", endereco_bruto: "Y", enviado_por: "cron-fusion (pelo Ao vivo do KPI)" },
      { ...pontoBase, id: "nutry", placa: "RIU-1I75", veiculo_id: "v-nutry", nf: "6081999", cliente_nome: "N", endereco_bruto: "N", enviado_por: "transmonseg.25@gmail.com (pelo Ao vivo do KPI)" },
      { ...pontoBase, id: "nutry-sem-veiculo", placa: "AAA-0A00", veiculo_id: null, nf: "777", cliente_nome: "N", endereco_bruto: "N", enviado_por: "transmonseg.25@gmail.com (pelo Ao vivo do KPI)" },
      { ...pontoBase, id: "outro-dia", romaneio_data: "2026-10-22", placa: "LNH-9C10", veiculo_id: "v-lnh", nf: "1", cliente_nome: "X", endereco_bruto: "Y", enviado_por: "cron-fusion (pelo Ao vivo do KPI)" },
    ];
    const r = await postJson({ data: "2026-10-23", modo: "substituir", linhas: [
      { placa: "LNH9C10", nf: "5557757", pedidoErp: "6081346", clienteCodigo: "27946", clienteNome: "LOJA", rua: "RUA IMBOASSU", bairro: "ALCANTARA", cidade: "SAO GONCALO", uf: "RJ", lat: -22.82, lng: -43.0 },
      { placa: "LUN8C28", nf: "5557758", pedidoErp: "6082001", clienteNome: "NOVA", rua: "RUA Z", bairro: "B", cidade: "NITEROI", uf: "RJ" },
    ] }, { ...CHAVE, "x-enviado-por": "erica@x.com" });
    expect(r.status).toBe(200);
    expect(r.json).toMatchObject({ ok: true, linhasInseridas: 1, linhasAtualizadas: 1, linhasApagadas: 2, linhasDoDia: 2 });
    const ids = db.pontos.map(p => p.id).sort();
    expect(ids).toEqual(["novo-4", "nutry", "nutry-sem-veiculo", "outro-dia", "rq-fusion"]);
    const atual = db.pontos.find(p => p.id === "rq-fusion")!;
    expect(atual).toMatchObject({
      nf: "5557757", endereco_bruto: "RUA IMBOASSU, - ALCANTARA, SAO GONCALO - RJ", lat: -22.82, lng: -43.0, geocode_status: "ok",
      enviado_por: "erica@x.com (Rio Quality pelo Ao vivo do KPI)", presenca_confirmada_em: "2026-10-23T12:00:00Z",
    });
  });

  it("F2-REV-09: substituir nao apaga ponto da Nutry cuja placa caiu num veiculo da frota da RQ", async () => {
    // A Nutry subiu a placa LNH-9C10 (frota da RQ) pelo Ao vivo do KPI. A cada
    // tick da Fusion o substituir apagava essa linha (veiculo_id na frota RQ).
    db.pontos = [
      { ...pontoBase, id: "rq", placa: "LUN-8C28", veiculo_id: "v-lun", nf: "6081346", cliente_nome: "L", endereco_bruto: "E", enviado_por: "cron-fusion (pelo Ao vivo do KPI)" },
      { ...pontoBase, id: "nutry-na-frota-rq", placa: "LNH-9C10", veiculo_id: "v-lnh", nf: "2432618", cliente_nome: "CHURRASCO", endereco_bruto: "N", enviado_por: "ericanutrymax (pelo Ao vivo do KPI)", presenca_confirmada_em: "2026-10-23T12:00:00Z" },
    ];
    const r = await postJson({ data: "2026-10-23", modo: "substituir", linhas: [
      { placa: "LUN8C28", nf: "6081346", clienteNome: "L", enderecoBruto: "E" },
    ] }, { ...CHAVE, "x-enviado-por": "cron-fusion" });
    expect(r.status).toBe(200);
    expect(r.json).toMatchObject({ ok: true, linhasApagadas: 0 });
    expect(db.pontos.map(p => p.id).sort()).toEqual(["nutry-na-frota-rq", "rq"]);
    expect(db.pontos.find(p => p.id === "nutry-na-frota-rq")).toMatchObject({ presenca_confirmada_em: "2026-10-23T12:00:00Z" });
  });

  it("NF reatribuida a outro carro (MON-10): 1 linha por NF, placa trocada e presenca zerada", async () => {
    db.pontos = [{ ...pontoBase, id: "a", placa: "LNH-9C10", veiculo_id: "v-lnh", nf: "6063481", cliente_nome: "L", endereco_bruto: "E", enviado_por: "cron-fusion (pelo Ao vivo do KPI)", presenca_confirmada_em: "2026-10-20T09:00:00Z" }];
    const r = await postJson({ data: "2026-10-23", linhas: [{ placa: "LUN8C28", nf: "6063481", clienteNome: "L", enderecoBruto: "E" }] }, { ...CHAVE, "x-enviado-por": "cron-fusion" });
    expect(r.status).toBe(200);
    expect(db.pontos).toHaveLength(1);
    expect(db.pontos[0]).toMatchObject({ placa: "LUN-8C28", veiculo_id: "v-lun", presenca_confirmada_em: null });
    expect(db.upserts.find(u => u.onConflict === "id")).toBeDefined();
  });

  it("F2-10-a: com a coluna presenca_metodo (088), NF que muda de carro zera a presenca e o metodo juntos", async () => {
    db.temPresencaMetodo = true;
    db.pontos = [{ ...pontoBase, id: "a", placa: "LNH-9C10", veiculo_id: "v-lnh", nf: "6072109", cliente_nome: "L", endereco_bruto: "E", enviado_por: "cron-fusion (pelo Ao vivo do KPI)", presenca_confirmada_em: "2026-10-20T13:00:00Z", presenca_metodo: "vizinhanca" }];
    const r = await postJson({ data: "2026-10-23", linhas: [{ placa: "LUN8C28", nf: "6072109", clienteNome: "L", enderecoBruto: "E" }] }, { ...CHAVE, "x-enviado-por": "cron-fusion" });
    expect(r.status).toBe(200);
    expect(db.pontos[0]).toMatchObject({ placa: "LUN-8C28", presenca_confirmada_em: null, presenca_metodo: null });
  });

  it("F2-04-a: substituir com linhas vazias nao apaga o dia da RQ (nem a presenca) e devolve o aviso", async () => {
    db.pontos = [
      { ...pontoBase, id: "rq1", placa: "LNH-9C10", veiculo_id: "v-lnh", nf: "6081346", cliente_nome: "L", endereco_bruto: "E", enviado_por: "cron-fusion (pelo Ao vivo do KPI)", presenca_confirmada_em: "2026-10-23T12:00:00Z" },
      { ...pontoBase, id: "rq2", placa: "LUN-8C28", veiculo_id: "v-lun", nf: "6081999", cliente_nome: "X", endereco_bruto: "Y", enviado_por: "cron-fusion (pelo Ao vivo do KPI)" },
    ];
    const r = await postJson({ data: "2026-10-23", modo: "substituir", linhas: [] }, CHAVE);
    expect(r.status).toBe(200);
    expect(r.json).toMatchObject({ ok: true, linhasApagadas: 0, substituicaoRecusada: true });
    expect(String(r.json.aviso)).toMatch(/sem linhas/);
    expect(db.deletes).toEqual([]);
    expect(db.pontos.map(p => p.id)).toEqual(["rq1", "rq2"]);
  });

  it("F2-04-a: substituir encolhido (1 de 25 NFs) acrescenta/corrige mas nao apaga o resto", async () => {
    db.pontos = Array.from({ length: 25 }, (_, i) => ({ ...pontoBase, id: `rq${i}`, placa: "LNH-9C10", veiculo_id: "v-lnh", nf: String(6081000 + i), cliente_nome: "L", endereco_bruto: "E", enviado_por: "cron-fusion (pelo Ao vivo do KPI)" }));
    const r = await postJson({ data: "2026-10-23", modo: "substituir", linhas: [{ placa: "LUN8C28", nf: "6081000", clienteNome: "L", enderecoBruto: "E" }] }, CHAVE);
    expect(r.json).toMatchObject({ ok: true, linhasApagadas: 0, linhasAtualizadas: 1, substituicaoRecusada: true });
    expect(db.pontos).toHaveLength(25);
    expect(db.pontos.find(p => p.id === "rq0")).toMatchObject({ placa: "LUN-8C28" });
  });

  it("com a coluna pedido_erp (migration 089), o pedido e' gravado", async () => {
    db.temPedidoErp = true;
    await postJson({ data: "2026-10-23", modo: "substituir", linhas: [{ placa: "LNH9C10", nf: "5557757", pedidoErp: "6081346", clienteNome: "L", rua: "R", cidade: "RIO DE JANEIRO", uf: "RJ" }] }, CHAVE);
    expect(db.pontos[0]).toMatchObject({ nf: "5557757", pedido_erp: "6081346" });
  });

  it("simular: devolve o plano e nao grava nada", async () => {
    db.pontos = [{ ...pontoBase, id: "a", placa: "LNH-9C10", veiculo_id: "v-lnh", nf: "1", cliente_nome: "L", endereco_bruto: "E", enviado_por: "cron-fusion (pelo Ao vivo do KPI)" }];
    const r = await postJson({ data: "2026-10-23", modo: "substituir", simular: true, linhas: [{ placa: "LUN8C28", nf: "2", clienteNome: "L", enderecoBruto: "E" }] }, CHAVE);
    expect(r.json).toMatchObject({ ok: true, simulado: true, inserir: 1, atualizar: 0, apagar: 1 });
    expect(db.upserts).toEqual([]);
    expect(db.deletes).toEqual([]);
    expect(db.pontos).toHaveLength(1);
  });
});
