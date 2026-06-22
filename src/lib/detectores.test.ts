// Testes unitários do motor de detecção (Vitest).
import { describe, it, expect } from "vitest";
import {
  detectarPanico,
  detectarBau,
  detectarJammer,
  detectarExcessoVelocidade,
  detectarParadaLonga,
  avaliar,
  formataDuracao,
} from "./detectores";
import type { PosicaoNormalizada } from "./unitrac";

function posicaoBase(overrides: Partial<PosicaoNormalizada> = {}): PosicaoNormalizada {
  return {
    cv: "1234",
    placa: "ABC-1234",
    lat: -22.9,
    lng: -43.2,
    velocidade: 0,
    ignicao: false,
    atraso: 0,
    panico: false,
    bau: false,
    datagps: "2026-06-22T10:00:00Z",
    fresco: true,
    ...overrides,
  };
}

describe("formataDuracao", () => {
  it("formata minutos abaixo de 1h", () => {
    expect(formataDuracao(45)).toBe("45min");
  });
  it("formata 95 minutos como 1h35min", () => {
    expect(formataDuracao(95)).toBe("1h35min");
  });
  it("formata exatamente 1h", () => {
    expect(formataDuracao(60)).toBe("1h");
  });
  it("formata 2h10min", () => {
    expect(formataDuracao(130)).toBe("2h10min");
  });
});

describe("detectarPanico", () => {
  it("panico=true retorna alerta critico", () => {
    const alerta = detectarPanico(posicaoBase({ panico: true }));
    expect(alerta).not.toBeNull();
    expect(alerta?.nivel).toBe("critico");
    expect(alerta?.tipo).toBe("panico");
    expect(alerta?.score).toBe(100);
  });
  it("panico=false retorna null", () => {
    expect(detectarPanico(posicaoBase({ panico: false }))).toBeNull();
  });
});

describe("detectarBau", () => {
  it("bau=true retorna alerta critico", () => {
    const alerta = detectarBau(posicaoBase({ bau: true }));
    expect(alerta).not.toBeNull();
    expect(alerta?.nivel).toBe("critico");
    expect(alerta?.tipo).toBe("bau");
    expect(alerta?.score).toBe(90);
  });
  it("bau=false retorna null", () => {
    expect(detectarBau(posicaoBase({ bau: false }))).toBeNull();
  });
});

describe("detectarJammer", () => {
  it("ignicao ligada e atraso=30 retorna jammer critico", () => {
    const alerta = detectarJammer(posicaoBase({ ignicao: true, atraso: 30 }));
    expect(alerta).not.toBeNull();
    expect(alerta?.nivel).toBe("critico");
    expect(alerta?.tipo).toBe("jammer");
    expect(alerta?.score).toBe(80);
  });
  it("atraso no limite inferior (15) aciona jammer", () => {
    expect(detectarJammer(posicaoBase({ ignicao: true, atraso: 15 }))).not.toBeNull();
  });
  it("atraso no limite superior (720) aciona jammer", () => {
    expect(detectarJammer(posicaoBase({ ignicao: true, atraso: 720 }))).not.toBeNull();
  });
  it("ignicao desligada nao aciona jammer", () => {
    expect(detectarJammer(posicaoBase({ ignicao: false, atraso: 30 }))).toBeNull();
  });
  it("atraso fora da janela (721) nao aciona jammer", () => {
    expect(detectarJammer(posicaoBase({ ignicao: true, atraso: 721 }))).toBeNull();
  });
  it("atraso=0 nao aciona jammer", () => {
    expect(detectarJammer(posicaoBase({ ignicao: true, atraso: 0 }))).toBeNull();
  });
});

describe("detectarExcessoVelocidade", () => {
  it("velocidade=120 retorna excesso atencao", () => {
    const alerta = detectarExcessoVelocidade(posicaoBase({ velocidade: 120 }));
    expect(alerta).not.toBeNull();
    expect(alerta?.nivel).toBe("atencao");
    expect(alerta?.tipo).toBe("excesso");
    expect(alerta?.score).toBe(40);
  });
  it("velocidade=100 nao aciona (limite e >100)", () => {
    expect(detectarExcessoVelocidade(posicaoBase({ velocidade: 100 }))).toBeNull();
  });
  it("velocidade=60 nao aciona", () => {
    expect(detectarExcessoVelocidade(posicaoBase({ velocidade: 60 }))).toBeNull();
  });
});

describe("detectarParadaLonga", () => {
  it("paradoMin=95 retorna parada_longa atencao", () => {
    const alerta = detectarParadaLonga(95);
    expect(alerta).not.toBeNull();
    expect(alerta?.nivel).toBe("atencao");
    expect(alerta?.tipo).toBe("parada_longa");
    expect(alerta?.score).toBe(50);
    expect(alerta?.motivo).toContain("1h35min");
  });
  it("paradoMin=90 aciona (limite e >=90)", () => {
    expect(detectarParadaLonga(90)).not.toBeNull();
  });
  it("paradoMin=40 retorna null", () => {
    expect(detectarParadaLonga(40)).toBeNull();
  });
  it("paradoMin=89 retorna null", () => {
    expect(detectarParadaLonga(89)).toBeNull();
  });
});

describe("avaliar", () => {
  it("panico retorna critico", () => {
    const alerta = avaliar(posicaoBase({ panico: true }), { paradoMin: 0 });
    expect(alerta?.nivel).toBe("critico");
    expect(alerta?.tipo).toBe("panico");
  });
  it("bau retorna critico", () => {
    const alerta = avaliar(posicaoBase({ bau: true }), { paradoMin: 0 });
    expect(alerta?.nivel).toBe("critico");
    expect(alerta?.tipo).toBe("bau");
  });
  it("jammer (ignicao+atraso=30) retorna critico", () => {
    const alerta = avaliar(posicaoBase({ ignicao: true, atraso: 30 }), { paradoMin: 0 });
    expect(alerta?.nivel).toBe("critico");
    expect(alerta?.tipo).toBe("jammer");
  });
  it("velocidade=120 retorna excesso atencao", () => {
    const alerta = avaliar(posicaoBase({ velocidade: 120 }), { paradoMin: 0 });
    expect(alerta?.nivel).toBe("atencao");
    expect(alerta?.tipo).toBe("excesso");
  });
  it("paradoMin=95 retorna parada_longa atencao", () => {
    const alerta = avaliar(posicaoBase(), { paradoMin: 95 });
    expect(alerta?.nivel).toBe("atencao");
    expect(alerta?.tipo).toBe("parada_longa");
  });
  it("posicao limpa + paradoMin=0 retorna null", () => {
    expect(avaliar(posicaoBase(), { paradoMin: 0 })).toBeNull();
  });
  it("panico tem prioridade sobre excesso de velocidade", () => {
    const alerta = avaliar(posicaoBase({ panico: true, velocidade: 120 }), { paradoMin: 0 });
    expect(alerta?.tipo).toBe("panico");
  });
  it("panico tem prioridade sobre parada longa", () => {
    const alerta = avaliar(posicaoBase({ panico: true }), { paradoMin: 120 });
    expect(alerta?.tipo).toBe("panico");
  });
});
