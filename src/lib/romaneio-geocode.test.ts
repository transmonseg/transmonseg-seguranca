import { describe, it, expect, vi, afterEach } from "vitest";
import { normalizarEndereco, geocodificarEndereco, geocodificarLocal, geocodificarCnefe, geocodificarNominatim, escolherPontoReferencia } from "./romaneio-geocode";

describe("normalizarEndereco", () => {
  it("maiuscula, sem espacos duplicados, sem espaco nas pontas", () => {
    expect(normalizarEndereco("  rua  teste,  10 - centro  ")).toBe("RUA TESTE, 10 - CENTRO");
  });

  // Desde a migration 069 esta funcao produz o endereco_chave de
  // romaneio_cliente_codigo_geocode -- e scripts/confirmar-presenca-romaneio.mjs
  // escreve na MESMA linha com uma copia da funcao (roda fora do Next.js,
  // nao consegue importar src/lib/*.ts). Se as duas divergirem, os dois
  // lados passam a gravar linhas distintas pro mesmo endereco (cache que
  // nunca acerta). Este teste trava as duas implementacoes juntas.
  it("bate com normalizarEnderecoChave do script de confirmacao de presenca (migration 069)", async () => {
    const { normalizarEnderecoChave } = await import("../../scripts/confirmar-presenca-romaneio.mjs");
    const amostras = [
      "  rua  teste,  10 - centro  ",
      "RUA FREI CANECA, 08 - CENTRO, RIO DE JANEIRO - HEMORIO",
      "AVENIDA JOÃO XXIII , 2891 - SANTA CRUZ, RIO DE JANEIRO - 668 TERNIUM BRASIL",
      "ESTRDA RIO PEQUENO, 656 - TAQUARA, RIO DE JANEIRO - HOSPITAL ESTADUAL SANTA MARIA",
      "rodovia\tpresidente  dutra , 4674 - jardim josé bonifácio\n",
    ];
    for (const a of amostras) expect(normalizarEnderecoChave(a)).toBe(normalizarEndereco(a));
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

  // Achado real 12/08: CNEFE/local ja tinham checagem de distancia contra
  // o ponto de referencia (escolherCandidatoMaisProximo, teto de 30km) --
  // Google/Nominatim NUNCA tiveram essa protecao, aceitavam qualquer
  // resultado direto. Ver docs/superpowers/specs/2026-08-12-precisao-geocodificacao-romaneio-design.md.
  describe("teto de distancia contra o ponto de referencia -- Google/Nominatim (achado real 12/08)", () => {
    const pontoCidade = { lat: -22.9, lng: -43.2 };
    const pertoDoPontoCidade = { lat: -22.91, lng: -43.21 }; // ~1.5km
    const longeDoPontoCidade = { lat: -21.7, lng: -41.03 }; // ~270km (caso real: Grussai geocodificado no Rio)

    it("Google longe do ponto de referencia: rejeita, cai pra Nominatim", async () => {
      const deps = mockDeps({
        geocodificarGoogle: async () => longeDoPontoCidade,
        geocodificarNominatim: async () => pertoDoPontoCidade,
      });
      const r = await geocodificarEndereco("Rua X, 1 - Bairro, Cidade - *", pontoCidade, deps);
      expect(r).toEqual({ ...pertoDoPontoCidade, fonte: "nominatim" });
    });

    it("Google perto do ponto de referencia: aceita normalmente", async () => {
      const deps = mockDeps({ geocodificarGoogle: async () => pertoDoPontoCidade });
      const r = await geocodificarEndereco("Rua X, 1 - Bairro, Cidade - *", pontoCidade, deps);
      expect(r).toEqual({ ...pertoDoPontoCidade, fonte: "google" });
    });

    it("Nominatim longe do ponto de referencia (ultima fonte da cadeia): rejeita, resultado final e' null", async () => {
      const deps = mockDeps({ geocodificarNominatim: async () => longeDoPontoCidade });
      const r = await geocodificarEndereco("Rua X, 1 - Bairro, Cidade - *", pontoCidade, deps);
      expect(r).toBeNull();
      expect(deps.salvarCache).not.toHaveBeenCalled();
    });

    it("sem ponto de referencia (null): aceita qualquer resultado, sem checagem -- comportamento de hoje preservado", async () => {
      const deps = mockDeps({ geocodificarGoogle: async () => longeDoPontoCidade });
      const r = await geocodificarEndereco("Rua X, 1 - Bairro, Cidade - *", null, deps);
      expect(r).toEqual({ ...longeDoPontoCidade, fonte: "google" });
    });
  });

  // Item 4 da blindagem de geocodificacao (27/08): esse caminho era 100%
  // silencioso -- resultado aceito sem NENHUMA validacao de distancia (nao
  // ha ponto de referencia contra o que comparar) e sem nenhum rastro no
  // log. E' o cenario que precisa de olho humano quando acontece muito.
  describe("aviso quando CNEFE/OSM resolvem SEM ponto de referencia de cidade (item 4)", () => {
    const pontoCidade = { lat: -22.9, lng: -43.2 };

    // O spy de console.warn e' global -- sem restaurar, as chamadas de um
    // teste vazam pra contagem do seguinte.
    afterEach(() => { vi.restoreAllMocks(); });

    it("CNEFE sem ponto de referencia: avisa, mas NAO bloqueia o resultado", async () => {
      const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
      const deps = mockDeps({ geocodificarCnefeDep: async () => ({ lat: 1, lng: 2 }) });
      const r = await geocodificarEndereco("Rua X, 1 - Bairro, Cidade - *", null, deps);
      expect(r).toEqual({ lat: 1, lng: 2, fonte: "cnefe" });
      expect(warn).toHaveBeenCalledTimes(1);
      expect(warn.mock.calls[0][0]).toContain("SEM ponto de referencia");
      expect(warn.mock.calls[0][0]).toContain("fonte=cnefe");
    });

    it("OSM/local sem ponto de referencia: avisa, mas NAO bloqueia o resultado", async () => {
      const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
      const deps = mockDeps({ geocodificarLocalDep: async () => ({ lat: 1, lng: 2 }) });
      const r = await geocodificarEndereco("Rua X, 1 - Bairro, Cidade - *", null, deps);
      expect(r).toEqual({ lat: 1, lng: 2, fonte: "local" });
      expect(warn).toHaveBeenCalledTimes(1);
      expect(warn.mock.calls[0][0]).toContain("fonte=local");
    });

    it("COM ponto de referencia: nao avisa (a validacao de distancia rodou)", async () => {
      const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
      const deps = mockDeps({ geocodificarCnefeDep: async () => ({ lat: 1, lng: 2 }) });
      await geocodificarEndereco("Rua X, 1 - Bairro, Cidade - *", pontoCidade, deps);
      expect(warn).not.toHaveBeenCalled();
    });

    it("hit de cache nao avisa (nada foi geocodificado agora)", async () => {
      const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
      const deps = mockDeps({ buscarCache: async () => ({ lat: 1, lng: 2, fonte: "cnefe" }) });
      await geocodificarEndereco("Rua X, 1", null, deps);
      expect(warn).not.toHaveBeenCalled();
    });
  });
});

describe("geocodificarCnefe (IBGE, achado real 31/07 -- ver migration contabo/022_cnefe_enderecos.sql)", () => {
  const mockDeps = (overrides: Partial<{
    buscarPorRuaNumero: (nome: string, numero: string, municipioCodigo: string | null) => Promise<{ lat: number; lng: number }[]>;
    buscarPorRua: (nome: string, municipioCodigo: string | null) => Promise<{ lat: number; lng: number }[]>;
    buscarPorSimilaridade: (nome: string, municipioCodigo: string | null) => Promise<{ lat: number; lng: number }[]>;
  }> = {}) => ({
    buscarPorRuaNumero: vi.fn(overrides.buscarPorRuaNumero ?? (async () => [])),
    buscarPorRua: vi.fn(overrides.buscarPorRua ?? (async () => [])),
    buscarPorSimilaridade: vi.fn(overrides.buscarPorSimilaridade ?? (async () => [])),
  });

  it("sem candidato em nenhum nivel: null", async () => {
    const deps = mockDeps();
    const r = await geocodificarCnefe("RUA X, 10 - BAIRRO, CIDADE - *", null, null, deps);
    expect(r).toBeNull();
  });

  it("bate por rua+numero exato: usa esse resultado, nao chega a buscar so por rua nem por similaridade", async () => {
    const deps = mockDeps({ buscarPorRuaNumero: async () => [{ lat: 1, lng: 2 }] });
    const r = await geocodificarCnefe("RUA X, 10 - BAIRRO, CIDADE - *", null, null, deps);
    expect(r).toEqual({ lat: 1, lng: 2 });
    expect(deps.buscarPorRua).not.toHaveBeenCalled();
    expect(deps.buscarPorSimilaridade).not.toHaveBeenCalled();
  });

  it("rua+numero nao bate, cai pra so rua: nao chega a buscar por similaridade", async () => {
    const deps = mockDeps({ buscarPorRua: async () => [{ lat: 3, lng: 4 }] });
    const r = await geocodificarCnefe("RUA X, 10 - BAIRRO, CIDADE - *", null, null, deps);
    expect(r).toEqual({ lat: 3, lng: 4 });
    expect(deps.buscarPorSimilaridade).not.toHaveBeenCalled();
  });

  it("rua+numero e so-rua nao batem, cai pra similaridade (pg_trgm)", async () => {
    const deps = mockDeps({ buscarPorSimilaridade: async () => [{ lat: 5, lng: 6 }] });
    const r = await geocodificarCnefe("RUA X, 10 - BAIRRO, CIDADE - *", null, null, deps);
    expect(r).toEqual({ lat: 5, lng: 6 });
  });

  it("numero S/N: nao tenta buscar por rua+numero, vai direto pra so-rua", async () => {
    const deps = mockDeps({ buscarPorRua: async () => [{ lat: 3, lng: 4 }] });
    const r = await geocodificarCnefe("RUA X, S/N - BAIRRO, CIDADE - *", null, null, deps);
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
    const r = await geocodificarCnefe("RUA X, 10 - BAIRRO, CIDADE - *", pontoCidade, null, deps);
    expect(r).toEqual(candidatos[1]);
  });

  it("achado real 26/08: MULTIPLOS candidatos SEM ponto de cidade -- rejeitado, nao aceita cego o primeiro (mesma logica de geocodificarLocal)", async () => {
    const candidatos = [
      { lat: -22.9, lng: -43.2 },
      { lat: -21.06, lng: -41.97 },
    ];
    const deps = mockDeps({ buscarPorRua: async () => candidatos });
    const r = await geocodificarCnefe("RUA X, 10 - BAIRRO, CIDADE - *", null, null, deps);
    expect(r).toBeNull();
  });

  // Achado real 12/08 (romaneio de hoje, casos SEPETIBA/CAMPOS -- erro de
  // ate 270km por rua homonima em cidade errada): filtro de municipio na
  // query em si, nao so proximidade depois. Ver
  // docs/superpowers/specs/2026-08-12-precisao-geocodificacao-romaneio-design.md.
  it("passa o codigo de municipio pros 3 niveis de busca do CNEFE", async () => {
    const deps = mockDeps();
    await geocodificarCnefe("RUA X, 10 - BAIRRO, CIDADE - *", null, "3304557", deps);
    expect(deps.buscarPorRuaNumero).toHaveBeenCalledWith(expect.any(String), "10", "3304557");
  });

  it("sem codigo de municipio resolvido: passa null pros 3 niveis (comportamento de hoje, sem regressao)", async () => {
    const deps = mockDeps();
    await geocodificarCnefe("RUA X, 10 - BAIRRO, CIDADE - *", null, null, deps);
    expect(deps.buscarPorRuaNumero).toHaveBeenCalledWith(expect.any(String), "10", null);
  });

  it("cai pra so-rua COM o codigo de municipio tambem (nao perde o filtro no fallback)", async () => {
    const deps = mockDeps({ buscarPorRua: async () => [{ lat: 3, lng: 4 }] });
    await geocodificarCnefe("RUA X, 10 - BAIRRO, CIDADE - *", null, "3301009", deps);
    // 3o arg = numero alvo, pro produtor ordenar pelo numero no banco (migration 074)
    expect(deps.buscarPorRua).toHaveBeenCalledWith(expect.any(String), "3301009", 10);
  });

  it("cai pra similaridade COM o codigo de municipio tambem", async () => {
    const deps = mockDeps({ buscarPorSimilaridade: async () => [{ lat: 5, lng: 6 }] });
    await geocodificarCnefe("RUA X, 10 - BAIRRO, CIDADE - *", null, "3305000", deps);
    expect(deps.buscarPorSimilaridade).toHaveBeenCalledWith(expect.any(String), "3305000");
  });

  // Achado real 05/09 (diagnostico dos 382 pendentes do KPI Nutry Max de
  // 03/09): 226 deles tinham coordenada mas o caminhao NUNCA passou a menos
  // de 1,5km dela -- media de 14km. Causa: no nivel "so rua", o CNEFE
  // devolve ate 200 pontos da rua INTEIRA e a escolha era pela proximidade
  // ao CENTRO DA CIDADE. Em via longa isso colapsa numeros distantes no
  // mesmo ponto: "AV LUCIO COSTA, 2900 / 5700 / 16580" (avenida de ~18km na
  // Barra) caiam TODOS em -23.01391,-43.31373; idem "ESTRADA DO MARINAS,
  // 200 / 580" e 4 numeros diferentes da "R PROF ALICE KURI DA SILVA".
  // Com o numero do romaneio em maos, o desempate certo e' pelo NUMERO mais
  // proximo, nao pela distancia ao centro da cidade.
  describe("nivel so-rua: desempate pelo numero mais proximo (achado 05/09)", () => {
    const ruaLonga = [
      { lat: -23.00, lng: -43.30, numero: "1000" },
      { lat: -23.01, lng: -43.35, numero: "6000" },
      { lat: -23.02, lng: -43.45, numero: "16000" },
    ];

    it("escolhe o ponto do numero mais proximo, nao o mais perto do centro da cidade", async () => {
      const centroCidade = { lat: -22.90, lng: -43.20 }; // mais perto do numero 1000
      const deps = mockDeps({ buscarPorRua: async () => ruaLonga });
      const r = await geocodificarCnefe("AV LUCIO COSTA, 16580 - BARRA, RIO DE JANEIRO - *", centroCidade, "3304557", deps);
      expect(r).toEqual({ lat: -23.02, lng: -43.45 });
    });

    it("numeros diferentes da MESMA rua nao colapsam mais no mesmo ponto", async () => {
      const centroCidade = { lat: -22.90, lng: -43.20 };
      const deps = mockDeps({ buscarPorRua: async () => ruaLonga });
      const a = await geocodificarCnefe("AV LUCIO COSTA, 900 - BARRA, RIO DE JANEIRO - *", centroCidade, "3304557", deps);
      const b = await geocodificarCnefe("AV LUCIO COSTA, 16580 - BARRA, RIO DE JANEIRO - *", centroCidade, "3304557", deps);
      expect(a).not.toEqual(b);
      expect(a).toEqual({ lat: -23.00, lng: -43.30 });
    });

    it("sem numero no endereco (S/N): mantem o comportamento antigo (mais proximo do centro da cidade)", async () => {
      const centroCidade = { lat: -22.90, lng: -43.20 };
      const deps = mockDeps({ buscarPorRua: async () => ruaLonga });
      const r = await geocodificarCnefe("AV LUCIO COSTA, S/N - BARRA, RIO DE JANEIRO - *", centroCidade, "3304557", deps);
      expect(r).toEqual({ lat: -23.00, lng: -43.30 });
    });

    it("candidatos sem numero utilizavel: cai no comportamento antigo, nao quebra", async () => {
      const centroCidade = { lat: -22.90, lng: -43.20 };
      const deps = mockDeps({ buscarPorRua: async () => [{ lat: -23.00, lng: -43.30 }, { lat: -23.02, lng: -43.45 }] });
      const r = await geocodificarCnefe("AV LUCIO COSTA, 16580 - BARRA, RIO DE JANEIRO - *", centroCidade, "3304557", deps);
      expect(r).toEqual({ lat: -23.00, lng: -43.30 });
    });

    it("o desempate por numero ainda respeita o teto de distancia do ponto de cidade (rua homonima em cidade errada)", async () => {
      const centroCidade = { lat: -22.90, lng: -43.20 };
      // unico candidato, numero bate, mas fica a ~270km -- nao pode passar
      const deps = mockDeps({ buscarPorRua: async () => [{ lat: -21.06, lng: -41.97, numero: "16580" }] });
      const r = await geocodificarCnefe("AV LUCIO COSTA, 16580 - BARRA, RIO DE JANEIRO - *", centroCidade, "3304557", deps);
      expect(r).toBeNull();
    });
  });
});

describe("escolherPontoReferencia (achado real 05/09)", () => {
  // Os 132 pendentes SEM COORDENADA do KPI Nutry Max de 03/09 (Valenca,
  // Carmo, Areal, Duas Barras, Cambuci, Itaocara, Miracema...) tinham UMA
  // causa comum: o ponto de referencia usado pra validar o geocode e' o do
  // BAIRRO, preferido sobre o da cidade -- e o bairro e' resolvido sozinho
  // ("CENTRO, CAMBUCI"), o que joga o Nominatim pra outro lugar. Medido:
  //   "CENTRO, CAMBUCI"      -> Sao Paulo capital (~350km)
  //   "CENTRO, ITAOCARA"     -> Rua Itaocara, Duque de Caxias
  //   "VILA NOVA, MIRACEMA"  -> Rua Miracema, Nova Iguacu
  // Com o ponto de referencia errado, o endereco CERTO cai fora do teto de
  // 30km e vira null. Bairro fica dentro da propria cidade: se o ponto do
  // bairro estiver longe do da cidade, ele esta errado -- usa o da cidade.
  const cambuci = { lat: -21.4836, lng: -41.9071 };
  const bairroReal = { lat: -21.49, lng: -41.91 };        // ~1km do centro da cidade
  const bairroErrado = { lat: -23.5506, lng: -46.6182 };  // Sao Paulo capital

  it("bairro perto da cidade: usa o bairro (mais preciso)", () => {
    expect(escolherPontoReferencia(bairroReal, cambuci)).toEqual(bairroReal);
  });

  it("bairro longe da cidade: descarta o bairro e usa a cidade", () => {
    expect(escolherPontoReferencia(bairroErrado, cambuci)).toEqual(cambuci);
  });

  it("sem bairro: usa a cidade", () => {
    expect(escolherPontoReferencia(null, cambuci)).toEqual(cambuci);
  });

  it("sem cidade: usa o bairro (nao ha com o que comparar -- comportamento de hoje)", () => {
    expect(escolherPontoReferencia(bairroReal, null)).toEqual(bairroReal);
  });

  it("sem nada: null", () => {
    expect(escolherPontoReferencia(null, null)).toBeNull();
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

  it("achado real 26/08 (RBJ-2J67): MULTIPLOS candidatos SEM ponto de cidade (cidade truncada na origem, pontoCidade nao resolveu) -- rejeitado, nao aceita cego o primeiro da lista", async () => {
    const candidatos = [
      { lat: -22.9, lng: -43.2 }, // RJ capital -- errado, mas seria o "primeiro" aceito cego antes deste fix
      { lat: -21.55, lng: -42.18 }, // Santo Antonio de Padua -- o certo, mas nao ha como saber qual e' sem pontoCidade
    ];
    const buscar = vi.fn().mockResolvedValue(candidatos);
    const r = await geocodificarLocal("AVENIDA GETULIO VARGAS, 60 - SAO FELIX, CIDADE - LOJA 04", null, buscar);
    expect(r).toBeNull();
  });
});

describe("geocodificarNominatim (achado real 27/08, caso BAIRRO:CENTRO:RIO DE JANEIRO)", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  function mockFetch(resultados: unknown[]) {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue({
      ok: true,
      json: async () => resultados,
    }));
  }

  it("query com virgula (bairro+cidade): pula resultado 'city'/'state' amplo demais e pega o resultado especifico", async () => {
    // Reproduz o caso real: Nominatim devolve Nova Friburgo (city) em 1o
    // lugar pra "Centro, Rio de Janeiro", o bairro certo (suburb) so' em 2o.
    mockFetch([
      { lat: "-22.2800004", lon: "-42.5325303", addresstype: "city" }, // Nova Friburgo, errado
      { lat: "-22.9043934", lon: "-43.1830653", addresstype: "suburb" }, // Centro/RJ, certo
    ]);
    const r = await geocodificarNominatim("Centro, Rio de Janeiro");
    expect(r).toEqual({ lat: -22.9043934, lng: -43.1830653 });
  });

  it("query SEM virgula (so' cidade): aceita resultado 'city' normalmente, nao filtra", async () => {
    mockFetch([{ lat: "-22.9068", lon: "-43.1729", addresstype: "city" }]);
    const r = await geocodificarNominatim("Rio de Janeiro");
    expect(r).toEqual({ lat: -22.9068, lng: -43.1729 });
  });

  it("query com virgula mas TODOS os resultados sao amplos demais: cai pro 1o mesmo (nunca rejeita tudo)", async () => {
    mockFetch([
      { lat: "-22.2800004", lon: "-42.5325303", addresstype: "city" },
      { lat: "-22.0", lon: "-43.0", addresstype: "state" },
    ]);
    const r = await geocodificarNominatim("Bairro Inventado, Cidade Sem Bairro Especifico");
    expect(r).toEqual({ lat: -22.2800004, lng: -42.5325303 });
  });

  it("sem resultado nenhum: null", async () => {
    mockFetch([]);
    const r = await geocodificarNominatim("Endereco Que Nao Existe, Cidade");
    expect(r).toBeNull();
  });

  it("erro de rede: null, nunca lanca", async () => {
    vi.stubGlobal("fetch", vi.fn().mockRejectedValue(new Error("timeout")));
    const r = await geocodificarNominatim("Rua X, 1 - Bairro, Cidade");
    expect(r).toBeNull();
  });
});
