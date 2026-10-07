import { describe, it, expect } from "vitest";
import { clienteDaConta } from "@/lib/acesso-sync";

describe("clienteDaConta (logins separados 06/10)", () => {
  it("admin ve todas", () => expect(clienteDaConta({ email: "a", admin: true, empresas: ["nutrimax"] })).toBeNull());
  it("so Nutry -> Nutry Max", () => expect(clienteDaConta({ email: "a", admin: false, empresas: ["nutrimax"] })).toBe("Nutry Max"));
  it("so Rio Quality -> Rio Quality", () => expect(clienteDaConta({ email: "a", admin: false, empresas: ["rioquality", "benassi"] })).toBe("Rio Quality"));
  it("as duas ou nenhuma: nao mexe", () => {
    expect(clienteDaConta({ email: "a", admin: false, empresas: ["nutrimax", "rioquality"] })).toBeUndefined();
    expect(clienteDaConta({ email: "a", admin: false, empresas: ["benassi"] })).toBeUndefined();
  });
});
