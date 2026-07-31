import { describe, it, expect, vi } from "vitest";
import { normalizarEndereco, geocodificarEndereco, geocodificarLocal, geocodificarCnefe } from "./romaneio-geocode";

describe("normalizarEndereco", () => {
  it("maiuscula, sem espacos duplicados, sem espaco nas pontas", () => {
    expect(normalizarEndereco("  rua  teste,  10 - centro  ")).toBe("RUA TESTE, 10 - CENTRO");
  });
});

describe("geocodificarEndereco (fallback: cache -> cnefe -> local -> google -> nominatim -- SEM fallback pra Unitrac de proposito, ver achado real 15/07)", () => {
  const mockDeps = (overrides: Partial<{
    buscarCache: () => Promise<{ lat: number; lng: number; fonte: string } | null>;
    salvarCache: () => Promise<void>;
    geocodificarCnefeDep: () => Promise<{ lat: number; lng: number } | null>;
    geocodificarLocalDep: () => Promise<{ lat: number; lng: number } | null>;
    geocodificarGoogle: () => Promise<{ lat: number; lng: number } | null>;
    geocodificarNominatim: () => Promise<{ lat: number; lng: number } | null>;
  }> = {}) => ({
    buscarCache: vi.fn(overrides.buscarCache ?? (async () => null)),
    salvarCache: vi.fn(overrides.salvarCache ?? (async () => {})),
    geocodificarCnefeDep: vi.fn(overrides.geocodificarCnefeDep ?? (async () => null)),
    geocodificarLocalDep: vi.fn(overrides.geocodificarLocalDep ?? (async () => null)),
    geocodificarGoogle: vi.fn(overrides.geocodificarGoogle ?? (async () => null)),
    geocodificarNominatim: vi.fn(overrides.geocodificarNominatim ?? (async () => null)),
  });

  it("cache hit: nao chama nenhuma API", async () => {
    const deps = mockDeps({ buscarCache: async () => ({ lat: 1, lng: 2, fonte: "google" }) });
    const r = await geocodificarEndereco("Rua X, 1", null, deps);
    expect(r).toEqual({ lat: 1, lng: 2, fonte: "google" });
    expect(deps.geocodificarCnefeDep).not.toHaveBeenCalled();
    expect(deps.geocodificarLocalDep).not.toHaveBeenCalled();
    expect(deps.geocodificarGoogle).not.toHaveBeenCalled();
    expect(deps.geocodificarNominatim).not.toHaveBeenCalled();
  });

  it("cache miss, CNEFE funciona: usa CNEFE e salva no cache, nao chama local/Google/Nominatim -- achado real 31/07, CNEFE roda primeiro por ser mais preciso", async () => {
    const deps = mockDeps({ geocodificarCnefeDep: async () => ({ lat: 9, lng: 10 }) });
    const r = await geocodificarEndereco("Rua X, 1", null, deps);
    expect(r).toEqual({ lat: 9, lng: 10, fonte: "cnefe" });
    expect(deps.salvarCache).toHaveBeenCalledWith(expect.any(String), { lat: 9, lng: 10, fonte: "cnefe" });
    expect(deps.geocodificarLocalDep).not.toHaveBeenCalled();
    expect(deps.geocodificarGoogle).not.toHaveBeenCalled();
    expect(deps.geocodificarNominatim).not.toHaveBeenCalled();
  });

  it("CNEFE falha, local funciona: usa local e salva no cache", async () => {
    const deps = mockDeps({ geocodificarLocalDep: async () => ({ lat: 7, lng: 8 }) });
    const r = await geocodificarEndereco("Rua X, 1", null, deps);
    expect(r).toEqual({ lat: 7, lng: 8, fonte: "local" });
    expect(deps.salvarCache).toHaveBeenCalledWith(expect.any(String), { lat: 7, lng: 8, fonte: "local" });
    expect(deps.geocodificarGoogle).not.toHaveBeenCalled();
    expect(deps.geocodificarNominatim).not.toHaveBeenCalled();
  });

  it("CNEFE e local falham, Google funciona: usa Google e salva no cache", async () => {
    const deps = mockDeps({ geocodificarGoogle: async () => ({ lat: 3, lng: 4 }) });
    const r = await geocodificarEndereco("Rua X, 1", null, deps);
    expect(r).toEqual({ lat: 3, lng: 4, fonte: "google" });
    expect(deps.salvarCache).toHaveBeenCalledWith(expect.any(String), { lat: 3, lng: 4, fonte: "google" });
    expect(deps.geocodificarNominatim).not.toHaveBeenCalled();
  });

  it("CNEFE, local e Google falham, Nominatim funciona: usa Nominatim e salva no cache", async () => {
    const deps = mockDeps({ geocodificarNominatim: async () => ({ lat: 5, lng: 6 }) });
    const r = await geocodificarEndereco("Rua X, 1", null, deps);
    expect(r).toEqual({ lat: 5, lng: 6, fonte: "nominatim" });
  });

  it("todas as fontes falham: null (NUNCA cai pra coordenada da Unitrac -- decisao explicita do usuario, o ponto todo do romaneio e nao reusar coordenada que pode estar errada)", async () => {
    const deps = mockDeps();
    const r = await geocodificarEndereco("Rua X, 1", null, deps);
    expect(r).toBeNull();
  });

  it("Google/Nominatim recebem o endereco LIMPO (sem sufixo de complemento, cidade expandida) -- achado real 31/07, ver montarEnderecoParaGeocode", async () => {
    const deps = mockDeps({ geocodificarGoogle: async () => ({ lat: 3, lng: 4 }) });
    await geocodificarEndereco("RUA RESENDE, 358 - FLUMINENSE, SAO PEDRO DA AL - LOJA 02", null, deps);
    expect(deps.geocodificarGoogle).toHaveBeenCalledWith("RUA RESENDE, 358, FLUMINENSE, São Pedro da Aldeia, RJ, Brasil");
  });

  it("geocodificarCnefeDep e geocodificarLocalDep continuam recebendo o enderecoBruto ORIGINAL (parsing de rua nao e afetado pelo sufixo)", async () => {
    const deps = mockDeps({ geocodificarLocalDep: async () => ({ lat: 7, lng: 8 }) });
    const enderecoOriginal = "RUA RESENDE, 358 - FLUMINENSE, SAO PEDRO DA AL - LOJA 02";
    await geocodificarEndereco(enderecoOriginal, null, deps);
    expect(deps.geocodificarCnefeDep).toHaveBeenCalledWith(enderecoOriginal, null);
    expect(deps.geocodificarLocalDep).toHaveBeenCalledWith(enderecoOriginal, null);
  });
});

