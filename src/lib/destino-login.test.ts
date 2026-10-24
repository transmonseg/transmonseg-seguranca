import { describe, it, expect } from "vitest";
import { destinoAposLogin, DESTINO_PADRAO_APOS_LOGIN } from "./destino-login";

const C = "/central-romaneio";

describe("destinoAposLogin", () => {
  it("R-F3-12-01: login sem 'volta' (endereço próprio do monitoramento, sessão vencida em '/') cai na Central Romaneio, não na Central Unitrac de 76 MB", () => {
    expect(destinoAposLogin("")).toBe("/central-romaneio");
    expect(destinoAposLogin(undefined)).toBe("/central-romaneio");
    expect(DESTINO_PADRAO_APOS_LOGIN).toBe("/central-romaneio");
  });
  it("Central Unitrac continua acessível pedindo '/' explicitamente", () => {
    expect(destinoAposLogin("/")).toBe("/");
  });
  it("volta pra tela pedida", () => {
    expect(destinoAposLogin("/escala")).toBe("/escala");
    expect(destinoAposLogin("/veiculos?x=1")).toBe("/veiculos?x=1");
  });
  it("nunca sai do sistema nem volta pro login", () => {
    expect(destinoAposLogin("//evil.com")).toBe(C);
    expect(destinoAposLogin("https://evil.com")).toBe(C);
    expect(destinoAposLogin("/login")).toBe(C);
    expect(destinoAposLogin(null)).toBe(C);
    expect(destinoAposLogin("/\\evil.com")).toBe(C);
  });
  it("caractere de controle/espaco nao fura o filtro (navegador tira TAB/CR/LF e vira //evil.com)", () => {
    expect(destinoAposLogin("/\t/evil.com")).toBe(C);
    expect(destinoAposLogin("/\n/evil.com")).toBe(C);
    expect(destinoAposLogin("/\r/evil.com")).toBe(C);
    expect(destinoAposLogin("/ /evil.com")).toBe(C);
  });
});
