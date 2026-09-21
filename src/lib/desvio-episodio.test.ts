import { describe, it, expect } from "vitest";
import {
  EPISODIO_DESVIO_GAP_MIN,
  deveReabrirDesvio,
  montarContextoReabertura,
  formatarReabertura,
  type EntradaReaberturaDesvio,
} from "./desvio-episodio";

const MIN = 60_000;
const AGORA = Date.parse("2026-09-15T13:00:00Z"); // 10:00 BRT

// Base: o caso que o gabarito mostrou -- veiculo com desvio aberto desde a
// manha (falso "iniciando rota", nunca tratado), ultimo disparo ha' 45 min,
// e um episodio novo comecando agora.
const base: EntradaReaberturaDesvio = {
  flagAtiva: true,
  tipoAlerta: "desvio",
  origemDesvio: "afastando_geral",
  nivelNovo: "critico",
  nivelExistente: "critico",
  ultimoDisparoEmMs: AGORA - 45 * MIN,
  agoraMs: AGORA,
  desdeExistenteMs: AGORA - 3 * 60 * MIN,
};

describe("deveReabrirDesvio", () => {
  it("episodio novo (45 min sem disparo) sobre desvio velho aberto: reabre", () => {
    expect(deveReabrirDesvio(base)).toBe(true);
  });

  it("flag desligada: comportamento anterior (nao reabre)", () => {
    expect(deveReabrirDesvio({ ...base, flagAtiva: false })).toBe(false);
  });

  it("mesmo episodio (ultimo disparo ha' 30s, ciclo anterior): NAO reabre -- evita bump a cada ciclo", () => {
    expect(deveReabrirDesvio({ ...base, ultimoDisparoEmMs: AGORA - 30_000 })).toBe(false);
  });

  it("flapping curto (parou de disparar por 9 min): NAO reabre; com 10 min exatos reabre", () => {
    expect(deveReabrirDesvio({ ...base, ultimoDisparoEmMs: AGORA - 9 * MIN })).toBe(false);
    expect(deveReabrirDesvio({ ...base, ultimoDisparoEmMs: AGORA - EPISODIO_DESVIO_GAP_MIN * MIN })).toBe(true);
  });

  it("alerta recem criado (5 min) nunca reabre, mesmo com gap grande de disparo", () => {
    expect(deveReabrirDesvio({ ...base, desdeExistenteMs: AGORA - 5 * MIN })).toBe(false);
  });

  it("sem registro de ultimo disparo (null: log ausente ou consulta falhou): fail-safe, NAO reabre", () => {
    expect(deveReabrirDesvio({ ...base, ultimoDisparoEmMs: null })).toBe(false);
    expect(deveReabrirDesvio({ ...base, ultimoDisparoEmMs: Number.NaN })).toBe(false);
  });

  it("origens sem log de disparo (cerca virtual, classe viaria, saida de parada) nunca reabrem: nao ha' como medir o gap", () => {
    for (const o of ["cerca_virtual", "classe_viaria", "saida_parada", "rumo_diverge", "comportamental", undefined]) {
      expect(deveReabrirDesvio({ ...base, origemDesvio: o })).toBe(false);
    }
  });

  it("so' vale pra tipo desvio", () => {
    expect(deveReabrirDesvio({ ...base, tipoAlerta: "parada_anomala" })).toBe(false);
  });

  it("existente CRITICO + novo sinal mais fraco (atencao/sem_destinos): nao mexe (nunca rebaixa um critico)", () => {
    expect(
      deveReabrirDesvio({ ...base, origemDesvio: "sem_destinos", nivelNovo: "atencao", nivelExistente: "critico" })
    ).toBe(false);
  });

  it("existente atencao (sem_destinos velho) + novo critico: reabre (sobe pra critico e aparece de novo)", () => {
    expect(deveReabrirDesvio({ ...base, nivelNovo: "critico", nivelExistente: "atencao" })).toBe(true);
  });

  it("existente atencao + novo atencao (novo episodio sem_destinos): reabre", () => {
    expect(
      deveReabrirDesvio({ ...base, origemDesvio: "sem_destinos", nivelNovo: "atencao", nivelExistente: "atencao" })
    ).toBe(true);
  });

  it("desde do alerta existente invalido: nao reabre", () => {
    expect(deveReabrirDesvio({ ...base, desdeExistenteMs: Number.NaN })).toBe(false);
  });
});

describe("montarContextoReabertura", () => {
  const agoraIso = "2026-09-15T13:00:00.000Z";
  const desdeOriginal = "2026-09-15T10:00:00.000Z";

  it("primeira reabertura: episodios 1 -> 2, guarda o horario do primeiro episodio e o contexto novo do ciclo", () => {
    const ctx = montarContextoReabertura({ origem_desvio: "afastando_geral" }, { origem_desvio: "afastando_geral" }, agoraIso, desdeOriginal);
    expect(ctx).toEqual({
      origem_desvio: "afastando_geral",
      episodios: 2,
      reaberto_em: agoraIso,
      desde_primeiro_episodio: desdeOriginal,
    });
  });

  it("reaberturas seguintes: incrementa e NAO perde o primeiro episodio", () => {
    const ctx = montarContextoReabertura(
      { origem_desvio: "afastando_geral" },
      { episodios: 3, desde_primeiro_episodio: "2026-09-15T06:00:00.000Z", reaberto_em: "2026-09-15T11:00:00.000Z" },
      agoraIso,
      "2026-09-15T11:00:00.000Z"
    );
    expect(ctx.episodios).toBe(4);
    expect(ctx.desde_primeiro_episodio).toBe("2026-09-15T06:00:00.000Z");
    expect(ctx.reaberto_em).toBe(agoraIso);
  });

  it("contexto existente ausente/invalido nao quebra", () => {
    expect(montarContextoReabertura({}, null, agoraIso, desdeOriginal).episodios).toBe(2);
    expect(montarContextoReabertura({}, "lixo", agoraIso, desdeOriginal).episodios).toBe(2);
  });
});

describe("formatarReabertura", () => {
  it("rotulo so' aparece a partir do 2o episodio", () => {
    expect(formatarReabertura({ episodios: 2 })).toBe("Reaberto — 2º episódio");
    expect(formatarReabertura({ episodios: 5 })).toBe("Reaberto — 5º episódio");
    expect(formatarReabertura({ episodios: 1 })).toBeNull();
    expect(formatarReabertura({})).toBeNull();
    expect(formatarReabertura(null)).toBeNull();
  });
});
