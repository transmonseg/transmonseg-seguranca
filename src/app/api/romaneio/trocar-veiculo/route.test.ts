import { describe, it, expect, vi, beforeEach } from "vitest";

const estado = vi.hoisted(() => ({
  chamadas: [] as { sql: string; params: unknown[] }[],
  origem: [] as { id: string; veiculo_id: string | null; nf?: string }[],
  destino: [] as { nf: string }[],
  falhaUpdate: null as Error | null,
  liberado: 0,
  encerrado: 0,
}));

vi.mock("@/lib/supabase/admin", () => ({
  createAdminClient: () => ({
    from: (t: string) => {
      if (t === "veiculos") return { select: async () => ({ data: [{ id: "v1", placa: "TTK-8A87" }, { id: "v2", placa: "RQR-2G85" }, { id: "v3", placa: "TOS-5E38" }], error: null }) };
      throw new Error(`tabela inesperada ${t}`);
    },
  }),
}));

vi.mock("pg", () => {
  class Pool {
    async connect() {
      return {
        query: async (sql: string, params: unknown[] = []) => {
          estado.chamadas.push({ sql, params });
          if (sql.includes("FOR UPDATE")) return { rows: estado.origem };
          if (sql.includes("SELECT DISTINCT nf")) return { rows: estado.destino };
          if (sql.includes("UPDATE romaneio_pontos")) {
            if (estado.falhaUpdate) throw estado.falhaUpdate;
            return { rows: (params[0] as string[]).map((id) => ({ id })) };
          }
          return { rows: [] };
        },
        release: () => { estado.liberado++; },
      };
    }
    async end() { estado.encerrado++; }
  }
  return { default: { Pool } };
});

import { POST } from "./route";

const req = (body: unknown, chave = "segredo") => new Request("http://x/api/romaneio/trocar-veiculo", { method: "POST", headers: { "x-motor-key": chave }, body: JSON.stringify(body) });
const selecao = () => estado.chamadas.find((c) => c.sql.includes("FOR UPDATE"));

