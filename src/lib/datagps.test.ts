import { describe, it, expect } from "vitest";
import { DATAGPS_CORRIGIDO_DESDE, datagpsReal, parseDatagps } from "./datagps";

// RAS-02 / Frente H (auditoria 03/11): a Unitrac manda "dd/mm/aaaa hh:mm:ss"
// na hora de Brasília. Até a correção o parse colava "Z" e gravava 3 h a menos.
describe("parseDatagps", () => {
  it("lê a hora de Brasília (-03:00): 17:12:29 BRT = 20:12:29Z", () => {
    expect(parseDatagps("03/11/2026 17:12:29")).toBe("2026-11-03T20:12:29.000Z");
  });

  it("vira o dia em UTC depois das 21h de Brasília", () => {
    expect(parseDatagps("03/11/2026 22:30:00")).toBe("2026-11-04T01:30:00.000Z");
  });

  it("aceita o formato curto de ano com 2 dígitos", () => {
    expect(parseDatagps("26/06/26 01:01:33")).toBe("2026-06-26T04:01:33.000Z");
  });

  it("aceita espaço sobrando nas pontas", () => {
    expect(parseDatagps("  03/11/2026 17:12:29 ")).toBe("2026-11-03T20:12:29.000Z");
  });

  it("vazio, nulo e indefinido dão null (nunca 'agora')", () => {
    expect(parseDatagps("")).toBeNull();
    expect(parseDatagps("   ")).toBeNull();
    expect(parseDatagps(null)).toBeNull();
    expect(parseDatagps(undefined)).toBeNull();
  });

  it("texto inválido e data impossível dão null", () => {
    expect(parseDatagps("nao e data")).toBeNull();
    expect(parseDatagps("31/02/2026 10:00:00")).toBeNull();
    expect(parseDatagps("03/13/2026 10:00:00")).toBeNull();
    expect(parseDatagps("03/11/2026 25:00:00")).toBeNull();
  });

  it("ISO com fuso explícito é respeitado", () => {
    expect(parseDatagps("2026-11-03T20:12:29Z")).toBe("2026-11-03T20:12:29.000Z");
    expect(parseDatagps("2026-11-03T17:12:29-03:00")).toBe("2026-11-03T20:12:29.000Z");
  });

  it("ISO sem fuso é hora de Brasília, não a do servidor (CEST)", () => {
    expect(parseDatagps("2026-11-03T17:12:29")).toBe("2026-11-03T20:12:29.000Z");
  });
});

// datagps gravado antes da correção está 3 h atrás; datagpsReal devolve o
// instante real pra comparar com o que é gravado depois.
describe("datagpsReal", () => {
  const corte = "2026-11-04T00:45:00Z";

  it("constante do corte é um ISO válido", () => {
    expect(Number.isFinite(Date.parse(DATAGPS_CORRIGIDO_DESDE))).toBe(true);
  });

  it("gravado antes do corte: soma 3 h", () => {
    // leitura das 17:12 BRT gravada às 20:13Z com o parse antigo (17:12Z)
    expect(datagpsReal("2026-11-03T17:12:29Z", "2026-11-03T20:13:00Z", corte)?.toISOString()).toBe(
      "2026-11-03T20:12:29.000Z",
    );
  });

  it("gravado depois do corte: devolve como está", () => {
    expect(datagpsReal("2026-11-04T10:00:00Z", "2026-11-04T10:00:30Z", corte)?.toISOString()).toBe(
      "2026-11-04T10:00:00.000Z",
    );
  });

  it("aceita Date nos dois argumentos", () => {
    expect(datagpsReal(new Date("2026-11-03T17:12:29Z"), new Date("2026-11-03T20:13:00Z"), corte)?.toISOString()).toBe(
      "2026-11-03T20:12:29.000Z",
    );
  });

  it("não soma se o resultado cairia depois da gravação (+5 min): valor já estava certo", () => {
    // corte configurado tarde demais: leitura já certa gravada antes dele.
    // Somar 3 h jogaria o marco pro futuro e o motor pularia o carro por 3 h.
    expect(datagpsReal("2026-11-04T00:00:00Z", "2026-11-04T00:00:30Z", corte)?.toISOString()).toBe(
      "2026-11-04T00:00:00.000Z",
    );
  });

  it("gravadoEm desconhecido ou inválido: devolve como está (lado seguro, nunca empurra pro futuro)", () => {
    expect(datagpsReal("2026-11-03T17:12:29Z", null, corte)?.toISOString()).toBe("2026-11-03T17:12:29.000Z");
    expect(datagpsReal("2026-11-03T17:12:29Z", "lixo", corte)?.toISOString()).toBe("2026-11-03T17:12:29.000Z");
  });

  it("datagps nulo ou inválido dá null", () => {
    expect(datagpsReal(null, "2026-11-03T20:13:00Z", corte)).toBeNull();
    expect(datagpsReal("lixo", "2026-11-03T20:13:00Z", corte)).toBeNull();
  });
});
