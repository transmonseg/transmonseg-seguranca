// F2-15 (MON-12): a frota da RQ no monitoramento e' uma copia da
// kpi_rioquality_frota do KPI (06/10, 121 placas, identicas) e nunca mais foi
// atualizada: a masn/598 responde "sem permissao" e a varredura de cv
// (KPI: scripts/descobrir-cv-rq.ts) so' gravava no KPI. O KPI passa a mandar
// a frota inteira a cada varredura; aqui so' entra o que falta.
import { describe, it, expect } from "vitest";
import { lerVeiculosRQ, planejarFrotaRQ } from "./frota-rioquality";

describe("lerVeiculosRQ", () => {
  it("placa sem hifen do KPI vira o formato do monitoramento; descarta lixo", () => {
    expect(lerVeiculosRQ([
      { placa: "TUP0B49", cv: "24410" }, { placa: "ltu7c95", cv: 19364 }, { placa: "", cv: "1" },
      { placa: "KZA2F01", cv: null }, "x", { placa: "AB", cv: "2" },
    ])).toEqual([{ placa: "TUP-0B49", cv: "24410" }, { placa: "LTU-7C95", cv: "19364" }]);
  });
});

describe("planejarFrotaRQ", () => {
  const RQ = "16a32814-3402-4b2d-b974-aef0707d7a4e";
  const existentes = [
    { id: "a", cliente_id: RQ, cv: "19364", placa: "LTU-7C95" },
    { id: "b", cliente_id: RQ, cv: "22272", placa: "SSW-7J12" },
    { id: "n", cliente_id: "nutry", cv: "18785", placa: "TTT-1E20" },
  ];
  it("so' insere o cv novo; o que ja' existe nao e' tocado", () => {
    const p = planejarFrotaRQ(RQ, existentes, [
      { placa: "LTU-7C95", cv: "19364" }, { placa: "SSW-7J12", cv: "22272" }, { placa: "TUP-0B49", cv: "24410" },
    ]);
    expect(p.inserir).toEqual([{ cliente_id: RQ, cv: "24410", placa: "TUP-0B49", perfil: "auto", ativo: true }]);
    expect(p.jaExistiam).toBe(2);
    expect(p.conflitos).toEqual([]);
  });
  it("cv da RQ com outra placa no monitoramento: nao renomeia, avisa", () => {
    const p = planejarFrotaRQ(RQ, existentes, [{ placa: "LTU-7C96", cv: "19364" }]);
    expect(p.inserir).toEqual([]);
    expect(p.conflitos).toEqual([{ placa: "LTU-7C96", cv: "19364", motivo: "cv já cadastrado com a placa LTU-7C95" }]);
  });
  it("placa ja' usada por outro veiculo (outra frota ou outro cv): nao insere, avisa", () => {
    const p = planejarFrotaRQ(RQ, existentes, [{ placa: "TTT-1E20", cv: "99999" }]);
    expect(p.inserir).toEqual([]);
    expect(p.conflitos[0]).toMatchObject({ placa: "TTT-1E20", cv: "99999", motivo: expect.stringMatching(/placa já cadastrada/) });
  });
  it("repetido no mesmo envio entra uma vez", () => {
    const p = planejarFrotaRQ(RQ, [], [{ placa: "TUP-0B49", cv: "24410" }, { placa: "TUP-0B49", cv: "24410" }]);
    expect(p.inserir).toHaveLength(1);
  });
});
