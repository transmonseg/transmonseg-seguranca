import { describe, it, expect } from "vitest";
import {
  verificarFingerprintPinado,
  calcularFingerprintSha256,
  PINNED_FINGERPRINT_SHA256,
} from "./fetch-contabo";

describe("verificarFingerprintPinado (TLS certificate pinning do Contabo)", () => {
  it("rejeita um certificado com fingerprint diferente do fixado (ex.: atacante ativo apresentando outro cert)", () => {
    const certFalso = { raw: Buffer.from("certificado-de-um-atacante-qualquer") };

    const resultado = verificarFingerprintPinado(certFalso);

    expect(resultado).toBeInstanceOf(Error);
    expect((resultado as Error).message).toContain("nao bate com o fingerprint fixado");
  });

  it("aceita quando o fingerprint calculado do certificado bate com o esperado", () => {
    // Simula receber exatamente o certificado do Contabo: o fingerprint
    // "esperado" passado eh o mesmo que o buffer realmente produz.
    const certCerto = { raw: Buffer.from("simulacao-do-certificado-real-do-contabo") };
    const fingerprintDoCertCerto = calcularFingerprintSha256(certCerto.raw);

    const resultado = verificarFingerprintPinado(certCerto, fingerprintDoCertCerto);

    expect(resultado).toBeUndefined();
  });

  it("o fingerprint fixado em producao tem o formato esperado (32 bytes hex maiusculo, separados por ':')", () => {
    expect(PINNED_FINGERPRINT_SHA256).toMatch(/^([0-9A-F]{2}:){31}[0-9A-F]{2}$/);
  });
});

describe("calcularFingerprintSha256", () => {
  it("eh deterministico -- o mesmo buffer sempre produz o mesmo fingerprint", () => {
    const cert = Buffer.from("mesmo-certificado-duas-vezes");
    expect(calcularFingerprintSha256(cert)).toBe(calcularFingerprintSha256(cert));
  });

  it("buffers diferentes produzem fingerprints diferentes", () => {
    const a = calcularFingerprintSha256(Buffer.from("certificado-a"));
    const b = calcularFingerprintSha256(Buffer.from("certificado-b"));
    expect(a).not.toBe(b);
  });
});
