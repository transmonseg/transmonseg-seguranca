import { describe, it, expect } from "vitest";
import { enderecoDaRioQuality, AVISO_LIMITACAO_PORTFRIO } from "./auditar-geocode-territorio";
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

  // Fix 3 (Fase 2, 13/09): Porte Frio monta endereco com
  // src/lib/kpi-portefrio/agregacao.ts:enderecoCompleto
  // (`${endereco}, ${numero} - ${bairro}, ${cidade} - ${uf}`), e o numero
  // parseado (parse-romaneio.ts linha 246) pode ser um numero real -- nesse
  // caso o formato e' byte-a-byte identico ao formato Nutry Max (numero real,
  // virgula, hifen, bairro, cidade, hifen, sufixo) e enderecoDaRioQuality NAO
  // exclui. Nao ha discriminador de forma possivel aqui -- confirmado lendo
  // agregacao.ts (esta funcao so testa numero vazio, e Porte Frio com numero
  // parseado passa por igual a um endereco real da Nutry Max).
  it("endereco Porte Frio COM numero (formato identico ao da Nutry Max) NAO e' excluido -- limitacao conhecida, sem discriminador de forma possivel", () => {
    // Shape de src/lib/kpi-portefrio/agregacao.ts:enderecoCompleto com numero
    // parseado (nao vazio).
    expect(enderecoDaRioQuality("RUA CORONEL PEDRO CORREIA, 850 - CENTRO, MACAE - RJ")).toBe(false);
  });
});

// Fix 3 (Fase 2, 13/09): como nao ha discriminador de forma seguro pra
// separar Porte Frio de Nutry Max quando Porte Frio tem numero real (ver
// teste acima), a mitigacao possivel neste nivel e' tornar o risco visivel
// pra quem le o relatorio, em vez de inventar uma heuristica fragil. Exposicao
// hoje e' zero (0 geracoes Porte Frio em kpi_romaneio_geracoes, 13/09) -- o
// fix real e' uma coluna `cliente` em kpi_romaneio_geocode_cache antes de
// Porte Frio ir pra producao.
describe("AVISO_LIMITACAO_PORTFRIO", () => {
  it("documenta a limitacao (Porte Frio com numero real nao e' excluido) e a mitigacao real (coluna cliente)", () => {
    expect(AVISO_LIMITACAO_PORTFRIO).toMatch(/Porte Frio/);
    expect(AVISO_LIMITACAO_PORTFRIO).toMatch(/coluna/i);
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
