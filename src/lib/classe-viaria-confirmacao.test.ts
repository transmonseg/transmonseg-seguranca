import { describe, it, expect } from "vitest";
import {
  melhorClasse,
  avaliarQuedaClasseViaria,
  avaliarSaiuParadaConfirmadaRecentemente,
  aplicarCorroboracaoClasseViaria,
} from "./classe-viaria-confirmacao";

describe("melhorClasse", () => {
  it("principal vence intermediaria", () => {
    expect(melhorClasse("principal", "intermediaria")).toBe("principal");
    expect(melhorClasse("intermediaria", "principal")).toBe("principal");
  });
  it("intermediaria vence estreita", () => {
    expect(melhorClasse("intermediaria", "estreita")).toBe("intermediaria");
  });
  it("null de um lado retorna o outro", () => {
    expect(melhorClasse(null, "estreita")).toBe("estreita");
    expect(melhorClasse("estreita", null)).toBe("estreita");
  });
  it("null dos dois lados retorna null", () => {
    expect(melhorClasse(null, null)).toBeNull();
  });
});

describe("avaliarQuedaClasseViaria", () => {
  const AGORA = new Date("2026-08-15T12:00:00Z");

  it("celula atual estreita + esteve em principal ha 5min: queda detectada", () => {
    const ultimaViaPrincipal = new Date("2026-08-15T11:55:00Z");
    expect(avaliarQuedaClasseViaria("estreita", ultimaViaPrincipal, AGORA)).toEqual({ quedaDetectada: true });
  });
  it("celula atual estreita + esteve em principal ha exatamente 10min: ainda detectada (limite inclusivo)", () => {
    const ultimaViaPrincipal = new Date("2026-08-15T11:50:00Z");
    expect(avaliarQuedaClasseViaria("estreita", ultimaViaPrincipal, AGORA)).toEqual({ quedaDetectada: true });
  });
  it("celula atual estreita + esteve em principal ha 11min: janela expirou, sem queda", () => {
    const ultimaViaPrincipal = new Date("2026-08-15T11:49:00Z");
    expect(avaliarQuedaClasseViaria("estreita", ultimaViaPrincipal, AGORA)).toEqual({ quedaDetectada: false });
  });
  it("nunca esteve em via principal (null): sem queda", () => {
    expect(avaliarQuedaClasseViaria("estreita", null, AGORA)).toEqual({ quedaDetectada: false });
  });
  it("celula atual intermediaria (nao estreita): sem queda, mesmo com historico de principal", () => {
    const ultimaViaPrincipal = new Date("2026-08-15T11:58:00Z");
    expect(avaliarQuedaClasseViaria("intermediaria", ultimaViaPrincipal, AGORA)).toEqual({ quedaDetectada: false });
  });
  it("celula atual null (sem classificacao): sem queda", () => {
    const ultimaViaPrincipal = new Date("2026-08-15T11:58:00Z");
    expect(avaliarQuedaClasseViaria(null, ultimaViaPrincipal, AGORA)).toEqual({ quedaDetectada: false });
  });
});

describe("avaliarSaiuParadaConfirmadaRecentemente", () => {
  const AGORA = new Date("2026-08-15T12:00:00Z");

  it("saiu ha 2min: recente", () => {
    expect(avaliarSaiuParadaConfirmadaRecentemente(new Date("2026-08-15T11:58:00Z"), AGORA)).toBe(true);
  });
  it("saiu ha exatamente 5min: ainda recente (limite inclusivo)", () => {
    expect(avaliarSaiuParadaConfirmadaRecentemente(new Date("2026-08-15T11:55:00Z"), AGORA)).toBe(true);
  });
  it("saiu ha 6min: expirou", () => {
    expect(avaliarSaiuParadaConfirmadaRecentemente(new Date("2026-08-15T11:54:00Z"), AGORA)).toBe(false);
  });
  it("nunca saiu de parada confirmada (null): false", () => {
    expect(avaliarSaiuParadaConfirmadaRecentemente(null, AGORA)).toBe(false);
  });
});

describe("aplicarCorroboracaoClasseViaria", () => {
  const BASE = { score: 60, motivo: "Afastando-se de todos os destinos", outraCoisa: "preservada" };

  it("queda nao detectada: retorna o MESMO objeto, sem mutacao", () => {
    const r = aplicarCorroboracaoClasseViaria(BASE, false, false, 15);
    expect(r).toBe(BASE);
  });
  it("saiu de parada confirmada recentemente SUPRIME mesmo com queda detectada: sem bonus", () => {
    const r = aplicarCorroboracaoClasseViaria(BASE, true, true, 15);
    expect(r).toBe(BASE);
  });
  it("queda detectada e sem saida de parada recente: soma bonus e sufixo no motivo", () => {
    const r = aplicarCorroboracaoClasseViaria(BASE, true, false, 15);
    expect(r.score).toBe(75);
    expect(r.motivo).toBe("Afastando-se de todos os destinos (corroborado por: saiu de via principal para rua estreita)");
    expect(r.outraCoisa).toBe("preservada");
  });
  it("nunca passa de 100 mesmo com score inicial alto", () => {
    const r = aplicarCorroboracaoClasseViaria({ score: 95, motivo: "x" }, true, false, 15);
    expect(r.score).toBe(100);
  });
});
