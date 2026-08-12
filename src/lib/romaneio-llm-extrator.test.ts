import { describe, it, expect, vi } from "vitest";
import { extrairRomaneioViaLLM } from "./romaneio-llm-extrator";

const RESPOSTA_VALIDA = JSON.stringify({
  linhas: [
    { placaBruta: "ABC1D23", enderecoBruto: "Rua das Flores, 100", clienteNome: "Mercado Central", nf: "12345", clienteCodigo: "C001" },
  ],
});

describe("extrairRomaneioViaLLM", () => {
  it("extrai linhas validas usando o resultado do Ollama (local) quando funciona", async () => {
    const chamarOllama = vi.fn().mockResolvedValue(RESPOSTA_VALIDA);
    const chamarMistral = vi.fn();
    const resultado = await extrairRomaneioViaLLM("texto do romaneio", { chamarOllama, chamarMistral });
    expect(resultado).toEqual([
      { placaBruta: "ABC1D23", enderecoBruto: "Rua das Flores, 100", clienteNome: "Mercado Central", nf: "12345", clienteCodigo: "C001" },
    ]);
    expect(chamarMistral).not.toHaveBeenCalled();
  });

  it("cai pro Mistral quando o Ollama local falha (rede/timeout)", async () => {
    const chamarOllama = vi.fn().mockRejectedValue(new Error("timeout"));
    const chamarMistral = vi.fn().mockResolvedValue(RESPOSTA_VALIDA);
    const resultado = await extrairRomaneioViaLLM("texto", { chamarOllama, chamarMistral });
    expect(resultado).toEqual([
      { placaBruta: "ABC1D23", enderecoBruto: "Rua das Flores, 100", clienteNome: "Mercado Central", nf: "12345", clienteCodigo: "C001" },
    ]);
    expect(chamarMistral).toHaveBeenCalledTimes(1);
  });

  it("cai pro Mistral quando o Ollama local devolve JSON invalido", async () => {
    const chamarOllama = vi.fn().mockResolvedValue("isso nao e json");
    const chamarMistral = vi.fn().mockResolvedValue(RESPOSTA_VALIDA);
    const resultado = await extrairRomaneioViaLLM("texto", { chamarOllama, chamarMistral });
    expect(resultado).toEqual([
      { placaBruta: "ABC1D23", enderecoBruto: "Rua das Flores, 100", clienteNome: "Mercado Central", nf: "12345", clienteCodigo: "C001" },
    ]);
  });

  it("aceita linha sem nf/clienteCodigo (campos opcionais)", async () => {
    const chamarOllama = vi.fn().mockResolvedValue(
      JSON.stringify({ linhas: [{ placaBruta: "XYZ9W88", enderecoBruto: "Av Brasil, 500", clienteNome: "Loja X" }] })
    );
    const chamarMistral = vi.fn();
    const resultado = await extrairRomaneioViaLLM("texto", { chamarOllama, chamarMistral });
    expect(resultado).toEqual([{ placaBruta: "XYZ9W88", enderecoBruto: "Av Brasil, 500", clienteNome: "Loja X", nf: undefined, clienteCodigo: undefined }]);
  });

  it("aceita linha ambigua (sem endereco reconhecivel) em vez de descartar", async () => {
    const chamarOllama = vi.fn().mockResolvedValue(
      JSON.stringify({ linhas: [{ placaBruta: "ABC1D23", enderecoBruto: "", clienteNome: "Cliente Y" }] })
    );
    const chamarMistral = vi.fn();
    const resultado = await extrairRomaneioViaLLM("texto", { chamarOllama, chamarMistral });
    expect(resultado).toEqual([{ placaBruta: "ABC1D23", enderecoBruto: "", clienteNome: "Cliente Y", nf: undefined, clienteCodigo: undefined }]);
  });

  it("devolve null quando NEM Ollama NEM Mistral funcionam", async () => {
    const chamarOllama = vi.fn().mockRejectedValue(new Error("timeout"));
    const chamarMistral = vi.fn().mockRejectedValue(new Error("mistral fora"));
    const resultado = await extrairRomaneioViaLLM("texto", { chamarOllama, chamarMistral });
    expect(resultado).toBeNull();
  });

  it("devolve null quando o JSON nao tem o campo 'linhas' como array", async () => {
    const chamarOllama = vi.fn().mockResolvedValue(JSON.stringify({ algoOutro: [] }));
    const chamarMistral = vi.fn().mockResolvedValue(JSON.stringify({ algoOutro: [] }));
    const resultado = await extrairRomaneioViaLLM("texto", { chamarOllama, chamarMistral });
    expect(resultado).toBeNull();
  });

  it("ignora entradas que nao sao objetos dentro de 'linhas'", async () => {
    const chamarOllama = vi.fn().mockResolvedValue(
      JSON.stringify({ linhas: ["string invalida", { placaBruta: "ABC1D23", enderecoBruto: "Rua X", clienteNome: "Y" }] })
    );
    const chamarMistral = vi.fn();
    const resultado = await extrairRomaneioViaLLM("texto", { chamarOllama, chamarMistral });
    expect(resultado).toEqual([{ placaBruta: "ABC1D23", enderecoBruto: "Rua X", clienteNome: "Y", nf: undefined, clienteCodigo: undefined }]);
  });
});
