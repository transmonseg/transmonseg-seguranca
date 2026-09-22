import { describe, it, expect } from "vitest";
import {
  SCORE_DESVIO_SEM_DESTINOS,
  MOTIVO_DESVIO_SEM_DESTINOS,
  CLIENTE_DISTANTE_TETO_M,
  deveRebaixarDesvioSemDestinos,
  rebaixarDesvioSemDestinos,
  indiceClienteDistanteParaIncluir,
  indicesComClienteDistante,
  deveUsarRomaneioComoFallbackDeDesvio,
  pontosRomaneioDisponiveisParaDesvio,
  pontoRomaneioPlausivelParaDesvio,
  filtrarPontosRomaneioPlausiveis,
  ROMANEIO_SANIDADE_TETO_M,
  type PontoRomaneioParaFallback,
} from "./desvio-destinos";
import { haversineM } from "./unitrac";
import { montarAlertaDesvio } from "./desvio";

const alertaAfastando = montarAlertaDesvio(
  { disparou: true, streak: 2 },
  { disparou: false, streak: 0, celula: "x", nVisitas: 0 }
)!;

describe("deveRebaixarDesvioSemDestinos", () => {
  // Casos reais do gabarito com lista sem cliente: TOS-1I21 25/08 07:31, RQV-8A12
  // 10/09 09:43, RQU-6E49 15/09 08:14 (n_pend=0, destinos so' a base).
  it("afastando_geral com ZERO pendente de cliente: rebaixa", () => {
    expect(
      deveRebaixarDesvioSemDestinos({ flagAtiva: true, origemDesvio: "afastando_geral", nPendentesCliente: 0 })
    ).toBe(true);
  });

  it("com pelo menos 1 pendente de cliente na lista: NAO rebaixa (o alerta critico segue igual)", () => {
    expect(
      deveRebaixarDesvioSemDestinos({ flagAtiva: true, origemDesvio: "afastando_geral", nPendentesCliente: 1 })
    ).toBe(false);
  });

  it("flag desligada: nunca rebaixa", () => {
    expect(
      deveRebaixarDesvioSemDestinos({ flagAtiva: false, origemDesvio: "afastando_geral", nPendentesCliente: 0 })
    ).toBe(false);
  });

  it("nao mexe em rua_rara nem em outras origens de desvio", () => {
    for (const o of ["rua_rara_frota", "cerca_virtual", "classe_viaria", "saida_parada", undefined]) {
      expect(deveRebaixarDesvioSemDestinos({ flagAtiva: true, origemDesvio: o, nPendentesCliente: 0 })).toBe(false);
    }
  });
});

describe("rebaixarDesvioSemDestinos", () => {
  it("vira desvio nivel atencao / origem sem_destinos com motivo claro -- continua tipo desvio (aparece na tela, dedupe/cooldown/silenciamento coerentes)", () => {
    expect(alertaAfastando.nivel).toBe("critico");
    const r = rebaixarDesvioSemDestinos(alertaAfastando);
    expect(r.tipo).toBe("desvio");
    expect(r.nivel).toBe("atencao");
    expect(r.origemDesvio).toBe("sem_destinos");
    expect(r.score).toBe(SCORE_DESVIO_SEM_DESTINOS);
    expect(r.motivo).toBe(MOTIVO_DESVIO_SEM_DESTINOS);
    expect(r.motivo).toMatch(/sem destinos carregados/i);
  });

  it("nao carrega flags de corredor do alerta original", () => {
    const r = rebaixarDesvioSemDestinos({ ...alertaAfastando, precisaVerificacaoCorredor: true });
    expect(r.precisaVerificacaoCorredor).toBeUndefined();
  });

  it("score de atencao competitivo (>= 40 dos outros atencao) mas abaixo do desvio critico (60)", () => {
    expect(SCORE_DESVIO_SEM_DESTINOS).toBeGreaterThanOrEqual(40);
    expect(SCORE_DESVIO_SEM_DESTINOS).toBeLessThan(alertaAfastando.score);
  });
});

