import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { PALETA, TIPO, RAIO, contraste, temaT } from "./design";
import { DARK_TOKENS, LIGHT_TOKENS } from "./tokens";

describe("design tokens", () => {
  it("tipografia nunca abaixo de 12px", () => {
    for (const t of Object.values(TIPO)) expect(t.fontSize).toBeGreaterThanOrEqual(12);
  });
  it("raios so 8/14/999 (+ check 4, exclusivo de checkbox)", () => {
    const { check, ...sistema } = RAIO;
    expect(Object.values(sistema).sort((a, b) => a - b)).toEqual([8, 14, 999]);
    expect(check).toBe(4);
    expect(Object.keys(RAIO).sort()).toEqual(["capsule", "check", "control", "panel"]);
  });
  for (const tema of ["dark", "light"] as const) {
    const p = PALETA[tema];
    it(`${tema}: texto >= 4.5 sobre bg e surface`, () => {
      expect(contraste(p.text, p.bg)).toBeGreaterThanOrEqual(4.5);
      expect(contraste(p.text, p.surface)).toBeGreaterThanOrEqual(4.5);
    });
    it(`${tema}: secundario >= 4.5 sobre surface`, () => {
      expect(contraste(p.secondary, p.surface)).toBeGreaterThanOrEqual(4.5);
    });
    it(`${tema}: terciario (T.dim, texto legivel) >= 3 sobre surface`, () => {
      expect(contraste(p.tertiary, p.surface)).toBeGreaterThanOrEqual(3);
    });
    it(`${tema}: cores de status >= 3 sobre surface`, () => {
      for (const c of [p.red, p.orange, p.green, p.accent]) expect(contraste(c, p.surface)).toBeGreaterThanOrEqual(3);
    });
    it(`${tema}: temaT mantem as chaves antigas do T`, () => {
      const T = temaT(tema);
      for (const k of ["bg","card","cardHover","border","borderSubtle","text","muted","dim","accent","accentFg","accentDim","red","yellow","green","drawerBg","sidebarBg","toolbarBg"])
        expect(T).toHaveProperty(k);
      expect(T.yellow).toBe(p.orange);
      expect(contraste(T.accentFg, T.accent)).toBeGreaterThanOrEqual(3.5);
    });
  }
  it("tokens.ts (Leaflet) deriva da paleta", () => {
    expect(DARK_TOKENS.red).toBe(PALETA.dark.red);
    expect(LIGHT_TOKENS.text).toBe(PALETA.light.text);
    expect(DARK_TOKENS.parado).toBe("#2563eb");
    expect(LIGHT_TOKENS.parado).toBe("#2563eb");
  });
  it("globals.css sincronizado com a paleta", () => {
    const css = readFileSync(join(process.cwd(), "src/app/globals.css"), "utf8");
    const bloco = (sel: string) => css.slice(css.indexOf(sel), css.indexOf("}", css.indexOf(sel)));
    const dark = bloco(":root {"), light = bloco('[data-theme="light"] {');
    const par: [string, keyof typeof PALETA.dark][] = [["--bg", "bg"], ["--card", "surface"], ["--border", "separator"], ["--text", "text"], ["--text-muted", "secondary"], ["--text-dim", "tertiary"], ["--accent", "accent"], ["--vermelho", "red"], ["--amarelo", "orange"], ["--verde", "green"]];
    for (const [v, k] of par) {
      expect(dark).toMatch(new RegExp(`${v}:\\s*${PALETA.dark[k]};`, "i"));
      expect(light).toMatch(new RegExp(`${v}:\\s*${PALETA.light[k]};`, "i"));
    }
  });
});
