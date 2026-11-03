import { describe, it, expect, vi } from "vitest";
import { validarTerritorio, LIMIAR_DISTANCIA_BAIRRO_M, cepConfirmaPonto } from "./territorio";

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

// F4-05 (GEO-14, plano mestre 23/10): a guarda (hull do bairro + 1.000 m)
// reprovava ponto EXATO confirmado pelo CEP especifico. O romaneio e o Censo
// dao nomes diferentes ao mesmo lugar (BOCAININHA x SIDERLANDIA). Dados reais
// do CNEFE em producao (24/10, so' leitura).
describe("F4-05: ponto exato confirmado pelo CEP especifico nao reprova por bairro", () => {
  const municipioOk = { municipioDaCoordenada: async () => "3300407" };
  // RUA JOSE GONCALVES REBOLLAS, 2411 - BOCAININHA, BARRA MANSA - 27350-390:
  // cache do KPI = -22.545158,-44.204038 (cnefe, exato, bairro_divergente).
  const REBOLLAS = { lat: -22.545158, lng: -44.204038 };
  const candidatosRebollas = [
    { lat: -22.545158, lng: -44.204038, numero: "2411", cep: "27350390", localidade: "SIDERLANDIA" },
    { lat: -22.545141, lng: -44.204076, numero: "2411", cep: "27350390", localidade: "SIDERLANDIA" },
  ];

  it("REBOLLAS 2411: CEP 27350390 do romaneio = CEP do 2411 no CNEFE, no proprio ponto -> cepConfirmaPonto", () => {
    expect(cepConfirmaPonto(REBOLLAS, candidatosRebollas, { numero: "2411", cep: "27350390" })).toBe(true);
  });

  it("REBOLLAS 2411: a 1.330 m do hull de BOCAININHA mas confirmado pelo CEP -> aprova", async () => {
    const confirmacaoCep = vi.fn(async () => cepConfirmaPonto(REBOLLAS, candidatosRebollas, { numero: "2411", cep: "27350390" }));
    const r = await validarTerritorio(REBOLLAS, { municipioCodigo: "3300407", bairro: "BOCAININHA" },
      { ...municipioOk, distanciaAoBairro: async () => 1329.92 }, confirmacaoCep);
    expect(r).toEqual({ ok: true });
    expect(confirmacaoCep).toHaveBeenCalledTimes(1);
  });

  it("REBOLLAS sem a confirmacao do CEP (cache, ponte antiga): continua reprovando como antes", async () => {
    const r = await validarTerritorio(REBOLLAS, { municipioCodigo: "3300407", bairro: "BOCAININHA" },
      { ...municipioOk, distanciaAoBairro: async () => 1329.92 });
    expect(r).toEqual({ ok: false, motivo: "bairro_divergente" });
  });

  it("SAVIO COTA 595 - RETIRO, VOLTA REDONDA - 27281-421: o 595 do CNEFE e' do CEP 27283527 (VALE DO PARAIBA) -> continua reprovado (3.010 m)", async () => {
    const ponto = { lat: -22.494773, lng: -44.095926 };
    const cands = [{ lat: -22.494773, lng: -44.095926, numero: "595", cep: "27283527", localidade: "VALE DO PARAIBA" }];
    expect(cepConfirmaPonto(ponto, cands, { numero: "595", cep: "27281421" })).toBe(false);
    const r = await validarTerritorio(ponto, { municipioCodigo: "3306305", bairro: "RETIRO" },
      { municipioDaCoordenada: async () => "3306305", distanciaAoBairro: async () => 3009.69 },
      async () => cepConfirmaPonto(ponto, cands, { numero: "595", cep: "27281421" }));
    expect(r).toEqual({ ok: false, motivo: "bairro_divergente" });
  });

  it("CEP confirmado nao salva municipio divergente (sinal mais forte vem antes)", async () => {
    const confirmacaoCep = vi.fn(async () => true);
    const r = await validarTerritorio(REBOLLAS, { municipioCodigo: "3300407", bairro: "BOCAININHA" },
      { municipioDaCoordenada: async () => "3306305", distanciaAoBairro: async () => 1329.92 }, confirmacaoCep);
    expect(r).toEqual({ ok: false, motivo: "municipio_divergente" });
    expect(confirmacaoCep).not.toHaveBeenCalled();
  });

  it("dentro do limiar: a confirmacao do CEP nem e' consultada (consulta so' pra quem ia reprovar)", async () => {
    const confirmacaoCep = vi.fn(async () => true);
    const r = await validarTerritorio(REBOLLAS, { municipioCodigo: "3300407", bairro: "BOCAININHA" },
      { ...municipioOk, distanciaAoBairro: async () => 0 }, confirmacaoCep);
    expect(r).toEqual({ ok: true });
    expect(confirmacaoCep).not.toHaveBeenCalled();
  });

  it("confirmacao do CEP falhando: reprova como antes (nunca aprova no escuro) e loga", async () => {
    const erro = vi.spyOn(console, "error").mockImplementation(() => {});
    const r = await validarTerritorio(REBOLLAS, { municipioCodigo: "3300407", bairro: "BOCAININHA" },
      { ...municipioOk, distanciaAoBairro: async () => 1329.92 }, async () => { throw new Error("timeout"); });
    expect(r).toEqual({ ok: false, motivo: "bairro_divergente" });
    expect(erro).toHaveBeenCalled();
    erro.mockRestore();
  });

  it("CNEFE com o CEP a mais de 300 m do ponto nao confirma", () => {
    const longe = [{ lat: -22.545158 + 0.004, lng: -44.204038, numero: "2411", cep: "27350390" }];
    expect(cepConfirmaPonto(REBOLLAS, longe, { numero: "2411", cep: "27350390" })).toBe(false);
  });

  it("CEP generico (terminado em 000) nao confirma", () => {
    const cands = [{ lat: REBOLLAS.lat, lng: REBOLLAS.lng, numero: "2411", cep: "27350000" }];
    expect(cepConfirmaPonto(REBOLLAS, cands, { numero: "2411", cep: "27350000" })).toBe(false);
  });

  // Os 4 casos da auditoria de 20/10 (analise-2026-10-20/geocodificacao.md, secao 4).
  it("caso 1 (EST CABUCU, 4356 - CAMPO GRANDE - 23017-250): o 4356 de CAMPO GRANDE tem o CEP -> confirma", () => {
    const cands = [
      { lat: -22.924116, lng: -43.522717, numero: "4356", cep: "23017250", localidade: "RIO DA PRATA" },
      { lat: -22.925579, lng: -43.518474, numero: "4356", cep: "23017250", localidade: "CAMPO GRANDE" },
    ];
    expect(cepConfirmaPonto({ lat: -22.925579, lng: -43.518474 }, cands, { numero: "4356", cep: "23017250" })).toBe(true);
  });

  it("caso 2 (RUA UM, S/N - JARDIM BARRO BRANCO - 25267-090): S/N nunca confirma pelo CEP -> guarda de bairro vale", () => {
    const cands = [{ lat: -22.641857, lng: -43.245056, numero: "0", cep: "25267090" }];
    expect(cepConfirmaPonto({ lat: -22.641857, lng: -43.245056 }, cands, { numero: "S/N", cep: "25267090" })).toBe(false);
  });

  it("caso 3 (ESTRADA FAZENDA INGLESA, 2111 - MOINHO PRETO - 25670070): o 2111 nao existe no CNEFE -> nao confirma", () => {
    const cands = [
      { lat: -22.485143, lng: -43.211058, numero: "2046", cep: "25675170", localidade: "MOSELA" },
      { lat: -22.47, lng: -43.20, numero: "3245", cep: "25670070", localidade: "MOINHO PRETO" },
    ];
    expect(cepConfirmaPonto({ lat: -22.485143, lng: -43.211058 }, cands, { numero: "2111", cep: "25670070" })).toBe(false);
  });

  it("caso 4 (ESTRADA DA PEDRA BRANCA, S/N - PONTE BRANCA, PARATI): sem CEP no romaneio -> nao confirma", () => {
    const cands = [{ lat: -23.222676, lng: -44.765641, numero: "0", cep: "23970000" }];
    expect(cepConfirmaPonto({ lat: -23.222676, lng: -44.765641 }, cands, { numero: null, cep: null })).toBe(false);
  });

  it("HENRIQUE TERRA, 88 - PARQUE BURLE (CEP 28911320, a avenida inteira: 5 localidades): interpolado nao confirma pelo CEP", () => {
    const cands = [
      { lat: -22.877107, lng: -42.031892, numero: "83", cep: "28911320", localidade: "JARDIM EXCELSIOR" },
      { lat: -22.877441, lng: -42.030648, numero: "97", cep: "28911320", localidade: "JARDIM EXCELSIOR" },
    ];
    expect(cepConfirmaPonto({ lat: -22.877232714285714, lng: -42.031452 }, cands, { numero: "88", cep: "28911320" })).toBe(false);
  });
});

