import { describe, it, expect } from "vitest";
import { delayEntradaEscalonada } from "./stagger";

describe("delayEntradaEscalonada", () => {
  it("primeiro item nao tem delay", () => {
    expect(delayEntradaEscalonada(0)).toBe(0);
  });

  it("cresce linearmente com o passo padrao (25ms)", () => {
    expect(delayEntradaEscalonada(1)).toBeCloseTo(0.025);
    expect(delayEntradaEscalonada(4)).toBeCloseTo(0.1);
  });

  it("respeita o teto padrao (300ms) pra listas grandes", () => {
    expect(delayEntradaEscalonada(100)).toBe(0.3);
    expect(delayEntradaEscalonada(12)).toBe(0.3);
  });

  it("aceita passo e teto customizados", () => {
    expect(delayEntradaEscalonada(3, 0.05, 1)).toBeCloseTo(0.15);
    expect(delayEntradaEscalonada(50, 0.05, 1)).toBe(1);
  });

  it("trata indice invalido ou negativo como zero", () => {
    expect(delayEntradaEscalonada(-1)).toBe(0);
    expect(delayEntradaEscalonada(NaN)).toBe(0);
  });
});
