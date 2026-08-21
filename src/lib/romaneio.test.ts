import { describe, it, expect } from "vitest";
import { normalizarPlaca, extrairDataRomaneio, parseRomaneio, montarPontosDeRomaneio } from "./romaneio";
import type { PontoEntrega } from "./unitrac";

function pontoUnitrac(overrides: Partial<PontoEntrega> = {}): PontoEntrega {
  return {
    lat: -21, lng: -41, raio: 50, ordem: 0, nome: "x", feito: false, situacao: 0,
    codigo: 1, pontoCodigo: 1, documento: "2272484", identificador: null,
    dataInicio: null, dataRealizado: null, observacoes: null, rota: null,
    ...overrides,
  };
}

describe("normalizarPlaca", () => {
  it("adiciona hifen na 3a posicao quando falta", () => {
    expect(normalizarPlaca("TUL1C38")).toBe("TUL-1C38");
    expect(normalizarPlaca("TTH3C94")).toBe("TTH-3C94");
  });
  it("ja com hifen: mantem como esta", () => {
    expect(normalizarPlaca("TUL-1C38")).toBe("TUL-1C38");
  });
  it("tamanho diferente do esperado (7 chars sem hifen): mantem como esta", () => {
    expect(normalizarPlaca("AB123")).toBe("AB123");
  });
  it("erro de digitacao na fonte (achado real 20-21/08, RGU-5G33 no romaneio da Nutry Max): corrige pra placa real confirmada na Unitrac", () => {
    expect(normalizarPlaca("RGU-5G33")).toBe("RQU-5G33");
    expect(normalizarPlaca("RGU5G33")).toBe("RQU-5G33");
  });
  it("placa parecida mas NAO mapeada na correcao: mantem como esta", () => {
    expect(normalizarPlaca("RGU-5G34")).toBe("RGU-5G34");
  });
});

describe("extrairDataRomaneio", () => {
  it("acha data no formato dd/mm/aaaa hh:mm e devolve ISO (aaaa-mm-dd)", () => {
    const texto = "8012 - Romaneio de Entrega 15/07/2026 06:17\nPLACA/MOTORISTA: ...";
    expect(extrairDataRomaneio(texto)).toBe("2026-07-15");
  });
  it("sem data no formato esperado: null", () => {
    expect(extrairDataRomaneio("texto sem nenhuma data reconhecivel")).toBeNull();
  });
});

// Formato real confirmado extraindo o texto do romaneio de 15/07/2026 com
// pdf-parse v2 -- cabecalho com PLACA/MOTORISTA antes de CARGA/DESTINO
// (separados por tab), e o rotulo "NF / CLIENTE:" solto, fora de ordem
// (sobra da entrada seguinte), nunca colado na linha de dados.
const TEXTO_EXEMPLO = [
  "8012 - Romaneio de Entrega 15/07/2026 06:17",
  "PLACA/MOTORISTA: TUL1C38 / LUCAS DOS SANTOS FERREIRA\tCARGA/DESTINO: 93587 / NATIVIDADE",
  "AJUDANTE(S): JEFFERSON LUIZ CASTRO COSTA ,",
  "2272484 / 137039 - SUPERMERCADO SANSAO",
  "RUA MONS MIGUEL REIS MELLO, 33 - LIBERDADE, NATIVIDADE - *",
  "NF / CLIENTE:",
  "2272485 / 137744 - SURPERMERCADO SANSAO",
  "AV AMARAL PEIXOTO, 37 - CENTRO, NATIVIDADE - LOJA B",
  "NF / CLIENTE:",
  "Total de 2 clientes",
  "",
  "-- 1 of 2 --",
  "",
  "8012 - Romaneio de Entrega 15/07/2026 06:17",
  "PLACA/MOTORISTA: TTH3C94 / DIEGO NUNES DE OLIVEIRA\tCARGA/DESTINO: 93588 / S.A.DE PADUA",
  "AJUDANTE(S): EMANUEL MARCOS VIDAL RIBEIRO ,",
  "2272397 / 135408 - MERCADO MILLER DE APERIBE",
  "AV JOSE PEREIRA DE PINHO, 1036 - CENTRO, APERIBE - *",
  "NF / CLIENTE:",
  "Total de 1 clientes",
].join("\n");

