import { describe, it, expect } from "vitest";
import { candidatoEntregaProximidade, RAIO_CONFIRMACAO_M, PARADO_MIN_CONFIRMACAO } from "./entrega-proximidade";
import type { PontoEntrega } from "./unitrac";

function pontoBase(overrides: Partial<PontoEntrega> = {}): PontoEntrega {
  return {
    lat: -22.9, lng: -43.2, raio: 50, ordem: 1, nome: "Cliente Teste",
    feito: false, situacao: 0, codigo: 111, pontoCodigo: 222,
    documento: null, identificador: null, dataInicio: null,
    dataRealizado: null, observacoes: null, rota: null,
    ...overrides,
  };
}

describe("candidatoEntregaProximidade", () => {
  it("parado >=5min a <=500m de um pendente retorna esse pendente", () => {
    // ~450m ao norte (0.004 grau de lat ~ 444m)
    const pos = { lat: -22.896, lng: -43.2 };
    const pendente = pontoBase();
    const r = candidatoEntregaProximidade(pos, 5, [pendente]);
    expect(r).toEqual(pendente);
  });

  it("parado menos de 5min nao retorna candidato mesmo perto", () => {
    const pos = { lat: -22.896, lng: -43.2 };
    const r = candidatoEntregaProximidade(pos, 4, [pontoBase()]);
    expect(r).toBeNull();
  });

  it("mais de 500m nao retorna candidato mesmo parado tempo suficiente", () => {
    // ~1.1km ao norte (0.01 grau ~ 1110m)
    const pos = { lat: -22.89, lng: -43.2 };
    const r = candidatoEntregaProximidade(pos, 10, [pontoBase()]);
    expect(r).toBeNull();
  });

  it("lista vazia de pendentes nao retorna candidato", () => {
    const pos = { lat: -22.896, lng: -43.2 };
    const r = candidatoEntregaProximidade(pos, 10, []);
    expect(r).toBeNull();
  });

  it("varios pendentes no raio: retorna o MAIS PROXIMO", () => {
    const pos = { lat: -22.9, lng: -43.2 };
    const longe = pontoBase({ lat: -22.9035, lng: -43.2, codigo: 1 }); // ~390m
    const perto = pontoBase({ lat: -22.901, lng: -43.2, codigo: 2 }); // ~111m
    const r = candidatoEntregaProximidade(pos, 10, [longe, perto]);
    expect(r?.codigo).toBe(2);
  });

  it("constantes exportadas batem com o design (500m, 5min)", () => {
    expect(RAIO_CONFIRMACAO_M).toBe(500);
    expect(PARADO_MIN_CONFIRMACAO).toBe(5);
  });
});
