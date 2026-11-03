import { describe, it, expect } from "vitest";
import { separarJaMovidasPorTroca, nfsRemovidas, nfsRestauradas, type LinhaExistente } from "./romaneio-reenvio";

const l = (nf: string, carga: string | null, placa: string) => ({ nf, carga_destino_codigo: carga, placa });
// Linha ja gravada no dia; `trocado` = movida por trocar-veiculo.
const e = (nf: string, carga: string | null, placa: string, trocado = false, removida = false): LinhaExistente => ({
  nf, carga_destino_codigo: carga, placa,
  trocado_em: trocado ? "2026-11-03T14:00:00Z" : null,
  removida_em: removida ? "2026-11-03T15:00:00Z" : null,
});

describe("separarJaMovidasPorTroca (reenvio 03/11)", () => {
  it("NF da carga trocada (ja em outra placa por troca) nao e recriada na placa do documento", () => {
    const r = separarJaMovidasPorTroca(
      [l("2455280", "101424", "TOS-0G53"), l("2455281", "101424", "TOS-0G53")],
      [e("2455280", "101424", "RQU-2G47", true), e("2455281", "101424", "RQU-2G47", true)],
    );
    expect(r).toEqual({ inserir: [], jaMovidas: 2 });
  });
  it("NF nova e NF ja na mesma placa seguem pro upsert (o DO NOTHING cuida da repetida)", () => {
    const r = separarJaMovidasPorTroca(
      [l("SEMNF-101465-2081", "101465", "RBI-1E10"), l("2456767", "101466", "RBI-1F75")],
      [e("2456767", "101466", "RBI-1F75")],
    );
    expect(r.inserir.map((x) => x.nf)).toEqual(["SEMNF-101465-2081", "2456767"]);
    expect(r.jaMovidas).toBe(0);
  });
  it("mesma NF em outra carga nao conta como troca", () => {
    const r = separarJaMovidasPorTroca([l("1", "A", "AAA-1A11")], [e("1", "B", "BBB-1B11", true)]);
    expect(r.jaMovidas).toBe(0);
  });
  // DSV-06 (auditoria 03/11), cenario C6 do lab
  it("C6: NF em outra placa SEM troca registrada (reenvio corrigido) vai pra placa nova", () => {
    const r = separarJaMovidasPorTroca([l("555", "900", "BBB-2B22")], [e("555", "900", "AAA-1A11")]);
    expect(r).toEqual({ inserir: [l("555", "900", "BBB-2B22")], jaMovidas: 0 });
  });
  it("C6b: escala do pao com carga nula, sem troca, tambem vai pra placa nova", () => {
    const r = separarJaMovidasPorTroca([l("777", null, "BBB-2B22")], [e("777", null, "AAA-1A11")]);
    expect(r.jaMovidas).toBe(0);
  });
  it("NF movida por troca continua pulada mesmo com outra linha sem troca na mesma placa do documento", () => {
    const r = separarJaMovidasPorTroca([l("555", "900", "AAA-1A11")], [e("555", "900", "BBB-2B22", true)]);
    expect(r.jaMovidas).toBe(1);
  });
});

describe("nfsRemovidas (NF retirada no reenvio sai da rota, sem apagar)", () => {
  it("NF ausente na versao nova da MESMA carga e' marcada", () => {
    const r = nfsRemovidas([l("1", "900", "AAA-1A11")], [e("1", "900", "AAA-1A11"), e("2", "900", "AAA-1A11")]);
    expect(r).toEqual([{ nf: "2", carga: "900", placa: "AAA-1A11" }]);
  });
  it("reenvio corrigido que muda a placa: a linha da placa antiga sai", () => {
    const r = nfsRemovidas([l("555", "900", "BBB-2B22")], [e("555", "900", "AAA-1A11")]);
    expect(r).toEqual([{ nf: "555", carga: "900", placa: "AAA-1A11" }]);
  });
  it("carga que nao veio no reenvio (lote parcial) fica intocada", () => {
    expect(nfsRemovidas([l("1", "900", "AAA-1A11")], [e("9", "901", "CCC-3C33")])).toEqual([]);
  });
  it("linha movida por troca nunca e' marcada (o documento ainda traz a placa antiga)", () => {
    expect(nfsRemovidas([l("555", "900", "AAA-1A11")], [e("555", "900", "BBB-2B22", true)])).toEqual([]);
  });
  it("carga nula (pao) nunca marca: nao da' pra saber se o lote e' o dia inteiro", () => {
    expect(nfsRemovidas([l("1", null, "AAA-1A11")], [e("2", null, "AAA-1A11")])).toEqual([]);
  });
  it("ja removida nao volta na lista", () => {
    expect(nfsRemovidas([l("1", "900", "AAA-1A11")], [e("2", "900", "AAA-1A11", false, true)])).toEqual([]);
  });
});

describe("nfsRestauradas (NF que volta num reenvio volta pra rota)", () => {
  it("linha marcada como removida que aparece de novo no documento", () => {
    expect(nfsRestauradas([l("2", "900", "AAA-1A11")], [e("2", "900", "AAA-1A11", false, true), e("1", "900", "AAA-1A11")]))
      .toEqual([{ nf: "2", carga: "900", placa: "AAA-1A11" }]);
  });
});
