import { describe, it, expect } from "vitest";
import { ABAS, ITENS_MENU } from "./nav-itens";
import { rotaAtiva } from "./nav-rota";

// F3-12 (AC-08): o produto é a Central Romaneio. A Central Unitrac ("/", a página
// de 76 MB) sai das abas e fica na engrenagem, junto das outras telas.
describe("navegação principal", () => {
  it("a aba é só a Central Romaneio", () => {
    expect(ABAS.map((a) => a.href)).toEqual(["/central-romaneio"]);
  });

  it("a Central Unitrac está na engrenagem, em primeiro, sem sumir nenhuma tela", () => {
    expect(ITENS_MENU[0]).toEqual({ href: "/", rotulo: "Central Unitrac" });
    expect(ITENS_MENU.map((i) => i.href)).toEqual(["/", "/romaneio", "/escala", "/veiculos", "/analise"]);
  });

  it("na Central Unitrac a engrenagem acende; na Central Romaneio, não", () => {
    expect(ITENS_MENU.some((i) => rotaAtiva("/", i.href))).toBe(true);
    expect(ITENS_MENU.some((i) => rotaAtiva("/central-romaneio", i.href))).toBe(false);
  });
});
