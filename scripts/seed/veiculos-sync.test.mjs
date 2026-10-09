import { describe, it, expect } from "vitest";
import { sincronizarVeiculo } from "./veiculos-sync.mjs";

// Banco falso: guarda a tabela veiculos em memoria e imita UNIQUE(placa) e
// UNIQUE(cliente_id, cv) -- o que a sincronizacao real encontra.
function bancoFalso(linhas) {
  const t = linhas.map((l) => ({ ...l }));
  const unica = (placa, cv) => t.find((l) => l.placa === placa && l.cv !== cv);
  const client = {
    consultas: 0,
    async query(sql, params) {
      this.consultas++;
      if (/INSERT INTO veiculos/.test(sql)) {
        const [clienteId, cv, placa] = params;
        const existente = t.find((l) => l.cliente_id === clienteId && l.cv === cv);
        if (unica(placa, cv)) { const e = new Error('duplicate key value violates unique constraint "veiculos_placa_key"'); e.code = "23505"; e.constraint = "veiculos_placa_key"; throw e; }
        if (!existente) { t.push({ id: `n${t.length}`, cliente_id: clienteId, cv, placa, ativo: true }); return { rows: [{ id: "x", foi_insercao: true }] }; }
        if (existente.placa === placa) return { rows: [] };
        existente.placa = placa; return { rows: [{ id: existente.id, foi_insercao: false }] };
      }
      if (/SELECT id, cv, ativo FROM veiculos WHERE placa/.test(sql)) {
        return { rows: t.filter((l) => l.placa === params[0]).map(({ id, cv, ativo }) => ({ id, cv, ativo })) };
      }
      if (/UPDATE veiculos SET placa/.test(sql)) {
        const l = t.find((x) => x.id === params[1]); l.placa = params[0]; return { rows: [] };
      }
      throw new Error("consulta inesperada: " + sql);
    },
  };
  return { client, t };
}

const base = { clienteId: "c1", grupo: null };

describe("sincronizarVeiculo", () => {
  it("veiculo novo: insere", async () => {
    const { client, t } = bancoFalso([]);
    expect(await sincronizarVeiculo(client, { ...base, cv: "1", placa: "AAA-1A11" })).toBe("inserido");
    expect(t).toHaveLength(1);
  });
  it("mesma placa: nada a fazer", async () => {
    const { client } = bancoFalso([{ id: "a", cliente_id: "c1", cv: "1", placa: "AAA-1A11", ativo: true }]);
    expect(await sincronizarVeiculo(client, { ...base, cv: "1", placa: "AAA-1A11" })).toBe("igual");
  });
  it("Unitrac renomeou: atualiza a placa do mesmo cv", async () => {
    const { client, t } = bancoFalso([{ id: "a", cliente_id: "c1", cv: "1", placa: "AAA-1A11", ativo: true }]);
    expect(await sincronizarVeiculo(client, { ...base, cv: "1", placa: "AAA-1A12" })).toBe("atualizado");
    expect(t[0].placa).toBe("AAA-1A12");
  });
  it("RQO9H37 (09/10): nome novo esta' com um cadastro INATIVO de outro cv -> renomeia o inativo e atualiza", async () => {
    const { client, t } = bancoFalso([
      { id: "morto", cliente_id: "c1", cv: "24138", placa: "RQO-9H37", ativo: false },
      { id: "vivo", cliente_id: "c1", cv: "24343", placa: "RQ0-9H37", ativo: true },
    ]);
    expect(await sincronizarVeiculo(client, { ...base, cv: "24343", placa: "RQO-9H37" })).toBe("atualizado_renomeando_inativo");
    expect(t.find((l) => l.id === "vivo").placa).toBe("RQO-9H37");
    expect(t.find((l) => l.id === "morto").placa).toBe("RQO-9H37-INATIVO-CV24138");
  });
  it("nome novo esta' com um cadastro ATIVO de outro cv: nao mexe, devolve erro claro", async () => {
    const { client, t } = bancoFalso([
      { id: "a", cliente_id: "c1", cv: "10", placa: "ZZZ-9Z99", ativo: true },
      { id: "b", cliente_id: "c1", cv: "11", placa: "YYY-8Y88", ativo: true },
    ]);
    await expect(sincronizarVeiculo(client, { ...base, cv: "11", placa: "ZZZ-9Z99" })).rejects.toThrow(/ZZZ-9Z99.*cv 10.*ativo/);
    expect(t.map((l) => l.placa)).toEqual(["ZZZ-9Z99", "YYY-8Y88"]);
  });
});
