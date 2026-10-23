import { describe, it, expect } from "vitest";
import { compactarPlaca, placasOrigemCompactas, executarTrocaVeiculo, type ClienteSql } from "./troca-veiculo";

// F1-05 (ING-01, MON-02): a troca do Ao vivo manda placaDe SEM hifen
// ("RQO5E38") e o upload grava COM hifen ("RQO-5E38"). Com a placa fora do
// cadastro, o .in("placa", ["RQO5E38"]) nao casava nada e a rota dizia ok.
// Agora a origem e' casada pela placa compacta (so' A-Z0-9) no banco.
describe("compactarPlaca", () => {
  it("tira hifen, espaco e caixa", () => {
    expect(compactarPlaca(" rqo-5e38 ")).toBe("RQO5E38");
  });
});

describe("placasOrigemCompactas", () => {
  const cadastro = new Set(["TOS5E38", "RQO9H37", "TUI0H19", "ABC1O23", "ABC1023"]);

  it("placa fora do cadastro (RQO5E38, 23/10): a propria placa compacta entra", () => {
    const r = placasOrigemCompactas("RQO5E38", cadastro, "TOS5E38");
    expect(r).toContain("RQO5E38");
  });

  it("LLD4202 fora do cadastro (21/10): casa as linhas gravadas LLD-4202", () => {
    expect(placasOrigemCompactas("LLD4202", cadastro, "TUI0H19")).toContain("LLD4202");
  });

  it("variante O/0 nao cadastrada entra (linhas gravadas como RQ0-9H37 em 06-08/10)", () => {
    const r = placasOrigemCompactas("RQO9H37", cadastro, "TOS5E38");
    expect(r).toEqual(expect.arrayContaining(["RQO9H37", "RQ09H37"]));
  });

  it("placa do documento com zero acha o carro do cadastro pela variante O/0", () => {
    const r = placasOrigemCompactas("RQ0-9H37", cadastro, "TOS5E38");
    expect(r).toEqual(expect.arrayContaining(["RQ09H37", "RQO9H37"]));
  });

  it("variante O/0 que e' OUTRO carro do cadastro nunca entra (nao chuta)", () => {
    const r = placasOrigemCompactas("ABC1O23", cadastro, "TOS5E38");
    expect(r).toContain("ABC1O23");
    expect(r).not.toContain("ABC1023");
  });

  it("nunca inclui a placa de destino", () => {
    const r = placasOrigemCompactas("RQ05E38", new Set(["RQO5E38"]), "RQO5E38");
    expect(r).not.toContain("RQO5E38");
  });
});

type Chamada = { sql: string; params: unknown[] };
function clienteFalso(respostas: Record<string, { rows: unknown[] } | Error>) {
  const chamadas: Chamada[] = [];
  const cliente: ClienteSql = {
    async query(sql: string, params: unknown[] = []) {
      chamadas.push({ sql, params });
      const chave = Object.keys(respostas).find((k) => sql.includes(k));
      const r = chave ? respostas[chave] : { rows: [] };
      if (r instanceof Error) throw r;
      return r as { rows: never[] };
    },
  };
  return { cliente, chamadas };
}