describe("geocodificarCnefe (IBGE, achado real 31/07 -- ver migration contabo/022_cnefe_enderecos.sql)", () => {
  const mockDeps = (overrides: Partial<{
    buscarPorRuaNumero: () => Promise<{ lat: number; lng: number }[]>;
    buscarPorRua: () => Promise<{ lat: number; lng: number }[]>;
    buscarPorSimilaridade: () => Promise<{ lat: number; lng: number }[]>;
  }> = {}) => ({
    buscarPorRuaNumero: vi.fn(overrides.buscarPorRuaNumero ?? (async () => [])),
    buscarPorRua: vi.fn(overrides.buscarPorRua ?? (async () => [])),
    buscarPorSimilaridade: vi.fn(overrides.buscarPorSimilaridade ?? (async () => [])),
  });

  it("sem candidato em nenhum nivel: null", async () => {
    const deps = mockDeps();
    const r = await geocodificarCnefe("RUA X, 10 - BAIRRO, CIDADE - *", null, deps);
    expect(r).toBeNull();
  });

  it("bate por rua+numero exato: usa esse resultado, nao chega a buscar so por rua nem por similaridade", async () => {
    const deps = mockDeps({ buscarPorRuaNumero: async () => [{ lat: 1, lng: 2 }] });
    const r = await geocodificarCnefe("RUA X, 10 - BAIRRO, CIDADE - *", null, deps);
    expect(r).toEqual({ lat: 1, lng: 2 });
    expect(deps.buscarPorRua).not.toHaveBeenCalled();
    expect(deps.buscarPorSimilaridade).not.toHaveBeenCalled();
  });

  it("rua+numero nao bate, cai pra so rua: nao chega a buscar por similaridade", async () => {
    const deps = mockDeps({ buscarPorRua: async () => [{ lat: 3, lng: 4 }] });
    const r = await geocodificarCnefe("RUA X, 10 - BAIRRO, CIDADE - *", null, deps);
    expect(r).toEqual({ lat: 3, lng: 4 });
    expect(deps.buscarPorSimilaridade).not.toHaveBeenCalled();
  });

  it("rua+numero e so-rua nao batem, cai pra similaridade (pg_trgm)", async () => {
    const deps = mockDeps({ buscarPorSimilaridade: async () => [{ lat: 5, lng: 6 }] });
    const r = await geocodificarCnefe("RUA X, 10 - BAIRRO, CIDADE - *", null, deps);
    expect(r).toEqual({ lat: 5, lng: 6 });
  });

  it("numero S/N: nao tenta buscar por rua+numero, vai direto pra so-rua", async () => {
    const deps = mockDeps({ buscarPorRua: async () => [{ lat: 3, lng: 4 }] });
    const r = await geocodificarCnefe("RUA X, S/N - BAIRRO, CIDADE - *", null, deps);
    expect(r).toEqual({ lat: 3, lng: 4 });
    expect(deps.buscarPorRuaNumero).not.toHaveBeenCalled();
  });

  it("multiplos candidatos: escolhe o mais proximo do ponto de cidade (mesma logica de geocodificarLocal)", async () => {
    const pontoCidade = { lat: -21.05, lng: -41.98 };
    const candidatos = [
      { lat: -22.9, lng: -43.2 },
      { lat: -21.06, lng: -41.97 },
    ];
    const deps = mockDeps({ buscarPorRua: async () => candidatos });
    const r = await geocodificarCnefe("RUA X, 10 - BAIRRO, CIDADE - *", pontoCidade, deps);
    expect(r).toEqual(candidatos[1]);
  });
});

