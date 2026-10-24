import { describe, it, expect } from "vitest";
import { ausentesDaApi, tratarAusentesDaApi } from "./veiculos-ausentes.mjs";

// F2-15 (MON-12): carro que saiu da API da Unitrac continuava ativo com a
// posicao congelada. Caso real 24/10: masn/4096 devolve 125 cvs; 5 ativos do
// banco nao estao nela -- TTJ-0F00 (18142), TTP-0H36 (18254), TTI-6D27
// (18514), TUC-1D15 (18604) e TTT-1E20 (18785), este com atraso_min=0 (verde)
// desde 13/10.
const SUMIDOS = [
  { id: "v18142", cv: "18142", placa: "TTJ-0F00" },
  { id: "v18254", cv: "18254", placa: "TTP-0H36" },
  { id: "v18514", cv: "18514", placa: "TTI-6D27" },
  { id: "v18604", cv: "18604", placa: "TUC-1D15" },
  { id: "v18785", cv: "18785", placa: "TTT-1E20" },
];
const PRESENTES = Array.from({ length: 116 }, (_, i) => ({ id: `p${i}`, cv: String(20000 + i), placa: `AAA-${String(i).padStart(4, "0")}` }));
const API_4096 = new Set([...PRESENTES.map((v) => v.cv), "30001", "30002", "30003", "30004", "30005", "30006", "30007", "30008", "30009"]); // 125

describe("ausentesDaApi", () => {
  it("caso real 24/10: os 5 ativos fora da masn/4096", () => {
    const r = ausentesDaApi([...PRESENTES, ...SUMIDOS], API_4096);
    expect(r.suspeita).toBeNull();
    expect(r.ausentes.map((v) => v.placa)).toEqual(["TTJ-0F00", "TTP-0H36", "TTI-6D27", "TUC-1D15", "TTT-1E20"]);
  });
  it("API vazia ou com menos da metade da frota ativa: nao marca ninguem (resposta parcial)", () => {
    expect(ausentesDaApi([...PRESENTES, ...SUMIDOS], new Set())).toMatchObject({ ausentes: [], suspeita: expect.stringMatching(/0 ve/) });
    const metade = new Set(PRESENTES.slice(0, 50).map((v) => v.cv));
    const r = ausentesDaApi([...PRESENTES, ...SUMIDOS], metade);
    expect(r.ausentes).toEqual([]);
    expect(r.suspeita).toMatch(/50 de 121/);
  });
  it("cv comparado como texto (a API manda numero)", () => {
    expect(ausentesDaApi([{ id: "a", cv: "18142", placa: "X" }], new Set(["18142"])).ausentes).toEqual([]);
  });
});

// Banco falso: registra as consultas e responde a leitura da frota.
function clienteFalso({ ativos, temColuna = true, envelhecidos = [] }) {
  const sqls = [];
  return {
    sqls,
    async query(sql, params) {
      sqls.push({ sql: sql.replace(/\s+/g, " ").trim(), params });
      if (/information_schema\.columns/.test(sql)) return { rows: temColuna ? [{ ok: 1 }] : [] };
      if (/SELECT id, cv, placa FROM veiculos/.test(sql)) return { rows: ativos };
      if (/UPDATE posicoes_atuais/.test(sql)) return { rows: envelhecidos.map((veiculo_id) => ({ veiculo_id })) };
      return { rows: [], rowCount: 0 };
    },
  };
}

describe("tratarAusentesDaApi", () => {
  it("marca sumiu_da_api_em, limpa quem voltou e envelhece so' a posicao que o motor nao grava ha 30 min", async () => {
    const c = clienteFalso({ ativos: [...PRESENTES, ...SUMIDOS], envelhecidos: ["v18785"] });
    const r = await tratarAusentesDaApi(c, { clienteId: "nutry", cvsApi: API_4096 });
    expect(r).toMatchObject({ ausentes: ["TTJ-0F00", "TTP-0H36", "TTI-6D27", "TUC-1D15", "TTT-1E20"], envelhecidos: 1, suspeita: null });
    const marca = c.sqls.find((s) => /SET sumiu_da_api_em = now\(\)/.test(s.sql));
    expect(marca.sql).toMatch(/sumiu_da_api_em IS NULL/);
    expect(marca.params[0]).toEqual(SUMIDOS.map((v) => v.id));
    const limpa = c.sqls.find((s) => /SET sumiu_da_api_em = NULL/.test(s.sql));
    expect(limpa.params).toEqual(["nutry", [...API_4096]]);
    const env = c.sqls.find((s) => /UPDATE posicoes_atuais/.test(s.sql));
    expect(env.sql).toMatch(/updated_at < now\(\) - interval '30 minutes'/);
    expect(env.sql).toMatch(/GREATEST/);
    expect(env.sql).toMatch(/nivel = 'cinza'/);
    expect(env.sql).not.toMatch(/updated_at =/); // a idade continua contando do ultimo dado real
    expect(env.params[0]).toEqual(SUMIDOS.map((v) => v.id));
    // nunca desativa nem apaga veiculo
    expect(c.sqls.some((s) => /ativo = false|DELETE/i.test(s.sql))).toBe(false);
  });
  it("sem a coluna (migration 090 ainda nao aplicada): so' envelhece a posicao", async () => {
    const c = clienteFalso({ ativos: [...PRESENTES, ...SUMIDOS], temColuna: false, envelhecidos: ["v18785"] });
    const r = await tratarAusentesDaApi(c, { clienteId: "nutry", cvsApi: API_4096 });
    expect(r.envelhecidos).toBe(1);
    expect(r.marcado).toBe(false);
    expect(c.sqls.some((s) => /sumiu_da_api_em/.test(s.sql) && !/information_schema/.test(s.sql))).toBe(false);
  });
  it("resposta suspeita da API: nao mexe em nada", async () => {
    const c = clienteFalso({ ativos: [...PRESENTES, ...SUMIDOS] });
    const r = await tratarAusentesDaApi(c, { clienteId: "nutry", cvsApi: new Set(["1"]) });
    expect(r.suspeita).toBeTruthy();
    expect(c.sqls.some((s) => /^UPDATE/.test(s.sql))).toBe(false);
  });
});
