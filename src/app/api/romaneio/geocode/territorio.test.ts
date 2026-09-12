import { describe, it, expect } from "vitest";
import { montarDepsTerritorio } from "./territorio-deps";

describe("montarDepsTerritorio", () => {
  it("municipioDaCoordenada devolve o codigo do poligono que contem o ponto", async () => {
    const rpc = async () => ({ data: [{ municipio_codigo: "3304557" }], error: null });
    const deps = montarDepsTerritorio({ rpc } as never);
    expect(await deps.municipioDaCoordenada(-22.9, -43.2)).toBe("3304557");
  });

  it("municipioDaCoordenada devolve null quando nenhum poligono contem o ponto", async () => {
    const rpc = async () => ({ data: [], error: null });
    const deps = montarDepsTerritorio({ rpc } as never);
    expect(await deps.municipioDaCoordenada(-20.8, -41.9)).toBeNull();
  });

  it("municipioDaCoordenada devolve null quando a consulta erra -- deixa o fail-open pra validarTerritorio", async () => {
    const rpc = async () => ({ data: null, error: { message: "boom" } });
    const deps = montarDepsTerritorio({ rpc } as never);
    expect(await deps.municipioDaCoordenada(-22.9, -43.2)).toBeNull();
  });

  it("bairroDaCoordenada devolve localidade e distancia do vizinho mais proximo", async () => {
    const rpc = async () => ({ data: [{ localidade: "PARADA DE LUCAS", distancia_m: 0 }], error: null });
    const deps = montarDepsTerritorio({ rpc } as never);
    expect(await deps.bairroDaCoordenada(-22.811137, -43.297583)).toEqual({
      localidade: "PARADA DE LUCAS",
      distanciaM: 0,
    });
  });

  it("bairroDaCoordenada devolve null quando nao ha vizinho", async () => {
    const rpc = async () => ({ data: [], error: null });
    const deps = montarDepsTerritorio({ rpc } as never);
    expect(await deps.bairroDaCoordenada(-22.9, -43.2)).toBeNull();
  });
});
