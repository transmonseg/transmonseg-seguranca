import { describe, it, expect } from "vitest";
import { rotaAtiva } from "./nav-rota";

describe("rotaAtiva", () => {
  it("Central so' acende na raiz exata -- '/' e' prefixo de tudo", () => {
    expect(rotaAtiva("/", "/")).toBe(true);
    expect(rotaAtiva("/central-romaneio", "/")).toBe(false);
    expect(rotaAtiva("/romaneio", "/")).toBe(false);
    expect(rotaAtiva("/analise", "/")).toBe(false);
  });

  it("Central Romaneio acende so' na propria rota", () => {
    expect(rotaAtiva("/central-romaneio", "/central-romaneio")).toBe(true);
    expect(rotaAtiva("/", "/central-romaneio")).toBe(false);
  });

  it("nunca duas abas ativas ao mesmo tempo", () => {
    for (const pathname of ["/", "/central-romaneio", "/romaneio", "/escala", "/analise"]) {
      const ativas = ["/", "/central-romaneio"].filter((href) => rotaAtiva(pathname, href));
      expect(ativas.length).toBeLessThanOrEqual(1);
    }
  });

  it("sub-rota mantem o item do menu ativo", () => {
    expect(rotaAtiva("/romaneio/algo", "/romaneio")).toBe(true);
    // ...mas nao um irmao que so' comeca com o mesmo texto
    expect(rotaAtiva("/romaneio-antigo", "/romaneio")).toBe(false);
  });
});
