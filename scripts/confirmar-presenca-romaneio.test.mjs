import { describe, it, expect } from "vitest";
import { calcularStreakMaximoComPosicao, proximaEscritaCache } from "./confirmar-presenca-romaneio.mjs";

describe("calcularStreakMaximoComPosicao", () => {
  const PONTO = { lat: -22.9, lng: -43.2 };

  it("sem trilha: sem streak", () => {
    const r = calcularStreakMaximoComPosicao([], PONTO.lat, PONTO.lng, 300, 5, 120);
    expect(r).toEqual({ dwellMaxS: 0, posicaoReal: null });
  });

  it("streak curto (menos que o minimo): dwellMaxS abaixo do minimo, posicaoReal null", () => {
    const trilha = [
      { lat: -22.9001, lng: -43.2001, velocidade: 0 },
      { lat: -22.9001, lng: -43.2001, velocidade: 0 },
    ];
    const r = calcularStreakMaximoComPosicao(trilha, PONTO.lat, PONTO.lng, 300, 5, 120);
    expect(r.dwellMaxS).toBeLessThan(120);
    expect(r.posicaoReal).toBeNull();
  });

  it("streak longo dentro do raio, parado: confirma e retorna a media real da trilha", () => {
    const trilha = [
      { lat: -22.9002, lng: -43.2002, velocidade: 0 },
      { lat: -22.9004, lng: -43.2004, velocidade: 0 },
      { lat: -22.9004, lng: -43.2004, velocidade: 0 },
      { lat: -22.9004, lng: -43.2004, velocidade: 0 },
      { lat: -22.9004, lng: -43.2004, velocidade: 0 },
    ];
    const r = calcularStreakMaximoComPosicao(trilha, PONTO.lat, PONTO.lng, 300, 5, 120);
    expect(r.dwellMaxS).toBeGreaterThanOrEqual(120);
    expect(r.posicaoReal).not.toBeNull();
    // media das 5 leituras
    expect(r.posicaoReal.lat).toBeCloseTo(-22.90036, 4);
    expect(r.posicaoReal.lng).toBeCloseTo(-43.20036, 4);
  });

  it("velocidade alta interrompe o streak (nao conta como parado)", () => {
    const trilha = [
      { lat: -22.9002, lng: -43.2002, velocidade: 0 },
      { lat: -22.9002, lng: -43.2002, velocidade: 0 },
      { lat: -22.9002, lng: -43.2002, velocidade: 20 }, // interrompe
      { lat: -22.9002, lng: -43.2002, velocidade: 0 },
    ];
    const r = calcularStreakMaximoComPosicao(trilha, PONTO.lat, PONTO.lng, 300, 5, 120);
    expect(r.dwellMaxS).toBeLessThan(120); // nenhum streak individual chega ao minimo
  });

  it("fora do raio nao conta, mesmo parado", () => {
    const trilha = [
      { lat: -23.5, lng: -43.9, velocidade: 0 }, // longe do ponto
      { lat: -23.5, lng: -43.9, velocidade: 0 },
      { lat: -23.5, lng: -43.9, velocidade: 0 },
      { lat: -23.5, lng: -43.9, velocidade: 0 },
      { lat: -23.5, lng: -43.9, velocidade: 0 },
    ];
    const r = calcularStreakMaximoComPosicao(trilha, PONTO.lat, PONTO.lng, 300, 5, 120);
    expect(r.dwellMaxS).toBe(0);
    expect(r.posicaoReal).toBeNull();
  });
});

describe("proximaEscritaCache", () => {
  const REAL = { lat: -22.91, lng: -43.21 };

  it("sem ancora existente: cria nova linha com fonte dwell_confirmado, n_observacoes=1", () => {
    const r = proximaEscritaCache(null, REAL);
    expect(r).toEqual({ lat: REAL.lat, lng: REAL.lng, fonte: "dwell_confirmado", n_observacoes: 1, novaLinha: true });
  });

  it("ancora existente com fonte geocodificada: corrige pra posicao real, reseta n_observacoes=1", () => {
    const existente = { lat: -22.85, lng: -43.15, fonte: "nominatim", n_observacoes: 1 };
    const r = proximaEscritaCache(existente, REAL);
    expect(r).toEqual({ lat: REAL.lat, lng: REAL.lng, fonte: "dwell_confirmado", n_observacoes: 1, novaLinha: false });
  });

  it("ancora ja dwell_confirmado: faz media ponderada por n_observacoes, incrementa", () => {
    const existente = { lat: -22.90, lng: -43.20, fonte: "dwell_confirmado", n_observacoes: 2 };
    const r = proximaEscritaCache(existente, REAL);
    // (lat*2 + REAL.lat) / 3
    expect(r.lat).toBeCloseTo((-22.90 * 2 + REAL.lat) / 3, 6);
    expect(r.lng).toBeCloseTo((-43.20 * 2 + REAL.lng) / 3, 6);
    expect(r.fonte).toBe("dwell_confirmado");
    expect(r.n_observacoes).toBe(3);
    expect(r.novaLinha).toBe(false);
  });
});
