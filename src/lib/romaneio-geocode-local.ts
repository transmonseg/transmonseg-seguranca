// Parsing/normalizacao de endereco do romaneio pra geocodificacao local
// via extrato OSM -- ver docs/superpowers/specs/2026-07-22-geocodificacao-local-romaneio-design.md.
// Funcoes PURAS, sem I/O.

// Formato real do romaneio (ver src/lib/romaneio.ts):
//   "<RUA>, <NUMERO> - <BAIRRO>, <CIDADE> - <SUFIXO>"
export function extrairRuaDoEndereco(enderecoBruto: string): string {
  const idx = enderecoBruto.indexOf(",");
  if (idx === -1) return enderecoBruto.trim();
  return enderecoBruto.slice(0, idx).trim();
}

export function extrairCidadeDoEndereco(enderecoBruto: string): string | null {
  const partes = enderecoBruto.split(",");
  if (partes.length < 3) return null;
  const ultimaParte = partes[partes.length - 1].trim();
  const cidade = ultimaParte.split(" - ")[0]?.trim();
  return cidade || null;
}

// Tipos de via reconhecidos como PREFIXO do nome -- removidos por completo
// (nao canonicalizados) pra bater independente de qual abreviacao o
// romaneio ou o OSM usarem (ex.: "AV" vs "Avenida" viram a mesma coisa
// depois de remover o prefixo dos dois lados).
const PREFIXOS_VIA = new Set([
  "RUA", "R", "AV", "AVENIDA", "TRAVESSA", "TRAV", "ESTRADA", "EST",
  "RODOVIA", "ROD", "ALAMEDA", "AL", "PRACA", "PC", "LARGO",
]);

export function normalizarNomeRua(rua: string): string {
  const semAcento = rua
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .toUpperCase()
    .trim()
    .replace(/\s+/g, " ");
  const tokens = semAcento.split(" ");
  if (tokens.length > 1 && PREFIXOS_VIA.has(tokens[0])) {
    return tokens.slice(1).join(" ");
  }
  return semAcento;
}
