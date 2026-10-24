// Fiação do F3-09 dentro do ciclo do motor (revisão da Fase 3): a regra pura
// está em @/lib/rastreador-mudo; aqui o ciclo roda com pool e admin falsos
// para travar o que vai para o banco e para `erros`.
import { describe, it, expect, beforeEach } from "vitest";
import { sinalizarRastreadorMudoComCarga } from "./route";
import type { CargaComPosicao } from "@/lib/rastreador-mudo";

type Linha = Record<string, unknown>;
const estado = {
  cargas: [] as Linha[],
  alertas: [] as Linha[],
  updates: [] as { id: string; patch: Linha }[],
  inserts: [] as Linha[],
};

function admin() {
  return {
    from: () => {
      const filtros: [string, string, unknown][] = [];
      const b: Record<string, unknown> = {};
      b.select = () => b;
      b.eq = (c: string, v: unknown) => { filtros.push(["eq", c, v]); return b; };
      b.gte = (c: string, v: unknown) => { filtros.push(["gte", c, v]); return b; };
      (b as { then?: unknown }).then = (res: (v: unknown) => unknown) => {
        const data = estado.alertas.filter((a) => filtros.every(([op, c, v]) =>
          op === "eq" ? a[c] === v : String(a[c]) >= String(v)));
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
const pool = { query: async () => ({ rows: estado.cargas }) };

async function ciclo(agora: Date, hoje: string): Promise<string[]> {
  const erros: string[] = [];
  await sinalizarRastreadorMudoComCarga({
    pool: pool as never, admin: admin() as never, hoje, agora, erros,
  });
  return erros;
}

function carga(over: Partial<CargaComPosicao> = {}): Linha {
  return {
    veiculo_id: "v-ltz", cliente_id: "cli-rq", placa: "LTZ-7I72", nfs: 41, tem_posicao: true,
    lat: -22.9, lng: -43.2, atraso_min: 29952, updated_at: "2026-10-23T13:59:40Z", ...over,
  };
}

beforeEach(() => {
  estado.cargas = []; estado.alertas = []; estado.updates = []; estado.inserts = [];
});

describe("R-F3-09-02: fechar sozinho preserva a evidência do alerta", () => {
  it("LTZ-7I72: alerta ativo de 22/10 fechado em 23/10 mantém nfs, ultima_comunicacao e atraso_min", async () => {
    const contexto22 = { nfs: 29, nunca_transmitiu: false, ultima_comunicacao: "2026-10-03T11:30:00.000Z", atraso_min: 28050 };
    estado.alertas = [{
      id: "ontem", veiculo_id: "v-ltz", status: "ativo", desde: "2026-10-22T13:10:00Z",
      tipo: "rastreador_mudo_com_carga", contexto: contexto22,
    }];
    estado.cargas = [carga()];
    const erros = await ciclo(new Date("2026-10-23T14:00:00Z"), "2026-10-23");
    expect(erros).toEqual([]);
    const fechado = estado.updates.find((u) => u.id === "ontem");
    expect(fechado?.patch.status).toBe("resolvido");
    expect(fechado?.patch.contexto).toEqual({ ...contexto22, auto_resolvido: true });
  });
});

describe("R-F3-09-04: linha de carga invalida vira aviso em erros", () => {
  it("nfs ilegivel => nenhum alerta e aviso com a placa", async () => {
    estado.cargas = [carga({ nfs: "x" as unknown as number })];
    const erros = await ciclo(new Date("2026-10-23T14:00:00Z"), "2026-10-23");
    expect(estado.inserts).toEqual([]);
    expect(erros.join("\n")).toMatch(/rastreador_mudo_com_carga.*LTZ-7I72/);
  });
});

describe("R-F3-09-03: posicoes paradas viram aviso de sistema, nao alerta de equipamento", () => {
  it("RQ sem linha atualizada ha 25 h => nenhum alerta e aviso com o nome do cliente", async () => {
    estado.cargas = [
      carga({ placa: "KWQ-6252", veiculo_id: "v-kwq", atraso_min: 0, updated_at: "2026-10-22T12:00:00Z", cliente_nome: "Rio Quality" } as Partial<CargaComPosicao>),
      carga({ updated_at: "2026-10-22T12:00:00Z", cliente_nome: "Rio Quality" } as Partial<CargaComPosicao>),
    ];
    const erros = await ciclo(new Date("2026-10-23T13:00:00Z"), "2026-10-23");
    expect(estado.inserts).toEqual([]);
    expect(erros.join("\n")).toMatch(/posi[cç][oõ]es.*Rio Quality.*paradas/i);
  });
});
