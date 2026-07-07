import { describe, it, expect } from "vitest";
import { atualizarPerfilRota, desvioPadraoDe, PERFIL_ROTA_ALPHA, type PerfilRotaEstado } from "./rotaperfil";

describe("atualizarPerfilRota", () => {
  it("primeira amostra: media = valor, variancia = 0, 1 amostra", () => {
    const estado = atualizarPerfilRota(null, 100);
    expect(estado).toEqual({ nAmostras: 1, mediaM: 100, varianciaM2: 0 });
  });

  it("amostras identicas repetidas: media fica estavel, variancia continua 0", () => {
    let estado: PerfilRotaEstado | null = null;
    for (let i = 0; i < 20; i++) estado = atualizarPerfilRota(estado, 50);
    expect(estado!.mediaM).toBeCloseTo(50, 6);
    expect(estado!.varianciaM2).toBeCloseTo(0, 6);
    expect(estado!.nAmostras).toBe(20);
  });

  it("2a amostra: media move exatamente ALPHA fracao na direcao do novo valor", () => {
    const e1 = atualizarPerfilRota(null, 100);
    const e2 = atualizarPerfilRota(e1, 200);
    // delta = 200-100=100; media = 100 + 0.08*100 = 108
    expect(e2.mediaM).toBeCloseTo(100 + PERFIL_ROTA_ALPHA * 100, 6);
    expect(e2.varianciaM2).toBeGreaterThan(0); // 1o desvio da media introduz variancia
  });

  it("outlier isolado desloca a media so uma fracao pequena (nao 'trava' no novo valor)", () => {
    let estado: PerfilRotaEstado | null = null;
    for (let i = 0; i < 20; i++) estado = atualizarPerfilRota(estado, 50);
    const antesDoOutlier = estado!.mediaM;
    const depoisDoOutlier = atualizarPerfilRota(estado, 5000);
    expect(depoisDoOutlier.mediaM).toBeGreaterThan(antesDoOutlier);
    expect(depoisDoOutlier.mediaM).toBeLessThan(antesDoOutlier + (5000 - antesDoOutlier)); // nao pula direto pro outlier
  });

  it("rota muda de verdade (novo padrao sustentado): media converge pro novo patamar em poucas amostras", () => {
    let estado: PerfilRotaEstado | null = null;
    for (let i = 0; i < 30; i++) estado = atualizarPerfilRota(estado, 50); // padrao antigo bem estabelecido
    for (let i = 0; i < 30; i++) estado = atualizarPerfilRota(estado, 500); // rota mudou (obra, novo acesso)
    expect(estado!.mediaM).toBeGreaterThan(450); // convergiu quase totalmente pro novo patamar
  });

  it("nAmostras satura em 1000 (so gate de confianca, nao entra na formula)", () => {
    let estado: PerfilRotaEstado | null = null;
    for (let i = 0; i < 1500; i++) estado = atualizarPerfilRota(estado, 100);
    expect(estado!.nAmostras).toBe(1000);
  });

  it("amostras alternadas entre dois valores: variancia converge pra algo positivo e estavel, nunca negativa", () => {
    let estado: PerfilRotaEstado | null = null;
    for (let i = 0; i < 200; i++) estado = atualizarPerfilRota(estado, i % 2 === 0 ? 100 : 300);
    expect(estado!.varianciaM2).toBeGreaterThan(0);
    expect(estado!.mediaM).toBeGreaterThan(100);
    expect(estado!.mediaM).toBeLessThan(300);
  });
});

describe("desvioPadraoDe", () => {
  it("variancia 0 -> desvio padrao 0", () => {
    expect(desvioPadraoDe({ nAmostras: 5, mediaM: 100, varianciaM2: 0 })).toBe(0);
  });

  it("variancia positiva -> raiz quadrada exata", () => {
    expect(desvioPadraoDe({ nAmostras: 5, mediaM: 100, varianciaM2: 400 })).toBe(20);
  });

  it("nunca retorna NaN/negativo mesmo com variancia negativa por erro de ponto flutuante", () => {
    expect(desvioPadraoDe({ nAmostras: 5, mediaM: 100, varianciaM2: -0.0000001 })).toBe(0);
  });
});
