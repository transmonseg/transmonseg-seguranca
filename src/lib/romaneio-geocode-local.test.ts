import { describe, it, expect } from "vitest";
import {
  extrairRuaDoEndereco, extrairCidadeDoEndereco, normalizarNomeRua,
  extrairNumeroDoEndereco, extrairBairroDoEndereco, expandirCidadeTruncada,
  montarEnderecoParaGeocode, municipioCodigoIbge,
} from "./romaneio-geocode-local";

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
  it("maiusculas, remove acentos e conectores", () => {
    expect(normalizarNomeRua("Rua Vinícius de Moraes")).toBe("VINICIUS MORAES");
  });

  it("remove prefixo de tipo de via reconhecido", () => {
    expect(normalizarNomeRua("RUA MONS MIGUEL REIS MELLO")).toBe("MONSENHOR MIGUEL REIS MELLO");
    expect(normalizarNomeRua("AV AMARAL PEIXOTO")).toBe("AMARAL PEIXOTO");
    expect(normalizarNomeRua("Avenida Amaral Peixoto")).toBe("AMARAL PEIXOTO");
    expect(normalizarNomeRua("TRAVESSA DA PAZ")).toBe("PAZ");
    expect(normalizarNomeRua("EST NATIVIDADE RAPOSO")).toBe("NATIVIDADE RAPOSO");
    expect(normalizarNomeRua("ESTRADA NATIVIDADE RAPOSO")).toBe("NATIVIDADE RAPOSO");
    expect(normalizarNomeRua("ROD BR 356")).toBe("BR 356");
    expect(normalizarNomeRua("PRACA DA SE")).toBe("SE");
  });

  it("bate igual independente de abreviacao (romaneio vs OSM)", () => {
    expect(normalizarNomeRua("AV AMARAL PEIXOTO")).toBe(normalizarNomeRua("Avenida Amaral Peixoto"));
  });

  it("sem prefixo reconhecido: mantem a string (so normaliza case/acento)", () => {
    expect(normalizarNomeRua("Novo Horizonte")).toBe("NOVO HORIZONTE");
  });

  it("remove conectores (de/da/do/das/dos) de qualquer posicao -- achado real 31/07", () => {
    // Romaneio com "de" a mais que o OSM.
    expect(normalizarNomeRua("RUA EDITH DE CASTRO LEITE")).toBe(normalizarNomeRua("EDITH CASTRO LEITE"));
    // OSM com "de" a mais que o romaneio -- o oposto tambem acontece.
    expect(normalizarNomeRua("RUA JOAO LUIZ SIQUEIRA")).toBe(normalizarNomeRua("JOAO LUIZ DE SIQUEIRA"));
  });

  it("remove MAIS DE UM prefixo em sequencia -- achado real 31/07 (segunda rodada), PDF as vezes repete o tipo abreviado E por extenso", () => {
    expect(normalizarNomeRua("AV AVENIDA VICTOR SENCE")).toBe("VICTOR SENCE");
    expect(normalizarNomeRua("R ESTRADA CONSERVATORIA")).toBe("CONSERVATORIA");
    expect(normalizarNomeRua("AREA AVENIDA NILO PECANHA")).toBe("NILO PECANHA");
  });

  it("reconhece tipos de via adicionados na segunda rodada (VILA, SERVIDAO, SITIO, AREA)", () => {
    expect(normalizarNomeRua("VILA ORATORIA")).toBe("ORATORIA");
    expect(normalizarNomeRua("SERVIDAO FRANCISCO JULIO DE OLIVEIRA")).toBe("FRANCISCO JULIO OLIVEIRA");
    expect(normalizarNomeRua("SITIO GRANJA TATIANA")).toBe("GRANJA TATIANA");
  });

  it("expande titulo abreviado -- achado real 31/07 (segunda rodada): CNEFE grava por extenso", () => {
    expect(normalizarNomeRua("PC DR ORLANDO OBERLAENDER")).toBe("DOUTOR ORLANDO OBERLAENDER");
    expect(normalizarNomeRua("RUA CEL FULANO")).toBe("CORONEL FULANO");
  });

  it("colapsa espacos multiplos", () => {
    expect(normalizarNomeRua("RUA   COM    ESPACOS")).toBe("COM ESPACOS");
  });
});

