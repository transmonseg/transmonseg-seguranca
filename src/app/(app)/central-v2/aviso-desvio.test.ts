import { describe, it, expect } from "vitest";
import {
  AVISO_DESVIO_MS, proximoModo, rotuloPilula, textoAviso, novosDoLoteNoEscopo,
} from "./aviso-desvio";

const nome = (t: string) => ({ desvio: "Desvio em movimento", parada_sem_marcacao: "Parada sem marcação" } as Record<string, string>)[t] ?? t;

describe("AVISO_DESVIO_MS", () => {
  it("é 8 segundos", () => expect(AVISO_DESVIO_MS).toBe(8000));
});

describe("rotuloPilula", () => {
  it("n = 0 não renderiza nada", () => expect(rotuloPilula(0)).toBeNull());
  it("n > 0 mostra a contagem", () => expect(rotuloPilula(3)).toBe("Ver mais desvios (3)"));
});

describe("textoAviso", () => {
  it("1 desvio", () => {
    expect(textoAviso([{ placa: "RQU-9D10", tipo: "desvio" }], nome)).toBe("RQU-9D10 em desvio agora");
  });
  it("1 alerta de outro tipo usa o nome do tipo", () => {
    expect(textoAviso([{ placa: "TOS-4J82", tipo: "parada_sem_marcacao" }], nome)).toBe("TOS-4J82 · Parada sem marcação");
  });
  it("2 novos", () => {
    expect(textoAviso([{ placa: "A", tipo: "desvio" }, { placa: "B", tipo: "desvio" }], nome)).toBe("2 desvios novos: A, B");
  });
  it("3 novos cabem inteiros", () => {
    const n = ["A", "B", "C"].map(placa => ({ placa, tipo: "desvio" }));
    expect(textoAviso(n, nome)).toBe("3 desvios novos: A, B, C");
  });
  it("10 novos: 3 placas + e mais 7", () => {
    const n = "ABCDEFGHIJ".split("").map(placa => ({ placa, tipo: "desvio" }));
    expect(textoAviso(n, nome)).toBe("10 desvios novos: A, B, C e mais 7");
  });
});

describe("proximoModo", () => {
  it("novos a partir da pílula viram aviso", () => {
    expect(proximoModo("pilula", { tipo: "novos", quantidade: 1 }, 3)).toBe("aviso");
  });
  it("novos durante o aviso mantêm aviso (o timer é reiniciado pelo componente)", () => {
    expect(proximoModo("aviso", { tipo: "novos", quantidade: 2 }, 5)).toBe("aviso");
  });
  it("novos com a lista aberta não fecham a lista", () => {
    expect(proximoModo("lista", { tipo: "novos", quantidade: 1 }, 4)).toBe("lista");
  });
  it("lote vazio não muda nada", () => {
    expect(proximoModo("pilula", { tipo: "novos", quantidade: 0 }, 3)).toBe("pilula");
  });
  it("timeout do aviso volta pra pílula", () => {
    expect(proximoModo("aviso", { tipo: "timeout" }, 3)).toBe("pilula");
  });
  it("timeout com a lista aberta não fecha a lista", () => {
    expect(proximoModo("lista", { tipo: "timeout" }, 3)).toBe("lista");
  });
  it("clique na pílula ou no aviso abre a lista", () => {
    expect(proximoModo("pilula", { tipo: "clique" }, 3)).toBe("lista");
    expect(proximoModo("aviso", { tipo: "clique" }, 3)).toBe("lista");
  });
  it("clique com a lista aberta fecha", () => {
    expect(proximoModo("lista", { tipo: "clique" }, 3)).toBe("pilula");
  });
  it("fechar (Esc / clique fora / ver no mapa) volta pra pílula", () => {
    expect(proximoModo("lista", { tipo: "fechar" }, 3)).toBe("pilula");
  });
  it("n = 0 sempre volta pra pílula (que não renderiza), mesmo com a lista aberta", () => {
    expect(proximoModo("lista", { tipo: "timeout" }, 0)).toBe("pilula");
    expect(proximoModo("aviso", { tipo: "clique" }, 0)).toBe("pilula");
  });
});

describe("novosDoLoteNoEscopo", () => {
  const escopo = [{ id: "a" }, { id: "b" }, { id: "c" }];
  it("só devolve ids do lote que estão no escopo do painel", () => {
    expect(novosDoLoteNoEscopo(["b", "z"], escopo)).toEqual([{ id: "b" }]);
  });
  it("lote vazio (primeiro poll / nenhum novo) não devolve nada", () => {
    expect(novosDoLoteNoEscopo([], escopo)).toEqual([]);
  });
  it("mudar o escopo não inventa novos: só o lote decide", () => {
    const escopoMaior = [...escopo, { id: "d" }, { id: "e" }];
    expect(novosDoLoteNoEscopo([], escopoMaior)).toEqual([]);
  });
  it("mantém a ordem do escopo (mais novo primeiro)", () => {
    expect(novosDoLoteNoEscopo(["c", "a"], escopo)).toEqual([{ id: "a" }, { id: "c" }]);
  });
});
