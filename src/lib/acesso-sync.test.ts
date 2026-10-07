import { describe, it, expect } from "vitest";
import { clienteDaConta, validarNovaConta } from "@/lib/acesso-sync";

describe("clienteDaConta (logins separados 06/10)", () => {
  it("admin ve todas", () => expect(clienteDaConta({ email: "a", admin: true, empresas: ["nutrimax"] })).toBeNull());
  it("so Nutry -> Nutry Max", () => expect(clienteDaConta({ email: "a", admin: false, empresas: ["nutrimax"] })).toBe("Nutry Max"));
  it("so Rio Quality -> Rio Quality", () => expect(clienteDaConta({ email: "a", admin: false, empresas: ["rioquality", "benassi"] })).toBe("Rio Quality"));
  it("as duas ou nenhuma: nao mexe", () => {
    expect(clienteDaConta({ email: "a", admin: false, empresas: ["nutrimax", "rioquality"] })).toBeUndefined();
    expect(clienteDaConta({ email: "a", admin: false, empresas: ["benassi"] })).toBeUndefined();
  });
});

describe("validarNovaConta (conta criada pelo convite do KPI)", () => {
  it("operador so da Rio Quality: cria presa a Rio Quality", () =>
    expect(validarNovaConta({ email: " Fulano@RQ.com ", senha: "123456", admin: false, empresas: ["rioquality"] }))
      .toEqual({ email: "fulano@rq.com", senha: "123456", cliente: "Rio Quality" }));
  it("admin: central (todas)", () =>
    expect(validarNovaConta({ email: "a@b.co", senha: "123456", admin: true, empresas: [] })).toEqual({ email: "a@b.co", senha: "123456", cliente: null }));
  it("sem cliente do monitoramento ou com os dois: nao cria (nunca vira central por engano)", () => {
    expect(validarNovaConta({ email: "a@b.co", senha: "123456", admin: false, empresas: ["benassi"] })).toEqual({ erro: "conta sem cliente do monitoramento" });
    expect(validarNovaConta({ email: "a@b.co", senha: "123456", admin: false, empresas: ["nutrimax", "rioquality"] })).toEqual({ erro: "conta sem cliente do monitoramento" });
  });
  it("email/senha invalidos", () => {
    expect(validarNovaConta({ email: "x", senha: "123456", admin: false, empresas: ["nutrimax"] })).toEqual({ erro: "email invalido" });
    expect(validarNovaConta({ email: "a@b.co", senha: "123", admin: false, empresas: ["nutrimax"] })).toEqual({ erro: "senha curta" });
    expect(validarNovaConta(null)).toEqual({ erro: "corpo invalido" });
  });
});
