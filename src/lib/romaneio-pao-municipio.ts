// Escala do Pão sem cidade (achado real 05/10, grupo DESVIO DE ROTA): o PDF
// tabular traz so' RUA,NUM + BAIRRO. Sem cidade, extrairCidadeDoEndereco
// devolve null e a geocodificacao fica sem municipio -- 12 de 79 pontos do
// pao "falhou" em 05/10 (Santa Rosa/Icarai/Sao Francisco = Niteroi, Mutondo
// = Sao Goncalo, Manguinhos de Buzios, Centro de Araruama/Bom Jesus).
// Mesma regra que o KPI ja usa (kpi-romaneio/parse-pao.ts municipioPorBairro)
// + pista do municipio no nome do cliente. Sem pista: Rio de Janeiro, que e'
// onde fica a maior parte das entregas do pao (comportamento de antes).

function semAcento(s: string): string {
  return s.normalize("NFD").replace(/[̀-ͯ]/g, "");
}
const norm = (s: string) => semAcento(s.toUpperCase()).replace(/\s+/g, " ").trim();

const BAIRROS: Record<string, string> = {
  BADU: "NITEROI", PENDOTIBA: "NITEROI", PIRATININGA: "NITEROI", ITAIPU: "NITEROI",
  ICARAI: "NITEROI", INGA: "NITEROI", "SANTA ROSA": "NITEROI", "SAO FRANCISCO": "NITEROI", CAMBOINHAS: "NITEROI",
  "NOVA CIDADE": "SAO GONCALO", MUTONDO: "SAO GONCALO",
  "OUTEIRO DAS PEDRAS": "ITABORAI",
  INOA: "MARICA", ITAIPUACU: "MARICA", BARROCO: "MARICA",
};

// Pista no nome do cliente ("HORTIFRUTI BUZIOS", "CASAFRUTI ARARUAMA").
const PISTAS: [RegExp, string][] = [
  [/\bBUZIOS\b/, "ARMACAO DOS BUZIOS"],
  [/\bARARUAMA\b/, "ARARUAMA"],
  [/\bBOM JESUS\b/, "BOM JESUS DO ITABAPOANA"],
  [/\bMARICA\b/, "MARICA"],
  [/\bCABO FRIO\b/, "CABO FRIO"],
  [/\bNITEROI\b/, "NITEROI"],
  [/\bSAO GONCALO\b/, "SAO GONCALO"],
  [/\bMACAE\b/, "MACAE"],
  [/\bITABORAI\b/, "ITABORAI"],
  [/\bRIO BONITO\b/, "RIO BONITO"],
  [/\bSAQUAREMA\b/, "SAQUAREMA"],
];

export function municipioDoPao(bairro: string, clienteNome: string): string {
  const cliente = norm(clienteNome);
  for (const [re, cidade] of PISTAS) if (re.test(cliente)) return cidade;
  const b = norm(bairro).replace(/\s*\(.*\)\s*$/, "");
  return BAIRROS[b] ?? "RIO DE JANEIRO";
}

/** "RUA X,43" + "SANTA ROSA" -> "RUA X, 43 - SANTA ROSA, NITEROI" (formato
 *  que extrairCidadeDoEndereco/extrairBairroDoEndereco entendem). */
export function montarEnderecoPao(endereco: string, bairroBruto: string, clienteNome: string): string {
  if (!bairroBruto.trim()) return endereco;
  let rua = endereco.trim();
  let bairro = bairroBruto.trim();
  // PDF colado (NF 216581, 05/10): bairro veio como número e o bairro de
  // verdade ficou no fim da rua ("... 1315 MUTONDO" + "40").
  if (!/[A-Za-zÀ-ú]/.test(bairro)) {
    const conhecido = Object.keys(BAIRROS).find(b => norm(rua).endsWith(` ${b}`));
    if (conhecido) {
      rua = rua.slice(0, rua.length - conhecido.length).trim();
      bairro = conhecido;
    }
  }
  let numero = "S/N";
  const comVirgula = rua.match(/^(.*?)\s*,\s*([^,]*)$/);
  // QUADRA/LOTE (NF 216600): o número no fim é do lote, não da rua.
  const semVirgula = /\b(QUADRA|LOTE|QD|LT)\b/i.test(rua) ? null : rua.match(/^(.*?)\s+(?:N[º°.]?\s*)?(\d+[A-Z]?)$/i);
  if (comVirgula) {
    rua = comVirgula[1].trim();
    numero = comVirgula[2].trim() || "S/N";
  } else if (semVirgula) {
    rua = semVirgula[1].trim();
    numero = semVirgula[2];
  }
  if (/^0+$/.test(numero)) numero = "S/N";
  return `${rua}, ${numero} - ${bairro.trim()}, ${municipioDoPao(bairro, clienteNome)}`;
}
