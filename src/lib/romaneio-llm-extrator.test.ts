import { describe, it, expect, vi } from "vitest";
import { extrairRomaneioViaLLM, LIMIAR_TEXTO_SO_CLOUD_CHARS } from "./romaneio-llm-extrator";

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
    expect(resultado).toEqual({
      linhas: [
        { placaBruta: "ABC1D23", enderecoBruto: "Rua das Flores, 100", clienteNome: "Mercado Central", nf: "12345", clienteCodigo: "C001" },
      ],
      fonte: "ollama",
    });
    expect(chamarMistral).not.toHaveBeenCalled();
  });

  it("texto grande (> LIMIAR_TEXTO_SO_CLOUD_CHARS): pula o Ollama e vai direto pro Mistral (achado real 21/08, Escala do Pao -- qwen em CPU nunca termina 60+ linhas nos 35s)", async () => {
    const chamarOllama = vi.fn();
    const chamarMistral = vi.fn().mockResolvedValue(RESPOSTA_VALIDA);
    const textoGrande = "x".repeat(LIMIAR_TEXTO_SO_CLOUD_CHARS + 1);
    const resultado = await extrairRomaneioViaLLM(textoGrande, { chamarOllama, chamarMistral });
    expect(chamarOllama).not.toHaveBeenCalled();
    expect(resultado?.fonte).toBe("mistral");
  });

  it("texto no limite exato do limiar: ainda tenta o Ollama primeiro (cascata normal)", async () => {
    const chamarOllama = vi.fn().mockResolvedValue(RESPOSTA_VALIDA);
    const chamarMistral = vi.fn();
    const textoLimite = "x".repeat(LIMIAR_TEXTO_SO_CLOUD_CHARS);
    const resultado = await extrairRomaneioViaLLM(textoLimite, { chamarOllama, chamarMistral });
    expect(chamarOllama).toHaveBeenCalledTimes(1);
    expect(resultado?.fonte).toBe("ollama");
  });

  it("cai pro Mistral quando o Ollama local falha (rede/timeout)", async () => {
    const chamarOllama = vi.fn().mockRejectedValue(new Error("timeout"));
    const chamarMistral = vi.fn().mockResolvedValue(RESPOSTA_VALIDA);
    const resultado = await extrairRomaneioViaLLM("texto", { chamarOllama, chamarMistral });
    expect(resultado).toEqual({
      linhas: [
        { placaBruta: "ABC1D23", enderecoBruto: "Rua das Flores, 100", clienteNome: "Mercado Central", nf: "12345", clienteCodigo: "C001" },
      ],
      fonte: "mistral",
    });
    expect(chamarMistral).toHaveBeenCalledTimes(1);
  });

  it("cai pro Mistral quando o Ollama local devolve JSON invalido", async () => {
    const chamarOllama = vi.fn().mockResolvedValue("isso nao e json");
    const chamarMistral = vi.fn().mockResolvedValue(RESPOSTA_VALIDA);
    const resultado = await extrairRomaneioViaLLM("texto", { chamarOllama, chamarMistral });
    expect(resultado).toEqual({
      linhas: [
        { placaBruta: "ABC1D23", enderecoBruto: "Rua das Flores, 100", clienteNome: "Mercado Central", nf: "12345", clienteCodigo: "C001" },
      ],
      fonte: "mistral",
    });
  });

  it("cai pro Mistral quando o Ollama local devolve um array 'linhas' VALIDO porem vazio", async () => {
    // Bug real corrigido: [] e' truthy em JS -- "if (local) return local"
    // travava aqui e nunca chamava o Mistral (o fallback que existe
    // exatamente pra esse caso: modelo local nao reconheceu o documento).
    const chamarOllama = vi.fn().mockResolvedValue(JSON.stringify({ linhas: [] }));
    const chamarMistral = vi.fn().mockResolvedValue(RESPOSTA_VALIDA);
    const resultado = await extrairRomaneioViaLLM("texto", { chamarOllama, chamarMistral });
    expect(chamarMistral).toHaveBeenCalledTimes(1);
    expect(resultado).toEqual({
      linhas: [
        { placaBruta: "ABC1D23", enderecoBruto: "Rua das Flores, 100", clienteNome: "Mercado Central", nf: "12345", clienteCodigo: "C001" },
      ],
      fonte: "mistral",
    });
  });

  it("aceita linha sem nf/clienteCodigo (campos opcionais)", async () => {
    const chamarOllama = vi.fn().mockResolvedValue(
      JSON.stringify({ linhas: [{ placaBruta: "XYZ9W88", enderecoBruto: "Av Brasil, 500", clienteNome: "Loja X" }] })
    );
    const chamarMistral = vi.fn();
    const resultado = await extrairRomaneioViaLLM("texto", { chamarOllama, chamarMistral });
    expect(resultado).toEqual({
      linhas: [{ placaBruta: "XYZ9W88", enderecoBruto: "Av Brasil, 500", clienteNome: "Loja X", nf: undefined, clienteCodigo: undefined }],
      fonte: "ollama",
    });
  });

  it("aceita linha ambigua (sem endereco reconhecivel) em vez de descartar", async () => {
    const chamarOllama = vi.fn().mockResolvedValue(
      JSON.stringify({ linhas: [{ placaBruta: "ABC1D23", enderecoBruto: "", clienteNome: "Cliente Y" }] })
    );
    const chamarMistral = vi.fn();
    const resultado = await extrairRomaneioViaLLM("texto", { chamarOllama, chamarMistral });
    expect(resultado).toEqual({
      linhas: [{ placaBruta: "ABC1D23", enderecoBruto: "", clienteNome: "Cliente Y", nf: undefined, clienteCodigo: undefined }],
      fonte: "ollama",
    });
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
    expect(resultado).toEqual({
      linhas: [{ placaBruta: "ABC1D23", enderecoBruto: "Rua X", clienteNome: "Y", nf: undefined, clienteCodigo: undefined }],
      fonte: "ollama",
    });
  });
});