describe("parseRomaneio", () => {
  it("extrai todas as linhas das 2 secoes, com placa/carga corretos por secao", () => {
    const linhas = parseRomaneio(TEXTO_EXEMPLO);
    expect(linhas).toHaveLength(3);
    expect(linhas[0]).toMatchObject({
      placaBruta: "TUL1C38",
      motorista: "LUCAS DOS SANTOS FERREIRA",
      cargaDestinoCodigo: "93587",
      cargaDestinoNome: "NATIVIDADE",
      nf: "2272484",
      clienteCodigo: "137039",
      clienteNome: "SUPERMERCADO SANSAO",
      enderecoBruto: "RUA MONS MIGUEL REIS MELLO, 33 - LIBERDADE, NATIVIDADE - *",
    });
    expect(linhas[2]).toMatchObject({
      placaBruta: "TTH3C94",
      cargaDestinoCodigo: "93588",
      cargaDestinoNome: "S.A.DE PADUA",
      nf: "2272397",
      clienteNome: "MERCADO MILLER DE APERIBE",
    });
  });
  it("ignora o rotulo 'NF / CLIENTE:', 'Total de N clientes' e o marcador de pagina", () => {
    const linhas = parseRomaneio(TEXTO_EXEMPLO);
    expect(linhas.some((l) => l.enderecoBruto.includes("Total de"))).toBe(false);
    expect(linhas.some((l) => l.nf === "NF")).toBe(false);
  });
  it("texto vazio: lista vazia", () => {
    expect(parseRomaneio("")).toEqual([]);
  });
  it("endereco com S/N (contem uma barra) nao e confundido com uma nova linha de NF", () => {
    const texto = [
      "PLACA/MOTORISTA: TUL1C38 / LUCAS\tCARGA/DESTINO: 93587 / NATIVIDADE",
      "2272489 / 142492 - LANCHONETE DO JUNINHO",
      "RUA DOMICILIANO GOMES, S/N - LIBERDADE, NATIVIDADE - *",
    ].join("\n");
    const linhas = parseRomaneio(texto);
    expect(linhas).toHaveLength(1);
    expect(linhas[0].enderecoBruto).toBe("RUA DOMICILIANO GOMES, S/N - LIBERDADE, NATIVIDADE - *");
  });
});

describe("montarPontosDeRomaneio", () => {
  it("NF com alvo correspondente na Unitrac: pega o status (feito/situacao) de la", () => {
    const romaneio = [{ nf: "2272484", clienteNome: "SUPERMERCADO SANSAO", lat: -21.04, lng: -41.98, presencaConfirmadaEm: null }];
    const unitrac = [pontoUnitrac({ documento: "2272484", feito: true, situacao: 1 })];
    const resultado = montarPontosDeRomaneio(romaneio, unitrac);
    expect(resultado).toHaveLength(1);
    expect(resultado[0]).toMatchObject({ lat: -21.04, lng: -41.98, feito: true, situacao: 1, documento: "2272484", nome: "SUPERMERCADO SANSAO" });
  });

  it("NF sem alvo correspondente ainda (nao sincronizou): vira pendente por padrao", () => {
    const romaneio = [{ nf: "9999999", clienteNome: "CLIENTE NOVO", lat: -21, lng: -41, presencaConfirmadaEm: null }];
    const resultado = montarPontosDeRomaneio(romaneio, []);
    expect(resultado[0]).toMatchObject({ feito: false, situacao: 0, codigo: null, pontoCodigo: null });
  });

  it("usa raio/codigo/pontoCodigo do alvo da Unitrac quando existe (mantem compatibilidade com o resto do motor)", () => {
    const romaneio = [{ nf: "2272484", clienteNome: "X", lat: -21, lng: -41, presencaConfirmadaEm: null }];
    const unitrac = [pontoUnitrac({ documento: "2272484", raio: 80, codigo: 555, pontoCodigo: 777 })];
    const resultado = montarPontosDeRomaneio(romaneio, unitrac);
    expect(resultado[0]).toMatchObject({ raio: 80, codigo: 555, pontoCodigo: 777 });
  });

  it("presencaConfirmadaEm nao-nulo: feito=true mesmo sem alvo da Unitrac confirmar", () => {
    const romaneio = [{ nf: "2272484", clienteNome: "X", lat: -21, lng: -41, presencaConfirmadaEm: "2026-07-15T12:00:00Z" }];
    const unitrac = [pontoUnitrac({ documento: "2272484", feito: false, situacao: 0 })];
    const resultado = montarPontosDeRomaneio(romaneio, unitrac);
    expect(resultado[0].feito).toBe(true);
  });

  it("presencaConfirmadaEm null e alvo nao confirmado: feito=false (comportamento atual preservado)", () => {
    const romaneio = [{ nf: "2272484", clienteNome: "X", lat: -21, lng: -41, presencaConfirmadaEm: null }];
    const unitrac = [pontoUnitrac({ documento: "2272484", feito: false, situacao: 0 })];
    const resultado = montarPontosDeRomaneio(romaneio, unitrac);
    expect(resultado[0].feito).toBe(false);
  });

  it("alvo da Unitrac ja confirmado, sem presenca confirmada: continua feito=true (uniao, nao substituicao)", () => {
    const romaneio = [{ nf: "2272484", clienteNome: "X", lat: -21, lng: -41, presencaConfirmadaEm: null }];
    const unitrac = [pontoUnitrac({ documento: "2272484", feito: true, situacao: 1 })];
    const resultado = montarPontosDeRomaneio(romaneio, unitrac);
    expect(resultado[0].feito).toBe(true);
  });
});
