import { describe, it, expect, vi } from "vitest";
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
    expect(await deps.distanciaAoBairro(-22.811137, -43.297583, "GALEAO", "3304557")).toBe(3603);
  });

  // Fix 1 (Fase 2, 13/09): a RPC precisa receber o municipio esperado pra que
  // 083 filtre o hull por (municipio, bairro) em vez de buscar entre os 92.
  it("distanciaAoBairro repassa o municipioCodigo pra RPC como p_municipio", async () => {
    const rpc = vi.fn(async () => ({ data: 0, error: null }));
    const deps = montarDepsTerritorio({ rpc } as never);
    await deps.distanciaAoBairro(-22.9, -43.2, "CENTRO", "3304557");
    expect(rpc).toHaveBeenCalledWith("distancia_ao_bairro", {
      p_lat: -22.9,
      p_lng: -43.2,
      p_bairro: "CENTRO",
      p_municipio: "3304557",
    });
  });

  it("distanciaAoBairro repassa null pra RPC quando o municipio esperado e' desconhecido", async () => {
    const rpc = vi.fn(async () => ({ data: 0, error: null }));
    const deps = montarDepsTerritorio({ rpc } as never);
    await deps.distanciaAoBairro(-22.9, -43.2, "CENTRO", null);
    expect(rpc).toHaveBeenCalledWith("distancia_ao_bairro", {
      p_lat: -22.9,
      p_lng: -43.2,
      p_bairro: "CENTRO",
      p_municipio: null,
    });
  });

  it("distanciaAoBairro devolve 0 quando o ponto esta dentro do hull", async () => {
    const rpc = async () => ({ data: 0, error: null });
    const deps = montarDepsTerritorio({ rpc } as never);
    expect(await deps.distanciaAoBairro(-22.971177, -43.182543, "COPACABANA", "3304557")).toBe(0);
  });

  it("distanciaAoBairro devolve null quando o bairro nao existe no CNEFE", async () => {
    const rpc = async () => ({ data: null, error: null });
    const deps = montarDepsTerritorio({ rpc } as never);
    expect(await deps.distanciaAoBairro(-22.9, -43.2, "BAIRRO INEXISTENTE", "3304557")).toBeNull();
  });

  it("distanciaAoBairro devolve null quando a consulta erra -- deixa o fail-open pra validarTerritorio", async () => {
    const rpc = async () => ({ data: null, error: { message: "boom" } });
    const deps = montarDepsTerritorio({ rpc } as never);
    expect(await deps.distanciaAoBairro(-22.9, -43.2, "GALEAO", "3304557")).toBeNull();
  });
});
