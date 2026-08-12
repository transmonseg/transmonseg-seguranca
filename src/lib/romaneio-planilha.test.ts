import { describe, it, expect } from "vitest";
import * as XLSX from "xlsx";
import { extrairTextoPlanilha } from "./romaneio-planilha";

function criarPlanilhaBuffer(linhas: string[][]): Buffer {
  const worksheet = XLSX.utils.aoa_to_sheet(linhas);
  const workbook = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(workbook, worksheet, "Sheet1");
  return XLSX.write(workbook, { type: "buffer", bookType: "xlsx" }) as Buffer;
}

describe("extrairTextoPlanilha", () => {
  it("extrai celulas de uma planilha simples separadas por tab", () => {
    const buffer = criarPlanilhaBuffer([
      ["Placa", "Endereco", "Cliente"],
      ["ABC1D23", "Rua das Flores, 100", "Mercado Central"],
    ]);
    const texto = extrairTextoPlanilha(buffer);
    expect(texto).toContain("Placa\tEndereco\tCliente");
    expect(texto).toContain("ABC1D23\tRua das Flores, 100\tMercado Central");
  });

  it("concatena multiplas abas com quebra de linha entre elas", () => {
    const worksheet1 = XLSX.utils.aoa_to_sheet([["A1", "B1"]]);
    const worksheet2 = XLSX.utils.aoa_to_sheet([["A2", "B2"]]);
    const workbook = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(workbook, worksheet1, "Aba1");
    XLSX.utils.book_append_sheet(workbook, worksheet2, "Aba2");
    const buffer = XLSX.write(workbook, { type: "buffer", bookType: "xlsx" }) as Buffer;
    const texto = extrairTextoPlanilha(buffer);
    expect(texto).toContain("A1\tB1");
    expect(texto).toContain("A2\tB2");
  });

  it("le CSV tambem (mesma funcao, xlsx detecta o formato pelo conteudo)", () => {
    const csvBuffer = Buffer.from("Placa,Endereco\nXYZ9W88,Av Brasil 500");
    const texto = extrairTextoPlanilha(csvBuffer);
    expect(texto).toContain("Placa");
    expect(texto).toContain("XYZ9W88");
  });
});
