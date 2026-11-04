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
  // Frente H / DSV-08: com o parse certo (-03:00) o datagps é o instante
  // real. Plausível = não está no futuro em relação à gravação da linha
  // (updated_at de posicoes_atuais), com 5 min de folga pro relógio do
  // aparelho. Independe do deslocamento de fuso: o valor antigo (3 h atrás)
  // também passa, então a transição não congela o marco.
  const updatedAt = new Date("2026-11-03T20:00:00Z");

  it("aceita o datagps certo de uma leitura ao vivo (segundos antes da gravação)", () => {
    expect(datagpsPlausivelComoMarco("2026-11-03T19:59:40Z", updatedAt)).toBe(true);
  });

  it("aceita o datagps antigo, 3 h atrás (gravado antes da correção)", () => {
    expect(datagpsPlausivelComoMarco("2026-11-03T17:00:00Z", updatedAt)).toBe(true);
  });

  it("aceita leitura antiga (GPS atrasado de verdade)", () => {
    expect(datagpsPlausivelComoMarco("2026-11-03T09:00:00Z", updatedAt)).toBe(true);
  });

  it("aceita até updated_at + 5 min (relógio do aparelho um pouco adiantado)", () => {
    const borda = new Date(updatedAt.getTime() + MARGEM_DATAGPS_PLAUSIVEL_MS).toISOString();
    expect(MARGEM_DATAGPS_PLAUSIVEL_MS).toBe(5 * 60 * 1000);
    expect(datagpsPlausivelComoMarco(borda, updatedAt)).toBe(true);
  });

  it("REJEITA updated_at + 10 min (futuro)", () => {
    expect(datagpsPlausivelComoMarco("2026-11-03T20:10:00Z", updatedAt)).toBe(false);
  });

  it("aceita objeto Date e referência em texto", () => {
    expect(datagpsPlausivelComoMarco(new Date("2026-11-03T19:59:00Z"), "2026-11-03T20:00:00Z")).toBe(true);
  });

  it("null e data invalida nunca viram marco", () => {
    expect(datagpsPlausivelComoMarco(null, updatedAt)).toBe(false);
    expect(datagpsPlausivelComoMarco("nao e uma data", updatedAt)).toBe(false);
  });

  it("referência inválida: não vira marco (fail-open, o carro continua sendo processado)", () => {
    expect(datagpsPlausivelComoMarco("2026-11-03T19:59:00Z", "lixo")).toBe(false);
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
