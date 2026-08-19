import { describe, it, expect } from "vitest";

// Mesmo padrao de CardAlertaCritico.test.ts: funcao nao exportada de
// route.ts (rota Next.js so exporta GET/POST), reimplementada aqui
// identica. Ver route.ts para a fonte da verdade.
const MOTIVOS_NAO_SAO_ERRO_DE_DETECTOR = new Set([
  "dado_entrada_errado",
  "NAO_FOI_AO_CLIENTE", "NAO_SAIU_DA_BASE", "DESATUALIZADO", "MUDOU_DE_ROTA",
]);
function contaComoSinalDeDetector(r: { status: string; motivo_falso_positivo: string | null }): boolean {
  return !(r.status === "falso_positivo" && r.motivo_falso_positivo !== null && MOTIVOS_NAO_SAO_ERRO_DE_DETECTOR.has(r.motivo_falso_positivo));
}

describe("contaComoSinalDeDetector", () => {
  it("status resolvido sempre conta, independente do motivo", () => {
    expect(contaComoSinalDeDetector({ status: "resolvido", motivo_falso_positivo: null })).toBe(true);
  });

  it("falso_positivo com motivo null conta (historico anterior a esta feature)", () => {
    expect(contaComoSinalDeDetector({ status: "falso_positivo", motivo_falso_positivo: null })).toBe(true);
  });

  it("falso_positivo com detector_errado conta (erro real do detector)", () => {
    expect(contaComoSinalDeDetector({ status: "falso_positivo", motivo_falso_positivo: "detector_errado" })).toBe(true);
  });

  it("falso_positivo com dado_entrada_errado NAO conta (legado)", () => {
    expect(contaComoSinalDeDetector({ status: "falso_positivo", motivo_falso_positivo: "dado_entrada_errado" })).toBe(false);
  });

  it.each(["NAO_FOI_AO_CLIENTE", "NAO_SAIU_DA_BASE", "DESATUALIZADO", "MUDOU_DE_ROTA"])(
    "falso_positivo com categoria nova '%s' NAO conta como erro de detector",
    (motivo) => {
      expect(contaComoSinalDeDetector({ status: "falso_positivo", motivo_falso_positivo: motivo })).toBe(false);
    }
  );
});
