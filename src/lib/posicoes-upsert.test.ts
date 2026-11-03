// RAS-05 (auditoria 03/11): upsert de posicoes_atuais sem guarda de ordem --
// leitura velha que chegasse depois de uma nova sobrescrevia. A guarda roda
// no ON CONFLICT ... WHERE. Conferida contra Postgres 17 real (docker, ver
// commit); aqui o teste avalia a mesma regra em JS e confere o SQL.
import { describe, it, expect } from "vitest";
import { SQL_GUARDA_ORDEM_DATAGPS, aceitaLeitura } from "./posicoes-upsert";

const t = (iso: string) => new Date(iso);

describe("guarda de ordem do datagps no upsert", () => {
  const atual = { datagps: t("2026-11-03T14:10:00Z"), updated_at: t("2026-11-03T17:10:00Z") }; // mascarado -3 h, como hoje
  it("datagps menor não sobrescreve", () => {
    expect(aceitaLeitura(atual, { datagps: t("2026-11-03T14:05:00Z"), updated_at: t("2026-11-03T17:10:30Z") })).toBe(false);
  });
  it("datagps igual ou maior sobrescreve", () => {
    expect(aceitaLeitura(atual, { datagps: t("2026-11-03T14:10:00Z"), updated_at: t("2026-11-03T17:10:30Z") })).toBe(true);
    expect(aceitaLeitura(atual, { datagps: t("2026-11-03T14:11:00Z"), updated_at: t("2026-11-03T17:10:30Z") })).toBe(true);
  });
  it("marco gravado implausível (fallback = hora da gravação) não trava o carro", () => {
    const fallback = { datagps: t("2026-11-03T17:10:00Z"), updated_at: t("2026-11-03T17:10:00Z") };
    expect(aceitaLeitura(fallback, { datagps: t("2026-11-03T14:10:30Z"), updated_at: t("2026-11-03T17:10:30Z") })).toBe(true);
  });
  it("linha parada há mais de 30 min aceita de novo (escape de relógio do aparelho errado)", () => {
    expect(aceitaLeitura(atual, { datagps: t("2026-11-03T14:05:00Z"), updated_at: t("2026-11-03T17:41:00Z") })).toBe(true);
  });
  it("datagps nulo de qualquer lado não bloqueia", () => {
    expect(aceitaLeitura({ datagps: null, updated_at: atual.updated_at }, { datagps: t("2026-11-03T14:05:00Z"), updated_at: t("2026-11-03T17:10:30Z") })).toBe(true);
    expect(aceitaLeitura(atual, { datagps: null, updated_at: t("2026-11-03T17:10:30Z") })).toBe(true);
  });
  it("o SQL tem a mesma regra", () => {
    expect(SQL_GUARDA_ORDEM_DATAGPS).toContain("EXCLUDED.datagps >= posicoes_atuais.datagps");
    expect(SQL_GUARDA_ORDEM_DATAGPS).toContain("posicoes_atuais.datagps >= posicoes_atuais.updated_at");
    expect(SQL_GUARDA_ORDEM_DATAGPS).toContain("interval '30 minutes'");
  });
});
