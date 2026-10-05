import { describe, it, expect } from "vitest";
import { situacaoTransmissao, ROTULO_SITUACAO } from "./veiculos-situacao";

const agora = new Date("2026-10-05T20:00:00Z");

describe("situacaoTransmissao", () => {
  it("transmitiu nos últimos 3 dias: ok", () => {
    expect(situacaoTransmissao("2026-10-05T19:00:00Z", agora)).toBe("ok");
    expect(situacaoTransmissao("2026-10-02T21:00:00Z", agora)).toBe("ok");
  });
  it("entre 3 e 30 dias: parado", () => {
    expect(situacaoTransmissao("2026-09-20T12:00:00Z", agora)).toBe("parado");
  });
  it("mais de 30 dias: sem sinal", () => {
    expect(situacaoTransmissao("2026-08-01T12:00:00Z", agora)).toBe("sem_sinal");
  });
  it("sem posição nenhuma ou data inválida: nunca", () => {
    expect(situacaoTransmissao(null, agora)).toBe("nunca");
    expect(situacaoTransmissao("lixo", agora)).toBe("nunca");
  });
  it("todo estado tem rótulo", () => {
    expect(Object.keys(ROTULO_SITUACAO).sort()).toEqual(["nunca", "ok", "parado", "sem_sinal"]);
  });
});
