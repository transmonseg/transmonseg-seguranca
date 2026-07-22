import { describe, it, expect } from "vitest";
import { extrairRuaDoEndereco, extrairCidadeDoEndereco, normalizarNomeRua } from "./romaneio-geocode-local";

describe("extrairRuaDoEndereco", () => {
  it("extrai o texto antes da primeira virgula", () => {
    expect(extrairRuaDoEndereco("RUA MONS MIGUEL REIS MELLO, 33 - LIBERDADE, NATIVIDADE - *")).toBe("RUA MONS MIGUEL REIS MELLO");
  });

  it("funciona com estrada/rodovia tambem", () => {
    expect(extrairRuaDoEndereco("EST NATIVIDADE RAPOSO, KM 3 - ZONA RURAL, NATIVIDADE - .")).toBe("EST NATIVIDADE RAPOSO");
  });

  it("sem virgula nenhuma: retorna a string inteira (fallback)", () => {
    expect(extrairRuaDoEndereco("ENDERECO SEM VIRGULA")).toBe("ENDERECO SEM VIRGULA");
  });
});

describe("extrairCidadeDoEndereco", () => {
  it("extrai o primeiro token do trecho depois da ULTIMA virgula", () => {
    expect(extrairCidadeDoEndereco("RUA MONS MIGUEL REIS MELLO, 33 - LIBERDADE, NATIVIDADE - *")).toBe("NATIVIDADE");
  });

  it("funciona com sufixo tipo loja/galpao", () => {
    expect(extrairCidadeDoEndereco("RUA X, 100 - CENTRO, ITAPERUNA - LOJA B")).toBe("ITAPERUNA");
  });

  it("endereco mal formado (menos de 2 virgulas): retorna null", () => {
    expect(extrairCidadeDoEndereco("SEM VIRGULA SUFICIENTE")).toBeNull();
    expect(extrairCidadeDoEndereco("SO UMA, VIRGULA")).toBeNull();
  });
});

describe("normalizarNomeRua", () => {
  it("maiusculas e remove acentos", () => {
    expect(normalizarNomeRua("Rua Vinícius de Moraes")).toBe("VINICIUS DE MORAES");
  });

  it("remove prefixo de tipo de via reconhecido", () => {
    expect(normalizarNomeRua("RUA MONS MIGUEL REIS MELLO")).toBe("MONS MIGUEL REIS MELLO");
    expect(normalizarNomeRua("AV AMARAL PEIXOTO")).toBe("AMARAL PEIXOTO");
    expect(normalizarNomeRua("Avenida Amaral Peixoto")).toBe("AMARAL PEIXOTO");
    expect(normalizarNomeRua("TRAVESSA DA PAZ")).toBe("DA PAZ");
    expect(normalizarNomeRua("EST NATIVIDADE RAPOSO")).toBe("NATIVIDADE RAPOSO");
    expect(normalizarNomeRua("ESTRADA NATIVIDADE RAPOSO")).toBe("NATIVIDADE RAPOSO");
    expect(normalizarNomeRua("ROD BR 356")).toBe("BR 356");
    expect(normalizarNomeRua("PRACA DA SE")).toBe("DA SE");
  });

  it("bate igual independente de abreviacao (romaneio vs OSM)", () => {
    expect(normalizarNomeRua("AV AMARAL PEIXOTO")).toBe(normalizarNomeRua("Avenida Amaral Peixoto"));
  });

  it("sem prefixo reconhecido: mantem a string (so normaliza case/acento)", () => {
    expect(normalizarNomeRua("Beco Sem Nome")).toBe("BECO SEM NOME");
  });

  it("colapsa espacos multiplos", () => {
    expect(normalizarNomeRua("RUA   COM    ESPACOS")).toBe("COM ESPACOS");
  });
});
