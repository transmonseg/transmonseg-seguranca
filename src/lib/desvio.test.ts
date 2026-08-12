import { describe, it, expect } from "vitest";
import { avaliarAfastandoDeTudo, avaliarRuaRara, montarAlertaDesvio } from "./desvio";

describe("avaliarAfastandoDeTudo", () => {
  it("não acumula streak sem destinos (guard 0 pendentes)", () => {
    const r = avaliarAfastandoDeTudo([], [], 2);
    expect(r).toEqual({ streak: 0, disparou: false, aproximandoAlgum: false });
  });

  it("não acumula streak se o conjunto de destinos mudou de tamanho (entrega confirmada no meio do streak)", () => {
    const r = avaliarAfastandoDeTudo([1000, 2000], [900], 2);
    expect(r.streak).toBe(0);
    expect(r.disparou).toBe(false);
  });

  it("zera o streak se aproximou de PELO MENOS UM destino", () => {
    const r = avaliarAfastandoDeTudo([1100, 900], [1000, 1000], 2);
    expect(r.streak).toBe(0);
    expect(r.disparou).toBe(false);
    expect(r.aproximandoAlgum).toBe(true);
  });

  it("acumula streak quando afasta de TODOS", () => {
    const r = avaliarAfastandoDeTudo([1100, 2100], [1000, 2000], 1);
    expect(r.streak).toBe(2);
    expect(r.aproximandoAlgum).toBe(false);
    expect(r.disparou).toBe(false); // ainda não bateu o limiar (3)
  });

  it("dispara na 3a leitura seguida afastando de todos", () => {
    const r = avaliarAfastandoDeTudo([1300, 2300], [1200, 2200], 2);
    expect(r.streak).toBe(3);
    expect(r.disparou).toBe(true);
  });
});

describe("avaliarRuaRara", () => {
  it("não acumula se a célula é comum (acima do limiar de visitas)", () => {
    const r = avaliarRuaRara(50, false, 1);
    expect(r).toEqual({ streak: 0, disparou: false });
  });

  it("não acumula se está aproximando de algum destino, mesmo em célula rara", () => {
    const r = avaliarRuaRara(0, true, 1);
    expect(r.streak).toBe(0);
    expect(r.disparou).toBe(false);
  });

  it("acumula em célula rara e sem aproximar de nada", () => {
    const r = avaliarRuaRara(1, false, 0);
    expect(r.streak).toBe(1);
    expect(r.disparou).toBe(false); // limiar é 2
  });

  it("dispara na 2a leitura seguida", () => {
    const r = avaliarRuaRara(0, false, 1);
    expect(r.streak).toBe(2);
    expect(r.disparou).toBe(true);
  });
});

describe("montarAlertaDesvio", () => {
  it("retorna null se nenhum sinal disparou", () => {
    const a = montarAlertaDesvio(
      { disparou: false, streak: 0 },
      { disparou: false, streak: 0, celula: "0:0", nVisitas: 10 }
    );
    expect(a).toBeNull();
  });

  it("prioriza afastando-de-tudo quando os dois disparam no mesmo ciclo", () => {
    const a = montarAlertaDesvio(
      { disparou: true, streak: 3 },
      { disparou: true, streak: 2, celula: "0:0", nVisitas: 0 }
    );
    expect(a?.origemDesvio).toBe("afastando_geral");
  });

  it("monta alerta de rua rara com a célula e contagem no motivo", () => {
    const a = montarAlertaDesvio(
      { disparou: false, streak: 0 },
      { disparou: true, streak: 2, celula: "-22900:-43200", nVisitas: 1 }
    );
    expect(a?.tipo).toBe("desvio");
    expect(a?.origemDesvio).toBe("rua_rara_frota");
    expect(a?.motivo).toContain("-22900:-43200");
    expect(a?.motivo).toContain("1");
  });
});