describe("extrairNumeroDoEndereco", () => {
  it("extrai o numero antes do primeiro ' - ' do segundo trecho", () => {
    expect(extrairNumeroDoEndereco("RUA MONS MIGUEL REIS MELLO, 33 - LIBERDADE, NATIVIDADE - *")).toBe("33");
  });

  it("funciona com S/N", () => {
    expect(extrairNumeroDoEndereco("EST NATIVIDADE RAPOSO, S/N - ZONA RURAL, NATIVIDADE - .")).toBe("S/N");
  });

  it("endereco mal formado (menos de 1 virgula): retorna null", () => {
    expect(extrairNumeroDoEndereco("SEM VIRGULA NENHUMA")).toBeNull();
  });
});

describe("extrairBairroDoEndereco", () => {
  it("extrai o texto depois do ' - ' do segundo trecho", () => {
    expect(extrairBairroDoEndereco("RUA MONS MIGUEL REIS MELLO, 33 - LIBERDADE, NATIVIDADE - *")).toBe("LIBERDADE");
  });

  it("endereco mal formado (menos de 2 virgulas): retorna null", () => {
    expect(extrairBairroDoEndereco("SO UMA, VIRGULA")).toBeNull();
  });
});

describe("expandirCidadeTruncada", () => {
  it("expande cidade cortada em 15 caracteres (achado real 31/07)", () => {
    expect(expandirCidadeTruncada("SAO PEDRO DA AL")).toBe("São Pedro da Aldeia");
    expect(expandirCidadeTruncada("SANTA MARIA MAD")).toBe("Santa Maria Madalena");
  });

  it("cidade ja completa e valida: mantem como veio", () => {
    expect(expandirCidadeTruncada("NATIVIDADE")).toBe("NATIVIDADE");
    expect(expandirCidadeTruncada("Rio de Janeiro")).toBe("Rio de Janeiro");
  });

  it("prefixo curto demais (ambiguo, bateria em varios municipios): mantem como veio", () => {
    expect(expandirCidadeTruncada("SAO")).toBe("SAO");
  });

  it("nao bate com nenhum municipio do RJ: mantem como veio", () => {
    expect(expandirCidadeTruncada("CIDADE INVENTADA QUE NAO EXISTE")).toBe("CIDADE INVENTADA QUE NAO EXISTE");
  });
});

describe("montarEnderecoParaGeocode", () => {
  it("monta rua+numero, bairro, cidade (expandida), RJ, Brasil -- sem o sufixo de complemento", () => {
    expect(montarEnderecoParaGeocode("RUA MONS MIGUEL REIS MELLO, 33 - LIBERDADE, NATIVIDADE - *"))
      .toBe("RUA MONS MIGUEL REIS MELLO, 33, LIBERDADE, NATIVIDADE, RJ, Brasil");
  });

  it("expande cidade truncada na montagem final", () => {
    expect(montarEnderecoParaGeocode("RUA RESENDE, 358 - FLUMINENSE, SAO PEDRO DA AL - ."))
      .toBe("RUA RESENDE, 358, FLUMINENSE, São Pedro da Aldeia, RJ, Brasil");
  });

  it("S/N nao vira parte do numero (rua sozinha)", () => {
    expect(montarEnderecoParaGeocode("EST NATIVIDADE RAPOSO, S/N - ZONA RURAL, NATIVIDADE - ."))
      .toBe("EST NATIVIDADE RAPOSO, ZONA RURAL, NATIVIDADE, RJ, Brasil");
  });
});

describe("municipioCodigoIbge", () => {
  it("acha o codigo IBGE de 7 digitos pra um municipio conhecido do RJ", () => {
    expect(municipioCodigoIbge("Rio de Janeiro")).toBe("3304557");
    expect(municipioCodigoIbge("Campos dos Goytacazes")).toBe("3301009");
    expect(municipioCodigoIbge("São João da Barra")).toBe("3305000");
  });

  it("retorna null pra cidade fora da lista do RJ", () => {
    expect(municipioCodigoIbge("São Paulo")).toBeNull();
  });

  it("retorna null pra string vazia", () => {
    expect(municipioCodigoIbge("")).toBeNull();
  });

  // Achado real 12/08: expandirCidadeTruncada preserva o CASE ORIGINAL
  // quando a cidade ja bate direto sem precisar truncar/expandir (so
  // retorna a forma canonica pro caso truncado) -- cidade que chega
  // completa do romaneio em CAIXA ALTA (o formato real da fonte) tem que
  // achar o codigo do mesmo jeito, nao so quando ja está em Title Case.
  it("acha o codigo mesmo com a cidade em CAIXA ALTA (formato real do romaneio, sem acento)", () => {
    expect(municipioCodigoIbge("RIO DE JANEIRO")).toBe("3304557");
    expect(municipioCodigoIbge("CAMPOS DOS GOYTACAZES")).toBe("3301009");
  });
});
