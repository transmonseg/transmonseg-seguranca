import { describe, it, expect } from "vitest";
import { classificarVia, melhorClasse } from "./classificacao-viaria";

describe("classificarVia", () => {
  it("classifica vias principais", () => {
    expect(classificarVia("motorway")).toBe("principal");
    expect(classificarVia("trunk")).toBe("principal");
    expect(classificarVia("primary")).toBe("principal");
    expect(classificarVia("secondary")).toBe("principal");
    expect(classificarVia("motorway_link")).toBe("principal");
    expect(classificarVia("primary_link")).toBe("principal");
  });

  it("classifica vias intermediarias", () => {
    expect(classificarVia("tertiary")).toBe("intermediaria");
    expect(classificarVia("unclassified")).toBe("intermediaria");
    expect(classificarVia("living_street")).toBe("intermediaria");
  });

  it("classifica vias estreitas", () => {
    expect(classificarVia("residential")).toBe("estreita");
    expect(classificarVia("service")).toBe("estreita");
    expect(classificarVia("track")).toBe("estreita");
  });

  it("retorna null para tags nao veiculares ou desconhecidas", () => {
    expect(classificarVia("footway")).toBeNull();
    expect(classificarVia("cycleway")).toBeNull();
    expect(classificarVia("pedestrian")).toBeNull();
    expect(classificarVia("steps")).toBeNull();
    expect(classificarVia("qualquer_coisa_desconhecida")).toBeNull();
  });
});

describe("melhorClasse", () => {
  it("principal vence intermediaria e estreita", () => {
    expect(melhorClasse("principal", "estreita")).toBe("principal");
    expect(melhorClasse("estreita", "principal")).toBe("principal");
    expect(melhorClasse("principal", "intermediaria")).toBe("principal");
  });

  it("intermediaria vence estreita", () => {
    expect(melhorClasse("intermediaria", "estreita")).toBe("intermediaria");
    expect(melhorClasse("estreita", "intermediaria")).toBe("intermediaria");
  });

  it("null nao vence nada -- retorna a outra classe", () => {
    expect(melhorClasse(null, "estreita")).toBe("estreita");
    expect(melhorClasse("principal", null)).toBe("principal");
    expect(melhorClasse(null, null)).toBeNull();
  });
});
