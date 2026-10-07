import { describe, it, expect } from "vitest";
import { filtrarEntregas } from "./filtro-entregas";

const pts = [{ id: 1, feito: false }, { id: 2, feito: true }, { id: 3, feito: true }];
describe("filtrarEntregas", () => {
  it("todas", () => expect(filtrarEntregas(pts, "todas")).toHaveLength(3));
  it("pendentes", () => expect(filtrarEntregas(pts, "pendentes").map((p) => p.id)).toEqual([1]));
  it("entregues", () => expect(filtrarEntregas(pts, "entregues").map((p) => p.id)).toEqual([2, 3]));
});
