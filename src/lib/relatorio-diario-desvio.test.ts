import { describe, it, expect } from "vitest";
import { montarTextoRelatorioDiario } from "./relatorio-diario-desvio";

describe("montarTextoRelatorioDiario", () => {
  it("dia normal: corretos, falsos, taxa e commits do dia", () => {
    const texto = montarTextoRelatorioDiario({
      dia: "2026-09-10",
      corretos: 6,
      falsos: 8,
      totalDisparosBrutos: 843,
      commits: [
        { hash: "34e7840", mensagem: "fix(desvio): reverte tolerancia de ruido no retorno-a-base, adiciona regra de horario avancado" },
        { hash: "d6e198c", mensagem: "chore(sim): espelha ehRetornoABaseHorarioAvancado no harness de simulacao" },
      ],
    });
    expect(texto).toContain("Nutry Max — 2026-09-10");
    expect(texto).toContain("✅ Corretos: 6");
    expect(texto).toContain("❌ Falsos: 8");
    expect(texto).toContain("Taxa de acerto: 43%");
    expect(texto).toContain("Disparos brutos no dia (afastando_geral): 843");
    expect(texto).toContain("- fix(desvio): reverte tolerancia de ruido no retorno-a-base, adiciona regra de horario avancado");
    expect(texto).toContain("- chore(sim): espelha ehRetornoABaseHorarioAvancado no harness de simulacao");
  });

  it("sem revisao individual no dia -- nao divide por zero", () => {
    const texto = montarTextoRelatorioDiario({
      dia: "2026-09-07",
      corretos: 0,
      falsos: 0,
      totalDisparosBrutos: 161,
      commits: [],
    });
    expect(texto).toContain("Sem revisão individual (caso a caso) hoje.");
    expect(texto).not.toContain("Taxa de acerto");
  });

  it("sem commit nenhum no dia", () => {
    const texto = montarTextoRelatorioDiario({
      dia: "2026-09-06",
      corretos: 2,
      falsos: 0,
      totalDisparosBrutos: 12,
      commits: [],
    });
    expect(texto).toContain("Nenhuma mudança no motor de desvio hoje.");
    expect(texto).toContain("Taxa de acerto: 100%");
  });

  it("100% falso -- taxa 0%", () => {
    const texto = montarTextoRelatorioDiario({
      dia: "2026-09-08",
      corretos: 0,
      falsos: 3,
      totalDisparosBrutos: 1287,
      commits: [],
    });
    expect(texto).toContain("Taxa de acerto: 0%");
  });
});
