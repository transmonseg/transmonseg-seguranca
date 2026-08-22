import { describe, it, expect } from "vitest";
import { classificarBalde, mediana, percentil90 } from "./qualidade-tratamento";

describe("classificarBalde", () => {
  it("revisao individual: origem_acao resolver_individual", () => {
    expect(classificarBalde({ origem_acao: "resolver_individual", status: "resolvido", operador_id: "op1" })).toBe("individual");
  });
  it("revisao individual: origem_acao falso_individual", () => {
    expect(classificarBalde({ origem_acao: "falso_individual", status: "falso_positivo", operador_id: "op1" })).toBe("individual");
  });
  it("acao em massa: origem_acao resolver_massa", () => {
    expect(classificarBalde({ origem_acao: "resolver_massa", status: "resolvido", operador_id: "op1" })).toBe("massa");
  });
  it("limpo: status limpo (tirado da tela sem julgamento) tem prioridade sobre origem_acao", () => {
    expect(classificarBalde({ origem_acao: "limpar_massa", status: "limpo", operador_id: "op1" })).toBe("limpo");
  });
  it("em aberto: status ativo", () => {
    expect(classificarBalde({ origem_acao: null, status: "ativo", operador_id: null })).toBe("aberto");
  });
  it("em aberto: status reconhecido", () => {
    expect(classificarBalde({ origem_acao: null, status: "reconhecido", operador_id: null })).toBe("aberto");
  });
  it("auto-resolvido: resolvido pelo motor, sem operador", () => {
    expect(classificarBalde({ origem_acao: null, status: "resolvido", operador_id: null })).toBe("auto");
  });
  it("auto-resolvido: falso_positivo sem operador (auto-resolve de rota concluida)", () => {
    expect(classificarBalde({ origem_acao: null, status: "falso_positivo", operador_id: null })).toBe("auto");
  });
  it("resolvido por operador mas sem origem_acao (dado antigo, antes da coluna): conta como individual", () => {
    expect(classificarBalde({ origem_acao: null, status: "resolvido", operador_id: "op1" })).toBe("individual");
  });
});

describe("mediana", () => {
  it("lista vazia: null", () => {
    expect(mediana([])).toBeNull();
  });
  it("quantidade impar: elemento do meio", () => {
    expect(mediana([5, 1, 3])).toBe(3);
  });
  it("quantidade par: media dos dois do meio", () => {
    expect(mediana([1, 2, 3, 4])).toBe(2.5);
  });
  it("nao muta o array de entrada", () => {
    const entrada = [3, 1, 2];
    mediana(entrada);
    expect(entrada).toEqual([3, 1, 2]);
  });
});

describe("percentil90", () => {
  it("lista vazia: null", () => {
    expect(percentil90([])).toBeNull();
  });
  it("um elemento: o proprio", () => {
    expect(percentil90([42])).toBe(42);
  });
  it("10 elementos 1..10: p90 e' 9", () => {
    expect(percentil90([1, 2, 3, 4, 5, 6, 7, 8, 9, 10])).toBe(9);
  });
  it("nao muta o array de entrada", () => {
    const entrada = [3, 1, 2];
    percentil90(entrada);
    expect(entrada).toEqual([3, 1, 2]);
  });
});
