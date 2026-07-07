// Testes da funcao pura de perfil horario (aoristic simples com shrinkage).
// Nao mexe em rede/banco — so a matematica de suavizacao.
import { describe, it, expect } from "vitest";
import { calcularPerfilHorario } from "./fogocruzado";

function ocorrenciaNaHora(horaLocal: number, dataBase = "2026-06-15"): { date: string } {
  // America/Sao_Paulo = UTC-3 (sem horario de verao no Brasil desde 2019).
  const horaUtc = (horaLocal + 3) % 24;
  return { date: `${dataBase}T${String(horaUtc).padStart(2, "0")}:00:00.000Z` };
}

describe("calcularPerfilHorario", () => {
  it("sem ocorrencias: fator neutro (1) em todas as horas", () => {
    const perfil = calcularPerfilHorario([]);
    expect(perfil).toHaveLength(24);
    expect(perfil.every((f) => f === 1)).toBe(true);
  });

  it("distribuicao uniforme (mesma contagem em todas as horas): todos os fatores ~1", () => {
    const ocorrencias = Array.from({ length: 24 }, (_, h) =>
      Array.from({ length: 10 }, () => ocorrenciaNaHora(h))
    ).flat();
    const perfil = calcularPerfilHorario(ocorrencias);
    for (const f of perfil) expect(f).toBeCloseTo(1, 1);
  });

  it("concentracao forte numa hora especifica: fator dessa hora > fator das outras", () => {
    const ocorrencias = [
      ...Array.from({ length: 200 }, () => ocorrenciaNaHora(22)), // pico as 22h
      ...Array.from({ length: 5 }, () => ocorrenciaNaHora(10)),   // pouco as 10h
    ];
    const perfil = calcularPerfilHorario(ocorrencias);
    expect(perfil[22]).toBeGreaterThan(perfil[10]);
    expect(perfil[22]).toBeGreaterThan(1);
    expect(perfil[10]).toBeLessThan(1);
  });

  it("nunca sai da faixa [0.7, 1.6] mesmo com concentracao extrema", () => {
    const ocorrencias = Array.from({ length: 1000 }, () => ocorrenciaNaHora(3));
    const perfil = calcularPerfilHorario(ocorrencias);
    for (const f of perfil) {
      expect(f).toBeGreaterThanOrEqual(0.7);
      expect(f).toBeLessThanOrEqual(1.6);
    }
    expect(perfil[3]).toBe(1.6); // hora do pico bate no teto
  });

  it("pseudo-contagem maior suaviza mais (shrinkage mais forte em direcao a 1)", () => {
    // 100 ocorrencias no total: 8 na hora 2 (acima da media uniforme de
    // ~4,17), resto espalhado nas outras 23 horas. Com pouca suavizacao
    // (k=1) o fator bruto da hora 2 estoura o teto de 1.6; com muita
    // suavizacao (k=100, i.e. tanto peso quanto os dados reais) fica bem
    // mais perto de 1 e abaixo do teto — mostra a suavizacao funcionando de
    // verdade, nao so o clamp escondendo a diferenca.
    const ocorrencias = [
      ...Array.from({ length: 8 }, () => ocorrenciaNaHora(2)),
      ...Array.from({ length: 23 }, (_, h) => Array.from({ length: 4 }, () => ocorrenciaNaHora((h + 3) % 24))).flat(),
    ];
    const poucaSuavizacao = calcularPerfilHorario(ocorrencias, 1);
    const muitaSuavizacao = calcularPerfilHorario(ocorrencias, 100);
    expect(poucaSuavizacao[2]).toBe(1.6); // bateu no teto
    expect(muitaSuavizacao[2]).toBeLessThan(1.6); // suavizado, nao bate mais
    expect(Math.abs(muitaSuavizacao[2] - 1)).toBeLessThan(Math.abs(poucaSuavizacao[2] - 1));
  });

  it("ignora data invalida sem lancar erro", () => {
    const perfil = calcularPerfilHorario([{ date: "nao-e-uma-data" }, ocorrenciaNaHora(5)]);
    expect(perfil).toHaveLength(24);
  });
});
