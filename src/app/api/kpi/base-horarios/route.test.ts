import { describe, it, expect } from "vitest";
import { acharSaidaEChegadaBase } from "./route";

const BASE = { lat: -22.816007, lng: -43.277827 };
// ~50km da base -- claramente fora do raio de 500m.
const LONGE = { lat: -22.35, lng: -42.9 };

describe("acharSaidaEChegadaBase", () => {
  it("dia normal: dentro de manha, fora o dia todo, dentro de novo a noite -- saida e chegada corretas", () => {
    const posicoes = [
      { lat: BASE.lat, lng: BASE.lng, criado_em: "2026-08-25T09:00:00.000Z" }, // dentro (madrugada BRT)
      { lat: BASE.lat, lng: BASE.lng, criado_em: "2026-08-25T09:30:00.000Z" }, // ainda dentro
      { lat: LONGE.lat, lng: LONGE.lng, criado_em: "2026-08-25T10:00:00.000Z" }, // saiu
      { lat: LONGE.lat, lng: LONGE.lng, criado_em: "2026-08-25T18:00:00.000Z" }, // ainda fora
      { lat: BASE.lat, lng: BASE.lng, criado_em: "2026-08-25T21:00:00.000Z" }, // voltou
    ];
    const r = acharSaidaEChegadaBase(posicoes, [BASE]);
    expect(r.saidaBase).toBe("2026-08-25T09:30:00.000Z"); // ULTIMA leitura dentro antes de sair
    expect(r.chegadaBase).toBe("2026-08-25T21:00:00.000Z"); // PRIMEIRA leitura dentro na volta
  });

  it("saiu de manha mas ainda nao voltou (dia em andamento): chegada fica null, nunca inventa", () => {
    const posicoes = [
      { lat: BASE.lat, lng: BASE.lng, criado_em: "2026-08-25T09:00:00.000Z" },
      { lat: LONGE.lat, lng: LONGE.lng, criado_em: "2026-08-25T10:00:00.000Z" },
      { lat: LONGE.lat, lng: LONGE.lng, criado_em: "2026-08-25T20:00:00.000Z" },
    ];
    const r = acharSaidaEChegadaBase(posicoes, [BASE]);
    expect(r.saidaBase).toBe("2026-08-25T09:00:00.000Z");
    expect(r.chegadaBase).toBeNull();
  });

  it("veiculo nunca aparece dentro do raio da base o dia inteiro: os dois ficam null", () => {
    const posicoes = [
      { lat: LONGE.lat, lng: LONGE.lng, criado_em: "2026-08-25T09:00:00.000Z" },
      { lat: LONGE.lat, lng: LONGE.lng, criado_em: "2026-08-25T20:00:00.000Z" },
    ];
    const r = acharSaidaEChegadaBase(posicoes, [BASE]);
    expect(r.saidaBase).toBeNull();
    expect(r.chegadaBase).toBeNull();
  });

  it("sem posicao nenhuma ou sem base cadastrada: os dois ficam null", () => {
    expect(acharSaidaEChegadaBase([], [BASE])).toEqual({ saidaBase: null, chegadaBase: null });
    expect(acharSaidaEChegadaBase([{ lat: BASE.lat, lng: BASE.lng, criado_em: "2026-08-25T09:00:00.000Z" }], [])).toEqual({
      saidaBase: null,
      chegadaBase: null,
    });
  });

  it("volta rapida no meio do dia e sai de novo: saida guarda a PRIMEIRA do dia, chegada guarda a ULTIMA", () => {
    const posicoes = [
      { lat: BASE.lat, lng: BASE.lng, criado_em: "2026-08-25T09:00:00.000Z" }, // dentro
      { lat: LONGE.lat, lng: LONGE.lng, criado_em: "2026-08-25T10:00:00.000Z" }, // 1a saida
      { lat: BASE.lat, lng: BASE.lng, criado_em: "2026-08-25T13:00:00.000Z" }, // volta rapida no meio do dia
      { lat: LONGE.lat, lng: LONGE.lng, criado_em: "2026-08-25T13:05:00.000Z" }, // sai de novo
      { lat: BASE.lat, lng: BASE.lng, criado_em: "2026-08-25T21:00:00.000Z" }, // volta final
    ];
    const r = acharSaidaEChegadaBase(posicoes, [BASE]);
    expect(r.saidaBase).toBe("2026-08-25T09:00:00.000Z"); // ULTIMA leitura dentro da 1a saida do dia, nao a do meio-dia
    expect(r.chegadaBase).toBe("2026-08-25T21:00:00.000Z"); // ultima chegada, nao a do meio-dia
  });

  it("aceita array de bases (2 garagens) -- conta como dentro se bater QUALQUER uma", () => {
    const campos = { lat: -21.6886, lng: -41.3113 };
    const posicoes = [
      { lat: campos.lat, lng: campos.lng, criado_em: "2026-08-25T09:00:00.000Z" },
      { lat: LONGE.lat, lng: LONGE.lng, criado_em: "2026-08-25T10:00:00.000Z" },
      { lat: campos.lat, lng: campos.lng, criado_em: "2026-08-25T21:00:00.000Z" },
    ];
    const r = acharSaidaEChegadaBase(posicoes, [BASE, campos]);
    expect(r.saidaBase).toBe("2026-08-25T09:00:00.000Z");
    expect(r.chegadaBase).toBe("2026-08-25T21:00:00.000Z");
  });
});
