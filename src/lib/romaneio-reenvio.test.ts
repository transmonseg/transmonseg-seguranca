import { describe, it, expect } from "vitest";
import { separarJaMovidasPorTroca } from "./romaneio-reenvio";

const l = (nf: string, carga: string, placa: string) => ({ nf, carga_destino_codigo: carga, placa });

describe("separarJaMovidasPorTroca (reenvio 03/11)", () => {
  it("NF da carga trocada (ja em outra placa) nao e recriada na placa do documento", () => {
    const r = separarJaMovidasPorTroca(
      [l("2455280", "101424", "TOS-0G53"), l("2455281", "101424", "TOS-0G53")],
      [l("2455280", "101424", "RQU-2G47"), l("2455281", "101424", "RQU-2G47")],
    );
    expect(r).toEqual({ inserir: [], jaMovidas: 2 });
  });
  it("NF nova e NF ja na mesma placa seguem pro upsert (o DO NOTHING cuida da repetida)", () => {
    const r = separarJaMovidasPorTroca(
      [l("SEMNF-101465-2081", "101465", "RBI-1E10"), l("2456767", "101466", "RBI-1F75")],
      [l("2456767", "101466", "RBI-1F75")],
    );
    expect(r.inserir.map((x) => x.nf)).toEqual(["SEMNF-101465-2081", "2456767"]);
    expect(r.jaMovidas).toBe(0);
  });
  it("mesma NF em outra carga nao conta como troca", () => {
    const r = separarJaMovidasPorTroca([l("1", "A", "AAA-1A11")], [l("1", "B", "BBB-1B11")]);
    expect(r.jaMovidas).toBe(0);
  });
});
