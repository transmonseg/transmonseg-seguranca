import { describe, it, expect } from "vitest";
import { parseRomaneioTabular, extrairDataTabular } from "./romaneio-tabular";

// Fixture SINTETICA (nunca dado real de cliente) no mesmo layout confirmado
// em 2 arquivos reais (21/08 e 25/08): DATA -> ROMANEIO -> CARRO -> ORDEM
// (header) -> linhas de NF -> linha de totais -> repete pro proximo carro.
const TEXTO_EXEMPLO = [
  "DATA\t01/09/2026",
  "ROMANEIO\t1\tMOTORISTA\tAJUDANTE",
  "CARRO\t10\tABC1D23\tFULANO DA SILVA\t-",
  "ORDEM\tNOTA FISCAL\tCLIENTE\tENDEREÇO\tBAIRRO\tQTD CAIXAS\tPESO BRUTO\tPESO LÍQUIDO\tVALOR BRUTO",
  "2\t900001\tMERCADO TESTE A\tRUA DAS FLORES,100\tCENTRO\t20\t150,0\t145,0\t1.000,00\tR$",
  "1\t900002\tMERCADO TESTE B\tAV BRASIL,200\tCENTRO\t30\t200,0\t190,0\t1.500,00\tR$",
  "50\t350,0\t335,0\t2.500,00\tR$",
  "ROMANEIO\t2\tMOTORISTA\tAJUDANTE",
  "CARRO\t20\tXYZ9W88\tCICLANO PEREIRA\t-",
  "ORDEM\tNOTA FISCAL\tCLIENTE\tENDEREÇO\tBAIRRO\tQTD CAIXAS\tPESO BRUTO\tPESO LÍQUIDO\tVALOR BRUTO",
  "1\t900003\tLOJA TESTE C\tRUA NOVA,300\tJARDIM\t10\t80,0\t75,0\t600,00\tR$",
  "10\t80,0\t75,0\t600,00\tR$",
].join("\n");

describe("parseRomaneioTabular", () => {
  it("extrai uma linha por NF, associada a placa do CARRO mais recente", () => {
    const linhas = parseRomaneioTabular(TEXTO_EXEMPLO);
    expect(linhas).toHaveLength(3);
    expect(linhas![0]).toEqual({
      placaBruta: "ABC1D23",
      nf: "900001",
      clienteNome: "MERCADO TESTE A",
      enderecoBruto: "RUA DAS FLORES,100, CENTRO",
    });
    expect(linhas![1].placaBruta).toBe("ABC1D23");
    expect(linhas![2]).toEqual({
      placaBruta: "XYZ9W88",
      nf: "900003",
      clienteNome: "LOJA TESTE C",
      enderecoBruto: "RUA NOVA,300, JARDIM",
    });
  });

  it("linha de totais (so 4-5 campos) nao vira entrega -- distinguida de linha de dado real", () => {
    const linhas = parseRomaneioTabular(TEXTO_EXEMPLO);
    // 3 entregas reais (2 do carro 1, 1 do carro 2) -- as 2 linhas de
    // totais ("50\t350,0\t..." e "10\t80,0\t...") nao contam.
    expect(linhas).toHaveLength(3);
  });

  it("texto que nao e' desse formato (nenhum CARRO) devolve null -- sinal pro chamador tentar outro caminho", () => {
    const resultado = parseRomaneioTabular("um texto qualquer\nsem nada a ver");
    expect(resultado).toBeNull();
  });

  it("CARRO reconhecido mas sem nenhuma linha de dado valida devolve array vazio (nao null)", () => {
    const texto = ["DATA\t01/09/2026", "ROMANEIO\t1\tMOTORISTA\tAJUDANTE", "CARRO\t10\tABC1D23\tFULANO\t-"].join("\n");
    const linhas = parseRomaneioTabular(texto);
    expect(linhas).toEqual([]);
  });

  it("linha de dado incompleta (sem cliente ou endereco) e' pulada, nao inventa dado", () => {
    const texto = [
      "CARRO\t10\tABC1D23\tFULANO\t-",
      "ORDEM\tNOTA FISCAL\tCLIENTE\tENDEREÇO\tBAIRRO\tQTD CAIXAS\tPESO BRUTO\tPESO LÍQUIDO\tVALOR BRUTO",
      "1\t900001\t\t\tCENTRO\t20\t150,0\t145,0\t1.000,00\tR$",
    ].join("\n");
    const linhas = parseRomaneioTabular(texto);
    expect(linhas).toEqual([]);
  });
});

describe("extrairDataTabular", () => {
  it("extrai a data do cabeçalho DATA\\t<dd/mm/yyyy> (sem horário, ao contrário do romaneio Nutry Max)", () => {
    expect(extrairDataTabular(TEXTO_EXEMPLO)).toBe("2026-09-01");
  });

  it("devolve null quando não encontra o cabeçalho DATA", () => {
    expect(extrairDataTabular("texto sem data nenhuma")).toBeNull();
  });
});
