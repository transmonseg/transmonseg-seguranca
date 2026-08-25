import { describe, it, expect, vi } from "vitest";
import { extrairRomaneioViaLLM, LIMIAR_TEXTO_SO_CLOUD_CHARS } from "./romaneio-llm-extrator";

const RESPOSTA_VALIDA = JSON.stringify({
  linhas: [
    { placaBruta: "ABC1D23", enderecoBruto: "Rua das Flores, 100", clienteNome: "Mercado Central", nf: "12345", clienteCodigo: "C001" },
  ],
});

// Achado real 25/08: Ollama travou (400-500% CPU) por 6h+ seguidas no mesmo
// dia, >24 reinicios do watchdog systemd numa unica janela -- desativado de
// proposito (ver OLLAMA_DESATIVADO em romaneio-llm-extrator.ts). Os testes
// abaixo travam esse comportamento: chamarOllama NUNCA e' chamado, qualquer
// tamanho de texto, e todo o resto da cascata (validacao de JSON, campos
// opcionais, linhas ambiguas) continua testado do mesmo jeito, so' que via
// chamarMistral -- unico provedor vivo agora.
describe("extrairRomaneioViaLLM", () => {
  it("achado real 25/08: Ollama desativado -- NUNCA chamado, nem com texto pequeno, vai direto pro Mistral", async () => {
    const chamarOllama = vi.fn();
    const chamarMistral = vi.fn().mockResolvedValue(RESPOSTA_VALIDA);
    const resultado = await extrairRomaneioViaLLM("texto pequeno", { chamarOllama, chamarMistral });
    expect(chamarOllama).not.toHaveBeenCalled();
    expect(chamarMistral).toHaveBeenCalledTimes(1);
    expect(resultado?.fonte).toBe("mistral");
  });

  it("texto grande (> LIMIAR_TEXTO_SO_CLOUD_CHARS): também vai direto pro Mistral (achado real 21/08, agora reforçado pelo achado de 25/08)", async () => {
    const chamarOllama = vi.fn();
    const chamarMistral = vi.fn().mockResolvedValue(RESPOSTA_VALIDA);
    const textoGrande = "x".repeat(LIMIAR_TEXTO_SO_CLOUD_CHARS + 1);
    const resultado = await extrairRomaneioViaLLM(textoGrande, { chamarOllama, chamarMistral });
    expect(chamarOllama).not.toHaveBeenCalled();
    expect(resultado?.fonte).toBe("mistral");
  });

  it("resultado valido do Mistral e' devolvido com os campos certos", async () => {
    const chamarOllama = vi.fn();
    const chamarMistral = vi.fn().mockResolvedValue(RESPOSTA_VALIDA);
    const resultado = await extrairRomaneioViaLLM("texto", { chamarOllama, chamarMistral });
    expect(resultado).toEqual({
      linhas: [
        { placaBruta: "ABC1D23", enderecoBruto: "Rua das Flores, 100", clienteNome: "Mercado Central", nf: "12345", clienteCodigo: "C001" },
      ],
      fonte: "mistral",
    });
  });

  it("devolve null quando o Mistral falha (rede/timeout)", async () => {
    const chamarOllama = vi.fn();
    const chamarMistral = vi.fn().mockRejectedValue(new Error("timeout"));
    const resultado = await extrairRomaneioViaLLM("texto", { chamarOllama, chamarMistral });
    expect(resultado).toBeNull();
  });

  it("devolve null quando o Mistral devolve JSON invalido", async () => {
    const chamarOllama = vi.fn();
    const chamarMistral = vi.fn().mockResolvedValue("isso nao e json");
    const resultado = await extrairRomaneioViaLLM("texto", { chamarOllama, chamarMistral });
    expect(resultado).toBeNull();
  });

  it("devolve null quando o Mistral devolve um array 'linhas' VALIDO porem vazio (nao reconheceu o documento)", async () => {
    const chamarOllama = vi.fn();
    const chamarMistral = vi.fn().mockResolvedValue(JSON.stringify({ linhas: [] }));
    const resultado = await extrairRomaneioViaLLM("texto", { chamarOllama, chamarMistral });
    expect(resultado).toEqual({ linhas: [], fonte: "mistral" });
  });

  it("aceita linha sem nf/clienteCodigo (campos opcionais)", async () => {
    const chamarOllama = vi.fn();
    const chamarMistral = vi.fn().mockResolvedValue(
      JSON.stringify({ linhas: [{ placaBruta: "XYZ9W88", enderecoBruto: "Av Brasil, 500", clienteNome: "Loja X" }] })
    );
    const resultado = await extrairRomaneioViaLLM("texto", { chamarOllama, chamarMistral });
    expect(resultado).toEqual({
      linhas: [{ placaBruta: "XYZ9W88", enderecoBruto: "Av Brasil, 500", clienteNome: "Loja X", nf: undefined, clienteCodigo: undefined }],
      fonte: "mistral",
    });
  });

  it("aceita linha ambigua (sem endereco reconhecivel) em vez de descartar", async () => {
    const chamarOllama = vi.fn();
    const chamarMistral = vi.fn().mockResolvedValue(
      JSON.stringify({ linhas: [{ placaBruta: "ABC1D23", enderecoBruto: "", clienteNome: "Cliente Y" }] })
    );
    const resultado = await extrairRomaneioViaLLM("texto", { chamarOllama, chamarMistral });
    expect(resultado).toEqual({
      linhas: [{ placaBruta: "ABC1D23", enderecoBruto: "", clienteNome: "Cliente Y", nf: undefined, clienteCodigo: undefined }],
      fonte: "mistral",
    });
  });

  it("devolve null quando o JSON nao tem o campo 'linhas' como array", async () => {
    const chamarOllama = vi.fn();
    const chamarMistral = vi.fn().mockResolvedValue(JSON.stringify({ algoOutro: [] }));
    const resultado = await extrairRomaneioViaLLM("texto", { chamarOllama, chamarMistral });
    expect(resultado).toBeNull();
  });

  it("ignora entradas que nao sao objetos dentro de 'linhas'", async () => {
    const chamarOllama = vi.fn();
    const chamarMistral = vi.fn().mockResolvedValue(
      JSON.stringify({ linhas: ["string invalida", { placaBruta: "ABC1D23", enderecoBruto: "Rua X", clienteNome: "Y" }] })
    );
    const resultado = await extrairRomaneioViaLLM("texto", { chamarOllama, chamarMistral });
    expect(resultado).toEqual({
      linhas: [{ placaBruta: "ABC1D23", enderecoBruto: "Rua X", clienteNome: "Y", nf: undefined, clienteCodigo: undefined }],
      fonte: "mistral",
    });
  });
});
