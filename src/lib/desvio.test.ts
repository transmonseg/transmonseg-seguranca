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

  it("decai o streak em 1 (não zera) se aproximou de PELO MENOS UM destino -- achado real 13/08, distância real de rua não é perfeitamente monótona nem numa divergência real (ruído de geometria de estrada não pode apagar streak todo)", () => {
    const r = avaliarAfastandoDeTudo([1100, 900], [1000, 1000], 2);
    expect(r.streak).toBe(1);
    expect(r.disparou).toBe(false);
    expect(r.aproximandoAlgum).toBe(true);
  });

  it("decai até 0 (nunca negativo) com streak já em 0", () => {
    const r = avaliarAfastandoDeTudo([1100, 900], [1000, 1000], 0);
    expect(r.streak).toBe(0);
  });

  it("streak tolerante: sobrevive a 1 blip de ruído no meio de uma divergência real e ainda dispara", () => {
    let streak = 0;
    streak = avaliarAfastandoDeTudo([1100, 2100], [1000, 2000], streak).streak; // afasta -> 1
    expect(streak).toBe(1);
    streak = avaliarAfastandoDeTudo([1150, 2050], [1100, 2100], streak).streak; // blip: aproxima do 2º -> decai pra 0
    expect(streak).toBe(0);
    streak = avaliarAfastandoDeTudo([1250, 2150], [1150, 2050], streak).streak; // afasta de novo -> 1
    streak = avaliarAfastandoDeTudo([1350, 2250], [1250, 2150], streak).streak; // -> 2
    const r = avaliarAfastandoDeTudo([1450, 2350], [1350, 2250], streak); // -> 3, dispara
    expect(r.streak).toBe(3);
    expect(r.disparou).toBe(true);
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

  it("não acumula streak em trânsito longo (destino mais próximo além do teto) -- ruído de rodovia/alça de acesso", () => {
    // 16km e 20km de distância -- ambos além do teto de 15km, mesmo afastando dos dois.
    const r = avaliarAfastandoDeTudo([16100, 20100], [16000, 20000], 2);
    expect(r.streak).toBe(0);
    expect(r.disparou).toBe(false);
  });

  it("volta a acumular streak assim que o destino mais próximo entra no teto de trânsito", () => {
    const r = avaliarAfastandoDeTudo([14900, 20100], [14800, 20000], 2);
    expect(r.streak).toBe(3);
    expect(r.disparou).toBe(true);
  });

  it("aceita teto de trânsito customizado", () => {
    const r = avaliarAfastandoDeTudo([6000], [5000], 2, { limiarTransitoLongoM: 5500 });
    expect(r.streak).toBe(0);
    expect(r.disparou).toBe(false);
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