describe("geocodificarLocal", () => {
  it("sem candidatos: retorna null", async () => {
    const buscar = vi.fn().mockResolvedValue([]);
    const r = await geocodificarLocal("RUA X, 10 - BAIRRO, CIDADE - *", null, buscar);
    expect(r).toBeNull();
  });

  it("um candidato, sem ponto de cidade: retorna o candidato direto", async () => {
    const buscar = vi.fn().mockResolvedValue([{ lat: -21.05, lng: -41.98 }]);
    const r = await geocodificarLocal("RUA X, 10 - BAIRRO, CIDADE - *", null, buscar);
    expect(r).toEqual({ lat: -21.05, lng: -41.98 });
  });

  it("multiplos candidatos: escolhe o mais proximo do ponto de cidade", async () => {
    const pontoCidade = { lat: -21.05, lng: -41.98 }; // Natividade aprox.
    const candidatos = [
      { lat: -22.9, lng: -43.2 }, // longe (RJ capital)
      { lat: -21.06, lng: -41.97 }, // perto de Natividade
    ];
    const buscar = vi.fn().mockResolvedValue(candidatos);
    const r = await geocodificarLocal("RUA X, 10 - BAIRRO, CIDADE - *", pontoCidade, buscar);
    expect(r).toEqual(candidatos[1]);
  });

  it("candidato UNICO muito longe do ponto de cidade: rejeitado (retorna null)", async () => {
    // Cobre o caso descoberto na Task 5 desta feature: nome de cidade pode
    // ser ambiguo (ex.: "Natividade" existe no RJ e no Tocantins) -- se a
    // cidade resolvida for a errada, ate um candidato UNICO (sem nenhuma
    // ambiguidade de nome) pode estar a milhares de km do ponto de
    // referencia. Por isso a checagem de distancia se aplica tambem com 1
    // so candidato quando ha pontoCidade -- desvio deliberado da spec
    // original (ver comentario de geocodificarLocal em romaneio-geocode.ts).
    const pontoCidade = { lat: -21.05, lng: -41.98 }; // Natividade/RJ aprox.
    const candidatos = [
      { lat: -23.5, lng: -46.6 }, // Sao Paulo -- so 1 candidato, mas MUITO longe
    ];
    const buscar = vi.fn().mockResolvedValue(candidatos);
    const r = await geocodificarLocal("RUA X, 10 - BAIRRO, CIDADE - *", pontoCidade, buscar);
    expect(r).toBeNull();
  });

  it("MULTIPLOS candidatos, todos longe do ponto de cidade: rejeitado (retorna null)", async () => {
    const pontoCidade = { lat: -21.05, lng: -41.98 }; // Natividade aprox.
    const candidatos = [
      { lat: -22.9, lng: -43.2 }, // RJ capital, ~250km+ de distancia
      { lat: -23.5, lng: -46.6 }, // Sao Paulo, MUITO mais longe ainda
    ];
    const buscar = vi.fn().mockResolvedValue(candidatos);
    const r = await geocodificarLocal("RUA X, 10 - BAIRRO, CIDADE - *", pontoCidade, buscar);
    expect(r).toBeNull();
  });
});
