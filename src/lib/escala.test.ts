import { describe, it, expect } from "vitest";
import { extrairDataEscala, parseEscala } from "./escala";

describe("extrairDataEscala", () => {
  it("acha data no formato dd/mm/aaaa hh:mm e devolve ISO (aaaa-mm-dd)", () => {
    const texto = "8081 - Escala de Rota 04/08/2026 01:50 Page 1 of 3\nCOMBOIO 1\t...";
    expect(extrairDataEscala(texto)).toBe("2026-08-04");
  });
  it("sem data no formato esperado: null", () => {
    expect(extrairDataEscala("texto sem nenhuma data reconhecivel")).toBeNull();
  });
});

// Texto bruto REAL extraido de Escala 04-08.pdf com pdf-parse v2 (ver
// docs/superpowers/specs/2026-08-09-escala-rota-design.md) -- inclui de
// proposito as 4 linhas "JEITO CASEIRO", que tem um numero a mais entre o
// destino e o nome do motorista (achado real, nao teorico) que o parser
// precisa tratar corretamente (ultimos 2 numeros antes do nome = ENT/NF,
// sempre, nao importa quantos vem antes).
const TEXTO_ESCALA_REAL = [
  "8081 - Escala de Rota 04/08/2026 01:50 Page 1 of 3",
  "CAMPOS CROSS\tCARGA VEICULO DESTINO PESO ENT NF MOTORISTA AJUDANTE 1 DUPLICADO\tAJUDANTE 2",
  "94941 68 - TUL1C38 CAMPOS 3.060 34 38 LUAN VIANA AREAS RIBEIRO\t3.060",
  "94942 22 - TUC1D15 CAMPOS 2 3.097 32 33 EDUARDO TEXEIRA DE AZEVEDO LEANDRO DA HORA BATISTA\t3.097",
  "94946 19 - TUI1A90 S.A DE PADUA 3.849 23 25 ELIZEU SILVA DA CRUZ JUNIOR PATRICK DA SILVA CUNHA AJUD1,\t3.850",
  "33.663\tComboio: 11 carga(s)",
  "COMBOIO 1\tCARGA VEICULO DESTINO PESO ENT NF MOTORISTA AJUDANTE 1 DUPLICADO\tAJUDANTE 2",
  "94970 16 - TTY1A57 JEITO CASEIRO 16 68 1 1 NELSON REIS MENDES SOARES MOT,",
  "95019 34 - RQU1G17 JEITO CASEIRO 34 120 3 3 LUIZ CARLOS MENEZES DE OLIVEIRA",
  "95021 43 - TTI6E49 JEITO CASEIRO 43 40 1 1 EDNILSON RICALDONI",
  "95020 54 - TTU1I06 JEITO CASEIRO 54 120 3 3 PAULO SERGIO COSTA",
  "81.384\tComboio: 27 carga(s)",
  "",
  "-- 1 of 3 --",
  "",
  "RETIRADA\tCARGA VEICULO DESTINO PESO ENT NF MOTORISTA AJUDANTE 1 DUPLICADO\tAJUDANTE 2",
  "94936 2 - XXX0000 DIRETA ZONA SUL 60.015 1 1 NELSON REIS MENDES SOARES MOT, VEICULO\t60.015",
  "61.227\tComboio: 04 carga(s)",
  "Geral: 83 carga(s) 277.505",
].join("\n");

describe("parseEscala", () => {
  it("linha normal, sem indice de sub-rota", () => {
    const linhas = parseEscala(TEXTO_ESCALA_REAL);
    const l = linhas.find((x) => x.placaBruta === "TUL1C38")!;
    expect(l).toMatchObject({
      cargaCodigo: "94941",
      destinoTexto: "CAMPOS",
      destinoNormalizado: "CAMPOS",
      entregas: 34,
      nfs: 38,
    });
  });

  it("linha com indice de sub-rota (CAMPOS 2): indice fica em destinoTexto mas some em destinoNormalizado", () => {
    const linhas = parseEscala(TEXTO_ESCALA_REAL);
    const l = linhas.find((x) => x.placaBruta === "TUC1D15")!;
    expect(l).toMatchObject({
      destinoTexto: "CAMPOS 2",
      destinoNormalizado: "CAMPOS",
      entregas: 32,
      nfs: 33,
    });
  });

  it("destino com pontos (S.A DE PADUA): letras+pontos reconhecidos como destino", () => {
    const linhas = parseEscala(TEXTO_ESCALA_REAL);
    const l = linhas.find((x) => x.placaBruta === "TUI1A90")!;
    expect(l.destinoNormalizado).toBe("S.A DE PADUA");
    expect(l.entregas).toBe(23);
    expect(l.nfs).toBe(25);
  });

  it("linhas JEITO CASEIRO (4 numeros antes do nome): ENT/NF sao sempre os ultimos 2 numeros", () => {
    const linhas = parseEscala(TEXTO_ESCALA_REAL);
    const l = linhas.find((x) => x.placaBruta === "RQU1G17")!;
    expect(l.destinoNormalizado).toBe("JEITO CASEIRO");
    expect(l.entregas).toBe(3);
    expect(l.nfs).toBe(3);
  });

  it("placa placeholder XXX0000 ainda parseia normalmente (rejeicao acontece no endpoint, nao aqui)", () => {
    const linhas = parseEscala(TEXTO_ESCALA_REAL);
    const l = linhas.find((x) => x.placaBruta === "XXX0000")!;
    expect(l.destinoNormalizado).toBe("DIRETA ZONA SUL");
  });

  it("rodape de comboio, marcador de pagina, cabecalho de tabela e total geral nao viram linha", () => {
    const linhas = parseEscala(TEXTO_ESCALA_REAL);
    expect(linhas).toHaveLength(8);
  });
});
