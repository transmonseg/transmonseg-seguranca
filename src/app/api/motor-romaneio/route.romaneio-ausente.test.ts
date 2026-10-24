// F3-07 (MON-04): fiação do romaneio_ausente agregado no ciclo do motor. A
// regra pura está em @/lib/romaneio-ausente; aqui o ciclo roda com pool e
// admin falsos para travar o que vai para o banco e para `erros`.
import { describe, it, expect, beforeEach } from "vitest";
import { sinalizarRomaneioAusente } from "./route";

type Linha = Record<string, unknown>;
const NUTRY = "cfcb52f5-fd01-47c7-988c-d13a10f0d8fd";
const RQ = "16a32814-3402-4b2d-b974-aef0707d7a4e";
const estado = {
  frota: [] as Linha[],
  ultimo: [] as Linha[],
  alertas: [] as Linha[],
  updates: [] as { id: string; patch: Linha }[],
  inserts: [] as Linha[],
  queries: [] as { sql: string; params: unknown[] }[],
  falharPool: false,
};

function admin() {
  return {
    from: () => {
      const filtros: [string, string, unknown][] = [];
      const b: Record<string, unknown> = {};
      b.select = () => b;
      b.eq = (c: string, v: unknown) => { filtros.push(["eq", c, v]); return b; };
      b.in = (c: string, v: unknown[]) => { filtros.push(["in", c, v]); return b; };
      b.gte = (c: string, v: unknown) => { filtros.push(["gte", c, v]); return b; };
      (b as { then?: unknown }).then = (res: (v: unknown) => unknown) => {
        const data = estado.alertas.filter((a) => filtros.every(([op, c, v]) =>
          op === "eq" ? a[c] === v : op === "in" ? (v as unknown[]).includes(a[c]) : String(a[c]) >= String(v)));
        return Promise.resolve({ data, error: null }).then(res);
      };
      b.insert = (row: Linha) => { estado.inserts.push(row); return Promise.resolve({ error: null }); };
      b.update = (patch: Linha) => ({
        eq: (_c: string, id: string) => { estado.updates.push({ id, patch }); return Promise.resolve({ error: null }); },
      });
      return b;
    },
  };
}
const pool = {
  query: async (sql: string, params: unknown[]) => {
    estado.queries.push({ sql, params });
    if (estado.falharPool) throw new Error("connection terminated");
    return { rows: /max\(rp\.criado_em\)/.test(sql) ? estado.ultimo : estado.frota };
  },
};

async function ciclo(agora: Date, hoje: string): Promise<string[]> {
  const erros: string[] = [];
  await sinalizarRomaneioAusente({ pool: pool as never, admin: admin() as never, hoje, agora, erros });
  return erros;
}

const carro = (placa: string, cliente_id: string, tem_romaneio = false): Linha => ({
  veiculo_id: `v-${placa}`, cliente_id, cod_user_unitrac: cliente_id === RQ ? "598" : "4096", placa, lat: -22.85, lng: -43.3, tem_romaneio,
});

beforeEach(() => {
  estado.frota = []; estado.ultimo = []; estado.alertas = []; estado.updates = []; estado.inserts = []; estado.queries = []; estado.falharPool = false;
});

describe("sinalizarRomaneioAusente (F3-07)", () => {
  it("21/10 07:00 BRT: Nutry sem romaneio (3 carros) e RQ com Fusion fora (1) => 1 card por cliente; carro com romaneio fica fora", async () => {
    estado.frota = [carro("RQU-1B50", NUTRY), carro("OXE-7D03", NUTRY), carro("TTI-6E43", NUTRY), carro("KWM-9877", RQ), carro("LNH-8A80", RQ, true)];
    estado.ultimo = [{ cliente_id: NUTRY, ultimo_dia: "2026-10-20", ultimo_envio: new Date("2026-10-20T14:10:00Z") }];
    const erros = await ciclo(new Date("2026-10-21T10:00:00Z"), "2026-10-21");
    expect(erros).toEqual([]);
    const frota = estado.queries.find((q) => /tem_romaneio/.test(q.sql))!;
    expect((frota.params[0] as string[]).sort()).toEqual(["4096", "598"]);
    expect(frota.params.slice(1)).toEqual([60, "2026-10-21", 5000]);
    expect(estado.inserts).toHaveLength(2);
    const nutry = estado.inserts.find((i) => i.cliente_id === NUTRY)!;
    expect(nutry.tipo).toBe("romaneio_ausente");
    expect(nutry.motivo).toBe("3 carros em rota sem romaneio, último romaneio é de 20/10 (enviado há 19 h). Placas: OXE-7D03, RQU-1B50, TTI-6E43");
    const rq = estado.inserts.find((i) => i.cliente_id === RQ)!;
    expect(rq.motivo).toBe("1 carro em rota sem romaneio, nenhum envio nos últimos 7 dias. Placas: KWM-9877");
  });

  it("ciclo seguinte com o card aberto e um carro a mais => atualiza o mesmo card", async () => {
    estado.frota = [carro("RQU-1B50", NUTRY), carro("TTI-6E43", NUTRY)];
    estado.alertas = [{
      id: "c1", cliente_id: NUTRY, veiculo_id: "v-RQU-1B50", status: "ativo", tipo: "romaneio_ausente", desde: "2026-10-21T09:00:00Z",
      motivo: "x", origem_acao: null, contexto: { agregado: true, dia: "2026-10-21", placas: ["RQU-1B50"], veiculo_ids: ["v-RQU-1B50"] },
    }];
    await ciclo(new Date("2026-10-21T10:00:00Z"), "2026-10-21");
    expect(estado.inserts).toEqual([]);
    expect(estado.updates).toHaveLength(1);
    expect((estado.updates[0].patch.contexto as Linha).placas).toEqual(["RQU-1B50", "TTI-6E43"]);
  });

  it("card fecha sozinho com status resolvido e resolvido_em", async () => {
    estado.alertas = [{
      id: "c1", cliente_id: NUTRY, veiculo_id: "v-RQU-1B50", status: "ativo", tipo: "romaneio_ausente", desde: "2026-10-21T09:00:00Z",
      motivo: "x", origem_acao: null, contexto: { agregado: true, dia: "2026-10-21", placas: ["RQU-1B50"], veiculo_ids: ["v-RQU-1B50"] },
    }];
    await ciclo(new Date("2026-10-21T15:00:00Z"), "2026-10-21");
    expect(estado.updates[0]).toMatchObject({ id: "c1", patch: { status: "resolvido", resolvido_em: "2026-10-21T15:00:00.000Z" } });
  });

  it("falha na consulta da frota vira aviso em erros e nao fecha nenhum card", async () => {
    estado.falharPool = true;
    estado.alertas = [{ id: "c1", cliente_id: NUTRY, veiculo_id: "v", status: "ativo", tipo: "romaneio_ausente", desde: "2026-10-21T09:00:00Z", motivo: "x", origem_acao: null, contexto: { agregado: true } }];
    const erros = await ciclo(new Date("2026-10-21T10:00:00Z"), "2026-10-21");
    expect(estado.updates).toEqual([]);
    expect(estado.inserts).toEqual([]);
    expect(erros.join("\n")).toMatch(/romaneio ausente/i);
  });
});
