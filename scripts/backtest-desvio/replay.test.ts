import { describe, it, expect } from "vitest";
import { replay } from "./replay";
import { all } from "./candidatos";

const BASE_TS = new Date("2026-08-10T12:00:00Z").getTime();
function ts(minutos: number): string {
  return new Date(BASE_TS + minutos * 60_000).toISOString();
}

describe("replay", () => {
  it("dispara quando a regra e o streak real cruzam o limiar (2 leituras seguidas)", () => {
    const destino = { lat: -22.9, lng: -43.2 };
    // 3 pontos se afastando em linha reta do destino, velocidade > 0.
    const pontos = [
      { lat: -22.9, lng: -43.21, velocidade: 40, criado_em: ts(0) },
      { lat: -22.9, lng: -43.22, velocidade: 40, criado_em: ts(1) },
      { lat: -22.9, lng: -43.23, velocidade: 40, criado_em: ts(2) },
    ];
    const destinosPorPonto = pontos.map(() => [destino]);
    const r = replay(all, pontos, destinosPorPonto);
    expect(r.disparou).toBe(true);
    expect(r.streakMaximo).toBeGreaterThanOrEqual(2);
    expect(r.cicloDoDisparo).not.toBeNull();
  });

  it("nao dispara quando o veiculo se aproxima (mesmo com N=1)", () => {
    const destino = { lat: -22.9, lng: -43.2 };
    const pontos = [
      { lat: -22.9, lng: -43.23, velocidade: 40, criado_em: ts(0) },
      { lat: -22.9, lng: -43.22, velocidade: 40, criado_em: ts(1) },
      { lat: -22.9, lng: -43.21, velocidade: 40, criado_em: ts(2) },
    ];
    const destinosPorPonto = pontos.map(() => [destino]);
    const r = replay(all, pontos, destinosPorPonto);
    expect(r.disparou).toBe(false);
  });

  it("veiculo parado (velocidade=0) congela o streak, nao zera nem avanca", () => {
    const destino = { lat: -22.9, lng: -43.2 };
    const pontos = [
      { lat: -22.9, lng: -43.21, velocidade: 40, criado_em: ts(0) },
      { lat: -22.9, lng: -43.22, velocidade: 40, criado_em: ts(1) }, // afasta, streak=1
      { lat: -22.9, lng: -43.22, velocidade: 0, criado_em: ts(2) },  // parado, congela
      { lat: -22.9, lng: -43.23, velocidade: 40, criado_em: ts(3) }, // afasta, streak=2 -> dispara
    ];
    const destinosPorPonto = pontos.map(() => [destino]);
    const r = replay(all, pontos, destinosPorPonto);
    expect(r.disparou).toBe(true);
  });

  it("salto implausivel (>2500m entre ciclos) congela o streak", () => {
    const destino = { lat: -22.9, lng: -43.2 };
    const pontos = [
      { lat: -22.9, lng: -43.21, velocidade: 40, criado_em: ts(0) },
      { lat: -22.9, lng: -43.22, velocidade: 40, criado_em: ts(1) }, // afasta, streak=1
      { lat: -21.0, lng: -41.0, velocidade: 40, criado_em: ts(2) },  // teleporte, congela
    ];
    const destinosPorPonto = pontos.map(() => [destino]);
    const r = replay(all, pontos, destinosPorPonto);
    expect(r.streakMaximo).toBe(1);
    expect(r.disparou).toBe(false);
  });

  it("uma leitura isolada de aproximacao NAO zera o streak (histerese real, so 2 seguidas zeram)", () => {
    const destino = { lat: -22.9, lng: -43.2 };
    const pontos = [
      { lat: -22.9, lng: -43.21, velocidade: 40, criado_em: ts(0) },
      { lat: -22.9, lng: -43.22, velocidade: 40, criado_em: ts(1) },  // afasta, streak=1
      { lat: -22.9, lng: -43.23, velocidade: 40, criado_em: ts(2) },  // afasta, streak=2 -> dispara
      { lat: -22.9, lng: -43.225, velocidade: 40, criado_em: ts(3) }, // aproxima ISOLADA (sinal genuino de aproximacao, sem congelar por velocidade/salto) -- streak deve CONGELAR em 2, nao zerar
      { lat: -22.9, lng: -43.235, velocidade: 40, criado_em: ts(4) }, // afasta de novo: se o streak tivesse zerado, iria 0->1; como so congelou, continua 2->3
      { lat: -22.9, lng: -43.245, velocidade: 40, criado_em: ts(5) }, // afasta: se zerado, 1->2 (max continuaria 2); como congelou, 3->4
    ];
    const destinosPorPonto = pontos.map(() => [destino]);
    const r = replay(all, pontos, destinosPorPonto);
    // Se a leitura isolada de aproximacao tivesse zerado o streak (o bug
    // exato que a tentativa anterior em Python cometeu), o streak maximo
    // apos as duas leituras finais de afastamento seria no maximo 2
    // (0->1->2). A histerese real so zera com 2 leituras SEGUIDAS de
    // aproximacao -- aqui so ha 1 -- entao o streak sobrevive congelado em
    // 2 e continua dali: 2->3->4.
    expect(r.streakMaximo).toBe(4);
    expect(r.cicloDoDisparo).toBe(2);
  });
});
