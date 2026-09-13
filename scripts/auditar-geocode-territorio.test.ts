import { describe, it, expect } from "vitest";
import { enderecoDaRioQuality } from "./auditar-geocode-territorio";
import { extrairBairroDoEndereco, extrairCidadeDoEndereco } from "@/lib/romaneio-geocode-local";

// Finding 2 (fix wave 12/09): kpi_romaneio_geocode_cache e' compartilhada
// entre Nutry Max e Rio Quality, sem coluna de cliente -- o discriminador
// precisa separar os dois formatos sem tocar em endereco fora de escopo.
describe("enderecoDaRioQuality", () => {
  it("reconhece o formato Rio Quality (montarEnderecoBrutoCompleto: numero sempre vazio)", () => {
    expect(enderecoDaRioQuality("RUA X, - CENTRO, CAMBUCI - RJ")).toBe(true);
    expect(enderecoDaRioQuality("AV. EMBAIXADOR ABELARDO BUENO, - BARRA DA TIJUCA, RIO DE JANEIRO - RJ")).toBe(true);
  });

  it("os 3 anchors de verificacao do fix wave (formato Nutry Max, numero real ou S/N) NAO sao excluidos", () => {
    expect(enderecoDaRioQuality("AVENIDA VINTE DE JANEIRO, S/N - GALEAO, RIO DE JANEIRO - PSU 3 PISO EIXOS 2/6 LINHAS 4/C2")).toBe(false);
    expect(enderecoDaRioQuality("ESTRADA DA PACIENCIA, 713 - PACIENCIA, RIO DE JANEIRO - *")).toBe(false);
    expect(enderecoDaRioQuality("EST DA PEDRA, 4900 - GUARATIBA, RIO DE JANEIRO - *")).toBe(false);
  });

  it("endereco Nutry Max generico (numero real, sufixo qualquer) nao e' excluido", () => {
    expect(enderecoDaRioQuality("RUA DAS FLORES, 100 - CENTRO, ANGRA DOS REIS - *")).toBe(false);
  });
});

// Finding 6 (fix wave 12/09): o script tinha um parser local (partesDoEndereco,
// removido) que divergia de extrairBairroDoEndereco/extrairCidadeDoEndereco
// (romaneio-geocode-local.ts, a MESMA lib que a rota real usa) quando o nome
// da rua tinha " - " embutido -- caso real do CNEFE (faixa de numeracao).
// O script agora usa direto essas funcoes; este teste documenta o caso que
// fazia o parser antigo divergir, contra a lib real (nao contra um parser
// duplicado).
describe("bairro/cidade via romaneio-geocode-local (Finding 6 -- nome de rua com \" - \" embutido)", () => {
  const endereco = "RUA PEREIRA NUNES - DE 212 AO FIM - LADO, 300 - CENTRO, ANGRA DOS REIS - *";

  it("extrairBairroDoEndereco acha o bairro certo (nao o pedaco do meio do nome da rua)", () => {
    expect(extrairBairroDoEndereco(endereco)).toBe("CENTRO");
  });

  it("extrairCidadeDoEndereco acha a cidade certa", () => {
    expect(extrairCidadeDoEndereco(endereco)).toBe("ANGRA DOS REIS");
  });

  it("o parser antigo (ancorado no PRIMEIRO \" - \" do endereco inteiro) teria lido o trecho errado -- documentado aqui pra nao reintroduzir a regressao", () => {
    // Equivalente ao partesDoEndereco removido: split(" - ") e pega o
    // segmento [1] inteiro como "bairro,cidade".
    const seg = endereco.split(" - ");
    const bairroAntigoErrado = seg.length >= 2 && seg[1].includes(",") ? seg[1].slice(0, seg[1].lastIndexOf(",")).trim() : null;
    expect(bairroAntigoErrado).not.toBe("CENTRO");
  });
});
