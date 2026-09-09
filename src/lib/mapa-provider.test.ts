import { describe, it, expect } from "vitest";
import { transicionar, deveTentarRetryAgora, RETRY_INTERVALO_MIN, type MapaProviderEstado } from "./mapa-provider";

const ESTADO_GOOGLE: MapaProviderEstado = {
  provider: "google",
  quotaExcedidaEm: null,
  proximaTentativaEm: null,
};

describe("transicionar", () => {
  it("quota_excedida a partir de 'google' -- vira fallback e agenda retry em RETRY_INTERVALO_MIN", () => {
    const agora = "2026-09-08T18:00:00.000Z";
    const r = transicionar(ESTADO_GOOGLE, "quota_excedida", agora);
    expect(r.provider).toBe("fallback");
    expect(r.quotaExcedidaEm).toBe(agora);
    expect(r.proximaTentativaEm).toBe("2026-09-08T18:20:00.000Z");
  });

  it("retry_sucesso a partir de 'fallback' -- volta pra google e limpa os timestamps", () => {
    const emFallback: MapaProviderEstado = {
      provider: "fallback",
      quotaExcedidaEm: "2026-09-08T18:00:00.000Z",
      proximaTentativaEm: "2026-09-08T18:20:00.000Z",
    };
    const r = transicionar(emFallback, "retry_sucesso", "2026-09-08T18:20:05.000Z");
    expect(r).toEqual({ provider: "google", quotaExcedidaEm: null, proximaTentativaEm: null });
  });

  it("retry_falhou a partir de 'fallback' -- continua fallback, empurra proximaTentativaEm mais RETRY_INTERVALO_MIN", () => {
    const emFallback: MapaProviderEstado = {
      provider: "fallback",
      quotaExcedidaEm: "2026-09-08T18:00:00.000Z",
      proximaTentativaEm: "2026-09-08T18:20:00.000Z",
    };
    const r = transicionar(emFallback, "retry_falhou", "2026-09-08T18:20:05.000Z");
    expect(r.provider).toBe("fallback");
    expect(r.quotaExcedidaEm).toBe("2026-09-08T18:00:00.000Z"); // preserva o original
    expect(r.proximaTentativaEm).toBe("2026-09-08T18:40:05.000Z");
  });

  it("quota_excedida de novo enquanto ja esta em fallback -- idempotente, so' reagenda o retry a partir de agora", () => {
    const emFallback: MapaProviderEstado = {
      provider: "fallback",
      quotaExcedidaEm: "2026-09-08T18:00:00.000Z",
      proximaTentativaEm: "2026-09-08T18:20:00.000Z",
    };
    const r = transicionar(emFallback, "quota_excedida", "2026-09-08T18:05:00.000Z");
    expect(r.provider).toBe("fallback");
    expect(r.proximaTentativaEm).toBe("2026-09-08T18:25:00.000Z");
  });
});

describe("deveTentarRetryAgora", () => {
  it("false quando provider e' google (nao ha' retry a fazer)", () => {
    expect(deveTentarRetryAgora(ESTADO_GOOGLE, "2026-09-08T18:00:00.000Z")).toBe(false);
  });

  it("false quando ainda nao chegou a proximaTentativaEm", () => {
    const emFallback: MapaProviderEstado = {
      provider: "fallback",
      quotaExcedidaEm: "2026-09-08T18:00:00.000Z",
      proximaTentativaEm: "2026-09-08T18:20:00.000Z",
    };
    expect(deveTentarRetryAgora(emFallback, "2026-09-08T18:19:59.000Z")).toBe(false);
  });

  it("true quando ja passou da proximaTentativaEm", () => {
    const emFallback: MapaProviderEstado = {
      provider: "fallback",
      quotaExcedidaEm: "2026-09-08T18:00:00.000Z",
      proximaTentativaEm: "2026-09-08T18:20:00.000Z",
    };
    expect(deveTentarRetryAgora(emFallback, "2026-09-08T18:20:01.000Z")).toBe(true);
  });
});
