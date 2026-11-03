import { describe, it, expect, vi } from "vitest";
import { criarReferencias, chaveCidade, chaveBairro, localDoEndereco } from "./referencia-cidade";

const MAGE = { lat: -22.6043, lng: -43.1081 };
const END_MAGE = "RUA ANTONIO PIO TEIXEIRA, - , MAGE - RJ";

describe("criarReferencias (GEO3-02/03)", () => {
  it("le CIDADE:/BAIRRO: do cache numa chamada so' e devolve a referencia da cidade", async () => {
    const lerCacheEmLote = vi.fn(async (chaves: string[]) => new Map(chaves.filter((c) => c === chaveCidade("MAGE")).map((c) => [c, MAGE])));
    const refs = criarReferencias({ lerCacheEmLote });
    await refs.carregar([END_MAGE, "RUA X, 10 - CENTRO, MAGE - RJ"]);
    expect(lerCacheEmLote).toHaveBeenCalledTimes(1);
    expect(lerCacheEmLote.mock.calls[0][0]).toEqual(expect.arrayContaining([chaveCidade("MAGE"), chaveBairro("CENTRO", "MAGE")]));
    expect(refs.referenciaDoEndereco(END_MAGE)).toEqual({ ponto: MAGE, precisao: "cidade" });
  });

  it("segunda carga com as mesmas cidades nao le de novo (memo)", async () => {
    const lerCacheEmLote = vi.fn(async () => new Map());
    const refs = criarReferencias({ lerCacheEmLote });
    await refs.carregar([END_MAGE]);
    await refs.carregar([END_MAGE]);
    expect(lerCacheEmLote).toHaveBeenCalledTimes(1);
  });

  it("fora do cache: resolve no externo e grava (quando ha salvar)", async () => {
    const salvar = vi.fn(async () => {});
    const resolverExterno = vi.fn(async () => MAGE);
    const refs = criarReferencias({ lerCacheEmLote: async () => new Map(), resolverExterno, salvar });
    await refs.carregar([END_MAGE]);
    expect(resolverExterno).toHaveBeenCalledWith(expect.stringContaining("RJ, Brasil"));
    expect(salvar).toHaveBeenCalledWith(chaveCidade("MAGE"), MAGE);
    expect(refs.referenciaDoEndereco(END_MAGE)?.ponto).toEqual(MAGE);
  });

  it("opcoes podem proibir o externo (retentativa: bairro so' do cache)", async () => {
    const resolverExterno = vi.fn(async () => MAGE);
    const refs = criarReferencias({ lerCacheEmLote: async () => new Map(), resolverExterno });
    await refs.carregar(["RUA X, 10 - CENTRO, MAGE - RJ"], { resolverCidadeExterno: () => false, resolverBairroExterno: () => false });
    expect(resolverExterno).not.toHaveBeenCalled();
    expect(refs.referenciaDoEndereco("RUA X, 10 - CENTRO, MAGE - RJ")).toBeNull();
  });

  it("endereco sem cidade reconhecivel: sem referencia", async () => {
    const refs = criarReferencias({ lerCacheEmLote: async () => new Map() });
    await refs.carregar(["RUA SEM CIDADE"]);
    expect(refs.referenciaDoEndereco("RUA SEM CIDADE")).toBeNull();
  });
});

