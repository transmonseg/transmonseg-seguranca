import { describe, it, expect } from "vitest";
import { filtrarEntregas } from "./filtro-entregas";

const pts = [{ id: 1, feito: false }, { id: 2, feito: true }, { id: 3, feito: true }];
describe("filtrarEntregas", () => {
  it("todas", () => expect(filtrarEntregas(pts, "todas")).toHaveLength(3));
  it("pendentes", () => expect(filtrarEntregas(pts, "pendentes").map((p) => p.id)).toEqual([1]));
  it("entregues", () => expect(filtrarEntregas(pts, "entregues").map((p) => p.id)).toEqual([2, 3]));
});

describe("situacaoExibida", () => {
  it("feito pelo GPS e 'esteve no local' (98) aparecem como entregue; pendente nao muda", async () => {
    const { situacaoExibida } = await import("@/lib/filtro-entregas");
    expect(situacaoExibida({ feito: true, situacao: 0 })).toBe(1);
    expect(situacaoExibida({ feito: false, situacao: 0 })).toBe(0);
    // "esteve no local" (98) agora conta como entregue (pedido da operacao 13/10).
    expect(situacaoExibida({ feito: true, situacao: 98 })).toBe(1);
    expect(situacaoExibida({ feito: false, situacao: 98 })).toBe(1);
    expect(situacaoExibida({ feito: true, situacao: 1 })).toBe(1);
  });
});
