import { describe, it, expect } from "vitest";
import { createHmac } from "node:crypto";
import { verificarPasse } from "./passe-central";

// Mesmo formato que o KPI assina (KPI src/lib/passe-central.ts).
const b64 = (s: string | Buffer) => Buffer.from(s).toString("base64url");
function assinar(dados: object, segredo = "seg") {
  const corpo = b64(JSON.stringify(dados));
  return `${corpo}.${b64(createHmac("sha256", segredo).update(`entrar-central:${corpo}`).digest())}`;
}

describe("verificarPasse", () => {
  it("passe valido devolve o email (minusculo)", () => {
    expect(verificarPasse(assinar({ e: "Erica@X.com", x: 1060 }), "seg", 1000)).toEqual({ email: "erica@x.com" });
  });
  it("vencido, assinatura errada, segredo vazio ou lixo: null", () => {
    expect(verificarPasse(assinar({ e: "a@x.com", x: 999 }), "seg", 1000)).toBeNull();
    expect(verificarPasse(assinar({ e: "a@x.com", x: 1060 }, "outro"), "seg", 1000)).toBeNull();
    expect(verificarPasse(assinar({ e: "a@x.com", x: 1060 }), "", 1000)).toBeNull();
    expect(verificarPasse("abc", "seg", 1000)).toBeNull();
    expect(verificarPasse(null, "seg", 1000)).toBeNull();
  });
  it("validade longa demais (mais de 5 min a frente) e' recusada", () => {
    expect(verificarPasse(assinar({ e: "a@x.com", x: 1000 + 301 }), "seg", 1000)).toBeNull();
  });
  it("corpo adulterado (troca de email) nao passa", () => {
    const [, sig] = assinar({ e: "a@x.com", x: 1060 }).split(".");
    expect(verificarPasse(`${b64(JSON.stringify({ e: "chefe@x.com", x: 1060 }))}.${sig}`, "seg", 1000)).toBeNull();
  });
});
