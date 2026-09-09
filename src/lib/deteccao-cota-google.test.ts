import { describe, it, expect } from "vitest";
import { matchErroCotaGoogle } from "./deteccao-cota-google";

describe("matchErroCotaGoogle", () => {
  it("reconhece a mensagem real do incidente de 08/09", () => {
    expect(
      matchErroCotaGoogle(
        "Maps Demo Key limit reached: Your daily quota for Maps JavaScript 2D has been met. To continue without interruption and get higher limits, upgrade your account."
      )
    ).toBe(true);
  });

  it("reconhece BillingNotEnabledMapError", () => {
    expect(matchErroCotaGoogle("Google Maps JavaScript API error: BillingNotEnabledMapError")).toBe(true);
  });

  it("reconhece ApiNotActivatedMapError", () => {
    expect(matchErroCotaGoogle("Google Maps JavaScript API error: ApiNotActivatedMapError")).toBe(true);
  });

  it("reconhece mencao generica a 'quota' quando ha co-sinal do Google no mesmo texto", () => {
    expect(matchErroCotaGoogle("Google Maps JavaScript API: quota exceeded for this project")).toBe(true);
  });

  it("nao reconhece QuotaExceededError nativo do navegador (localStorage cheio)", () => {
    expect(
      matchErroCotaGoogle(
        "Failed to execute 'setItem' on 'Storage': Setting the value of 'x' exceeded the quota."
      )
    ).toBe(false);
  });

  it("nao reconhece 'quota' vinda de outro subsistema do app", () => {
    expect(
      matchErroCotaGoogle(
        "dadosRouboCarga: falha ao atualizar, servindo cache antigo se houver: quota exceeded"
      )
    ).toBe(false);
  });

  it("nao reconhece mensagem de erro nao relacionada", () => {
    expect(matchErroCotaGoogle("TypeError: Cannot read properties of undefined (reading 'foo')")).toBe(false);
  });

  it("nao reconhece string vazia", () => {
    expect(matchErroCotaGoogle("")).toBe(false);
  });
});
