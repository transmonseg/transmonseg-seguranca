import { describe, it, expect } from "vitest";
import {
  atualizarBaselineWelford, zScoreBaseline, classificarTipoViagem,
  deveForcarReadmissaoBaseline, decidirAdmissaoBaseline, BASELINE_N_MAXIMO,
  type Baseline,
} from "./baseline-veiculo";

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
  // Substituir o teste existente "variancia zero: nao divide por zero..."
  // por este (o comportamento muda: em vez de +-Infinity, agora usa o piso):
  it("variancia zero: usa o piso de desvio em vez de dividir por zero", () => {
    expect(zScoreBaseline(40, { n: 50, media: 40, variancia: 0 }, 20)).toBe(0);
    expect(zScoreBaseline(50, { n: 50, media: 40, variancia: 0 }, 20)).toBeCloseTo(10 / 3, 5);
    expect(zScoreBaseline(30, { n: 50, media: 40, variancia: 0 }, 20)).toBeCloseTo(-10 / 3, 5);
  });

  it("variancia pequena mas nao-zero (caso real RQV-9B26): piso evita explosao de z-score", () => {
    // n=581, media=6.0, variancia=0.0068 (desvio real ~0.083km/h) -- sem piso,
    // 58km/h dava z=(58-6)/0.083 ~= 626. Com piso de 3km/h, fica bem menor.
    const baselineTravado = { n: 581, media: 6.0, variancia: 0.0068 };
    const z = zScoreBaseline(58, baselineTravado, 20)!;
    expect(z).toBeCloseTo((58 - 6.0) / 3, 1);
    expect(z).toBeLessThan(20);
  });

  it("variancia ja saudavel (acima do piso): nao mexe no desvio calculado", () => {
    const baselineSaudavel = { n: 100, media: 30, variancia: 100 }; // desvio = 10
    expect(zScoreBaseline(50, baselineSaudavel, 20)).toBeCloseTo(2, 5);
  });
});

describe("atualizarBaselineWelford: teto de peso acumulado (BASELINE_N_MAXIMO)", () => {
  it("nao ultrapassa o teto mesmo com muitas amostras", () => {
    let b: Baseline = { n: 0, media: 0, variancia: 0 };
    for (let i = 0; i < BASELINE_N_MAXIMO + 100; i++) b = atualizarBaselineWelford(b, 10);
    expect(b.n).toBe(BASELINE_N_MAXIMO);
  });

  it("depois de saturar, uma amostra nova ainda move a media perceptivelmente", () => {
    let b: Baseline = { n: 0, media: 0, variancia: 0 };
    for (let i = 0; i < BASELINE_N_MAXIMO + 50; i++) b = atualizarBaselineWelford(b, 6);
    expect(b.media).toBeCloseTo(6, 5);
    const antes = b.media;
    b = atualizarBaselineWelford(b, 60);
    // com n tampado, o peso da amostra nova e 1/BASELINE_N_MAXIMO -- deve
    // mover a media de forma mensuravel, nao travar em ~6 pra sempre.
    expect(b.media).toBeGreaterThan(antes + 0.05);
  });

  it("apos saturar, variancia converge pra variancia real (nao cresce sem limite)", () => {
    let b: Baseline = { n: 0, media: 0, variancia: 0 };
    // oscila 20/40 -- media real 30, variancia real 100 (sd=10)
    for (let i = 0; i < BASELINE_N_MAXIMO * 20; i++) b = atualizarBaselineWelford(b, i % 2 === 0 ? 20 : 40);
    expect(b.variancia).toBeCloseTo(100, -1); // tolerancia ampla, so pra provar que NAO explode
    expect(b.variancia).toBeLessThan(300); // bem abaixo do que o bug antigo dava (sd=200 -> variancia=40000)
  });
});

describe("deveForcarReadmissaoBaseline", () => {
  it("nunca foi excluida (null): nao forca", () => {
    expect(deveForcarReadmissaoBaseline(null, new Date("2026-07-28T12:00:00Z"))).toBe(false);
  });

  it("excluida ha menos tempo que o limiar: nao forca", () => {
    const excluidaDesde = "2026-07-28T10:00:00Z";
    const agora = new Date("2026-07-28T12:00:00Z"); // 2h depois
    expect(deveForcarReadmissaoBaseline(excluidaDesde, agora)).toBe(false);
  });

  it("excluida ha mais tempo que o limiar: forca", () => {
    const excluidaDesde = "2026-07-28T06:00:00Z";
    const agora = new Date("2026-07-28T12:00:00Z"); // 6h depois (limiar e 4h)
    expect(deveForcarReadmissaoBaseline(excluidaDesde, agora)).toBe(true);
  });

  it("aceita limiar customizado", () => {
    const excluidaDesde = "2026-07-28T11:00:00Z";
    const agora = new Date("2026-07-28T12:00:00Z"); // 1h depois
    expect(deveForcarReadmissaoBaseline(excluidaDesde, agora, 30 * 60 * 1000)).toBe(true); // limiar 30min
  });
});

describe("decidirAdmissaoBaseline", () => {
  const agora = new Date("2026-07-28T12:00:00Z");

  it("cold-start (usaBaselineProprio=false): sempre admite mesmo com ehAnomalia=true", () => {
    const r = decidirAdmissaoBaseline({ usaBaselineProprio: false, ehAnomalia: true, excluidaDesde: null, agora });
    expect(r).toEqual({ admitir: true, marcarExclusaoAgora: false });
  });

  it("baseline proprio + anomalia + ainda dentro do prazo: exclui e marca", () => {
    const r = decidirAdmissaoBaseline({ usaBaselineProprio: true, ehAnomalia: true, excluidaDesde: null, agora });
    expect(r).toEqual({ admitir: false, marcarExclusaoAgora: true });
  });

  it("baseline proprio + anomalia + ja passou do prazo: admite (forcado) e nao marca de novo", () => {
    const excluidaDesde = "2026-07-28T06:00:00Z"; // 6h atras, limiar e 4h
    const r = decidirAdmissaoBaseline({ usaBaselineProprio: true, ehAnomalia: true, excluidaDesde, agora });
    expect(r).toEqual({ admitir: true, marcarExclusaoAgora: false });
  });

  it("ja estava marcado + ainda anomalo + dentro do prazo: exclui mas nao marca de novo", () => {
    const excluidaDesde = "2026-07-28T11:00:00Z"; // 1h atras, dentro do limiar de 4h
    const r = decidirAdmissaoBaseline({ usaBaselineProprio: true, ehAnomalia: true, excluidaDesde, agora });
    expect(r).toEqual({ admitir: false, marcarExclusaoAgora: false });
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
