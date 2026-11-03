import { describe, it, expect } from "vitest";
import {
  montarTextoRelatorioDiario,
  agruparRelatorioPorCliente,
  SQL_RELATORIO_ALERTAS_ROMANEIO,
  SQL_RELATORIO_DISPAROS_ROMANEIO,
} from "./relatorio-diario-desvio";

// DSV-02 (auditoria 03/11): o relatorio das 22 h contava a Central Unitrac
// (tabela `alertas`, so' Nutry). Agora conta a Central Romaneio, por cliente.
describe("montarTextoRelatorioDiario (Central Romaneio, por cliente)", () => {
  const nutry = { cliente: "Nutry Max", alertas: 48, porTipo: { desvio: 48, parada_anomala: 61 }, falsoPositivo: 2, resolvido: 5, veiculos: 48, disparos: 296, episodios: 175 };
  const rq = { cliente: "Rio Quality", alertas: 69, porTipo: { desvio: 69 }, falsoPositivo: 0, resolvido: 0, veiculos: 69, disparos: 410, episodios: 298 };

  it("Nutry e RQ aparecem com nome e totais", () => {
    const t = montarTextoRelatorioDiario([nutry, rq], { dia: "2026-10-30", commits: [] });
    expect(t).toContain("Central Romaneio");
    expect(t).toContain("2026-10-30");
    expect(t).toContain("Nutry Max");
    expect(t).toContain("Rio Quality");
    expect(t).toContain("Alertas: 48");
    expect(t).toContain("Alertas: 69");
    expect(t).toContain("desvio 48");
    expect(t).toContain("parada_anomala 61");
    expect(t).toContain("Disparos de desvio: 296");
    expect(t).toContain("Episódios de desvio: 175");
    expect(t).toContain("Falso positivo: 2");
    expect(t).toContain("Resolvidos: 5");
    expect(t).not.toContain("— Nutry Max —");
  });

  it("cliente sem alerta no dia continua listado", () => {
    const t = montarTextoRelatorioDiario([{ ...rq, alertas: 0, porTipo: {}, veiculos: 0, disparos: 0, episodios: 0 }]);
    expect(t).toContain("Rio Quality");
    expect(t).toContain("Alertas: 0");
  });

  it("commits do dia saem no fim", () => {
    const t = montarTextoRelatorioDiario([nutry], { dia: "2026-10-30", commits: [{ hash: "abc", mensagem: "fix(desvio): x" }] });
    expect(t).toContain("- fix(desvio): x");
    expect(montarTextoRelatorioDiario([nutry], { dia: "2026-10-30", commits: [] })).toContain("Nenhuma mudança no motor de desvio hoje.");
  });
});

describe("consultas do relatorio", () => {
  it("leem alertas_romaneio (sem sombra) e alertas_romaneio_disparos, nunca a Central Unitrac", () => {
    expect(SQL_RELATORIO_ALERTAS_ROMANEIO).toMatch(/FROM alertas_romaneio\b/);
    expect(SQL_RELATORIO_ALERTAS_ROMANEIO).toMatch(/sombra = false/);
    expect(SQL_RELATORIO_DISPAROS_ROMANEIO).toMatch(/FROM alertas_romaneio_disparos\b/);
    for (const sql of [SQL_RELATORIO_ALERTAS_ROMANEIO, SQL_RELATORIO_DISPAROS_ROMANEIO]) {
      expect(sql).not.toMatch(/FROM alertas\s/);
      expect(sql).not.toMatch(/desvio_disparo_log/);
    }
  });

  it("agrupa as linhas por cliente, com os clientes sem nada no dia", () => {
    const r = agruparRelatorioPorCliente(
      [{ id: "n", nome: "Nutry Max" }, { id: "r", nome: "Rio Quality" }],
      [
        { cliente_id: "n", tipo: "desvio", status: "ativo", n: "40", veiculos_desvio: "41" },
        { cliente_id: "n", tipo: "desvio", status: "falso_positivo", n: "2", veiculos_desvio: "41" },
        { cliente_id: "n", tipo: "parada_anomala", status: "resolvido", n: "5", veiculos_desvio: "41" },
      ],
      [{ cliente_id: "n", disparos: "296", episodios: "175" }],
    );
    expect(r).toEqual([
      { cliente: "Nutry Max", alertas: 47, porTipo: { desvio: 42, parada_anomala: 5 }, falsoPositivo: 2, resolvido: 5, veiculos: 41, disparos: 296, episodios: 175 },
      { cliente: "Rio Quality", alertas: 0, porTipo: {}, falsoPositivo: 0, resolvido: 0, veiculos: 0, disparos: 0, episodios: 0 },
    ]);
  });
});
