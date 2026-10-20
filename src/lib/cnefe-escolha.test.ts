import { describe, it, expect } from "vitest";
import { escolherPontoCnefe, extrairCepDoEndereco, type CandidatoCnefe } from "./cnefe-escolha";

// Casos reais da auditoria de 20/10 (geocodificacao.md, casos 1-3).
const c = (lat: number, lng: number, numero: string, cep: string, localidade: string): CandidatoCnefe => ({ lat, lng, numero, cep, localidade });

describe("extrairCepDoEndereco", () => {
  it("pega o CEP do fim do endereco do romaneio, com ou sem hifen", () => {
    expect(extrairCepDoEndereco("RUA UM, S/N - JARDIM BARRO BRANCO, DUQUE DE CAXIAS - CASA LOTE 7 QUADRA 24 - 25267-090")).toBe("25267090");
    expect(extrairCepDoEndereco("ESTRADA FAZENDA INGLESA, 2111 - MOINHO PRETO, PETROPOLIS - * - 25670070")).toBe("25670070");
    expect(extrairCepDoEndereco("RUA A, 10 - CENTRO, RIO DE JANEIRO")).toBeNull();
  });
});

describe("escolherPontoCnefe", () => {
  it("caso 1 (EST CABUCU 4356): dois pontos com o numero exato e o mesmo CEP -- vence o da localidade igual ao bairro (CAMPO GRANDE), nao o mais perto da referencia", () => {
    const r = escolherPontoCnefe(
      [c(-22.924116, -43.522717, "4356", "23017250", "RIO DA PRATA"), c(-22.925579, -43.518474, "4356", "23017250", "CAMPO GRANDE")],
      { numero: 4356, cep: "23017250", bairro: "CAMPO GRANDE" },
    )!;
    expect(r.lat).toBeCloseTo(-22.925579, 5);
    expect(r.precisao).toBe("exato");
    expect(r.confirmado).toBe(true);
  });

  it("caso 2 (RUA UM, S/N, CEP 25267090): usa so' os pontos do CEP do endereco, nunca a Rua Um de outro CEP", () => {
    const cands = [
      c(-22.6500, -43.2400, "10", "25267090", "BARRO BRANCO"),
      c(-22.6505, -43.2405, "20", "25267090", "BARRO BRANCO"),
      c(-22.6510, -43.2410, "30", "25267090", "JARDIM BARRO BRANCO"),
      c(-22.641857, -43.245056, "5", "25268040", "NOVA CAMPINAS"),
    ];
    const r = escolherPontoCnefe(cands, { numero: null, cep: "25267090", bairro: "JARDIM BARRO BRANCO" })!;
    expect(r.lat).toBeCloseTo(-22.6505, 4);
    expect(["trecho", "rua"]).toContain(r.precisao);
    expect(r.confirmado).toBe(true);
  });

  it("caso 3 (ESTRADA FAZENDA INGLESA 2111, CEP 25670070): nunca cai no 2046 de outro CEP; sem vizinho proximo vira trecho/rua, nao exato", () => {
    const cands = [
      c(-22.4830, -43.2180, "3245", "25670070", "FAZENDA INGLESA"),
      c(-22.4822, -43.2174, "3251", "25670070", "FAZENDA INGLESA"),
      c(-22.4900, -43.2100, "1421", "25670070", "FAZENDA INGLESA"),
      c(-22.485143, -43.211058, "2046", "25675001", "MOSELA"),
    ];
    const r = escolherPontoCnefe(cands, { numero: 2111, cep: "25670070", bairro: "MOINHO PRETO" })!;
    expect(r.lat).not.toBeCloseTo(-22.485143, 4);
    expect(["trecho", "rua"]).toContain(r.precisao);
  });

  it("numero ausente entre dois vizinhos proximos da mesma rua: interpola", () => {
    const r = escolherPontoCnefe(
      [c(-22.9000, -43.2000, "10", "20000100", "CENTRO"), c(-22.9010, -43.2000, "20", "20000100", "CENTRO")],
      { numero: 14, cep: "20000100", bairro: "CENTRO" },
    )!;
    expect(r.precisao).toBe("interpolado");
    expect(r.lat).toBeCloseTo(-22.9004, 4);
  });

  it("numero do romaneio nunca vira 'exato'/'interpolado' em cima de um ponto S/N do CNEFE (numero '0'; UNIAO E INDUSTRIA 12726)", () => {
    const r = escolherPontoCnefe(
      [c(-22.95, -43.20, "0", "25730740", "NOGUEIRA"), c(-22.90, -43.10, "12500", "25730740", "NOGUEIRA")],
      { numero: 12726, cep: "25730740", bairro: "NOGUEIRA" },
    )!;
    expect(r.precisao).toBe("rua");
    const soSN = escolherPontoCnefe([c(-22.95, -43.20, "0", "25730740", "NOGUEIRA")], { numero: 1, cep: "25730740", bairro: "NOGUEIRA" })!;
    expect(["exato", "interpolado"]).not.toContain(soSN.precisao);
  });

  it("resultado deterministico: a ordem dos candidatos nao muda o ponto", () => {
    const cands = Array.from({ length: 30 }, (_, i) => c(-22.6 - i * 0.0003, -43.2 - (i % 7) * 0.0002, String(i * 2), "25267090", "BARRO BRANCO"));
    const a = escolherPontoCnefe(cands, { numero: null, cep: "25267090", bairro: "BARRO BRANCO" })!;
    const b = escolherPontoCnefe([...cands].reverse(), { numero: null, cep: "25267090", bairro: "BARRO BRANCO" })!;
    expect([b.lat, b.lng]).toEqual([a.lat, a.lng]);
  });

  it("sem CEP nem bairro batendo: devolve sem confirmacao (o chamador aplica o teto de distancia da referencia)", () => {
    const r = escolherPontoCnefe([c(-22.9, -43.2, "50", "11111111", "OUTRO")], { numero: 50, cep: "22222222", bairro: "CENTRO" })!;
    expect(r.confirmado).toBe(false);
  });
});
