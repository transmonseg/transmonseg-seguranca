import { describe, it, expect } from "vitest";
import { normalizarOrigem, ORIGENS_ROMANEIO, ORIGEM_PADRAO, ROTULO_ORIGEM } from "./romaneio-origem";

describe("normalizarOrigem", () => {
  it("aceita os valores da allowlist", () => {
    for (const origem of ORIGENS_ROMANEIO) expect(normalizarOrigem(origem)).toBe(origem);
  });

  it("qualquer coisa fora da allowlist vira o padrao -- nunca a string crua", () => {
    for (const valor of [null, undefined, "", "ROMANEIO", "escala", 42, {}, "'; drop table x; --"]) {
      expect(ORIGENS_ROMANEIO).toContain(normalizarOrigem(valor));
      expect(normalizarOrigem(valor)).toBe(ORIGEM_PADRAO);
    }
  });

  it("todo valor valido tem rotulo de tela", () => {
    for (const origem of ORIGENS_ROMANEIO) expect(ROTULO_ORIGEM[origem]).toBeTruthy();
  });
});
