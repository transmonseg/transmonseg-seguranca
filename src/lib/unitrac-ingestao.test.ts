// RAS-05 (auditoria 03/11): a ingestão confiava no formato da Unitrac.
// Casos do lab rastreamento-lab/normalizar-lab.ts.
import { describe, it, expect } from "vitest";
import { normalizar, leituraAproveitavel, extrairPosicoes } from "./unitrac";

const base = { veicucodigo: "1", veicuplaca: "AAA", posiclatitude: "-22.9", posiclongitude: "-43.2", posicvelocidade: "40", datagps: "03/11/2026 17:12:29" };

describe("normalizar: atraso inválido não é 'fresco'", () => {
  it.each([
    ["atraso ausente", {}],
    ["atraso vazio", { atraso: "" }],
    ["atraso texto", { atraso: "N/D" }],
  ])("%s => atraso null, fresco false", (_n, extra) => {
    const p = normalizar({ ...base, ...extra });
    expect(p.atraso).toBeNull();
    expect(p.fresco).toBe(false);
  });
  it("atraso '0' continua fresco", () => {
    expect(normalizar({ ...base, atraso: "0" })).toMatchObject({ atraso: 0, fresco: true });
  });
  it("atraso '75' => não fresco", () => {
    expect(normalizar({ ...base, atraso: "75" })).toMatchObject({ atraso: 75, fresco: false });
  });
});

describe("leituraAproveitavel: descarta coordenada inválida e atraso desconhecido", () => {
  it("leitura boa passa", () => expect(leituraAproveitavel(normalizar({ ...base, atraso: "0" }))).toBe(true));
  it("lat/lng vazios (NaN) => descartada", () =>
    expect(leituraAproveitavel(normalizar({ ...base, atraso: "0", posiclatitude: "", posiclongitude: "" }))).toBe(false));
  it("0,0 => descartada (Golfo da Guiné)", () =>
    expect(leituraAproveitavel(normalizar({ ...base, atraso: "0", posiclatitude: "0", posiclongitude: "0" }))).toBe(false));
  it("fora do Brasil => descartada", () =>
    expect(leituraAproveitavel(normalizar({ ...base, atraso: "0", posiclatitude: "40.7", posiclongitude: "-74.0" }))).toBe(false));
  it("atraso desconhecido => descartada", () => expect(leituraAproveitavel(normalizar({ ...base }))).toBe(false));
});

describe("extrairPosicoes: resposta sem Posicoes vira erro do cliente, não TypeError do ciclo", () => {
  it("{} lança", () => expect(() => extrairPosicoes({})).toThrow(/sem lista Posicoes/));
  it("null lança", () => expect(() => extrairPosicoes(null)).toThrow(/sem lista Posicoes/));
  it("lista volta igual", () => expect(extrairPosicoes({ Posicoes: [{ a: 1 }] })).toEqual([{ a: 1 }]));
});
