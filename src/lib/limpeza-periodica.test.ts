import { describe, it, expect } from "vitest";
import { deveRodarLimpezaPeriodica } from "./limpeza-periodica";

const t = (iso: string) => new Date(iso);

describe("deveRodarLimpezaPeriodica (06/10: rodava ~12x/h varrendo posicoes_historico)", () => {
  it("roda no começo da hora se nunca rodou neste processo", () => {
    expect(deveRodarLimpezaPeriodica(t("2026-10-06T10:02:00Z"), null)).toBe(true);
  });
  it("não roda de novo na mesma hora (motor roda a cada 30 s)", () => {
    expect(deveRodarLimpezaPeriodica(t("2026-10-06T10:03:30Z"), t("2026-10-06T10:00:30Z"))).toBe(false);
    expect(deveRodarLimpezaPeriodica(t("2026-10-06T10:05:00Z"), t("2026-10-06T10:00:00Z"))).toBe(false);
  });
  it("roda de novo na hora seguinte", () => {
    expect(deveRodarLimpezaPeriodica(t("2026-10-06T11:00:30Z"), t("2026-10-06T10:00:30Z"))).toBe(true);
  });
  it("fora dos minutos 0-5 não roda", () => {
    expect(deveRodarLimpezaPeriodica(t("2026-10-06T10:20:00Z"), null)).toBe(false);
  });
});
