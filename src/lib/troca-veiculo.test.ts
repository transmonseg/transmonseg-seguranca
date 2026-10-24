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
    const origem = Array.from({ length: 8 }, (_, i) => ({ id: `p${i}`, veiculo_id: null, nf: i < 4 ? "1" : "2" }));
    const { cliente, chamadas } = clienteFalso({
      "FOR UPDATE": { rows: origem },
      "DELETE FROM romaneio_pontos": { rows: [] },
      "UPDATE romaneio_pontos": { rows: origem.map((o) => ({ id: o.id })) },
      "UPDATE alertas_romaneio": { rows: [] },
    });
    const r = await executarTrocaVeiculo(cliente, { data: "2026-10-23", origens: ["RQO5E38", "RQ05E38"], nfs: ["1", "2"], para });
    expect(r).toEqual({ movidos: 8, jaNoDestino: 0, desviosFechados: 0, nfsNaoEncontradas: [] });
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
    expect(r).toEqual({ movidos: 0, jaNoDestino: 0, desviosFechados: 0, nfsNaoEncontradas: ["1"] });
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
    expect(r).toEqual({ movidos: 1, jaNoDestino: 1, desviosFechados: 1, nfsNaoEncontradas: [] });
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

  // Revisao F1-05 (R1): o KPI regrava a troca (troca/route.ts "Idempotencia:
  // limpa ... e regrava") e chama o MON de novo com as NFs do romaneio
  // original. Na 2a chamada as NFs ja estao no destino: nada na origem.
  it("troca refeita (as NFs ja estao todas no destino): ROLLBACK, conta jaNoDestino e nada falta", async () => {
    const { cliente, chamadas } = clienteFalso({
      "FOR UPDATE": { rows: [] },
      "SELECT DISTINCT nf": { rows: [{ nf: "2410175" }, { nf: "2410176" }] },
    });
    const r = await executarTrocaVeiculo(cliente, { data: "2026-10-07", origens: ["RQV5F67"], nfs: ["2410175", "2410176"], para });
    expect(r).toEqual({ movidos: 0, jaNoDestino: 2, desviosFechados: 0, nfsNaoEncontradas: [] });
    const dest = chamadas.find((c) => c.sql.includes("SELECT DISTINCT nf"))!;
    expect(dest.sql).toContain("regexp_replace(upper(placa), '[^A-Z0-9]', '', 'g') = $2");
    expect(dest.params).toEqual(["2026-10-07", "TOS5E38", ["2410175", "2410176"]]);
    expect(chamadas.map((c) => c.sql)).toContain("ROLLBACK");
    expect(chamadas.map((c) => c.sql)).not.toContain("COMMIT");
  });

  // Revisao F1-05 (R2): das N NFs da carga so' parte casava e a troca
  // respondia ok sem dizer quantas faltaram (falha silenciosa parcial).
  it("troca parcial: devolve as NFs que nao estao nem na origem nem no destino", async () => {
    const { cliente, chamadas } = clienteFalso({
      "FOR UPDATE": { rows: [{ id: "a", veiculo_id: "v-old", nf: "1" }, { id: "b", veiculo_id: "v-old", nf: "1" }, { id: "c", veiculo_id: "v-old", nf: "2" }] },
      "SELECT DISTINCT nf": { rows: [{ nf: "3" }] },
      "UPDATE romaneio_pontos": { rows: [{ id: "a" }, { id: "b" }, { id: "c" }] },
    });
    const r = await executarTrocaVeiculo(cliente, { data: "2026-10-23", origens: ["RQO5E38"], nfs: ["1", "2", "3", "4", "5", "4"], para });
    expect(r.movidos).toBe(3);
    expect(r.jaNoDestino).toBe(1);
    expect(r.nfsNaoEncontradas).toEqual(["4", "5"]);
    const dest = chamadas.find((c) => c.sql.includes("SELECT DISTINCT nf"))!;
    expect(dest.params[2]).toEqual(["3", "4", "5"]);
    expect(chamadas.at(-1)!.sql).toBe("COMMIT");
  });

  it("sem nfs (placa inteira): nunca consulta o destino e nada falta", async () => {
    const { cliente, chamadas } = clienteFalso({
      "FOR UPDATE": { rows: [{ id: "a", veiculo_id: null, nf: "1" }] },
      "UPDATE romaneio_pontos": { rows: [{ id: "a" }] },
    });
    const r = await executarTrocaVeiculo(cliente, { data: "2026-10-21", origens: ["X"], nfs: null, para });
    expect(r.nfsNaoEncontradas).toEqual([]);
    expect(chamadas.some((c) => c.sql.includes("SELECT DISTINCT nf"))).toBe(false);
  });
});