describe("indiceClienteDistanteParaIncluir", () => {
  // Gabarito, categoria "so' base, clientes >50 km": RQV-3G18 26/08 07:17 (26
  // pendentes), RBJ-2J67 27/08 06:57 (37), RQV-9E67 31/08 07:08 (25). Todos de
  // manha, veiculo saindo da base rumo a rota longa: 14 falsos, 0 corretos.
  // Modelo: N pendentes a 60-180 km, 1 base a poucos km (indice apos os pendentes).
  function cenarioRotaLonga(nPend: number) {
    const dist: number[] = [];
    for (let i = 0; i < nPend; i++) dist.push(60_000 + ((i * 7919) % 120_000)); // 60-180 km
    dist.push(4_600); // base (fora do array de pendentes)
    return dist;
  }

  it("rota longa (26 pendentes, todos > 50 km): inclui o MAIS PROXIMO em linha reta", () => {
    const dist = cenarioRotaLonga(26);
    const idx = indiceClienteDistanteParaIncluir({
      distRetaM: dist,
      nPendentes: 26,
      indicesRelevantes: [26], // so' a base sobrou apos o filtro de 50 km
    });
    expect(idx).not.toBeNull();
    const menor = Math.min(...dist.slice(0, 26));
    expect(dist[idx!]).toBe(menor);
    expect(idx!).toBeLessThan(26); // e' um pendente, nao a base
  });

  it("37 pendentes (2J67): idem", () => {
    const dist = cenarioRotaLonga(37);
    const idx = indiceClienteDistanteParaIncluir({ distRetaM: dist, nPendentes: 37, indicesRelevantes: [37] });
    expect(idx).not.toBeNull();
    expect(dist[idx!]).toBe(Math.min(...dist.slice(0, 37)));
  });

  it("ja' existe cliente relevante (<= 50 km): NAO inclui nada (comportamento anterior)", () => {
    const dist = [12_000, 90_000, 4_600];
    expect(indiceClienteDistanteParaIncluir({ distRetaM: dist, nPendentes: 2, indicesRelevantes: [0, 2] })).toBeNull();
  });

  it("veiculo sem pendente nenhum (lista so' base): nao se aplica -- e' o caso da mudanca 2", () => {
    expect(indiceClienteDistanteParaIncluir({ distRetaM: [4_600], nPendentes: 0, indicesRelevantes: [0] })).toBeNull();
  });

  it("cliente mais proximo alem do teto (coordenada outlier): ignora, como antes", () => {
    const dist = [CLIENTE_DISTANTE_TETO_M + 1, 900_000, 4_600];
    expect(indiceClienteDistanteParaIncluir({ distRetaM: dist, nPendentes: 2, indicesRelevantes: [2] })).toBeNull();
  });

  it("distancia NaN/Infinity e' ignorada (nunca escolhida)", () => {
    const dist = [Number.NaN, Number.POSITIVE_INFINITY, 80_000, 4_600];
    expect(indiceClienteDistanteParaIncluir({ distRetaM: dist, nPendentes: 3, indicesRelevantes: [3] })).toBe(2);
  });

  it("empate: fica com o primeiro (determinismo)", () => {
    const dist = [70_000, 70_000, 4_600];
    expect(indiceClienteDistanteParaIncluir({ distRetaM: dist, nPendentes: 2, indicesRelevantes: [2] })).toBe(0);
  });

  it("nao inclui a base nem a escala: so' indices de pendente (< nPendentes)", () => {
    // base a 1 km (indice 2) e' MAIS perto que os pendentes -- nunca e' escolhida como 'cliente distante'
    const dist = [80_000, 90_000, 1_000];
    const idx = indiceClienteDistanteParaIncluir({ distRetaM: dist, nPendentes: 2, indicesRelevantes: [2] });
    expect(idx).toBe(0);
  });
});

describe("indicesComClienteDistante", () => {
  it("insere preservando a ordem original de `destinos` [pendentes..., bases..., escala...]", () => {
    expect(indicesComClienteDistante([26, 27], 3)).toEqual([3, 26, 27]);
  });

  it("indice null: devolve a mesma lista (sem alterar)", () => {
    const base = [26, 27];
    expect(indicesComClienteDistante(base, null)).toBe(base);
  });
});

// Fallback pro romaneio (22/09, correcao pendente desde 22/08 -- ver
// docs/investigacoes/2026-08-21-marcacoes-faltantes.md). Testes que faltavam
// (achado da revisao adversarial): a mensagem do commit original alegava "9
// testes novos" mas o arquivo so' tinha 3 linhas de import.
describe("deveUsarRomaneioComoFallbackDeDesvio", () => {
  it("Unitrac vazia + romaneio com pontos + flag ligada: usa o fallback", () => {
    expect(
      deveUsarRomaneioComoFallbackDeDesvio({ flagAtiva: true, nPendentesUnitrac: 0, nPontosRomaneioDisponiveis: 3 })
    ).toBe(true);
  });

  it("Unitrac com pendente: NUNCA usa o fallback, mesmo com romaneio disponivel (nao mistura)", () => {
    expect(
      deveUsarRomaneioComoFallbackDeDesvio({ flagAtiva: true, nPendentesUnitrac: 5, nPontosRomaneioDisponiveis: 3 })
    ).toBe(false);
  });

  it("romaneio sem nenhum ponto disponivel: nao usa (cai no rebaixamento sem_destinos)", () => {
    expect(
      deveUsarRomaneioComoFallbackDeDesvio({ flagAtiva: true, nPendentesUnitrac: 0, nPontosRomaneioDisponiveis: 0 })
    ).toBe(false);
  });

  it("flag desligada: nunca usa o fallback, mesmo com Unitrac vazia e romaneio disponivel", () => {
    expect(
      deveUsarRomaneioComoFallbackDeDesvio({ flagAtiva: false, nPendentesUnitrac: 0, nPontosRomaneioDisponiveis: 3 })
    ).toBe(false);
  });
});

