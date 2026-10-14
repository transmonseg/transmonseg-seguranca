// Extrai o município de um endereço bruto no formato
// "RUA X, [BAIRRO,] CIDADE - UF" (o que o KPI envia). Usado pelo fallback por
// NOME do geocode: quando a via nao resolve, busca "<cliente>, <municipio>".
export function municipioDoEndereco(endereco: string | null | undefined): string | null {
  if (!endereco) return null;
  // Tira o " - UF" do fim (ex.: " - RJ").
  const semUf = endereco.replace(/\s*-\s*[A-Za-z]{2}\s*$/, "").trim();
  const partes = semUf.split(",").map((p) => p.trim()).filter(Boolean);
  if (partes.length === 0) return null;
  const municipio = partes[partes.length - 1];
  // Precisa ser um nome plausível de cidade (nao um número ou vazio).
  if (municipio.length < 3 || /^\d+$/.test(municipio)) return null;
  return municipio;
}
