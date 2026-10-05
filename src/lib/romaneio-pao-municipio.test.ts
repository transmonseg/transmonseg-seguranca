import { describe, it, expect } from "vitest";
import { municipioDoPao, montarEnderecoPao } from "./romaneio-pao-municipio";
import { extrairCidadeDoEndereco, extrairBairroDoEndereco, extrairNumeroDoEndereco } from "./romaneio-geocode-local";

describe("municipioDoPao (casos reais 05/10, Escala do Pão sem cidade)", () => {
  it("bairros de Niterói / São Gonçalo", () => {
    expect(municipioDoPao("SANTA ROSA", "HORTIFRUTI SANTA ROSA")).toBe("NITEROI");
    expect(municipioDoPao("ICARAI", "PAO DO ATLETA (FILIAL)")).toBe("NITEROI");
    expect(municipioDoPao("SAO FRANCISCO", "CASAFRUTI")).toBe("NITEROI");
    expect(municipioDoPao("MUTONDO", "MERCADO ACOUGUE MOURA DO MUTONDO")).toBe("SAO GONCALO");
  });
  it("pista no nome do cliente vence bairro ambíguo", () => {
    expect(municipioDoPao("MANGUINHOS", "HORTIFRUTI BUZIOS")).toBe("ARMACAO DOS BUZIOS");
    expect(municipioDoPao("CENTRO", "CASAFRUTI ARARUAMA")).toBe("ARARUAMA");
    expect(municipioDoPao("CENTRO", "SUPERMERCADO SERRA AZUL BOM JESUS")).toBe("BOM JESUS DO ITABAPOANA");
  });
  it("sem pista: Rio de Janeiro (comportamento de antes)", () => {
    expect(municipioDoPao("GRAJAU", "SUPERPRIX EDMUNDO REGO")).toBe("RIO DE JANEIRO");
    expect(municipioDoPao("S Cristovão", "SUPERMERCADOS CAMPEAO S CRISTOVAO")).toBe("RIO DE JANEIRO");
    expect(municipioDoPao("CENTRO", "PADARIA")).toBe("RIO DE JANEIRO");
  });
  it("acento e caixa não importam", () => {
    expect(municipioDoPao("Icaraí", "x")).toBe("NITEROI");
  });
});

describe("montarEnderecoPao", () => {
  it("rua com número após vírgula: formato RUA, NUM - BAIRRO, CIDADE", () => {
    const e = montarEnderecoPao("RUA NORONHA TERREZAO,43", "SANTA ROSA", "HORTIFRUTI SANTA ROSA");
    expect(e).toBe("RUA NORONHA TERREZAO, 43 - SANTA ROSA, NITEROI");
    expect(extrairCidadeDoEndereco(e)).toBe("NITEROI");
    expect(extrairBairroDoEndereco(e)).toBe("SANTA ROSA");
    expect(extrairNumeroDoEndereco(e)).toBe("43");
  });
  it("sem vírgula com 'N 59': extrai o número", () => {
    const e = montarEnderecoPao("ARISTIDES FIGUEIREDO N 59", "CENTRO", "SUPERMERCADO SERRA AZUL BOM JESUS");
    expect(e).toBe("ARISTIDES FIGUEIREDO, 59 - CENTRO, BOM JESUS DO ITABAPOANA");
    expect(extrairCidadeDoEndereco(e)).toBe("BOM JESUS DO ITABAPOANA");
  });
  it("sem número nenhum: S/N", () => {
    expect(montarEnderecoPao("RODODVIA RJ 124 VIA LAGOS", "LATINO MELO", "GRAAL OASIS")).toBe("RODODVIA RJ 124 VIA LAGOS, S/N - LATINO MELO, RIO DE JANEIRO");
  });
  it("número 0 vira S/N", () => {
    expect(montarEnderecoPao("AVN JOSE BENTO RIBEIRO DANTAS,0", "MANGUINHOS", "HORTIFRUTI BUZIOS")).toBe("AVN JOSE BENTO RIBEIRO DANTAS, S/N - MANGUINHOS, ARMACAO DOS BUZIOS");
  });
  it("sem bairro: devolve o endereço como veio", () => {
    expect(montarEnderecoPao("RUA X,10", "", "CLIENTE")).toBe("RUA X,10");
  });
  it("bairro veio como número e o bairro de verdade ficou no fim da rua (PDF colado, NF 216581)", () => {
    expect(montarEnderecoPao("RUA GUILHERME SANTOS ANDRADE 1315 MUTONDO", "40", "MERCADO ACOUGUE MOURA DO MUTONDO"))
      .toBe("RUA GUILHERME SANTOS ANDRADE, 1315 - MUTONDO, SAO GONCALO");
  });
  it("endereço com QUADRA/LOTE: não inventa número (NF 216600)", () => {
    expect(montarEnderecoPao("AVENIDA NILO PECANHA 0 QUADRA A LOTE 1 103 RUA BRENO RESENDE QUADRA A LOTE 6 E 7", "CENTRO", "CASAFRUTI ARARUAMA"))
      .toBe("AVENIDA NILO PECANHA 0 QUADRA A LOTE 1 103 RUA BRENO RESENDE QUADRA A LOTE 6 E 7, S/N - CENTRO, ARARUAMA");
  });
});
