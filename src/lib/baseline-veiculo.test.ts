import { describe, it, expect } from "vitest";
import { atualizarBaselineWelford, zScoreBaseline, classificarTipoViagem, type Baseline } from "./baseline-veiculo";

describe("atualizarBaselineWelford (media/variancia incremental, sem guardar amostras cruas)", () => {
  it("primeira amostra vira a media, variancia zero", () => {
    const r = atualizarBaselineWelford({ n: 0, media: 0, variancia: 0 }, 50);
    expect(r).toEqual({ n: 1, media: 50, variancia: 0 });
  });

  it("converge pra media real apos varias amostras identicas", () => {
    let b: Baseline = { n: 0, media: 0, variancia: 0 };
    for (const v of [40, 40, 40, 40]) b = atualizarBaselineWelford(b, v);
    expect(b.media).toBeCloseTo(40, 5);
    expect(b.variancia).toBeCloseTo(0, 5);
    expect(b.n).toBe(4);
  });

  it("detecta variancia com valores diferentes", () => {
    let b: Baseline = { n: 0, media: 0, variancia: 0 };
    for (const v of [10, 20, 30, 40, 50]) b = atualizarBaselineWelford(b, v);
    expect(b.media).toBeCloseTo(30, 5);
    expect(b.variancia).toBeGreaterThan(0);
  });
});

describe("zScoreBaseline", () => {
  const baseline: Baseline = { n: 50, media: 40, variancia: 100 }; // desvio = 10
  it("valor igual a media: z = 0", () => {
    expect(zScoreBaseline(40, baseline, 20)).toBeCloseTo(0, 5);
  });
  it("valor 2 desvios acima: z = 2", () => {
    expect(zScoreBaseline(60, baseline, 20)).toBeCloseTo(2, 5);
  });
  it("amostras insuficientes (cold start): retorna null", () => {
    expect(zScoreBaseline(60, { n: 5, media: 40, variancia: 100 }, 20)).toBeNull();
  });
  it("variancia zero: nao divide por zero, retorna 0 se valor igual, diferenca grande se nao", () => {
    expect(zScoreBaseline(40, { n: 50, media: 40, variancia: 0 }, 20)).toBe(0);
    expect(zScoreBaseline(50, { n: 50, media: 40, variancia: 0 }, 20)).toBe(Infinity);
    expect(zScoreBaseline(30, { n: 50, media: 40, variancia: 0 }, 20)).toBe(-Infinity);
  });
});

describe("classificarTipoViagem", () => {
  it("velocidade media alta (>=60): rodoviario", () => {
    expect(classificarTipoViagem(65)).toBe("rodoviario");
    expect(classificarTipoViagem(60)).toBe("rodoviario");
  });
  it("velocidade media abaixo de 60: urbano", () => {
    expect(classificarTipoViagem(59)).toBe("urbano");
    expect(classificarTipoViagem(20)).toBe("urbano");
  });
});