describe("executarTrocaVeiculo", () => {
  const para = { id: "v-tos", placa: "TOS-5E38" };

  it("caso real 23/10 RQO5E38 -> TOS5E38: as 8 linhas mudam em transacao, casando pela placa compacta", async () => {
    const origem = Array.from({ length: 8 }, (_, i) => ({ id: `p${i}`, veiculo_id: null }));
    const { cliente, chamadas } = clienteFalso({
      "FOR UPDATE": { rows: origem },
      "DELETE FROM romaneio_pontos": { rows: [] },
      "UPDATE romaneio_pontos": { rows: origem.map((o) => ({ id: o.id })) },
      "UPDATE alertas_romaneio": { rows: [] },
    });
    const r = await executarTrocaVeiculo(cliente, { data: "2026-10-23", origens: ["RQO5E38", "RQ05E38"], nfs: ["1", "2"], para });
    expect(r).toEqual({ movidos: 8, jaNoDestino: 0, desviosFechados: 0 });
    expect(chamadas[0].sql).toBe("BEGIN");
    expect(chamadas.at(-1)!.sql).toBe("COMMIT");
    const sel = chamadas.find((c) => c.sql.includes("FOR UPDATE"))!;
    expect(sel.sql).toContain("regexp_replace(upper(placa), '[^A-Z0-9]', '', 'g') = ANY($2::text[])");
    expect(sel.params).toEqual(["2026-10-23", ["RQO5E38", "RQ05E38"], ["1", "2"]]);
    const upd = chamadas.find((c) => c.sql.includes("UPDATE romaneio_pontos"))!;
    expect(upd.params).toEqual([origem.map((o) => o.id), "v-tos", "TOS-5E38"]);
  });

  it("0 linhas de origem com NFs: ROLLBACK e nada movido (a rota responde ok:false)", async () => {
    const { cliente, chamadas } = clienteFalso({ "FOR UPDATE": { rows: [] } });
    const r = await executarTrocaVeiculo(cliente, { data: "2026-10-23", origens: ["RQO5E38"], nfs: ["1"], para });
    expect(r).toEqual({ movidos: 0, jaNoDestino: 0, desviosFechados: 0 });
    expect(chamadas.map((c) => c.sql)).toContain("ROLLBACK");
    expect(chamadas.map((c) => c.sql)).not.toContain("COMMIT");
    expect(chamadas.some((c) => c.sql.includes("UPDATE romaneio_pontos"))).toBe(false);
  });

  it("NF que ja' esta no carro de destino (colisao DR-19): a linha velha sai, as outras mudam, nada de 500", async () => {
    const { cliente, chamadas } = clienteFalso({
      "FOR UPDATE": { rows: [{ id: "a", veiculo_id: "v-old" }, { id: "b", veiculo_id: "v-old" }] },
      "DELETE FROM romaneio_pontos": { rows: [{ id: "a" }] },
      "UPDATE romaneio_pontos": { rows: [{ id: "b" }] },
      "UPDATE alertas_romaneio": { rows: [{ id: "al1" }] },
    });
    const r = await executarTrocaVeiculo(cliente, { data: "2026-10-21", origens: ["LLD4202"], nfs: null, para });
    expect(r).toEqual({ movidos: 1, jaNoDestino: 1, desviosFechados: 1 });
    const upd = chamadas.find((c) => c.sql.includes("UPDATE romaneio_pontos"))!;
    expect(upd.params[0]).toEqual(["b"]);
  });

  it("fecha o desvio ATIVO do carro antigo daquele dia, como acao da maquina (auto_resolvido)", async () => {
    const { cliente, chamadas } = clienteFalso({
      "FOR UPDATE": { rows: [{ id: "a", veiculo_id: "v-old" }, { id: "b", veiculo_id: null }] },
      "UPDATE romaneio_pontos": { rows: [{ id: "a" }, { id: "b" }] },
      "UPDATE alertas_romaneio": { rows: [{ id: "al1" }] },
    });
    await executarTrocaVeiculo(cliente, { data: "2026-10-21", origens: ["LLD4202"], nfs: null, para, veiculosOrigemCadastro: ["v-cad"] });
    const al = chamadas.find((c) => c.sql.includes("UPDATE alertas_romaneio"))!;
    expect(al.sql).toContain("tipo = 'desvio'");
    expect(al.sql).toContain("status = 'ativo'");
    expect(al.sql).toContain("auto_resolvido");
    expect(al.sql).toContain("America/Sao_Paulo");
    expect((al.params[0] as string[]).sort()).toEqual(["v-cad", "v-old"]);
    expect(al.params[1]).toBe("2026-10-21");
  });

  it("nunca fecha desvio do proprio carro de destino", async () => {
    const { cliente, chamadas } = clienteFalso({
      "FOR UPDATE": { rows: [{ id: "a", veiculo_id: "v-tos" }] },
      "UPDATE romaneio_pontos": { rows: [{ id: "a" }] },
    });
    await executarTrocaVeiculo(cliente, { data: "2026-10-21", origens: ["X"], nfs: null, para });
    expect(chamadas.some((c) => c.sql.includes("UPDATE alertas_romaneio"))).toBe(false);
  });

  it("erro no meio: ROLLBACK e o erro sobe (nada pela metade)", async () => {
    const { cliente, chamadas } = clienteFalso({
      "FOR UPDATE": { rows: [{ id: "a", veiculo_id: null }] },
      "UPDATE romaneio_pontos": new Error("duplicate key"),
    });
    await expect(executarTrocaVeiculo(cliente, { data: "2026-10-21", origens: ["X"], nfs: null, para })).rejects.toThrow("duplicate key");
    expect(chamadas.map((c) => c.sql)).toContain("ROLLBACK");
    expect(chamadas.map((c) => c.sql)).not.toContain("COMMIT");
  });
});
