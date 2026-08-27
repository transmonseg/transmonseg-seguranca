import { describe, it, expect } from "vitest";
import {
  extrairRuaDoEndereco, extrairCidadeDoEndereco, normalizarNomeRua,
  extrairNumeroDoEndereco, extrairBairroDoEndereco, expandirCidadeTruncada,
  montarEnderecoParaGeocode, municipioCodigoIbge, termoBuscaCidade,
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
  // Achado real da auditoria 27/08 (194 linhas / 50 enderecos distintos
  // nos ultimos 30 dias): o sufixo de complemento de entrega as vezes tem
  // virgula, e ai a cidade nao e' o ultimo segmento -- e' sempre o
  // TERCEIRO. Casos reais de producao abaixo.
  it("sufixo de complemento COM virgula: a cidade continua sendo o terceiro segmento, nao o ultimo", () => {
    // Estava gravado em producao com (-22.83106, -43.27671), no Rio
    // capital, ~137km de Rio das Ostras -- porque a "cidade" lida era "5".
    expect(extrairCidadeDoEndereco("ESTRADA CALIFORNIA, S/N - CANTAGALO, RIO DAS OSTRAS - KM 7,5")).toBe("RIO DAS OSTRAS");
    expect(extrairCidadeDoEndereco("AVENIDA DOM HÉLDER CÂMARA, 5474 - DEL CASTILHO, RIO DE JANEIRO - LOJA 306, 306A, PISO S")).toBe("RIO DE JANEIRO");
    expect(extrairCidadeDoEndereco("AVENIDA DE SANTA CRUZ, 5403 - BANGU, RIO DE JANEIRO - A, B, C RUA BOIOBI, 204")).toBe("RIO DE JANEIRO");
    expect(extrairCidadeDoEndereco("ROD PRESIDENTE JOAO GOULART RJ 116, 2501 - A SANTO ANTONIO, BOM JARDIM - KM 106,5")).toBe("BOM JARDIM");
  });

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

  it("achado real (cliente EMPORIO VALLEJU): romaneio sem cidade nenhuma ('RUA ,NUM, BAIRRO', sem ' - ') -- nao inventa cidade a partir do bairro", () => {
    expect(extrairCidadeDoEndereco("ESTRADA UNIAO E INDUSTRIA ,7046, NOGUEIRA")).toBeNull();
  });

  it("achado real (cliente MINIMERCADO BOA UNIAO, Tres Rios): virgula extra DENTRO do numero (dois lotes) nao desloca a contagem de segmentos", () => {
    // Ancora no primeiro ' - ', nao em posicao de virgula -- "85, 87" antes
    // do ' - ' nao muda onde a cidade esta.
    expect(extrairCidadeDoEndereco("R EDUARDO SANTOS LARA, 85, 87 - BOA UNIAO, TRES RIOS - *")).toBe("TRES RIOS");
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

  it("achado real (cliente EMPORIO VALLEJU): sem ' - ', o bairro e' o ultimo segmento inteiro", () => {
    expect(extrairBairroDoEndereco("ESTRADA UNIAO E INDUSTRIA ,7046, NOGUEIRA")).toBe("NOGUEIRA");
  });

  it("achado real (cliente MINIMERCADO BOA UNIAO, Tres Rios): virgula extra DENTRO do numero nao rouba o bairro pra 'cidade - sufixo'", () => {
    expect(extrairBairroDoEndereco("R EDUARDO SANTOS LARA, 85, 87 - BOA UNIAO, TRES RIOS - *")).toBe("BOA UNIAO");
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

  // Os casos abaixo NAO sao hipoteticos: sao os 157 valores distintos que o
  // campo de cidade assumiu de verdade em romaneio_pontos nos ultimos 30
  // dias (auditoria de 27/08, 49.535 linhas). Contagem real entre
  // parenteses em cada assercao.
  describe("truncamentos REAIS do dado de producao (auditoria 27/08, ultimos 30 dias)", () => {
    it("todo truncamento de 15 caracteres que aparece de verdade ja expandia por prefixo -- inclusive SANTO ANTONIO D, o caso que motivou o plano", () => {
      expect(expandirCidadeTruncada("SANTO ANTONIO D")).toBe("Santo Antônio de Pádua"); // 325
      expect(expandirCidadeTruncada("SANTO ANTÔNIO D")).toBe("Santo Antônio de Pádua"); // 3
      expect(expandirCidadeTruncada("CAMPOS DOS GOYT")).toBe("Campos dos Goytacazes"); // 2229
      expect(expandirCidadeTruncada("ARMACAO DOS BUZ")).toBe("Armação dos Búzios"); // 595
      expect(expandirCidadeTruncada("SAO JOAO DA BAR")).toBe("São João da Barra"); // 395
      expect(expandirCidadeTruncada("CASIMIRO DE ABR")).toBe("Casimiro de Abreu"); // 381
      expect(expandirCidadeTruncada("SAO JOAO DE MER")).toBe("São João de Meriti"); // 337
      expect(expandirCidadeTruncada("CACHOEIRAS DE M")).toBe("Cachoeiras de Macacu"); // 286
      expect(expandirCidadeTruncada("SAO FRANCISCO D")).toBe("São Francisco de Itabapoana"); // 242
      expect(expandirCidadeTruncada("SAO JOSE DO VAL")).toBe("São José do Vale do Rio Preto"); // 204
      expect(expandirCidadeTruncada("BOM JESUS DO IT")).toBe("Bom Jesus do Itabapoana"); // 119
      expect(expandirCidadeTruncada("ENGENHEIRO PAUL")).toBe("Engenheiro Paulo de Frontin"); // 77
      expect(expandirCidadeTruncada("CONCEICAO DE MA")).toBe("Conceição de Macabu"); // 74
      expect(expandirCidadeTruncada("TRAJANO DE MORA")).toBe("Trajano de Moraes"); // 67
      expect(expandirCidadeTruncada("COMENDADOR LEVY")).toBe("Comendador Levy Gasparian"); // 63
      expect(expandirCidadeTruncada("SAO SEBASTIAO D")).toBe("São Sebastião do Alto"); // 24
    });

    it("municipio com hifen sem o hifen: VARRE SAI -> Varre-Sai (127 linhas, o maior volume nao resolvido)", () => {
      expect(expandirCidadeTruncada("VARRE SAI")).toBe("Varre-Sai");
    });

    it("hifen do separador grudado no nome (endereco terminado em ' -' com sufixo vazio): limpa e resolve", () => {
      expect(expandirCidadeTruncada("ANGRA DOS REIS -")).toBe("Angra dos Reis"); // 81
      expect(expandirCidadeTruncada("RIO DE JANEIRO -")).toBe("Rio de Janeiro"); // 56
      expect(expandirCidadeTruncada("GUAPIMIRIM -")).toBe("Guapimirim"); // 1
      expect(expandirCidadeTruncada("NOVA IGUACU -")).toBe("Nova Iguaçu"); // 1
    });

    it("nome corrompido pela origem (nao so cortado): resolve pela tabela de aliases", () => {
      // Sem isso a linha ia pro CNEFE/OSM sem municipio nem pontoCidade e
      // casou o bairro homonimo Manguinhos do Rio capital, ~160km errado.
      expect(expandirCidadeTruncada("ARMAÇO DOS BZIO")).toBe("Armação dos Búzios"); // 4
      expect(expandirCidadeTruncada("ARMACAO BUZIOS")).toBe("Armação dos Búzios"); // 6
      expect(expandirCidadeTruncada("PARATY")).toBe("Parati"); // 2
      expect(expandirCidadeTruncada("CAMPOS DOS GOIT")).toBe("Campos dos Goytacazes"); // 1
      expect(expandirCidadeTruncada("PATY DE ALFERE")).toBe("Paty do Alferes"); // 1
    });

    it("toda cidade expandida acima resolve codigo IBGE (o que habilita o filtro de municipio no CNEFE)", () => {
      for (const bruta of ["VARRE SAI", "ANGRA DOS REIS -", "ARMAÇO DOS BZIO", "PARATY", "CAMPOS DOS GOIT", "PATY DE ALFERE", "SANTO ANTONIO D"]) {
        expect(municipioCodigoIbge(expandirCidadeTruncada(bruta)), bruta).not.toBeNull();
      }
    });

    it("cidade de OUTRO estado que aparece no dado real continua sem expandir (nao inventa municipio do RJ)", () => {
      expect(expandirCidadeTruncada("ALEM PARAIBA")).toBe("ALEM PARAIBA"); // MG, 2 linhas
    });
  });
});

// Achado real 27/08 (item 3 da blindagem): o ponto de referencia de cidade
// era buscado com o nome PELADO, e o cache de producao acumulou dezenas de
// pontos em outro estado -- CIDADE:NATIVIDADE apontando pra Natividade/TO,
// ~1500km, EM USO como regua de validacao de distancia dos enderecos.
describe("termoBuscaCidade", () => {
  it("municipio reconhecido do RJ: qualifica com o estado (nome de municipio se repete pelo Brasil inteiro)", () => {
    expect(termoBuscaCidade("Natividade")).toBe("Natividade, RJ, Brasil");
    expect(termoBuscaCidade("Valença")).toBe("Valença, RJ, Brasil");
    expect(termoBuscaCidade("Mesquita")).toBe("Mesquita, RJ, Brasil");
    expect(termoBuscaCidade("Rio Bonito")).toBe("Rio Bonito, RJ, Brasil");
  });

  it("funciona com a cidade em CAIXA ALTA (formato bruto do romaneio)", () => {
    expect(termoBuscaCidade("NATIVIDADE")).toBe("NATIVIDADE, RJ, Brasil");
  });

  it("nao reconhecido (bairro ou lixo que o parsing entregou como cidade): NAO afirma RJ", () => {
    expect(termoBuscaCidade("GRAJAU")).toBe("GRAJAU");
    expect(termoBuscaCidade("PISO S")).toBe("PISO S");
    expect(termoBuscaCidade("ALEM PARAIBA")).toBe("ALEM PARAIBA");
  });

  it("cidade truncada, ja expandida antes: qualifica (a expansao e' o que habilita o reconhecimento)", () => {
    expect(termoBuscaCidade(expandirCidadeTruncada("VARRE SAI"))).toBe("Varre-Sai, RJ, Brasil");
    expect(termoBuscaCidade(expandirCidadeTruncada("SANTO ANTONIO D"))).toBe("Santo Antônio de Pádua, RJ, Brasil");
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
