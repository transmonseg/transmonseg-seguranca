// Plano mestre 23/10, F2-02 (GEO-21) e F2-04 (KRQ-03, MON-01, MON-10).
// Casos reais de romaneio_pontos (producao, so' leitura em 24/10).
import { describe, it, expect } from "vitest";
import {
  montarEnderecoRQ, lerLinhasRQ, planejarDiaRQ, ehPontoRQ, enviadoPorRQ, ehEnviadoPorRQ,
  agruparPorColunas, ENVIADO_POR_RQ_ANTIGO, motivoParaNaoSubstituirRQ, type PontoRQ,
} from "./romaneio-rioquality";
import {
  extrairCidadeDoEndereco, extrairNumeroDoEndereco, extrairBairroDoEndereco, expandirCidadeTruncada, municipioCodigoIbge,
} from "./romaneio-geocode-local";

describe("montarEnderecoRQ (F2-02, GEO-21)", () => {
  it('"RUA DOUTOR SOUZA NUNES, VALENCA - RJ" deixava num="VALENCA" e cidade null; o texto novo da cidade e municipio certos', () => {
    // como chegava ate' 23/10 (enviar-monitoramento-rq.ts juntava rua, bairro vazio e "cidade - UF")
    expect(extrairNumeroDoEndereco("RUA DOUTOR SOUZA NUNES, VALENCA - RJ")).toBe("VALENCA");
    expect(extrairCidadeDoEndereco("RUA DOUTOR SOUZA NUNES, VALENCA - RJ")).toBeNull();
    const e = montarEnderecoRQ({ rua: "RUA DOUTOR SOUZA NUNES", bairro: "", cidade: "VALENCA", uf: "RJ" });
    expect(e).toBe("RUA DOUTOR SOUZA NUNES, - , VALENCA - RJ");
    expect(extrairNumeroDoEndereco(e)).toBeNull();
    expect(extrairCidadeDoEndereco(e)).toBe("VALENCA");
    expect(municipioCodigoIbge(expandirCidadeTruncada(extrairCidadeDoEndereco(e)!))).toBe("3306107");
  });

  it("AVENIDA SERGIPE, RESENDE (ponto caiu em Sergipe, -11,00/-37,10): cidade Resende, com bairro quando vier", () => {
    const e = montarEnderecoRQ({ rua: "AVENIDA SERGIPE", bairro: "CAMPOS ELISEOS", cidade: "RESENDE", uf: "RJ" });
    expect(e).toBe("AVENIDA SERGIPE, - CAMPOS ELISEOS, RESENDE - RJ");
    expect(extrairCidadeDoEndereco(e)).toBe("RESENDE");
    expect(extrairBairroDoEndereco(e)).toBe("CAMPOS ELISEOS");
    expect(municipioCodigoIbge(expandirCidadeTruncada("RESENDE"))).toBe("3304201");
  });

  it("numero e CEP entram onde o parser procura", () => {
    const e = montarEnderecoRQ({ rua: "RUA X", numero: "42", bairro: "CENTRO", cidade: "MAGE", uf: "RJ", cep: "25900-000" });
    expect(e).toBe("RUA X, 42 - CENTRO, MAGE - RJ - 25900000");
    expect(extrairNumeroDoEndereco(e)).toBe("42");
    expect(extrairCidadeDoEndereco(e)).toBe("MAGE");
  });
});

describe("lerLinhasRQ", () => {
  it("campos estruturados tem preferencia; formato antigo (enderecoBruto) continua aceito; coordenada fora do Brasil e' descartada", () => {
    const r = lerLinhasRQ([
      { placa: "LUI1G55", nf: "6079976", pedidoErp: "6079976", clienteNome: "ELIZABETH", rua: "AVENIDA SERGIPE", bairro: "", cidade: "RESENDE", uf: "RJ", enderecoBruto: "AVENIDA SERGIPE, RESENDE - RJ", lat: -22.47, lng: -44.45 },
      { placa: "LNH9C10", nf: "6072109", clienteNome: "LEONARDO", enderecoBruto: "RUA DOUTOR SOUZA NUNES, VALENCA - RJ" },
      { placa: "LNH9C10", nf: "1", enderecoBruto: "x", lat: 50, lng: 10 },
      { placa: "", nf: "2" },
      { placa: "AAA1A11" },
    ]);
    expect(r).toHaveLength(3);
    expect(r[0]).toMatchObject({ placa: "LUI-1G55", nf: "6079976", pedidoErp: "6079976", enderecoBruto: "AVENIDA SERGIPE, - , RESENDE - RJ", lat: -22.47, lng: -44.45 });
    expect(r[1]).toMatchObject({ placa: "LNH-9C10", enderecoBruto: "RUA DOUTOR SOUZA NUNES, VALENCA - RJ", pedidoErp: null, lat: null });
    expect(r[2]).toMatchObject({ lat: null, lng: null, clienteNome: "" });
  });

  it("NF repetida ganha sufixo -2 (mesma regra do KPI)", () => {
    const r = lerLinhasRQ([{ placa: "AAA1A11", nf: "9", rua: "R" }, { placa: "BBB2B22", nf: "9", rua: "R" }]);
    expect(r.map(l => l.nf)).toEqual(["9", "9-2"]);
  });
});

