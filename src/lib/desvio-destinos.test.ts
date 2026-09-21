import { describe, it, expect } from "vitest";
import {
  SCORE_DESVIO_SEM_DESTINOS,
  MOTIVO_DESVIO_SEM_DESTINOS,
  CLIENTE_DISTANTE_TETO_M,
  deveRebaixarDesvioSemDestinos,
  rebaixarDesvioSemDestinos,
  indiceClienteDistanteParaIncluir,
  indicesComClienteDistante,
} from "./desvio-destinos";
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
