import { describe, it, expect } from "vitest";
import { janelaDiaBR, paradaDaEntrega, maisPerto, afinarRastro, normPlacaVariantes } from "./entrega-mapa";

const p = (hhmm: string, lat: number, lng: number) => ({ lat, lng, em: `2026-10-05T${hhmm}:00-03:00` });

describe("entrega no mapa", () => {
  it("janela do dia em BRT", () => {
    expect(janelaDiaBR("2026-10-05")).toEqual({ inicio: "2026-10-05T03:00:00.000Z", fim: "2026-10-06T03:00:00.000Z" });
  });
  it("parada da entrega = média das posições entre chegada e saída", () => {
    const pts = [p("10:00", -22.9, -43.2), p("10:15", -22.91, -43.21), p("10:30", -22.93, -43.23), p("11:10", -23, -43.3)];
    const r = paradaDaEntrega(pts, "2026-10-05", "10:13", "10:58")!;
    expect(r.lat).toBeCloseTo(-22.92, 3);
    expect(r.lng).toBeCloseTo(-43.22, 3);
    expect(paradaDaEntrega(pts, "2026-10-05", null, null)).toBeNull();
  });
  it("sem posição dentro da janela: a mais próxima da chegada (até 15 min)", () => {
    const pts = [p("10:00", -22.9, -43.2), p("11:30", -23, -43.3)];
    expect(paradaDaEntrega(pts, "2026-10-05", "10:10", "10:20")).toMatchObject({ lat: -22.9, lng: -43.2 });
    expect(paradaDaEntrega(pts, "2026-10-05", "10:40", "10:50")).toBeNull();
  });
  it("ponto do dia mais perto do cliente", () => {
    const pts = [p("08:00", -22.9, -43.2), p("09:00", -22.95, -43.25), p("10:00", -23, -43.3)];
    const r = maisPerto(pts, { lat: -22.951, lng: -43.251 })!;
    expect(r.em).toBe(pts[1].em);
    expect(r.distM).toBeLessThan(200);
  });
  it("afina o rastro mantendo primeiro e último", () => {
    const pts = Array.from({ length: 10 }, (_, i) => p(`10:${String(i).padStart(2, "0")}`, i, i));
    const r = afinarRastro(pts, 4);
    expect(r.length).toBeLessThanOrEqual(5);
    expect(r[0]).toBe(pts[0]);
    expect(r[r.length - 1]).toBe(pts[9]);
  });
  it("placa do KPI casa com a do monitoramento: com e sem hífen e com O/0 e I/1 trocados (frota com cadastro duplicado)", () => {
    const v = normPlacaVariantes("rqo9h37");
    expect(v).toEqual(expect.arrayContaining(["RQO9H37", "RQO-9H37", "RQ09H37", "RQ0-9H37"]));
    expect(new Set(v).size).toBe(v.length);
    expect(normPlacaVariantes("TTK4D17")).toEqual(expect.arrayContaining(["TTK4D17", "TTK-4D17", "TTK4DI7", "TTK-4DI7"]));
  });
});
