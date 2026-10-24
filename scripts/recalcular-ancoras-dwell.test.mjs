import { describe, it, expect } from "vitest";
import { umaObservacaoPorDia, dobrarObservacoes, classificarAncora, categoriasParaAplicar } from "./recalcular-ancoras-dwell.mjs";

// F4-02 (GEO-29): recalcula as ancoras "dwell_confirmado" a partir da trilha
// GPS real de cada dia (nunca da presenca_confirmada_em: as 33.759
// confirmacoes antigas por vizinhanca nao sao evidencia de parada).

describe("umaObservacaoPorDia", () => {
  it("duas NFs do mesmo cliente no mesmo dia viram UMA observacao (a de maior dwell)", () => {
    const obs = umaObservacaoPorDia([
      { dia: "2026-10-23", dwellMaxS: 200, posicaoReal: { lat: -22.6461, lng: -43.2488 } },
      { dia: "2026-10-23", dwellMaxS: 600, posicaoReal: { lat: -22.6462, lng: -43.2489 } },
      { dia: "2026-10-21", dwellMaxS: 300, posicaoReal: { lat: -22.6460, lng: -43.2487 } },
    ]);
    expect(obs).toEqual([
      { dia: "2026-10-21", dwellMaxS: 300, posicaoReal: { lat: -22.6460, lng: -43.2487 } },
      { dia: "2026-10-23", dwellMaxS: 600, posicaoReal: { lat: -22.6462, lng: -43.2489 } },
    ]);
  });
  it("dia sem dwell suficiente nao e' observacao", () => {
    expect(umaObservacaoPorDia([{ dia: "2026-10-23", dwellMaxS: 90, posicaoReal: null }])).toEqual([]);
  });
});

describe("dobrarObservacoes", () => {
  // Caso real (Nutry 165601, "RUA 10, 749 - NOVA CAMPINAS, DUQUE DE CAXIAS"):
  // ancora dwell n=2 com primeira=ultima=23/10. Com uma parada so' naquele
  // dia, o recalculo da' n=1.
  it("um dia so': n=1 na posicao da parada", () => {
    const r = dobrarObservacoes([{ dia: "2026-10-23", dwellMaxS: 600, posicaoReal: { lat: -22.6461, lng: -43.2488 } }]);
    expect(r).toEqual({ lat: -22.6461, lng: -43.2488, n: 1, primeira: "2026-10-23", ultima: "2026-10-23" });
  });
  it("dias diferentes no mesmo lugar: media e n = numero de dias", () => {
    const r = dobrarObservacoes([
      { dia: "2026-10-21", dwellMaxS: 300, posicaoReal: { lat: -22.6460, lng: -43.2480 } },
      { dia: "2026-10-23", dwellMaxS: 300, posicaoReal: { lat: -22.6462, lng: -43.2490 } },
    ]);
    expect(r.n).toBe(2);
    expect(r.lat).toBeCloseTo(-22.6461, 6);
    expect(r.ultima).toBe("2026-10-23");
  });
  it("dia a mais de 2 km da media (outro lugar) nao entra (mesma guarda do cron, NUTRIMED 31/08)", () => {
    const r = dobrarObservacoes([
      { dia: "2026-10-21", dwellMaxS: 300, posicaoReal: { lat: -22.9080, lng: -43.1950 } },
      { dia: "2026-10-22", dwellMaxS: 300, posicaoReal: { lat: -22.9285, lng: -43.3830 } },
    ]);
    expect(r.n).toBe(1);
    expect(r.lat).toBe(-22.9080);
  });
  it("sem observacao: null (nada a gravar, nunca inventa ponto)", () => {
    expect(dobrarObservacoes([])).toBeNull();
  });
});

describe("classificarAncora", () => {
  const ATUAL = { lat: -22.64605, lng: -43.248743, fonte: "dwell_confirmado", n_observacoes: 2 };
  it("dwell n=2 no mesmo dia que vira n=1 no mesmo lugar: n_cai", () => {
    expect(classificarAncora(ATUAL, { lat: -22.64605, lng: -43.248743, n: 1 }).categoria).toBe("n_cai");
  });
  it("mais dias com parada na trilha: n_sobe", () => {
    expect(classificarAncora(ATUAL, { lat: -22.64605, lng: -43.248743, n: 4 }).categoria).toBe("n_sobe");
  });
  it("igual: mesma n e < 30 m", () => {
    expect(classificarAncora(ATUAL, { lat: -22.6461, lng: -43.2488, n: 2 }).categoria).toBe("igual");
  });
  it("move > 150 m: revisao (nao aplica sozinho)", () => {
    expect(classificarAncora(ATUAL, { lat: -22.6480, lng: -43.2488, n: 2 }).categoria).toBe("revisao");
  });
  it("dwell sem nenhuma parada na trilha: sem_evidencia (nao mexe)", () => {
    expect(classificarAncora(ATUAL, null).categoria).toBe("sem_evidencia");
  });
  it("geocodificada (photon) com parada real: vira_dwell", () => {
    const r = classificarAncora({ lat: -22.3207663, lng: -42.6521455, fonte: "photon", n_observacoes: 1 }, { lat: -22.3214, lng: -42.6525, n: 1 });
    expect(r.categoria).toBe("vira_dwell");
    expect(r.distM).toBeGreaterThan(50);
  });
  it("fonte protegida (manual) nunca muda", () => {
    expect(classificarAncora({ ...ATUAL, fonte: "manual" }, { lat: -22.6461, lng: -43.2488, n: 3 }).categoria).toBe("protegida");
  });
  it("geocodificada sem parada: fica como esta'", () => {
    expect(classificarAncora({ ...ATUAL, fonte: "cnefe", n_observacoes: 1 }, null).categoria).toBe("geocodificada_sem_parada");
  });
});

describe("categoriasParaAplicar", () => {
  it("padrao: so' n_cai (tirar contagem inflada e' o lado seguro)", () => {
    expect([...categoriasParaAplicar(null)]).toEqual(["n_cai"]);
  });
  it("revisao nunca e' aplicavel", () => {
    expect(() => categoriasParaAplicar("n_cai,revisao")).toThrow();
  });
});
