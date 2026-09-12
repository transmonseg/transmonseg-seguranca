import { describe, it, expect } from "vitest";
import { validarTerritorio, RAIO_MAXIMO_VIZINHO_CNEFE_M } from "./territorio";

const semBairro = { municipioCodigo: "3304557", bairro: null };

describe("validarTerritorio - municipio", () => {
  it("aprova quando a coordenada cai no municipio pedido", async () => {
    const r = await validarTerritorio(
      { lat: -22.9, lng: -43.2 },
      semBairro,
      { municipioDaCoordenada: async () => "3304557", bairroDaCoordenada: async () => null },
    );
    expect(r).toEqual({ ok: true });
  });

  it("reprova quando a coordenada cai em outro municipio", async () => {
    // Caso real da auditoria: endereco de Paciencia/Rio de Janeiro que foi
    // parar em Sao Goncalo (3304904), 67,7 km de distancia.
    const r = await validarTerritorio(
      { lat: -22.83, lng: -43.05 },
      semBairro,
      { municipioDaCoordenada: async () => "3304904", bairroDaCoordenada: async () => null },
    );
    expect(r).toEqual({ ok: false, motivo: "municipio_divergente" });
  });

  it("aprova quando o municipio esperado nao foi resolvido -- nada pra comparar", async () => {
    // Cidade truncada/corrompida que expandirCidadeTruncada nao resolveu.
    // Sem municipioCodigo nao ha afirmacao possivel; nunca inventar suspeita.
    const r = await validarTerritorio(
      { lat: -22.9, lng: -43.2 },
      { municipioCodigo: null, bairro: null },
      { municipioDaCoordenada: async () => "3304904", bairroDaCoordenada: async () => null },
    );
    expect(r).toEqual({ ok: true });
  });

  it("aprova quando a coordenada nao cai em nenhum poligono -- fora do RJ ou malha incompleta", async () => {
    const r = await validarTerritorio(
      { lat: -20.8, lng: -41.9 },
      semBairro,
      { municipioDaCoordenada: async () => null, bairroDaCoordenada: async () => null },
    );
    expect(r).toEqual({ ok: true });
  });

  it("aprova quando a consulta de municipio falha -- fail-open", async () => {
    const r = await validarTerritorio(
      { lat: -22.9, lng: -43.2 },
      semBairro,
      { municipioDaCoordenada: async () => { throw new Error("banco fora"); }, bairroDaCoordenada: async () => null },
    );
    expect(r).toEqual({ ok: true });
  });
});

const municipioOk = { municipioDaCoordenada: async () => "3304557" };

describe("validarTerritorio - bairro", () => {
  it("reprova o caso Galeao: municipio certo, bairro errado", async () => {
    // Caso real: AVENIDA VINTE DE JANEIRO, S/N - GALEAO, RIO DE JANEIRO caiu em
    // -22.811137,-43.297583, cujo vizinho CNEFE a 0m tem localidade PARADA DE
    // LUCAS. Municipio identico (3304557), 5.014m do endereco real.
    const r = await validarTerritorio(
      { lat: -22.811137, lng: -43.297583 },
      { municipioCodigo: "3304557", bairro: "GALEAO" },
      { ...municipioOk, bairroDaCoordenada: async () => ({ localidade: "PARADA DE LUCAS", distanciaM: 0 }) },
    );
    expect(r).toEqual({ ok: false, motivo: "bairro_divergente" });
  });

  it("aprova quando o bairro bate", async () => {
    const r = await validarTerritorio(
      { lat: -22.811, lng: -43.228 },
      { municipioCodigo: "3304557", bairro: "GALEAO" },
      { ...municipioOk, bairroDaCoordenada: async () => ({ localidade: "GALEAO", distanciaM: 40 }) },
    );
    expect(r).toEqual({ ok: true });
  });

  it("aprova ignorando acento e caixa", async () => {
    const r = await validarTerritorio(
      { lat: -22.8, lng: -43.2 },
      { municipioCodigo: "3304557", bairro: "JARDIM GUANABARA" },
      { ...municipioOk, bairroDaCoordenada: async () => ({ localidade: "Jardim Guanabará", distanciaM: 50 }) },
    );
    expect(r).toEqual({ ok: true });
  });

  it("aprova quando o vizinho CNEFE esta longe demais pra julgar", async () => {
    // Area rural sem cobertura CNEFE densa: o vizinho mais proximo pode ser de
    // outro bairro so' por ser o unico ponto cadastrado na regiao.
    const r = await validarTerritorio(
      { lat: -22.1, lng: -41.4 },
      { municipioCodigo: "3304557", bairro: "GALEAO" },
      { ...municipioOk, bairroDaCoordenada: async () => ({ localidade: "OUTRO", distanciaM: RAIO_MAXIMO_VIZINHO_CNEFE_M + 1 }) },
    );
    expect(r).toEqual({ ok: true });
  });

  it("aprova quando o romaneio nao trouxe bairro", async () => {
    const r = await validarTerritorio(
      { lat: -22.9, lng: -43.2 },
      { municipioCodigo: "3304557", bairro: null },
      { ...municipioOk, bairroDaCoordenada: async () => ({ localidade: "QUALQUER", distanciaM: 10 }) },
    );
    expect(r).toEqual({ ok: true });
  });

  it("aprova quando nao ha vizinho CNEFE nenhum", async () => {
    const r = await validarTerritorio(
      { lat: -22.9, lng: -43.2 },
      { municipioCodigo: "3304557", bairro: "GALEAO" },
      { ...municipioOk, bairroDaCoordenada: async () => null },
    );
    expect(r).toEqual({ ok: true });
  });

  it("aprova quando a consulta de bairro falha -- fail-open", async () => {
    const r = await validarTerritorio(
      { lat: -22.9, lng: -43.2 },
      { municipioCodigo: "3304557", bairro: "GALEAO" },
      { ...municipioOk, bairroDaCoordenada: async () => { throw new Error("banco fora"); } },
    );
    expect(r).toEqual({ ok: true });
  });

  it("municipio divergente ganha do bairro -- sinal mais forte primeiro", async () => {
    const r = await validarTerritorio(
      { lat: -22.83, lng: -43.05 },
      { municipioCodigo: "3304557", bairro: "GALEAO" },
      {
        municipioDaCoordenada: async () => "3304904",
        bairroDaCoordenada: async () => ({ localidade: "OUTRO", distanciaM: 10 }),
      },
    );
    expect(r).toEqual({ ok: false, motivo: "municipio_divergente" });
  });
});