// GEO3-07 (auditoria 03/11): ponto fora de QUALQUER poligono da malha (MG, PE,
// 0,0) passava como "dentro do territorio" -- real=null aprovava. Agora, com o
// municipio esperado conhecido, mede a distancia ate o poligono esperado: mais
// de 2 km reprova. A folga de 2 km e' de praia e ilha (10 referencias de bairro
// caem fora da malha por isso).
describe("validarTerritorio - ponto fora da malha (GEO3-07)", () => {
  const MAGE = { municipioCodigo: "3302502", bairro: null };
  const foraDaMalha = (distanciaM: number | null) => ({
    municipioDaCoordenada: async () => null,
    distanciaAoBairro: async () => null,
    distanciaAoMunicipio: vi.fn(async () => distanciaM),
  });

  it("lab G1: ponto em MG (-18.68,-48.17) com Mage esperado, a 684 km do poligono -> reprova", async () => {
    const deps = foraDaMalha(684_000);
    const r = await validarTerritorio({ lat: -18.6785, lng: -48.1692 }, MAGE, deps);
    expect(r).toEqual({ ok: false, motivo: "municipio_divergente" });
    expect(deps.distanciaAoMunicipio).toHaveBeenCalledWith(-18.6785, -48.1692, "3302502");
  });

  it("lab G2: (0,0) com bairro sem hull -> reprova", async () => {
    const r = await validarTerritorio({ lat: 0, lng: 0 }, { municipioCodigo: "3302502", bairro: "CENTRO" }, foraDaMalha(5_000_000));
    expect(r).toEqual({ ok: false, motivo: "municipio_divergente" });
  });

  it.each([
    ["Ilha Grande (Angra)", { lat: -23.1606, lng: -44.2306 }, "3300100", 900],
    ["Ilha do Governador (Rio)", { lat: -22.8105, lng: -43.2085 }, "3304557", 150],
    ["Marambaia (Rio/Itaguai)", { lat: -23.0614, lng: -43.8597 }, "3304557", 1_800],
  ])("%s fora da malha mas a menos de 2 km do municipio esperado -> aprova", async (_n, ponto, municipio, d) => {
    const r = await validarTerritorio(ponto, { municipioCodigo: municipio, bairro: null }, foraDaMalha(d));
    expect(r).toEqual({ ok: true });
  });

  it("sem a consulta de distancia (migration 095 nao aplicada) -- ponto fora do retangulo do RJ reprova", async () => {
    const deps = { municipioDaCoordenada: async () => null, distanciaAoBairro: async () => null };
    expect(await validarTerritorio({ lat: -18.6785, lng: -48.1692 }, MAGE, deps)).toEqual({ ok: false, motivo: "municipio_divergente" });
    expect(await validarTerritorio({ lat: 0, lng: 0 }, MAGE, deps)).toEqual({ ok: false, motivo: "municipio_divergente" });
    // Sao Paulo capital (caso GEO3-11, "PARATI" aprendido a 198 km)
    expect(await validarTerritorio({ lat: -23.6055, lng: -46.6118 }, { municipioCodigo: "3303807", bairro: null }, deps)).toEqual({ ok: false, motivo: "municipio_divergente" });
    // dentro do retangulo (ilha, praia): sem a distancia, nao reprova
    expect(await validarTerritorio({ lat: -23.1606, lng: -44.2306 }, { municipioCodigo: "3300100", bairro: null }, deps)).toEqual({ ok: true });
  });

  it("consulta de distancia falhou (RPC ausente/erro -> null) -- cai no retangulo do RJ", async () => {
    const r = await validarTerritorio({ lat: -18.6785, lng: -48.1692 }, MAGE, foraDaMalha(null));
    expect(r).toEqual({ ok: false, motivo: "municipio_divergente" });
  });

  it("consulta de distancia lancou -- loga e cai no retangulo do RJ", async () => {
    const erro = vi.spyOn(console, "error").mockImplementation(() => {});
    const deps = { ...foraDaMalha(0), distanciaAoMunicipio: async () => { throw new Error("boom"); } };
    expect(await validarTerritorio({ lat: -22.95, lng: -43.0 }, { municipioCodigo: "3304557", bairro: null }, deps)).toEqual({ ok: true });
    expect(erro).toHaveBeenCalled();
    erro.mockRestore();
  });

  it("sem municipio esperado: continua aprovando (nada pra comparar)", async () => {
    const r = await validarTerritorio({ lat: -18.6785, lng: -48.1692 }, { municipioCodigo: null, bairro: null }, foraDaMalha(684_000));
    expect(r).toEqual({ ok: true });
  });
});
