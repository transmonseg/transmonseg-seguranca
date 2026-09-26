import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { acoesVisiveis, corStatus } from "./card-acoes";

describe("acoes do card", () => {
  it("card ativo prende as acoes visiveis (operador sem mouse)", () => {
    expect(acoesVisiveis({ ativo: true, menuFalsoAberto: false })).toBe(true);
  });
  it("menu Falso aberto prende as acoes visiveis", () => {
    expect(acoesVisiveis({ ativo: false, menuFalsoAberto: true })).toBe(true);
  });
  it("card parado nao prende (so hover/foco via CSS revelam)", () => {
    expect(acoesVisiveis({ ativo: false, menuFalsoAberto: false })).toBe(false);
  });
  it("globals.css esconde as acoes e revela em hover, focus-within e data-acoes=on", () => {
    const css = readFileSync(join(process.cwd(), "src/app/globals.css"), "utf8").replace(/\s+/g, " ");
    expect(css).toMatch(/\.card-alerta-acoes \{ display: none; \}/);
    const regra = css.match(/([^{}]*)\{ display: flex; \}/g)?.find(r => r.includes(".card-alerta:hover")) ?? "";
    expect(regra).toContain(".card-alerta:hover .card-alerta-acoes");
    expect(regra).toContain(".card-alerta:focus-within .card-alerta-acoes");
    expect(regra).toContain('.card-alerta[data-acoes="on"] .card-alerta-acoes');
  });
  it("MonitorV2 nao guarda hover em estado React e liga o card ao CSS", () => {
    const src = readFileSync(join(process.cwd(), "src/app/(app)/central-v2/MonitorV2.tsx"), "utf8");
    expect(src).not.toMatch(/hoverCardId|onMouseEnter=\{\(\) => setHover/);
    expect(src).toContain('className="v2-alert-card card-alerta"');
    expect(src).toContain('className="card-alerta-acoes"');
    expect(src).toContain('data-acoes={acoesFixas ? "on" : undefined}');
  });
  it("cor por nivel", () => {
    const T = { red: "R", yellow: "Y", muted: "M" };
    expect(corStatus("critico", T)).toBe("R");
    expect(corStatus("atencao", T)).toBe("Y");
    expect(corStatus("info", T)).toBe("M");
  });
});
