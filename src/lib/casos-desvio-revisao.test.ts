import { describe, it, expect } from "vitest";
import { calcularJanelaTrilha } from "./casos-desvio-revisao";

describe("calcularJanelaTrilha (achado 26/07: janela da trilha pro caso de revisao)", () => {
  it("alerta recente (aberto ha poucos minutos): janela comeca 15min antes de 'desde'", () => {
    const desde = new Date("2026-07-26T12:00:00.000Z");
    const agora = new Date("2026-07-26T12:10:00.000Z");
    const { inicio, fim } = calcularJanelaTrilha(desde, agora);
    expect(inicio.toISOString()).toBe("2026-07-26T11:45:00.000Z");
    expect(fim.toISOString()).toBe(agora.toISOString());
  });

  it("alerta aberto ha dias: janela e' limitada as ultimas 6h (nao 15min antes de 'desde', que seria dias atras)", () => {
    const desde = new Date("2026-07-20T12:00:00.000Z");
    const agora = new Date("2026-07-26T12:00:00.000Z");
    const { inicio, fim } = calcularJanelaTrilha(desde, agora);
    expect(inicio.toISOString()).toBe("2026-07-26T06:00:00.000Z");
    expect(fim.toISOString()).toBe(agora.toISOString());
  });

  // Nota (achado real ao rodar, 26/07): a versao original deste teste tinha
  // desde=05:45 (6h15min antes de agora) esperando inicio=05:30 -- mas
  // desde-15min = 05:30 fica 6h30min antes de agora, o que ULTRAPASSA o teto
  // de 6h (contradiz o proprio comentario da formula em
  // calcularJanelaTrilha: "Janela = [max(desde - 15min, agora - 6h), agora]").
  // O caso realmente "no limite" (onde as duas contas coincidem) e' quando
  // desde - 15min == agora - 6h, ou seja desde = agora - 5h45min.
  it("exatamente no limite (desde ha 5h45min): piso de 15min e teto de 6h coincidem", () => {
    const desde = new Date("2026-07-26T06:15:00.000Z");
    const agora = new Date("2026-07-26T12:00:00.000Z");
    const { inicio } = calcularJanelaTrilha(desde, agora);
    expect(inicio.toISOString()).toBe("2026-07-26T06:00:00.000Z");
  });
});
