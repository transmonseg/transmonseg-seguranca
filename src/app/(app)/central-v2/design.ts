// Fonte UNICA de tokens visuais do monitor (26/09, redesign estilo Apple).
// Antes a paleta vivia em 3 copias divergentes (globals.css, tokens.ts e o
// objeto T do MonitorV2, com o bg claro diferente entre elas). Agora T e
// tokens.ts derivam daqui e design.test.ts trava globals.css em sincronia.

import type React from "react";

export type Tema = "dark" | "light";
export interface Paleta {
  bg: string; surface: string; surface2: string; separator: string;
  text: string; secondary: string; tertiary: string;
  accent: string; red: string; orange: string; green: string;
}

export const PALETA: Record<Tema, Paleta> = {
  dark: {
    bg: "#000000", surface: "#1c1c1e", surface2: "#2c2c2e", separator: "#38383a",
    text: "#f5f5f7", secondary: "#98989d", tertiary: "#636366",
    accent: "#0a84ff", red: "#ff453a", orange: "#ff9f0a", green: "#30d158",
  },
  light: {
    bg: "#f2f2f7", surface: "#ffffff", surface2: "#f2f2f7", separator: "#d1d1d6",
    text: "#1d1d1f", secondary: "#6e6e73", tertiary: "#aeaeb2",
    // #007aff da so 4,0:1 no branco; #0066cc e' o azul acessivel da Apple.
    accent: "#0066cc", red: "#d70015", orange: "#c93400", green: "#248a3d",
  },
};

export const PARADO = "#2563eb";

export const TIPO = {
  title:    { fontSize: 20, fontWeight: 700, letterSpacing: "-0.01em" },
  headline: { fontSize: 15, fontWeight: 600, letterSpacing: "-0.005em" },
  body:     { fontSize: 13, fontWeight: 400 },
  footnote: { fontSize: 12, fontWeight: 500 },
  caption:  { fontSize: 12, fontWeight: 600, letterSpacing: ".04em", textTransform: "uppercase" as const },
} as const;

export const RAIO = { control: 8, panel: 14, capsule: 999 } as const;

export const MOLA = { type: "spring", stiffness: 380, damping: 32 } as const;

export const FONT_SANS = "var(--font-geist), system-ui, sans-serif";
export const FONT_MONO = "var(--font-geist-mono), ui-monospace, monospace";
export const NUM: React.CSSProperties = { fontFamily: FONT_MONO, fontVariantNumeric: "tabular-nums" };

// Material translucido pra tudo que flutua sobre o mapa (Apple Maps).
export function material(tema: Tema): React.CSSProperties {
  return tema === "dark"
    ? { background: "rgba(28,28,30,0.72)", backdropFilter: "blur(20px) saturate(180%)", WebkitBackdropFilter: "blur(20px) saturate(180%)", border: "0.5px solid rgba(255,255,255,0.10)", boxShadow: "0 8px 32px rgba(0,0,0,0.45)" }
    : { background: "rgba(255,255,255,0.78)", backdropFilter: "blur(20px) saturate(180%)", WebkitBackdropFilter: "blur(20px) saturate(180%)", border: "0.5px solid rgba(0,0,0,0.10)", boxShadow: "0 8px 32px rgba(0,0,0,0.12)" };
}

function lum(hex: string): number {
  const n = hex.replace("#", "");
  const [r, g, b] = [0, 2, 4].map(i => parseInt(n.slice(i, i + 2), 16) / 255)
    .map(c => (c <= 0.03928 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4)));
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}
export function contraste(a: string, b: string): number {
  const [x, y] = [lum(a), lum(b)].sort((p, q) => q - p);
  return (x + 0.05) / (y + 0.05);
}

// Objeto T do MonitorV2: mesmas chaves de antes pra nao quebrar os ~2000
// usos no arquivo; "yellow" (atencao) agora e' o laranja do sistema.
export function temaT(tema: Tema) {
  const p = PALETA[tema];
  const dark = tema === "dark";
  return {
    bg: p.bg, card: p.surface, cardHover: p.surface2, surface2: p.surface2,
    border: p.separator, borderSubtle: dark ? "#2c2c2e" : "#e5e5ea",
    text: p.text, muted: p.secondary, dim: p.tertiary,
    accent: p.accent, accentFg: "#ffffff", accentDim: dark ? "rgba(10,132,255,0.18)" : "rgba(0,102,204,0.10)",
    red: p.red, yellow: p.orange, green: p.green,
    drawerBg: dark ? "rgba(28,28,30,0.72)" : "rgba(255,255,255,0.78)",
    sidebarBg: dark ? "#0b0b0c" : "#f7f7fa",
    toolbarBg: dark ? "rgba(0,0,0,0.72)" : "rgba(242,242,247,0.80)",
    thumb: dark ? "#636366" : "#ffffff",
    thumbShadow: dark ? "0 1px 3px rgba(0,0,0,0.4)" : "0 1px 3px rgba(0,0,0,0.12), 0 0 0 0.5px rgba(0,0,0,0.04)",
  };
}
export type TemaT = ReturnType<typeof temaT>;
