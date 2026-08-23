import { describe, it, expect } from "vitest";
import {
  dataSP,
  datagpsPlausivelComoMarco,
  estadoEhDeOutroDiaSP,
  MARGEM_DATAGPS_PLAUSIVEL_MS,
} from "./motor-romaneio-estado";

describe("dataSP", () => {
  it("usa o fuso de Sao Paulo, nao o do servidor (CEST)", () => {
    // 22:30 de Sao Paulo = 03:30 do dia seguinte em CEST (UTC+2) e
    // 01:30 do dia seguinte em UTC -- o dia de SP ainda e' o 22.
    expect(dataSP(new Date("2026-08-23T01:30:00Z"))).toBe("2026-08-22");
  });

  it("vira o dia so' na meia-noite de Sao Paulo", () => {
    expect(dataSP(new Date("2026-08-23T02:59:00Z"))).toBe("2026-08-22");
    expect(dataSP(new Date("2026-08-23T03:01:00Z"))).toBe("2026-08-23");
  });
});

describe("datagpsPlausivelComoMarco", () => {
  const agora = new Date("2026-08-22T20:00:00Z");

  it("aceita o datagps normal desta base (~3h atras por causa do offset de fuso)", () => {
    expect(datagpsPlausivelComoMarco("2026-08-22T17:00:00Z", agora)).toBe(true);
  });

  it("aceita leitura antiga (GPS atrasado de verdade)", () => {
    expect(datagpsPlausivelComoMarco("2026-08-22T09:00:00Z", agora)).toBe(true);
  });

  it("REJEITA o valor envenenado (agora.toISOString() do fallback da Central)", () => {
    expect(datagpsPlausivelComoMarco(agora.toISOString(), agora)).toBe(false);
  });

  it("REJEITA valor no futuro", () => {
    expect(datagpsPlausivelComoMarco("2026-08-22T23:00:00Z", agora)).toBe(false);
  });

  it("REJEITA valor dentro da margem de 2h", () => {
    expect(datagpsPlausivelComoMarco("2026-08-22T18:30:00Z", agora)).toBe(false);
  });

  it("aceita exatamente na borda da margem", () => {
    const borda = new Date(agora.getTime() - MARGEM_DATAGPS_PLAUSIVEL_MS).toISOString();
    expect(datagpsPlausivelComoMarco(borda, agora)).toBe(true);
  });

  it("aceita objeto Date, nao so' string", () => {
    expect(datagpsPlausivelComoMarco(new Date("2026-08-22T17:00:00Z"), agora)).toBe(true);
  });

  it("null e data invalida nunca viram marco", () => {
    expect(datagpsPlausivelComoMarco(null, agora)).toBe(false);
    expect(datagpsPlausivelComoMarco("nao e uma data", agora)).toBe(false);
  });
});

describe("estadoEhDeOutroDiaSP", () => {
  it("estado gravado hoje (SP) nao e' de outro dia", () => {
    expect(estadoEhDeOutroDiaSP(new Date("2026-08-22T13:00:00Z"), "2026-08-22")).toBe(false);
  });

  it("estado da sexta visto na segunda e' de outro dia", () => {
    expect(estadoEhDeOutroDiaSP(new Date("2026-08-21T20:00:00Z"), "2026-08-24")).toBe(true);
  });

  it("usa o dia de SP, nao o do servidor: 23:00Z ainda e' o dia anterior em SP", () => {
    // 2026-08-22T23:00:00Z = 20:00 em Sao Paulo do dia 22.
    expect(estadoEhDeOutroDiaSP(new Date("2026-08-22T23:00:00Z"), "2026-08-22")).toBe(false);
    // Mesmo instante, se comparado contra o dia 23 (que e' o dia do
    // servidor em CEST/UTC), seria "outro dia" -- e zerar o streak as 20h
    // no meio da operacao e' exatamente o bug que hojeSP() evita.
    expect(estadoEhDeOutroDiaSP(new Date("2026-08-22T23:00:00Z"), "2026-08-23")).toBe(true);
  });

  it("estado nunca gravado (null) nao conta como outro dia", () => {
    expect(estadoEhDeOutroDiaSP(null, "2026-08-22")).toBe(false);
  });

  it("data invalida nao conta como outro dia (nao inventa reset)", () => {
    expect(estadoEhDeOutroDiaSP(new Date("invalido"), "2026-08-22")).toBe(false);
  });
});
