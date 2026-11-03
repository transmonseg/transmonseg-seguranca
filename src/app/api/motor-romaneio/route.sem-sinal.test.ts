// DSV-05 (auditoria 03/11): fiação do card "sem sinal em rota" no ciclo.
import { describe, it, expect, beforeEach } from "vitest";
import { sinalizarSemSinalEmRota } from "./route";

type Linha = Record<string, unknown>;
const st = { cargas: [] as Linha[], alertas: [] as Linha[], inserts: [] as Linha[], updates: [] as { id: string; patch: Linha }[] };

function admin() {
  return {
    from: () => {
      const b: Record<string, unknown> = {};
      b.select = () => b; b.eq = () => b; b.in = () => b; b.gte = () => b;
      (b as { then?: unknown }).then = (res: (v: unknown) => unknown) => Promise.resolve({ data: st.alertas, error: null }).then(res);
      b.insert = (row: Linha) => { st.inserts.push(row); return Promise.resolve({ error: null }); };
      b.update = (patch: Linha) => ({ eq: (_c: string, id: string) => { st.updates.push({ id, patch }); return Promise.resolve({ error: null }); } });
      return b;
    },
  };
}
const pool = { query: async () => ({ rows: st.cargas }) };
const agora = new Date("2026-10-30T17:00:00Z");
const carga = (o: Linha = {}): Linha => ({
  veiculo_id: "v1", cliente_id: "c1", placa: "TOS-1H26", nfs: 12, tem_posicao: true,
  lat: -22.9, lng: -43.4, atraso_min: 90, updated_at: "2026-10-30T16:59:30Z", na_base: false, ...o,
});

beforeEach(() => { st.cargas = []; st.alertas = []; st.inserts = []; st.updates = []; });

describe("sinalizarSemSinalEmRota", () => {
  it("abre card de atencao, tipo sem_sinal_em_rota, com o local onde sumiu", async () => {
    st.cargas = [carga(), carga({ veiculo_id: "v2", atraso_min: 0 })];
    const erros: string[] = [];
    await sinalizarSemSinalEmRota({ pool: pool as never, admin: admin() as never, hoje: "2026-10-30", agora, erros });
    expect(erros).toEqual([]);
    expect(st.inserts).toHaveLength(1);
    expect(st.inserts[0]).toMatchObject({ tipo: "sem_sinal_em_rota", nivel: "atencao", veiculo_id: "v1", lat: -22.9, lng: -43.4, status: "ativo" });
    expect(String(st.inserts[0].motivo)).toMatch(/Sem sinal há 90 min/);
  });
  it("sinal voltou: fecha o card com o texto da volta", async () => {
    st.cargas = [carga({ atraso_min: 0, lng: -43.3 })];
    st.alertas = [{ id: "a", veiculo_id: "v1", status: "ativo", desde: "2026-10-30T16:00:00Z", lat: -22.9, lng: -43.4, contexto: {} }];
    await sinalizarSemSinalEmRota({ pool: pool as never, admin: admin() as never, hoje: "2026-10-30", agora, erros: [] });
    expect(st.updates).toHaveLength(1);
    expect(st.updates[0].patch.status).toBe("resolvido");
    expect((st.updates[0].patch.contexto as Linha).voltou).toMatch(/voltou a .* km de onde sumiu/);
  });
  it("falha de leitura vira aviso, nunca derruba o ciclo", async () => {
    const quebra = { query: async () => { throw new Error("boom"); } };
    const erros: string[] = [];
    await sinalizarSemSinalEmRota({ pool: quebra as never, admin: admin() as never, hoje: "2026-10-30", agora, erros });
    expect(erros.join("\n")).toMatch(/sem_sinal_em_rota/);
  });
});
