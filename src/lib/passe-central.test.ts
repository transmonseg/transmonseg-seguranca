import { describe, it, expect } from "vitest";
import { createHmac } from "node:crypto";
import { verificarPasse, consumirPasse } from "./passe-central";

// Mesmo formato que o KPI assina (KPI src/lib/passe-central.ts).
const b64 = (s: string | Buffer) => Buffer.from(s).toString("base64url");
function assinar(dados: object, segredo = "seg") {
  const corpo = b64(JSON.stringify(dados));
  return `${corpo}.${b64(createHmac("sha256", segredo).update(`entrar-central:${corpo}`).digest())}`;
}

describe("verificarPasse", () => {
  it("passe valido devolve email (minusculo), id e validade", () => {
    expect(verificarPasse(assinar({ e: "Erica@X.com", x: 1060, j: "abc12345" }), "seg", 1000)).toEqual({ email: "erica@x.com", jti: "abc12345", x: 1060 });
  });
  it("vencido, assinatura errada, segredo vazio, sem id ou lixo: null", () => {
    expect(verificarPasse(assinar({ e: "a@x.com", x: 999, j: "abc12345" }), "seg", 1000)).toBeNull();
    expect(verificarPasse(assinar({ e: "a@x.com", x: 1060, j: "abc12345" }, "outro"), "seg", 1000)).toBeNull();
    expect(verificarPasse(assinar({ e: "a@x.com", x: 1060, j: "abc12345" }), "", 1000)).toBeNull();
    expect(verificarPasse(assinar({ e: "a@x.com", x: 1060 }), "seg", 1000)).toBeNull();
    expect(verificarPasse("abc", "seg", 1000)).toBeNull();
    expect(verificarPasse(null, "seg", 1000)).toBeNull();
  });
  it("validade longa demais (mais de 90 s a frente) e' recusada", () => {
    expect(verificarPasse(assinar({ e: "a@x.com", x: 1091, j: "abc12345" }), "seg", 1000)).toBeNull();
  });
  it("corpo adulterado (troca de email) nao passa", () => {
    const [, sig] = assinar({ e: "a@x.com", x: 1060, j: "abc12345" }).split(".");
    expect(verificarPasse(`${b64(JSON.stringify({ e: "chefe@x.com", x: 1060, j: "abc12345" }))}.${sig}`, "seg", 1000)).toBeNull();
  });
});

describe("consumirPasse", () => {
  it("cada passe vale uma vez so'", () => {
    const usados = new Map<string, number>();
    expect(consumirPasse({ jti: "j1", x: 1060 }, 1000, usados)).toBe(true);
    expect(consumirPasse({ jti: "j1", x: 1060 }, 1001, usados)).toBe(false);
    expect(consumirPasse({ jti: "j2", x: 1060 }, 1001, usados)).toBe(true);
  });
  it("esquece os vencidos (a lista nao cresce pra sempre)", () => {
    const usados = new Map<string, number>([["velho", 900]]);
    consumirPasse({ jti: "novo", x: 1060 }, 1000, usados);
    expect(usados.has("velho")).toBe(false);
  });
});
