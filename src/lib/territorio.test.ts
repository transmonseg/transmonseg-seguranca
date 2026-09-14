import { describe, it, expect, vi } from "vitest";
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

  // Fix 2 (Fase 2, 13/09): fail-open silencioso ja escondeu 3 quebras reais
  // no dia (deps orfa, RPC ambigua). Manter fail-open, mas a aprovacao por
  // excecao precisa ser audivel -- console.error nomeando a consulta e o
  // erro. Isso NUNCA pode disparar quando a resposta e' so' "sem dado"
  // (esperado, comum, 942 enderecos) -- so' quando a consulta de fato falhou.
  it("consulta de municipio falhando: loga console.error nomeando a consulta e o erro (audivel, nao so' fail-open)", async () => {
    const erroSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    await validarTerritorio(
      { lat: -22.9, lng: -43.2 },
      semBairro,
      { municipioDaCoordenada: async () => { throw new Error("banco fora"); }, distanciaAoBairro: async () => null },
    );
    expect(erroSpy).toHaveBeenCalledTimes(1);
    const [msg, err] = erroSpy.mock.calls[0];
    expect(String(msg)).toMatch(/municipioDaCoordenada/);
    expect(err).toBeInstanceOf(Error);
    expect((err as Error).message).toBe("banco fora");
    erroSpy.mockRestore();
  });

  it("municipio nao resolvido (sem poligono, resposta normal) NAO loga -- fail-open silencioso continua igual", async () => {
    const erroSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    await validarTerritorio(
      { lat: -20.8, lng: -41.9 },
      semBairro,
      { municipioDaCoordenada: async () => null, distanciaAoBairro: async () => null },
    );
    expect(erroSpy).not.toHaveBeenCalled();
    erroSpy.mockRestore();
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

  it("consulta de distancia falhando: loga console.error nomeando a consulta e o erro", async () => {
    const erroSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    await validarTerritorio(
      { lat: -22.9, lng: -43.2 },
      { municipioCodigo: "3304557", bairro: "GALEAO" },
      { ...municipioOk, distanciaAoBairro: async () => { throw new Error("banco fora"); } },
    );
    expect(erroSpy).toHaveBeenCalledTimes(1);
    const [msg, err] = erroSpy.mock.calls[0];
    expect(String(msg)).toMatch(/distanciaAoBairro/);
    expect(err).toBeInstanceOf(Error);
    expect((err as Error).message).toBe("banco fora");
    erroSpy.mockRestore();
  });

  it("bairro genuinamente ausente do CNEFE (distancia null, resposta normal) NAO loga -- e' o caso esperado dos 942", async () => {
    const erroSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    await validarTerritorio(
      { lat: -22.9, lng: -43.2 },
      { municipioCodigo: "3304557", bairro: "BAIRRO INEXISTENTE NO CNEFE" },
      { ...municipioOk, distanciaAoBairro: async () => null },
    );
    expect(erroSpy).not.toHaveBeenCalled();
    erroSpy.mockRestore();
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

  // Fix 1 (Fase 2, 13/09): distancia_ao_bairro media a distancia ao hull mais
  // proximo entre os 92 municipios, ignorando o municipio esperado pelo
  // romaneio -- pra bairros homonimos (CENTRO em 92, BOA VISTA em 29) a
  // checagem virava quase um no-op. validarTerritorio precisa repassar o
  // municipioCodigo esperado pra deps.distanciaAoBairro, pra que o hull seja
  // buscado dentro do municipio certo.
  it("repassa o municipioCodigo esperado pra deps.distanciaAoBairro", async () => {
    const distanciaAoBairro = vi.fn(async () => 0);
    await validarTerritorio(
      { lat: -22.9, lng: -43.2 },
      { municipioCodigo: "3304557", bairro: "CENTRO" },
      { ...municipioOk, distanciaAoBairro },
    );
    expect(distanciaAoBairro).toHaveBeenCalledWith(-22.9, -43.2, "CENTRO", "3304557");
  });

  it("repassa null pra deps.distanciaAoBairro quando o municipio esperado e' desconhecido -- mantem busca em todos, fail-open", async () => {
    const distanciaAoBairro = vi.fn(async () => 0);
    await validarTerritorio(
      { lat: -22.9, lng: -43.2 },
      { municipioCodigo: null, bairro: "CENTRO" },
      { municipioDaCoordenada: async () => null, distanciaAoBairro },
    );
    expect(distanciaAoBairro).toHaveBeenCalledWith(-22.9, -43.2, "CENTRO", null);
  });
});
