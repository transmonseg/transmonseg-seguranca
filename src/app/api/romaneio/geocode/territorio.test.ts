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

  it("distanciaAoBairro devolve a distancia em metros ate o hull do bairro", async () => {
    const rpc = async () => ({ data: 3603, error: null });
    const deps = montarDepsTerritorio({ rpc } as never);
    expect(await deps.distanciaAoBairro(-22.811137, -43.297583, "GALEAO")).toBe(3603);
  });

  it("distanciaAoBairro devolve 0 quando o ponto esta dentro do hull", async () => {
    const rpc = async () => ({ data: 0, error: null });
    const deps = montarDepsTerritorio({ rpc } as never);
    expect(await deps.distanciaAoBairro(-22.971177, -43.182543, "COPACABANA")).toBe(0);
  });

  it("distanciaAoBairro devolve null quando o bairro nao existe no CNEFE", async () => {
    const rpc = async () => ({ data: null, error: null });
    const deps = montarDepsTerritorio({ rpc } as never);
    expect(await deps.distanciaAoBairro(-22.9, -43.2, "BAIRRO INEXISTENTE")).toBeNull();
  });

  it("distanciaAoBairro devolve null quando a consulta erra -- deixa o fail-open pra validarTerritorio", async () => {
    const rpc = async () => ({ data: null, error: { message: "boom" } });
    const deps = montarDepsTerritorio({ rpc } as never);
    expect(await deps.distanciaAoBairro(-22.9, -43.2, "GALEAO")).toBeNull();
  });
});