describe("enviado_por da RQ", () => {
  it("marca propria (a Nutry usa '<email> (pelo Ao vivo do KPI)') e reconhece o antigo cron-fusion", () => {
    expect(enviadoPorRQ("erica@x.com")).toBe("erica@x.com (Rio Quality pelo Ao vivo do KPI)");
    expect(ehEnviadoPorRQ(enviadoPorRQ("cron-fusion"))).toBe(true);
    expect(ehEnviadoPorRQ(ENVIADO_POR_RQ_ANTIGO)).toBe(true);
    expect(ehEnviadoPorRQ("transmonseg.25@gmail.com (pelo Ao vivo do KPI)")).toBe(false);
    expect(ehEnviadoPorRQ(null)).toBe(false);
  });

  it("ponto da RQ = frota da RQ ou enviado por esta ponte; Nutry sem veiculo nunca", () => {
    const frota = new Set(["v-rq"]);
    expect(ehPontoRQ({ veiculo_id: "v-rq", enviado_por: "Elloisy.Salles" }, frota)).toBe(true);
    expect(ehPontoRQ({ veiculo_id: null, enviado_por: ENVIADO_POR_RQ_ANTIGO }, frota)).toBe(true);
    expect(ehPontoRQ({ veiculo_id: null, enviado_por: "transmonseg.25@gmail.com (pelo Ao vivo do KPI)" }, frota)).toBe(false);
    expect(ehPontoRQ({ veiculo_id: "v-nutry", enviado_por: "reparo-automatico (pelo Ao vivo do KPI)" }, frota)).toBe(false);
  });
});

const ponto = (o: Partial<PontoRQ> & { id: string }): PontoRQ => ({
  placa: "LUI-1G55", nf: "6079976", pedido_erp: null, veiculo_id: "v-lui", cliente_codigo: "6079976",
  cliente_nome: "ELIZABETH DE ABREU LEITE ALMEIDA", endereco_bruto: "AVENIDA SERGIPE, RESENDE - RJ",
  lat: -11.0045812, lng: -37.1030405, geocode_status: "ok", presenca_confirmada_em: null,
  enviado_por: ENVIADO_POR_RQ_ANTIGO, criado_em: "2026-10-23T08:01:00Z", ...o,
});
const VEICULOS = new Map([["LUI-1G55", "v-lui"], ["LNH-9C10", "v-lnh"], ["LUN-8C28", "v-lun"]]);
const base = { data: "2026-10-23", veiculoPorPlaca: VEICULOS, enviadoPor: "erica@x.com (Rio Quality pelo Ao vivo do KPI)", comPedidoErp: false };

