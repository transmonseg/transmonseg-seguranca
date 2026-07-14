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

describe("segmentoCalibracaoPreferido (achado real 12/07, auditoria adversarial)", () => {
  it("desvio vencedor veio do detector comportamental: usa segmento por veredito de corredor", () => {
    const desvioComportamental = { motivo: "Afastando-se de todos os 3 destinos ha 2 leituras" };
    const alerta = { tipo: "desvio", motivo: "Afastando-se de todos os 3 destinos ha 2 leituras (+1,2km)" };
    expect(segmentoCalibracaoPreferido(alerta, desvioComportamental, "fora")).toBe("corredor_veredito:fora");
  });

  it("desvio vencedor veio da cerca virtual (motivo nao bate com o comportamental): nao usa veredito de corredor", () => {
    const desvioComportamental = { motivo: "Afastando-se de todos os 3 destinos ha 2 leituras" };
    const alertaCerca = { tipo: "desvio", motivo: "Fora da rota esperada (300m da estrada real ate o proximo ponto, buffer 120m)" };
    expect(segmentoCalibracaoPreferido(alertaCerca, desvioComportamental, "fora")).toBeNull();
  });

  it("nao havia candidato comportamental nesse ciclo (so a cerca disparou): nao usa veredito de corredor", () => {
    const alertaCerca = { tipo: "desvio", motivo: "Fora da rota esperada (300m da estrada real ate o proximo ponto, buffer 120m)" };
    expect(segmentoCalibracaoPreferido(alertaCerca, null, "fora")).toBeNull();
  });

  it("corredorInfo nao tem veredito (indisponivel/orcamento_estourado): nao usa segmento especifico mesmo vindo do comportamental", () => {
    const desvioComportamental = { motivo: "Afastando-se de todos os 3 destinos ha 2 leituras" };
    const alerta = { tipo: "desvio", motivo: "Afastando-se de todos os 3 destinos ha 2 leituras (+1,2km)" };
    expect(segmentoCalibracaoPreferido(alerta, desvioComportamental, undefined)).toBeNull();
    expect(segmentoCalibracaoPreferido(alerta, desvioComportamental, null)).toBeNull();
  });

  it("alerta vencedor nao e desvio: nunca usa segmento por veredito de corredor", () => {
    const alerta = { tipo: "jammer", motivo: "Sinal de GPS perdido de forma abrupta" };
    expect(segmentoCalibracaoPreferido(alerta, null, "fora")).toBeNull();
  });
});
