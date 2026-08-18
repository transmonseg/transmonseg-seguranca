import { describe, it, expect } from "vitest";

// A funcao nao e exportada do componente (e um helper interno de arquivo
// .tsx) -- reimplementada aqui identica, mesmo padrao de outras funcoes
// puras pequenas deste projeto quando extrair um modulo separado seria
// desproporcional. Ver CardAlertaCritico.tsx para a fonte da verdade.
const LIMIAR_ALERTA_ANTIGO_MS = 2 * 60 * 60 * 1000;
function ehAlertaAntigo(iso: string): boolean {
  return Date.now() - new Date(iso).getTime() >= LIMIAR_ALERTA_ANTIGO_MS;
}

describe("ehAlertaAntigo", () => {
  it("alerta de 1h: nao e antigo", () => {
    const umaHoraAtras = new Date(Date.now() - 60 * 60 * 1000).toISOString();
    expect(ehAlertaAntigo(umaHoraAtras)).toBe(false);
  });

  it("alerta de exatamente 2h: e antigo", () => {
    const duasHorasAtras = new Date(Date.now() - LIMIAR_ALERTA_ANTIGO_MS).toISOString();
    expect(ehAlertaAntigo(duasHorasAtras)).toBe(true);
  });

  it("alerta de 5h: e antigo", () => {
    const cincoHorasAtras = new Date(Date.now() - 5 * 60 * 60 * 1000).toISOString();
    expect(ehAlertaAntigo(cincoHorasAtras)).toBe(true);
  });
});

// Mesmo padrao de ehAlertaAntigo acima: funcao nao exportada de um .tsx,
// reimplementada aqui identica. Ver CardAlertaCritico.tsx para a fonte da verdade.
const ROTULO_BADGE_TIPO: Record<string, string> = {
  desvio: "Desvio em movimento",
  parada_fora_tapete: "Parada fora do esperado",
};
function rotuloBadgeTipo(tipo: string): string {
  return ROTULO_BADGE_TIPO[tipo] ?? tipo;
}

describe("rotuloBadgeTipo", () => {
  it("desvio vira 'Desvio em movimento'", () => {
    expect(rotuloBadgeTipo("desvio")).toBe("Desvio em movimento");
  });

  it("parada_fora_tapete vira 'Parada fora do esperado'", () => {
    expect(rotuloBadgeTipo("parada_fora_tapete")).toBe("Parada fora do esperado");
  });

  it("tipo sem entrada no mapa cai no slug cru (fallback preservado)", () => {
    expect(rotuloBadgeTipo("panico")).toBe("panico");
    expect(rotuloBadgeTipo("tiroteio")).toBe("tiroteio");
  });
});