describe("POST /api/romaneio/trocar-veiculo", () => {
  beforeEach(() => {
    process.env.MOTOR_SECRET = "segredo";
    estado.chamadas = []; estado.origem = [{ id: "p1", veiculo_id: "v1", nf: "2410175" }, { id: "p2", veiculo_id: "v1", nf: "2410176" }]; estado.destino = [];
    estado.falhaUpdate = null; estado.liberado = 0; estado.encerrado = 0;
  });

  it("sem a chave da ponte: 401", async () => {
    expect((await POST(req({}, "errada"))).status).toBe(401);
  });

  it("troca as entregas do dia do carro da escala pro carro real (placas sem traco tambem)", async () => {
    const r = await POST(req({ data: "2026-10-06", placaDe: "TTK8A87", placaPara: "RQR2G85" }));
    expect(await r.json()).toMatchObject({ ok: true, pontos: 2, para: "RQR-2G85" });
    const upd = estado.chamadas.find((c) => c.sql.includes("UPDATE romaneio_pontos"))!;
    expect(upd.params).toEqual([["p1", "p2"], "v2", "RQR-2G85"]);
    expect(selecao()!.params[0]).toBe("2026-10-06");
    expect(selecao()!.params[1]).toContain("TTK8A87");
    expect(estado.liberado).toBe(1);
    expect(estado.encerrado).toBe(1);
  });

  it("caso real 23/10: RQO5E38 fora do cadastro casa as linhas gravadas RQO-5E38 (pela placa compacta)", async () => {
    estado.origem = Array.from({ length: 8 }, (_, i) => ({ id: `r${i}`, veiculo_id: null, nf: String(i + 1) }));
    const r = await POST(req({ data: "2026-10-23", placaDe: "RQO5E38", placaPara: "TOS5E38", nfs: ["1", "2", "3", "4", "5", "6", "7", "8"] }));
    expect(await r.json()).toMatchObject({ ok: true, pontos: 8, para: "TOS-5E38" });
    expect(selecao()!.sql).toContain("regexp_replace(upper(placa)");
    expect(selecao()!.params[1]).toContain("RQO5E38");
  });

  it("0 linhas mudam e havia NFs: ok:false com aviso (nao mais ok:true pontos:0)", async () => {
    estado.origem = [];
    const r = await POST(req({ data: "2026-10-23", placaDe: "RQO5E38", placaPara: "TOS5E38", nfs: ["1", "2"] }));
    const j = await r.json();
    expect(j.ok).toBe(false);
    expect(j.erro).toMatch(/2 notas/);
    expect(estado.chamadas.map((c) => c.sql)).toContain("ROLLBACK");
  });

  it("placa nova fora da frota: 404", async () => {
    expect((await POST(req({ data: "2026-10-06", placaDe: "TTK8A87", placaPara: "AAA0000" }))).status).toBe(404);
  });

  it("origem e destino iguais: 400", async () => {
    expect((await POST(req({ data: "2026-10-06", placaDe: "RQR-2G85", placaPara: "RQR2G85" }))).status).toBe(400);
  });

  it("com nfs (troca mutua 07/10): so' as notas da carga mudam de carro", async () => {
    const r = await POST(req({ data: "2026-10-07", placaDe: "TTK8A87", placaPara: "RQR2G85", nfs: ["2410175", "2410176"] }));
    expect((await r.json()).ok).toBe(true);
    expect(selecao()!.params[2]).toEqual(["2410175", "2410176"]);
  });

  it("sem nfs: troca a placa inteira (sem filtro de nota)", async () => {
    await POST(req({ data: "2026-10-07", placaDe: "TTK8A87", placaPara: "RQR2G85" }));
    expect(selecao()!.params[2]).toBeNull();
  });

  it("nfs vazio: 400 (nao vira troca da placa inteira por engano)", async () => {
    expect((await POST(req({ data: "2026-10-07", placaDe: "TTK8A87", placaPara: "RQR2G85", nfs: [] }))).status).toBe(400);
  });

  it("erro no banco: 500 com ok:false, ROLLBACK e conexao devolvida", async () => {
    estado.falhaUpdate = new Error("duplicate key value");
    const r = await POST(req({ data: "2026-10-07", placaDe: "TTK8A87", placaPara: "RQR2G85" }));
    expect(r.status).toBe(500);
    expect((await r.json()).ok).toBe(false);
    expect(estado.chamadas.map((c) => c.sql)).toContain("ROLLBACK");
    expect(estado.liberado).toBe(1);
    expect(estado.encerrado).toBe(1);
  });

  // Revisao F1-05 (R1): o KPI regrava a troca de placa inteira/mutua ja'
  // aplicada; as NFs ja estao no destino. Antes: 404 "nada foi trocado" e a
  // tela pintava de vermelho um estado correto (convite a desfazer).
  it("troca refeita (as NFs ja estao no destino): ok:true pontos:0 jaNoDestino:n, nada de 404", async () => {
    estado.origem = [];
    estado.destino = [{ nf: "2410175" }, { nf: "2410176" }];
    const r = await POST(req({ data: "2026-10-07", placaDe: "TTK8A87", placaPara: "RQR2G85", nfs: ["2410175", "2410176"] }));
    expect(r.status).toBe(200);
    expect(await r.json()).toMatchObject({ ok: true, pontos: 0, jaNoDestino: 2, para: "RQR-2G85" });
  });

  it("NF nem na origem nem no destino continua 404 (nada foi trocado)", async () => {
    estado.origem = [];
    estado.destino = [];
    const r = await POST(req({ data: "2026-10-07", placaDe: "TTK8A87", placaPara: "RQR2G85", nfs: ["2410175"] }));
    expect(r.status).toBe(404);
    expect((await r.json()).ok).toBe(false);
  });

  // Revisao F1-05 (R2): KPI manda as 10 NFs da carga e so' 3 casam no MON.
  // Antes: ok:true pontos:3 e o KPI mostrava sucesso com 7 entregas no carro
  // errado. Agora a falta aparece (ok:false com a lista), sem desfazer o que
  // ja' mudou de carro.
  it("troca parcial: ok:false parcial:true com as NFs que faltam, sem esconder o que mudou", async () => {
    const nfs = Array.from({ length: 10 }, (_, i) => String(2430000 + i));
    estado.origem = nfs.slice(0, 3).map((nf, i) => ({ id: `r${i}`, veiculo_id: "v1", nf }));
    const r = await POST(req({ data: "2026-10-23", placaDe: "TTK8A87", placaPara: "RQR2G85", nfs }));
    const j = await r.json();
    expect(j.ok).toBe(false);
    expect(j.parcial).toBe(true);
    expect(j.pontos).toBe(3);
    expect(j.nfsNaoEncontradas).toEqual(nfs.slice(3));
    expect(j.erro).toMatch(/3 de 10 notas/);
    expect(j.erro).toMatch(/7 notas/);
    expect(j.erro).toContain("2430003");
    expect(estado.chamadas.map((c) => c.sql)).toContain("COMMIT");
  });
});
