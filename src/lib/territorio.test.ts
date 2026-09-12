import { describe, it, expect } from "vitest";
import { validarTerritorio, LIMIAR_DISTANCIA_BAIRRO_M } from "./territorio";

const semBairro = { municipioCodigo: "3304557", bairro: null };

describe("validarTerritorio - municipio", () => {
  it("aprova quando a coordenada cai no municipio pedido", async () => {
    const r = await validarTerritorio(
      { lat: -22.9, lng: -43.2 },
      semBairro,
      { municipioDaCoordenada: async () => "3304557", distanciaAoBairro: async () => null },
    );
    expect(r).toEqual({ ok: true });
  });

  it("reprova quando a coordenada cai em outro municipio", async () => {
    // Caso real da auditoria: endereco de Paciencia/Rio de Janeiro que foi
    // parar em Sao Goncalo (3304904), 67,7 km de distancia.
    const r = await validarTerritorio(
      { lat: -22.83, lng: -43.05 },
      semBairro,
      { municipioDaCoordenada: async () => "3304904", distanciaAoBairro: async () => null },
    );
    expect(r).toEqual({ ok: false, motivo: "municipio_divergente" });
  });

  it("aprova quando o municipio esperado nao foi resolvido -- nada pra comparar", async () => {
    // Cidade truncada/corrompida que expandirCidadeTruncada nao resolveu.
    // Sem municipioCodigo nao ha afirmacao possivel; nunca inventar suspeita.
    const r = await validarTerritorio(
      { lat: -22.9, lng: -43.2 },
      { municipioCodigo: null, bairro: null },
      { municipioDaCoordenada: async () => "3304904", distanciaAoBairro: async () => null },
    );
    expect(r).toEqual({ ok: true });
  });

  it("aprova quando a coordenada nao cai em nenhum poligono -- fora do RJ ou malha incompleta", async () => {
    const r = await validarTerritorio(
      { lat: -20.8, lng: -41.9 },
      semBairro,
      { municipioDaCoordenada: async () => null, distanciaAoBairro: async () => null },
    );
    expect(r).toEqual({ ok: true });
  });

  it("aprova quando a consulta de municipio falha -- fail-open", async () => {
    const r = await validarTerritorio(
      { lat: -22.9, lng: -43.2 },
      semBairro,
      { municipioDaCoordenada: async () => { throw new Error("banco fora"); }, distanciaAoBairro: async () => null },
    );
    expect(r).toEqual({ ok: true });
  });
});

const municipioOk = { municipioDaCoordenada: async () => "3304557" };

// Valores medidos em producao (ver migration 083 / relatorio da Task 4b):
// distancia_ao_bairro(lat, lng, bairro_normalizado).
describe("validarTerritorio - bairro (distancia ao hull cnefe_bairros)", () => {
  it("reprova o Galeao com coordenada ruim: 3603m do hull do bairro pedido", async () => {
    // Caso real: AVENIDA VINTE DE JANEIRO, S/N - GALEAO, RIO DE JANEIRO caiu em
    // -22.811137,-43.297583, medido a 3603m do hull convexo de GALEAO no CNEFE.
    // Municipio identico (3304557) -- so' o bairro diverge.
    const r = await validarTerritorio(
      { lat: -22.811137, lng: -43.297583 },
      { municipioCodigo: "3304557", bairro: "GALEAO" },
      { ...municipioOk, distanciaAoBairro: async () => 3603 },
    );
    expect(r).toEqual({ ok: false, motivo: "bairro_divergente" });
  });

  it("aprova o Galeao com coordenada boa (Estrada das Canarias): 0m do hull do bairro", async () => {
    const r = await validarTerritorio(
      { lat: -22.811147, lng: -43.227995 },
      { municipioCodigo: "3304557", bairro: "GALEAO" },
      { ...municipioOk, distanciaAoBairro: async () => 0 },
    );
    expect(r).toEqual({ ok: true });
  });

  it("aprova Copacabana: 0m do hull do bairro", async () => {
    const r = await validarTerritorio(
      { lat: -22.971177, lng: -43.182543 },
      { municipioCodigo: "3304557", bairro: "COPACABANA" },
      { ...municipioOk, distanciaAoBairro: async () => 0 },
    );
    expect(r).toEqual({ ok: true });
  });

  it("reprova quando a distancia excede o limiar calibrado", async () => {
    const r = await validarTerritorio(
      { lat: -22.8, lng: -43.2 },
      { municipioCodigo: "3304557", bairro: "GALEAO" },
      { ...municipioOk, distanciaAoBairro: async () => LIMIAR_DISTANCIA_BAIRRO_M + 1 },
    );
    expect(r).toEqual({ ok: false, motivo: "bairro_divergente" });
  });

  it("aprova quando a distancia esta exatamente no limiar ou abaixo", async () => {
    const r = await validarTerritorio(
      { lat: -22.8, lng: -43.2 },
      { municipioCodigo: "3304557", bairro: "GALEAO" },
      { ...municipioOk, distanciaAoBairro: async () => LIMIAR_DISTANCIA_BAIRRO_M },
    );
    expect(r).toEqual({ ok: true });
  });

  it("aprova quando o bairro do romaneio nao existe no CNEFE -- distancia null, nada pra comparar", async () => {
    // 942 dos 8.725 enderecos em cache tem bairro desconhecido do CNEFE.
    const r = await validarTerritorio(
      { lat: -22.9, lng: -43.2 },
      { municipioCodigo: "3304557", bairro: "BAIRRO INEXISTENTE NO CNEFE" },
      { ...municipioOk, distanciaAoBairro: async () => null },
    );
    expect(r).toEqual({ ok: true });
  });

  it("aprova quando o romaneio nao trouxe bairro", async () => {
    const r = await validarTerritorio(
      { lat: -22.9, lng: -43.2 },
      { municipioCodigo: "3304557", bairro: null },
      { ...municipioOk, distanciaAoBairro: async () => 5000 },
    );
    expect(r).toEqual({ ok: true });
  });

  it("aprova quando a consulta de distancia falha -- fail-open", async () => {
    const r = await validarTerritorio(
      { lat: -22.9, lng: -43.2 },
      { municipioCodigo: "3304557", bairro: "GALEAO" },
      { ...municipioOk, distanciaAoBairro: async () => { throw new Error("banco fora"); } },
    );
    expect(r).toEqual({ ok: true });
  });

  it("municipio divergente ganha do bairro -- sinal mais forte primeiro", async () => {
    const r = await validarTerritorio(
      { lat: -22.83, lng: -43.05 },
      { municipioCodigo: "3304557", bairro: "GALEAO" },
      {
        municipioDaCoordenada: async () => "3304904",
        distanciaAoBairro: async () => 5000,
      },
    );
    expect(r).toEqual({ ok: false, motivo: "municipio_divergente" });
  });
});
