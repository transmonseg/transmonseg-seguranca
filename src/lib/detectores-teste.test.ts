import { describe, it, expect } from "vitest";
import { avaliarDesvioTeste, PARAMS_DESVIO_TESTE_PADRAO } from "./detectores-teste";

describe("avaliarDesvioTeste", () => {
  it("primeira leitura, sem estado anterior: nao dispara, so registra distancias", () => {
    const r = avaliarDesvioTeste(
      { lat: -22.9, lng: -43.2 },
      [{ id: "a", lat: -22.91, lng: -43.21 }],
      null
    );
    expect(r.disparouAgora).toBe(false);
    expect(r.estado.score).toBe(0);
    expect(Object.keys(r.estado.distanciasAnteriores)).toContain("a");
  });

  it("afastamento sustentado de um unico destino dispara", () => {
    const destino = { id: "a", lat: -22.9, lng: -43.2 };
    let estado = avaliarDesvioTeste({ lat: -22.91, lng: -43.21 }, [destino], null).estado;
    let disparou = false;
    for (let i = 0; i < 12 && !disparou; i++) {
      const extra = 0.01 * (i + 1);
      const r = avaliarDesvioTeste({ lat: -22.91 - extra, lng: -43.21 - extra }, [destino], estado);
      estado = r.estado;
      disparou = r.disparouAgora;
    }
    expect(disparou).toBe(true);
  });

  it("passar reto por um cliente A rumo a um cliente B nao dispara (reordenar livre)", () => {
    const destinoA = { id: "a", lat: -22.9, lng: -43.2 };
    const destinoB = { id: "b", lat: -22.95, lng: -43.25 };
    let estado = avaliarDesvioTeste({ lat: -22.901, lng: -43.201 }, [destinoA, destinoB], null).estado;
    const trajeto = [
      { lat: -22.92, lng: -43.22 },
      { lat: -22.93, lng: -43.23 },
      { lat: -22.94, lng: -43.24 },
      { lat: -22.949, lng: -43.249 },
    ];
    let disparouEmAlgumPonto = false;
    for (const pos of trajeto) {
      const r = avaliarDesvioTeste(pos, [destinoA, destinoB], estado);
      estado = r.estado;
      if (r.disparouAgora) disparouEmAlgumPonto = true;
    }
    expect(disparouEmAlgumPonto).toBe(false);
  });

  it("destino que sumiu da lista (entregue) nao conta como afastamento", () => {
    const destinoA = { id: "a", lat: -22.9, lng: -43.2 };
    const destinoB = { id: "b", lat: -22.95, lng: -43.25 };
    const estadoComAmbos = avaliarDesvioTeste(
      { lat: -22.901, lng: -43.201 },
      [destinoA, destinoB],
      null
    ).estado;
    // A foi entregue e some da lista -- so sobra B, bem mais longe.
    // O delta de B nao pode contar (nao existia antes com essa distancia
    // conhecida de um ciclo imediatamente anterior a este).
    const r = avaliarDesvioTeste({ lat: -22.901, lng: -43.201 }, [destinoB], estadoComAmbos);
    expect(r.estado.score).toBeLessThanOrEqual(estadoComAmbos.score);
  });

  it("PARAMS_DESVIO_TESTE_PADRAO tem todos os campos exigidos por ParametrosDesvioTeste", () => {
    expect(PARAMS_DESVIO_TESTE_PADRAO.margemRuidoM).toBeGreaterThan(0);
    expect(PARAMS_DESVIO_TESTE_PADRAO.decay).toBeGreaterThan(0);
    expect(PARAMS_DESVIO_TESTE_PADRAO.decay).toBeLessThan(1);
    expect(PARAMS_DESVIO_TESTE_PADRAO.limiar).toBeGreaterThan(0);
    expect(PARAMS_DESVIO_TESTE_PADRAO.proximidadeMaxM).toBeGreaterThan(PARAMS_DESVIO_TESTE_PADRAO.proximidadeMinM);
    expect(PARAMS_DESVIO_TESTE_PADRAO.contribMaxM).toBeGreaterThan(0);
  });
});
