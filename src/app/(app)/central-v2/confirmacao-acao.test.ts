import { describe, it, expect } from "vitest";
import { pedirConfirmacao, podeExecutar, aoTrocarVeiculo, JANELA_CONFIRMACAO_MS } from "./confirmacao-acao";

describe("confirmacao de sirene/bloqueio", () => {
  it("primeiro clique so pede confirmacao", () => {
    expect(podeExecutar(null, "bloqueio", 7, 0)).toBe(false);
  });
  it("confirmar dentro da janela executa", () => {
    const e = pedirConfirmacao("bloqueio", 7, 1000);
    expect(podeExecutar(e, "bloqueio", 7, 1000 + JANELA_CONFIRMACAO_MS)).toBe(true);
  });
  it("confirmar depois da janela nao executa", () => {
    const e = pedirConfirmacao("sirene", 7, 1000);
    expect(podeExecutar(e, "sirene", 7, 1001 + JANELA_CONFIRMACAO_MS)).toBe(false);
  });
  it("confirmacao de uma acao nao vale pra outra", () => {
    const e = pedirConfirmacao("sirene", 7, 0);
    expect(podeExecutar(e, "bloqueio", 7, 10)).toBe(false);
  });
  it("confirmacao de um veiculo nao vale pra outro", () => {
    const e = pedirConfirmacao("bloqueio", 7, 0);
    expect(podeExecutar(e, "bloqueio", 8, 10)).toBe(false);
  });
  it("trocar de veiculo cancela", () => {
    const e = pedirConfirmacao("bloqueio", 7, 0);
    expect(aoTrocarVeiculo(e, 8)).toBeNull();
    expect(aoTrocarVeiculo(e, null)).toBeNull();
    expect(aoTrocarVeiculo(e, 7)).toEqual(e);
  });
});