describe("planejarDiaRQ (F2-04)", () => {
  it("MON-10, 20/10 NF 6072109 em LNH-9C10 e LUN-8C28: fica 1 linha, a do carro da Fusion agora", () => {
    const p = planejarDiaRQ({ ...base, substituir: false,
      existentes: [
        ponto({ id: "a", placa: "LNH-9C10", veiculo_id: "v-lnh", nf: "6072109", cliente_codigo: "6072109", presenca_confirmada_em: "2026-10-20T13:00:00Z", criado_em: "2026-10-20T08:01:00Z", endereco_bruto: "RUA DOUTOR SOUZA NUNES, VALENCA - RJ" }),
        ponto({ id: "b", placa: "LUN-8C28", veiculo_id: "v-lun", nf: "6072109", cliente_codigo: "6072109", criado_em: "2026-10-20T12:45:00Z", endereco_bruto: "RUA DOUTOR SOUZA NUNES, VALENCA - RJ" }),
      ],
      linhas: lerLinhasRQ([{ placa: "LUN8C28", nf: "6072109", pedidoErp: "6072109", clienteCodigo: "6072109", clienteNome: "ELIZABETH DE ABREU LEITE ALMEIDA", enderecoBruto: "RUA DOUTOR SOUZA NUNES, VALENCA - RJ" }]),
    });
    expect(p.apagar).toEqual(["a"]);
    expect(p.inserir).toEqual([]);
    expect(p.atualizar).toEqual([]); // nada mudou na que ficou
  });

  it("reatribuicao: a NF so' existe no carro antigo -> troca placa/veiculo e zera a presenca (1 linha por NF)", () => {
    const p = planejarDiaRQ({ ...base, substituir: false,
      existentes: [ponto({ id: "a", placa: "LNH-9C10", veiculo_id: "v-lnh", presenca_confirmada_em: "2026-10-20T13:00:00Z" })],
      linhas: lerLinhasRQ([{ placa: "LUN8C28", nf: "6079976", clienteCodigo: "6079976", clienteNome: "ELIZABETH DE ABREU LEITE ALMEIDA", enderecoBruto: "AVENIDA SERGIPE, RESENDE - RJ" }]),
    });
    expect(p.apagar).toEqual([]);
    expect(p.atualizar).toEqual([expect.objectContaining({ id: "a", placa: "LUN-8C28", veiculo_id: "v-lun", presenca_confirmada_em: null })]);
    expect(p.atualizar[0]).not.toHaveProperty("lat"); // mesmo endereco: o ponto fica
  });

  it("upload manual de 23/10 substitui a versao da Fusion: casa pelo pedido, NF real, mesmo carro mantem presenca, coordenada do KPI", () => {
    const p = planejarDiaRQ({ ...base, substituir: true,
      existentes: [
        ponto({ id: "a", presenca_confirmada_em: "2026-10-23T14:00:00Z" }),
        ponto({ id: "sumiu", nf: "6080000", placa: "LNH-9C10", veiculo_id: "v-lnh" }),
        ponto({ id: "sem-veiculo", nf: "6080001", placa: "XYZ-1A23", veiculo_id: null }),
      ],
      linhas: lerLinhasRQ([
        { placa: "LUI1G55", nf: "5558902", pedidoErp: "6079976", clienteCodigo: "27946", clienteNome: "ELIZABETH DE ABREU LEITE ALMEIDA", rua: "AVENIDA SERGIPE", bairro: "CAMPOS ELISEOS", cidade: "RESENDE", uf: "RJ", lat: -22.4705, lng: -44.4471 },
        { placa: "LNH9C10", nf: "5559374", pedidoErp: "6081346", clienteNome: "LOJA NOVA", rua: "RUA Y", bairro: "B", cidade: "RIO DE JANEIRO", uf: "RJ" },
      ]),
    });
    expect(p.atualizar).toEqual([expect.objectContaining({
      id: "a", nf: "5558902", placa: "LUI-1G55", cliente_codigo: "27946", enviado_por: "erica@x.com (Rio Quality pelo Ao vivo do KPI)",
      endereco_bruto: "AVENIDA SERGIPE, - CAMPOS ELISEOS, RESENDE - RJ", lat: -22.4705, lng: -44.4471, geocode_status: "ok",
    })]);
    expect(p.atualizar[0]).not.toHaveProperty("presenca_confirmada_em");
    expect(p.inserir).toEqual([expect.objectContaining({ nf: "5559374", placa: "LNH-9C10", veiculo_id: "v-lnh", geocode_status: "pendente", lat: null, origem: "romaneio", modo_teste: false, romaneio_data: "2026-10-23" })]);
    expect(p.apagar.sort()).toEqual(["sem-veiculo", "sumiu"]);
  });

  it("endereco mudou sem coordenada do KPI: volta para a fila de geocode (o ponto velho era do endereco velho)", () => {
    const p = planejarDiaRQ({ ...base, substituir: false,
      existentes: [ponto({ id: "a" })],
      linhas: lerLinhasRQ([{ placa: "LUI1G55", nf: "6079976", clienteCodigo: "6079976", clienteNome: "ELIZABETH DE ABREU LEITE ALMEIDA", rua: "AVENIDA SERGIPE", cidade: "RESENDE", uf: "RJ" }]),
    });
    expect(p.atualizar).toEqual([expect.objectContaining({ id: "a", lat: null, lng: null, geocode_status: "pendente", geocode_tentativas: 0 })]);
  });

  it("pedido ERP guardado (depois da migration 089): a volta da manual para a Fusion casa pelo pedido", () => {
    const p = planejarDiaRQ({ ...base, comPedidoErp: true, substituir: true,
      existentes: [ponto({ id: "manual", nf: "5558902", pedido_erp: "6079976", enviado_por: "erica@x.com (Rio Quality pelo Ao vivo do KPI)" })],
      linhas: lerLinhasRQ([{ placa: "LUI1G55", nf: "6079976", pedidoErp: "6079976", clienteCodigo: "6079976", clienteNome: "ELIZABETH DE ABREU LEITE ALMEIDA", enderecoBruto: "AVENIDA SERGIPE, RESENDE - RJ" }]),
    });
    expect(p.apagar).toEqual([]);
    expect(p.inserir).toEqual([]);
    expect(p.atualizar).toEqual([expect.objectContaining({ id: "manual", nf: "6079976", pedido_erp: "6079976" })]);
  });

  // Revisao Fase 2 (F2-REV-01): com o pedido ERP em toda linha (KPI depois do
  // F2-04/D-21b), a 1a linha de um pedido repetido juntava como candidatas
  // TODAS as linhas do mesmo pedido: a presenca ia para a NF errada e as
  // linhas eram apagadas e reinseridas a cada tick.
  it("F2-REV-01, Fusion com o pedido repetido no dia (P e P-2): cada linha fica com a sua, presenca no lugar, plano vazio", () => {
    const p = planejarDiaRQ({ ...base, comPedidoErp: true, substituir: true,
      existentes: [
        ponto({ id: "A", nf: "6079976", pedido_erp: "6079976", criado_em: "2026-10-23T08:01:00Z" }),
        ponto({ id: "C", nf: "6079976-2", pedido_erp: "6079976", presenca_confirmada_em: "2026-10-23T14:00:00Z", criado_em: "2026-10-23T08:01:00Z" }),
      ],
      linhas: lerLinhasRQ([
        { placa: "LUI1G55", nf: "6079976", pedidoErp: "6079976", clienteCodigo: "6079976", clienteNome: "ELIZABETH DE ABREU LEITE ALMEIDA", enderecoBruto: "AVENIDA SERGIPE, RESENDE - RJ" },
        { placa: "LUI1G55", nf: "6079976", pedidoErp: "6079976", clienteCodigo: "6079976", clienteNome: "ELIZABETH DE ABREU LEITE ALMEIDA", enderecoBruto: "AVENIDA SERGIPE, RESENDE - RJ" },
      ]),
    });
    expect(p).toEqual({ inserir: [], atualizar: [], apagar: [] });
  });

  it("F2-REV-01, planilha manual com o pedido partido em 2 NFs (N1, N2): a presenca de N2 nao passa para N1", () => {
    const p = planejarDiaRQ({ ...base, comPedidoErp: true, substituir: true,
      existentes: [
        ponto({ id: "A", nf: "5558902", pedido_erp: "6079976", enviado_por: "erica@x.com (Rio Quality pelo Ao vivo do KPI)" }),
        ponto({ id: "C", nf: "5558903", pedido_erp: "6079976", presenca_confirmada_em: "2026-10-23T14:00:00Z", enviado_por: "erica@x.com (Rio Quality pelo Ao vivo do KPI)" }),
      ],
      linhas: lerLinhasRQ([
        { placa: "LUI1G55", nf: "5558902", pedidoErp: "6079976", clienteCodigo: "6079976", clienteNome: "ELIZABETH DE ABREU LEITE ALMEIDA", enderecoBruto: "AVENIDA SERGIPE, RESENDE - RJ" },
        { placa: "LUI1G55", nf: "5558903", pedidoErp: "6079976", clienteCodigo: "6079976", clienteNome: "ELIZABETH DE ABREU LEITE ALMEIDA", enderecoBruto: "AVENIDA SERGIPE, RESENDE - RJ" },
      ]),
    });
    expect(p.apagar).toEqual([]);
    expect(p.inserir).toEqual([]);
    // enviado_por igual nao entra no "mudou": nada a atualizar
    expect(p.atualizar).toEqual([]);
  });

  it("F2-REV-01, volta da manual (N1, N2 do pedido P) para a Fusion (P, P-2): uma NF por linha, nada apagado nem inserido", () => {
    const p = planejarDiaRQ({ ...base, comPedidoErp: true, substituir: true,
      existentes: [
        ponto({ id: "A", nf: "5558902", pedido_erp: "6079976", presenca_confirmada_em: "2026-10-23T14:00:00Z", enviado_por: "erica@x.com (Rio Quality pelo Ao vivo do KPI)" }),
        ponto({ id: "C", nf: "5558903", pedido_erp: "6079976", enviado_por: "erica@x.com (Rio Quality pelo Ao vivo do KPI)" }),
      ],
      linhas: lerLinhasRQ([
        { placa: "LUI1G55", nf: "6079976", pedidoErp: "6079976", clienteCodigo: "6079976", clienteNome: "ELIZABETH DE ABREU LEITE ALMEIDA", enderecoBruto: "AVENIDA SERGIPE, RESENDE - RJ" },
        { placa: "LUI1G55", nf: "6079976", pedidoErp: "6079976", clienteCodigo: "6079976", clienteNome: "ELIZABETH DE ABREU LEITE ALMEIDA", enderecoBruto: "AVENIDA SERGIPE, RESENDE - RJ" },
      ]),
    });
    expect(p.apagar).toEqual([]);
    expect(p.inserir).toEqual([]);
    expect(p.atualizar.map(a => [a.id, a.nf]).sort()).toEqual([["A", "6079976"], ["C", "6079976-2"]]);
  });

  it("F2-REV-01, pedido unico na Fusion em 2 placas (antes da 089) e a planilha manual com a NF real: continua 1 linha so'", () => {
    const p = planejarDiaRQ({ ...base, substituir: true,
      existentes: [
        ponto({ id: "a", placa: "LNH-9C10", veiculo_id: "v-lnh", nf: "6072109", presenca_confirmada_em: "2026-10-20T13:00:00Z" }),
        ponto({ id: "b", placa: "LUN-8C28", veiculo_id: "v-lun", nf: "6072109" }),
      ],
      linhas: lerLinhasRQ([{ placa: "LUN8C28", nf: "5557757", pedidoErp: "6072109", clienteCodigo: "6072109", clienteNome: "ELIZABETH DE ABREU LEITE ALMEIDA", enderecoBruto: "AVENIDA SERGIPE, RESENDE - RJ" }]),
    });
    expect(p.apagar).toEqual(["a"]);
    expect(p.inserir).toEqual([]);
    expect(p.atualizar).toEqual([expect.objectContaining({ id: "b", nf: "5557757" })]);
  });

  it("sem substituir, o que nao veio fica (formato antigo do KPI)", () => {
    const p = planejarDiaRQ({ ...base, substituir: false, existentes: [ponto({ id: "a" })], linhas: [] });
    expect(p).toEqual({ inserir: [], atualizar: [], apagar: [] });
  });
});

