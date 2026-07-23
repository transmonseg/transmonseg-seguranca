import { describe, it, expect } from "vitest";
import { taxaFalsoPositivoCalibrada, aplicarFatorCalibrado, segmentoCalibracaoPreferido } from "./calibracao-desvio";

describe("taxaFalsoPositivoCalibrada (shrinkage bayesiano simples, Beta-Binomial)", () => {
  it("com poucas amostras (abaixo do minimo), fica igual a taxa global (shrinkage total)", () => {
    const r = taxaFalsoPositivoCalibrada(2, 1, 0.3, 20);
    expect(r).toBeCloseTo(0.3, 1);
  });

  it("com muitas amostras, converge pra taxa observada do proprio segmento", () => {
    const r = taxaFalsoPositivoCalibrada(1000, 100, 0.3, 20); // 10% observado
    expect(r).toBeCloseTo(0.1, 1);
  });

  it("com amostras no meio do caminho, fica entre a taxa global e a observada", () => {
    const r = taxaFalsoPositivoCalibrada(20, 2, 0.3, 20); // observado 10%, global 30%
    expect(r).toBeGreaterThan(0.1);
    expect(r).toBeLessThan(0.3);
  });

  it("zero amostras: retorna exatamente a taxa global", () => {
    expect(taxaFalsoPositivoCalibrada(0, 0, 0.3, 20)).toBe(0.3);
  });
});

describe("aplicarFatorCalibrado", () => {
  it("taxa de falso positivo zero: score sai igual", () => {
    expect(aplicarFatorCalibrado(80, 0)).toBe(80);
  });

  it("taxa de falso positivo 0.5: score cai pela metade", () => {
    expect(aplicarFatorCalibrado(80, 0.5)).toBe(40);
  });

  it("taxa de falso positivo alta (0.9): score cai bastante mas nao desaparece", () => {
    expect(aplicarFatorCalibrado(80, 0.9)).toBe(8);
  });

  it("arredonda pro inteiro mais proximo", () => {
    expect(aplicarFatorCalibrado(45, 0.33)).toBe(30); // 45 * 0.67 = 30.15
  });
});

describe("segmentoCalibracaoPreferido (achado real 12/07, campo estrutural desde 22/07)", () => {
  it("desvio vencedor veio do detector comportamental: usa segmento por veredito de corredor", () => {
    const alerta = { tipo: "desvio", origemDesvio: "comportamental" as const };
    expect(segmentoCalibracaoPreferido(alerta, "fora")).toBe("corredor_veredito:fora");
  });

  it("desvio vencedor veio da cerca virtual: nao usa veredito de corredor", () => {
    const alerta = { tipo: "desvio", origemDesvio: "cerca_virtual" as const };
    expect(segmentoCalibracaoPreferido(alerta, "fora")).toBeNull();
  });

  it("origemDesvio ausente (nao deveria acontecer em producao, mas defensivo): nao usa veredito de corredor", () => {
    const alerta = { tipo: "desvio" };
    expect(segmentoCalibracaoPreferido(alerta, "fora")).toBeNull();
  });

  it("corredorVeredito nao tem veredito (indisponivel/orcamento_estourado): nao usa segmento especifico mesmo vindo do comportamental", () => {
    const alerta = { tipo: "desvio", origemDesvio: "comportamental" as const };
    expect(segmentoCalibracaoPreferido(alerta, undefined)).toBeNull();
    expect(segmentoCalibracaoPreferido(alerta, null)).toBeNull();
  });

  it("alerta vencedor nao e desvio: nunca usa segmento por veredito de corredor", () => {
    const alerta = { tipo: "jammer" };
    expect(segmentoCalibracaoPreferido(alerta, "fora")).toBeNull();
  });
});
