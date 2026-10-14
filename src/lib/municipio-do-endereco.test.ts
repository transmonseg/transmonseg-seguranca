import { describe, it, expect } from "vitest";
import { municipioDoEndereco } from "./municipio-do-endereco";

describe("municipioDoEndereco", () => {
  it("rua + cidade - UF", () => {
    expect(municipioDoEndereco("RUA DA FABRICA, ANGRA DOS REIS - RJ")).toBe("ANGRA DOS REIS");
  });
  it("rua + bairro + cidade - UF", () => {
    expect(municipioDoEndereco("AV. X, 150, RECREIO, RIO DE JANEIRO - RJ")).toBe("RIO DE JANEIRO");
  });
  it("espaços extras no fim", () => {
    expect(municipioDoEndereco("RUA Y, PARACAMBI       - RJ")).toBe("PARACAMBI");
  });
  it("vazio/nulo -> null", () => {
    expect(municipioDoEndereco("")).toBeNull();
    expect(municipioDoEndereco(null)).toBeNull();
  });
  it("sem cidade plausível -> null", () => {
    expect(municipioDoEndereco("RUA X, 12 - RJ")).toBeNull();
  });
});
