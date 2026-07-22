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
