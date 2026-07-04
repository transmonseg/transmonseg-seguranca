// Tokens para uso em Leaflet (SVG inline nao consegue ler CSS custom properties).
// Devem refletir exatamente os valores de globals.css.

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
  parado: string; // motor ligado, parado (nao e alerta) — precisa ser forte, distinto do dim (desligado)
  dim: string;
  tileUrl: string;
  tileSubdomains: string;
}

export const SAT_TILE_URL = "https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}";
export const SAT_TILE_SUBDOMAINS = "";

export const DARK_TOKENS: MapTokens = {
  bg:             "#0a0a0a",
  card:           "#131313",
  border:         "#242424",
  text:           "#fafaf9",
  muted:          "#a8a29e",
  accent:         "#9fb3ce",
  red:            "#ef4444",
  yellow:         "#f59e0b",
  green:          "#22c55e",
  parado:         "#2563eb",
  dim:            "#57534e",
  tileUrl:        "https://{s}.basemaps.cartocdn.com/dark_all/{z}/{x}/{y}{r}.png",
  tileSubdomains: "abcd",
};

export const LIGHT_TOKENS: MapTokens = {
  bg:             "#f4f4f3",
  card:           "#ffffff",
  border:         "#e2e2e0",
  text:           "#111110",
  muted:          "#6b7280",
  accent:         "#4b6f9a",
  red:            "#dc2626",
  yellow:         "#d97706",
  green:          "#16a34a",
  parado:         "#2563eb",
  dim:            "#9ca3af",
  tileUrl:        "https://{s}.basemaps.cartocdn.com/light_all/{z}/{x}/{y}{r}.png",
  tileSubdomains: "abcd",
};
