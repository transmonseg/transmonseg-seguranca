import { describe, it, expect } from "vitest";
import { acoesVisiveis, corStatus } from "./card-acoes";

describe("acoes do card", () => {
  it("card ativo mostra acoes sem hover (operador sem mouse)", () => {
    expect(acoesVisiveis({ ativo: true, hover: false, menuFalsoAberto: false })).toBe(true);
  });
  it("hover mostra acoes", () => {
    expect(acoesVisiveis({ ativo: false, hover: true, menuFalsoAberto: false })).toBe(true);
  });
  it("menu Falso aberto segura as acoes visiveis", () => {
    expect(acoesVisiveis({ ativo: false, hover: false, menuFalsoAberto: true })).toBe(true);
  });
  it("card parado sem hover esconde", () => {
    expect(acoesVisiveis({ ativo: false, hover: false, menuFalsoAberto: false })).toBe(false);
  });
  it("cor por nivel", () => {
    const T = { red: "R", yellow: "Y", muted: "M" };
    expect(corStatus("critico", T)).toBe("R");
    expect(corStatus("atencao", T)).toBe("Y");
    expect(corStatus("info", T)).toBe("M");
  });
});
