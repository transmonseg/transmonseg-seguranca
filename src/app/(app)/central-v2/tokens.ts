// Tokens para uso em Leaflet (SVG inline nao consegue ler CSS custom properties).
// Derivam de design.ts (fonte unica).

import { PALETA, PARADO } from "./design";

export interface MapTokens {
  bg: string;
  card: string;
  border: string;
  text: string;
  muted: string;
  accent: string;
  red: string;
  yellow: string;
  green: string;
  parado: string; // motor ligado, parado (nao e alerta) — azul forte, distinto do dim (desligado)
  dim: string;
  tileUrl: string;
  tileSubdomains: string;
}

export const SAT_TILE_URL = "https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}";
export const SAT_TILE_SUBDOMAINS = "";

const d = PALETA.dark, l = PALETA.light;

export const DARK_TOKENS: MapTokens = {
  bg:             d.bg,
  card:           d.surface,
  border:         d.separator,
  text:           d.text,
  muted:          d.secondary,
  accent:         d.accent,
  red:            d.red,
  yellow:         d.orange,
  green:          d.green,
  parado:         PARADO,
  dim:            d.tertiary,
  tileUrl:        "https://{s}.basemaps.cartocdn.com/dark_all/{z}/{x}/{y}{r}.png",
  tileSubdomains: "abcd",
};

export const LIGHT_TOKENS: MapTokens = {
  bg:             l.bg,
  card:           l.surface,
  border:         l.separator,
  text:           l.text,
  muted:          l.secondary,
  accent:         l.accent,
  red:            l.red,
  yellow:         l.orange,
  green:          l.green,
  parado:         PARADO,
  dim:            l.tertiary,
  tileUrl:        "https://{s}.basemaps.cartocdn.com/light_all/{z}/{x}/{y}{r}.png",
  tileSubdomains: "abcd",
};
