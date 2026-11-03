import { describe, it, expect, vi } from "vitest";
import { criarReferencias, chaveCidade, chaveBairro } from "./referencia-cidade";

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
