// RAS-01 + RAS-04 (auditoria 03/11): um só critério de atual / atrasado /
// sem sinal para mapa, painel, grade e filtro. O número de entrada é o atraso
// EFETIVO, calculado no Postgres (max(atraso_min, idade do updated_at)).
import { describe, it, expect } from "vitest";
import { estadoSinal, aparenciaMarcador, rotuloVelocidade, rotuloComunicacao, atrasoDoVeiculo } from "@/lib/estado-sinal";

describe("estadoSinal", () => {
  it("limites <5 atual, 5-30 atrasado, >30 sem sinal, null desconhecido", () => {
    expect(estadoSinal(0)).toBe("atual");
    expect(estadoSinal(4.9)).toBe("atual");
    expect(estadoSinal(5)).toBe("atrasado");
    expect(estadoSinal(30)).toBe("atrasado");
    expect(estadoSinal(31)).toBe("sem_sinal");
    expect(estadoSinal(null)).toBe("desconhecido");
    expect(estadoSinal(undefined)).toBe("desconhecido");
    expect(estadoSinal(Number.NaN)).toBe("desconhecido");
  });
});

describe("aparenciaMarcador", () => {
  it("atual andando com rumo tem seta", () => {
    expect(aparenciaMarcador({ estado: "atual", velocidade: 40, rumo: 90 }).seta).toBe(true);
  });
  it("atrasado nunca tem seta, fica cinza e tracejado", () => {
    const a = aparenciaMarcador({ estado: "atrasado", velocidade: 40, rumo: 90 });
    expect(a).toMatchObject({ seta: false, cinza: true, tracejado: true });
  });
  it("sem sinal: sem seta, cinza e meio apagado", () => {
    const a = aparenciaMarcador({ estado: "sem_sinal", velocidade: 26, rumo: 10 });
    expect(a).toMatchObject({ seta: false, cinza: true, opacidade: 0.5 });
  });
});

describe("rotulos", () => {
  it("velocidade de leitura velha: 'última: 40 km/h às 14:05' (hora de Brasília)", () => {
    // 14:05 BRT = 17:05Z
    expect(rotuloVelocidade(40, "atrasado", "2026-11-03T17:05:00.000Z")).toBe("última: 40 km/h às 14:05");
    expect(rotuloVelocidade(40, "sem_sinal", "2026-11-03T17:05:00.000Z")).toBe("última: 40 km/h às 14:05");
  });
  it("velocidade de leitura atual: só o número", () => {
    expect(rotuloVelocidade(40, "atual", "2026-11-03T17:05:00.000Z")).toBe("40 km/h");
  });
  it("comunicação: 'ao vivo' só para atual", () => {
    expect(rotuloComunicacao(0.4, "atual")).toBe("ao vivo");
    expect(rotuloComunicacao(12, "atrasado")).toBe("há 12 min");
    expect(rotuloComunicacao(125, "sem_sinal")).toBe("há 2 h");
    expect(rotuloComunicacao(null, "desconhecido")).toBe("sem posição");
  });
  it("atrasoDoVeiculo prefere o efetivo do servidor", () => {
    expect(atrasoDoVeiculo({ atraso_min: 0, atraso_efetivo_min: 10.2 })).toBe(10.2);
    expect(atrasoDoVeiculo({ atraso_min: 7 })).toBe(7);
  });
});
