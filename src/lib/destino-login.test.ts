import { describe, it, expect } from "vitest";
import { destinoAposLogin } from "./destino-login";

describe("destinoAposLogin", () => {
  it("volta pra tela pedida", () => {
    expect(destinoAposLogin("/escala")).toBe("/escala");
    expect(destinoAposLogin("/veiculos?x=1")).toBe("/veiculos?x=1");
  });
  it("nunca sai do sistema nem volta pro login", () => {
    expect(destinoAposLogin("//evil.com")).toBe("/");
    expect(destinoAposLogin("https://evil.com")).toBe("/");
    expect(destinoAposLogin("/login")).toBe("/");
    expect(destinoAposLogin(null)).toBe("/");
    expect(destinoAposLogin("/\\evil.com")).toBe("/");
  });
  it("caractere de controle/espaco nao fura o filtro (navegador tira TAB/CR/LF e vira //evil.com)", () => {
    expect(destinoAposLogin("/\t/evil.com")).toBe("/");
    expect(destinoAposLogin("/\n/evil.com")).toBe("/");
    expect(destinoAposLogin("/\r/evil.com")).toBe("/");
    expect(destinoAposLogin("/ /evil.com")).toBe("/");
  });
});