describe("pontosRomaneioDisponiveisParaDesvio", () => {
  const nf1: PontoRomaneioParaFallback = { nf: "1", lat: -22.9, lng: -43.2, presencaConfirmadaEm: null };
  const nf2Confirmado: PontoRomaneioParaFallback = { nf: "2", lat: -22.91, lng: -43.21, presencaConfirmadaEm: "2026-09-22T10:00:00Z" };

  it("filtra fora pontos ja confirmados (presencaConfirmadaEm preenchido) -- mesma garantia que `pendentes` da Unitrac tem contra entrega ja feita", () => {
    expect(pontosRomaneioDisponiveisParaDesvio([nf1, nf2Confirmado])).toEqual([nf1]);
  });

  it("romaneio undefined (veiculo sem romaneio no dia): fail-open, lista vazia", () => {
    expect(pontosRomaneioDisponiveisParaDesvio(undefined)).toEqual([]);
  });

  it("romaneio vazio: lista vazia", () => {
    expect(pontosRomaneioDisponiveisParaDesvio([])).toEqual([]);
  });
});

describe("pontoRomaneioPlausivelParaDesvio / filtrarPontosRomaneioPlausiveis (checagem de sanidade, achado da revisao adversarial)", () => {
  // Posicao do veiculo em Nutry Max (Penha, RJ).
  const posAtual = { lat: -22.845, lng: -43.28 };
  const baseCampos = { lat: -21.75, lng: -41.33 }; // base de Campos dos Goytacazes

  it("ponto plausivel (~5km da posicao atual): aceito", () => {
    const pontoPerto = { lat: -22.89, lng: -43.25 }; // ~6km
    expect(
      pontoRomaneioPlausivelParaDesvio(pontoPerto, { posAtual, bases: [baseCampos], distanciaM: haversineM })
    ).toBe(true);
  });

  it("caso real 27/08 (geocode do romaneio errando ate 144km, 'endereco mal formatado/rua homonima em outra cidade'): ponto a ~360km (Sao Paulo) de ambos e' descartado", () => {
    const pontoSP = { lat: -23.55, lng: -46.63 }; // ~360km de posAtual e da base de Campos
    expect(
      pontoRomaneioPlausivelParaDesvio(pontoSP, { posAtual, bases: [baseCampos], distanciaM: haversineM })
    ).toBe(false);
  });

  it("longe da posicao atual mas dentro do teto de alguma base (rota saindo de Campos): aceito", () => {
    const pontoPertoDeCampos = { lat: -21.76, lng: -41.34 }; // ~1.5km da base de Campos, ~330km da posAtual
    expect(
      pontoRomaneioPlausivelParaDesvio(pontoPertoDeCampos, { posAtual, bases: [baseCampos], distanciaM: haversineM })
    ).toBe(true);
  });

  it("exatamente no teto: aceita (<=), um pouco alem: rejeita", () => {
    // 1 grau de latitude ~= 111.32km -- desloca ~89.8km (dentro) e ~90.2km (fora) do teto de 90km usado neste teste
    const teto = 90_000;
    const dentro = { lat: posAtual.lat - 89_800 / 111_320, lng: posAtual.lng };
    const fora = { lat: posAtual.lat - 90_500 / 111_320, lng: posAtual.lng };
    expect(pontoRomaneioPlausivelParaDesvio(dentro, { posAtual, bases: [], distanciaM: haversineM, tetoM: teto })).toBe(true);
    expect(pontoRomaneioPlausivelParaDesvio(fora, { posAtual, bases: [], distanciaM: haversineM, tetoM: teto })).toBe(false);
  });

  it("teto default e' ROMANEIO_SANIDADE_TETO_M (100km)", () => {
    expect(ROMANEIO_SANIDADE_TETO_M).toBe(100_000);
  });

  it("filtrarPontosRomaneioPlausiveis descarta so' os implausiveis, preservando os demais", () => {
    const perto: PontoRomaneioParaFallback = { nf: "perto", lat: -22.89, lng: -43.25, presencaConfirmadaEm: null };
    const longe: PontoRomaneioParaFallback = { nf: "longe", lat: -23.55, lng: -46.63, presencaConfirmadaEm: null };
    const resultado = filtrarPontosRomaneioPlausiveis([perto, longe], { posAtual, bases: [baseCampos], distanciaM: haversineM });
    expect(resultado).toEqual([perto]);
  });

  it("todos implausiveis: lista vazia -- fail-open pro rebaixamento sem_destinos existente, nunca trava", () => {
    const longe1: PontoRomaneioParaFallback = { nf: "a", lat: -23.55, lng: -46.63, presencaConfirmadaEm: null };
    const longe2: PontoRomaneioParaFallback = { nf: "b", lat: 4.71, lng: -74.07, presencaConfirmadaEm: null }; // Bogota
    expect(filtrarPontosRomaneioPlausiveis([longe1, longe2], { posAtual, bases: [baseCampos], distanciaM: haversineM })).toEqual([]);
  });
});
