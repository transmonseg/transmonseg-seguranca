import { describe, it, expect } from "vitest";
import { avaliarDesvioTeste, PARAMS_DESVIO_TESTE_PADRAO } from "./detectores-teste";

describe("avaliarDesvioTeste", () => {
  it("primeira leitura, sem estado anterior: nao dispara, so registra distancias", () => {
    const r = avaliarDesvioTeste({ a: 1400 }, null);
    expect(r.disparouAgora).toBe(false);
    expect(r.estado.score).toBe(0);
    expect(r.estado.distanciasAnteriores).toEqual({ a: 1400 });
  });

  it("afastamento sustentado de um unico destino dispara", () => {
    let estado = avaliarDesvioTeste({ a: 1400 }, null).estado;
    let disparou = false;
    let dist = 1400;
    for (let i = 0; i < 12 && !disparou; i++) {
      dist += 400;
      const r = avaliarDesvioTeste({ a: dist }, estado);
      estado = r.estado;
      disparou = r.disparouAgora;
    }
    expect(disparou).toBe(true);
  });

  it("passar reto por um cliente A rumo a um cliente B nao dispara (reordenar livre)", () => {
    // A cresce, B encolhe pela mesma projecao do movimento -- media
    // ponderada por proximidade deve ficar perto de zero (os dois tem
    // distancia parecida, pesos parecidos).
    let estado = avaliarDesvioTeste({ a: 150, b: 7400 }, null).estado;
    const passos = [
      { a: 3020, b: 4530 },
      { a: 4530, b: 3020 },
      { a: 6050, b: 1510 },
      { a: 7400, b: 150 },
    ];
    let disparouEmAlgumPonto = false;
    for (const passo of passos) {
      const r = avaliarDesvioTeste(passo, estado);
      estado = r.estado;
      if (r.disparouAgora) disparouEmAlgumPonto = true;
    }
    expect(disparouEmAlgumPonto).toBe(false);
  });

  it("destino que sumiu da lista (entregue) nao conta como afastamento", () => {
    const estadoComAmbos = avaliarDesvioTeste({ a: 150, b: 7400 }, null).estado;
    // A foi entregue e some da lista -- so sobra B, com a mesma
    // distancia de antes (sem delta real).
    const r = avaliarDesvioTeste({ b: 7400 }, estadoComAmbos);
    expect(r.estado.score).toBeLessThanOrEqual(estadoComAmbos.score);
  });

  it("destino visitado (dwell perto) para de contar mesmo sem sumir da lista", () => {
    let estado = avaliarDesvioTeste({ a: 90 }, null).estado;
    const r1 = avaliarDesvioTeste({ a: 80 }, estado);
    expect(r1.estado.visitados["a"]).toBe(true);
    // segue viagem, destino "visitado" fica pra tras -- nao pode contar
    // como afastamento mesmo que a distancia cresca muito
    let estado2 = r1.estado;
    let disparou = false;
    let dist = 80;
    for (let i = 0; i < 10 && !disparou; i++) {
      dist += 900;
      const r = avaliarDesvioTeste({ a: dist }, estado2);
      estado2 = r.estado;
      disparou = r.disparouAgora;
    }
    expect(disparou).toBe(false);
  });

  it("destino distante pesa quase nada -- afastar de um cliente longe nao dispara sozinho perto de outro", () => {
    // "perto" comeca a 600m (fora do raio de "visitado", 100m -- senao
    // ele sai do calculo e so sobra "longe" sozinho, o oposto do que
    // queremos testar) e vai encolhendo devagar (indo entregar), "longe"
    // fica ainda mais longe (nao e' a prioridade agora).
    let estado = avaliarDesvioTeste({ perto: 600, longe: 55000 }, null).estado;
    let disparou = false;
    let distPerto = 600, distLonge = 55000;
    for (let i = 0; i < 10 && !disparou; i++) {
      distPerto -= 20;
      distLonge += 300;
      const r = avaliarDesvioTeste({ perto: distPerto, longe: distLonge }, estado);
      estado = r.estado;
      disparou = r.disparouAgora;
    }
    expect(disparou).toBe(false);
  });

  it("PARAMS_DESVIO_TESTE_PADRAO tem todos os campos exigidos por ParametrosDesvioTeste", () => {
    expect(PARAMS_DESVIO_TESTE_PADRAO.margemRuidoM).toBeGreaterThan(0);
    expect(PARAMS_DESVIO_TESTE_PADRAO.decay).toBeGreaterThan(0);
    expect(PARAMS_DESVIO_TESTE_PADRAO.decay).toBeLessThan(1);
    expect(PARAMS_DESVIO_TESTE_PADRAO.limiar).toBeGreaterThan(0);
    expect(PARAMS_DESVIO_TESTE_PADRAO.escalaProximidadeM).toBeGreaterThan(0);
    expect(PARAMS_DESVIO_TESTE_PADRAO.raioVisitaM).toBeGreaterThan(0);
    expect(PARAMS_DESVIO_TESTE_PADRAO.contribMaxM).toBeGreaterThan(0);
  });
});
