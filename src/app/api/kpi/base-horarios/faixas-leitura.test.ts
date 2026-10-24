import { describe, it, expect } from "vitest";
import { readFileSync } from "fs";
import { join } from "path";
import { contarLeiturasPorFaixa } from "./route";

// F2-09 (KN-06, D-05): o KPI decide "rastreador com falha no dia" pela fracao
// de leituras atrasadas (> 15 min) entre 05h e 21h BRT, fora da base, e o
// "coletor fora" pela frota toda na mesma faixa de 15 min. A ponte so' conta.
const PENHA = { lat: -22.815896899530625, lng: -43.27780385194278 };

describe("contarLeiturasPorFaixa", () => {
  it("64 faixas de 15 min (05:00-20:59 BRT): [total, atrasadas, total fora da base, atrasadas fora da base]", () => {
    const p = (hhmm: string, atraso_min: number, naBase: boolean) => ({
      criado_em: new Date(Date.parse(`2026-10-22T${hhmm}:00-03:00`)).toISOString(),
      lat: naBase ? PENHA.lat : -22.70, lng: naBase ? PENHA.lng : -43.27, velocidade: 0, atraso_min,
    });
    const faixas = contarLeiturasPorFaixa([
      p("04:59", 300, false), // antes da janela
      p("05:00", 300, false), p("05:10", 0, false),
      p("05:20", 40, true),
      p("20:59", 20, true),
      p("21:00", 99, false), // depois da janela
    ], [PENHA]);
    expect(faixas).toHaveLength(64);
    expect(faixas[0]).toEqual([2, 1, 2, 1]);
    expect(faixas[1]).toEqual([1, 1, 0, 0]);
    expect(faixas[63]).toEqual([1, 1, 0, 0]);
    expect(faixas.slice(2, 63).every((f) => f.every((n) => n === 0))).toBe(true);
  });

  it("RQV9B26 22/10: pernoite a 704 m com o rastreador dormindo conta como atrasada fora da base", () => {
    const pos = readFileSync(join(__dirname, "__fixtures__", "rqv9b26-2026-10-22-manha.csv"), "utf8").trim().split("\n").slice(1).map((l) => {
      const [criado_em, lat, lng, velocidade, atraso_min] = l.split(",");
      return { criado_em, lat: Number(lat), lng: Number(lng), velocidade: Number(velocidade), atraso_min: Number(atraso_min) };
    });
    const faixas = contarLeiturasPorFaixa(pos, [PENHA]);
    // 05:00-08:29 BRT: tudo atrasado e fora da base.
    for (let i = 0; i < 14; i++) expect(faixas[i][3]).toBe(faixas[i][0]);
    expect(faixas[0][0]).toBeGreaterThan(25);
    // 09:30-09:44 BRT: rodando, tudo fresco.
    expect(faixas[18][1]).toBe(0);
  });
});