// GEO3-04 (03/11): CIDADE:/BAIRRO: do Nominatim nunca eram validados --
// "CIDADE:QUISSAMA" caiu no bairro Quissama de Petropolis (179 km) e 36
// bairros em municipio errado viravam regua de 6 km.
describe("criarReferencias -- referencia validada no poligono do municipio (GEO3-04)", () => {
  const CARMO = "3301207";
  const CENTRO_CARMO = { lat: -21.93, lng: -42.6 };
  const EM_QUISSAMA = { lat: -22.1, lng: -41.47 };
  const END = "RUA X, 10 - CENTRO, CARMO - RJ";
  const cacheCom = (pares: [string, { lat: number; lng: number }][]) => async () => new Map(pares);

  it("bairro fora do municipio esperado e' descartado; vale a referencia da cidade", async () => {
    const refs = criarReferencias({
      lerCacheEmLote: cacheCom([[chaveCidade(localDoEndereco(END).cidade!), CENTRO_CARMO], [chaveBairro("CENTRO", localDoEndereco(END).cidade!), EM_QUISSAMA]]),
      municipioDaCoordenada: async (lat) => (lat === EM_QUISSAMA.lat ? "3304151" : CARMO),
    });
    await refs.carregar([END]);
    expect(refs.referenciaDoEndereco(END)).toEqual({ ponto: CENTRO_CARMO, precisao: "cidade" });
  });

  it("bairro fora de qualquer poligono (praia/mar) tambem e' descartado", async () => {
    const refs = criarReferencias({
      lerCacheEmLote: cacheCom([[chaveCidade(localDoEndereco(END).cidade!), CENTRO_CARMO], [chaveBairro("CENTRO", localDoEndereco(END).cidade!), { lat: -21.931, lng: -42.601 }]]),
      municipioDaCoordenada: async (lat) => (lat === -21.931 ? null : CARMO),
    });
    await refs.carregar([END]);
    expect(refs.referenciaDoEndereco(END)?.precisao).toBe("cidade");
  });

  it("bairro dentro do municipio: vale o bairro", async () => {
    const pertoDoCentro = { lat: -21.932, lng: -42.602 }; // memo do municipio e' por coordenada (outra do teste acima)
    const refs = criarReferencias({
      lerCacheEmLote: cacheCom([[chaveCidade(localDoEndereco(END).cidade!), CENTRO_CARMO], [chaveBairro("CENTRO", localDoEndereco(END).cidade!), pertoDoCentro]]),
      municipioDaCoordenada: async () => CARMO,
    });
    await refs.carregar([END]);
    expect(refs.referenciaDoEndereco(END)).toEqual({ ponto: pertoDoCentro, precisao: "bairro" });
  });

  it("cidade do cache em outro municipio (Quissama em Petropolis): descartada; nova do Nominatim so' se validada, sem gravar por cima", async () => {
    const salvar = vi.fn(async () => {});
    const PETROPOLIS = { lat: -22.4929, lng: -43.1591 };
    const QUISSAMA_CERTO = { lat: -22.1067, lng: -41.4722 };
    const refs = criarReferencias({
      lerCacheEmLote: cacheCom([[chaveCidade(localDoEndereco("RUA EUZEBIO DE QUEIROZ, S/N - , QUISSAMA - RJ").cidade!), PETROPOLIS]]),
      municipioDaCoordenada: async (lat) => (lat === PETROPOLIS.lat ? "3303906" : "3304151"),
      resolverExterno: async () => QUISSAMA_CERTO,
      salvar,
    });
    const e = "RUA EUZEBIO DE QUEIROZ, S/N - , QUISSAMA - RJ";
    await refs.carregar([e]);
    expect(refs.referenciaDoEndereco(e)?.ponto).toEqual(QUISSAMA_CERTO);
    expect(salvar).not.toHaveBeenCalled();
  });

  it("cidade nova do Nominatim em outro municipio: nao usa nem grava", async () => {
    const salvar = vi.fn(async () => {});
    const refs = criarReferencias({
      lerCacheEmLote: cacheCom([]),
      municipioDaCoordenada: async () => "3303906",
      resolverExterno: async () => ({ lat: -22.49, lng: -43.15 }),
      salvar,
    });
    await refs.carregar(["RUA A, 1 - , QUISSAMA - RJ"]);
    expect(refs.referenciaDoEndereco("RUA A, 1 - , QUISSAMA - RJ")).toBeNull();
    expect(salvar).not.toHaveBeenCalled();
  });
});
