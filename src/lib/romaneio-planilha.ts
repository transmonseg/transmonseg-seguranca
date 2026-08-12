// Extrai texto bruto de Excel/CSV (xlsx cobre os dois formatos com a mesma
// lib -- deteccao automatica pelo conteudo) pro mesmo formato de "texto por
// linha, celulas separadas por tab" que pdf-parse ja produz pro caminho
// PDF -- os dois caminhos convergem nesse formato antes de qualquer
// parsing/extracao (ver upload/route.ts).
import * as XLSX from "xlsx";

export function extrairTextoPlanilha(buffer: Buffer): string {
  const workbook = XLSX.read(buffer, { type: "buffer" });
  const linhas: string[] = [];
  for (const nomeAba of workbook.SheetNames) {
    const aba = workbook.Sheets[nomeAba];
    linhas.push(XLSX.utils.sheet_to_csv(aba, { FS: "\t", blankrows: false }));
  }
  return linhas.join("\n");
}