describe("motivoParaNaoSubstituirRQ (revisao Fase 2, F2-04-a)", () => {
  // Envio vazio (planilha com cabecalho certo e celulas de placa vazias) ou
  // encolhido (resposta anomala da Fusion sem rows num romaneio) apagava o
  // dia da RQ inteiro, com a presenca, e a rota respondia ok.
  const doDia = (n: number, dup = 0) => [
    ...Array.from({ length: n }, (_, i) => ponto({ id: `e${i}`, nf: String(6080000 + i) })),
    // "NF em 2 placas" (pre-089): a mesma NF em outra linha nao conta duas vezes
    ...Array.from({ length: dup }, (_, i) => ponto({ id: `d${i}`, nf: String(6080000 + i), placa: "LUN-8C28" })),
  ];
  const linhas = (n: number) => lerLinhasRQ(Array.from({ length: n }, (_, i) => ({ placa: "LNH9C10", nf: String(5550000 + i), rua: "R" })));

  it("envio sem linhas com o dia ja' preenchido: recusa", () => {
    expect(motivoParaNaoSubstituirRQ(doDia(2), [])).toMatch(/sem linhas/);
  });
  it("envio com menos da metade das NFs do dia: recusa (2.824 linhas em 23/10)", () => {
    expect(motivoParaNaoSubstituirRQ(doDia(100), linhas(49))).toMatch(/49 NF.*100 NF/);
  });
  it("metade ou mais: substitui (troca Fusion -> planilha com outras NFs)", () => {
    expect(motivoParaNaoSubstituirRQ(doDia(100), linhas(50))).toBeNull();
  });
  it("NF em 2 placas nao infla o dia: 100 NFs em 180 linhas, envio de 60 substitui", () => {
    expect(motivoParaNaoSubstituirRQ(doDia(100, 80), linhas(60))).toBeNull();
  });
  it("dia pequeno (menos de 20 NFs) so' recusa o envio vazio", () => {
    expect(motivoParaNaoSubstituirRQ(doDia(3), linhas(1))).toBeNull();
  });
  it("dia vazio: nada a proteger", () => {
    expect(motivoParaNaoSubstituirRQ([], [])).toBeNull();
  });
});

describe("agruparPorColunas", () => {
  it("lotes com as mesmas colunas", () => {
    expect(agruparPorColunas([{ id: 1, a: 1 }, { a: 2, id: 2 }, { id: 3, b: 1 }])).toEqual([[{ id: 1, a: 1 }, { a: 2, id: 2 }], [{ id: 3, b: 1 }]]);
  });
});
