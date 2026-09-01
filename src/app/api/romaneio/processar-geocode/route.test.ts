// Achado real 29/08 (varredura de sistema): a fase de fallback Unitrac
// (final de route.ts) so' pegava linhas 'falhou' com `veiculo_id IS NOT
// NULL`. Linhas com veiculo_id nulo (placa nao cadastrada NO MOMENTO do
// upload, ver romaneio/upload/route.ts) nunca entravam nem nessa fase nem
// na principal (que so' reprocessa pendente/processando) -- ficavam presas
// pra sempre, nunca chegando ao estado terminal `sem_coordenada_confirmada`
// que dispara revisao manual. Confirmado em producao (READ-ONLY): 305
// linhas assim, 283 das quais (93%) hoje JA tem um veiculo cadastrado com a
// mesma placa (cadastrado DEPOIS do upload do romaneio -- veiculo_id so' e'
// resolvido uma vez, no insert).
//
// Estes testes travam o fix: linhas orfas agora entram no MESMO orcamento
// de tentativas (geocode_tentativas/geocode_ultima_tentativa_em, migration
// contabo/061, reaproveitado -- nao duplicado) e primeiro tentam recasar a
// placa com um veiculo (consulta local, sem custo de API) antes de contar
// como tentativa "sem sucesso". So' quando o recasamento tambem falha e' que
// conta como tentativa igual ao fallback Unitrac de sempre, e so' esgota as
// tentativas (vira estado terminal) do mesmo jeito que as linhas com
// veiculo_id ja faziam -- nao ganham um orcamento mais curto nem mais longo.
//
// Estilo: mesma abordagem de src/app/api/romaneio/reverter/route.test.ts
// (mocka createAdminClient, chama POST direto) -- so' que aqui o admin
// mockado precisa rotear por tabela (romaneio_pontos, veiculos), porque a
// rota consulta varias.
import { describe, it, expect, vi, beforeEach } from "vitest";

type Resultado = { data: unknown; error: { message: string } | null };
type Operacao = { metodo: string; args: unknown[] };
type ChamadaFrom = { tabela: string; ops: Operacao[] };

const mockBuscarAlvos = vi.fn();
vi.mock("@/lib/unitrac", () => ({
  buscarAlvos: (...args: unknown[]) => mockBuscarAlvos(...args),
  deveCorrigirComRomaneio: vi.fn(() => false),
}));

// Achado real 01/09 (retentativa de texto no fallback Unitrac, ver route.ts):
// null por padrao -- simula "cascata de texto tambem falhou de novo",
// preservando o comportamento que os testes de fallback ja existentes
// (anteriores a esta mudanca) esperavam. Testes que querem exercitar a
// RETENTATIVA com sucesso sobrescrevem com mockResolvedValueOnce.
const mockGeocodificarEndereco = vi.fn().mockResolvedValue(null);
vi.mock("@/lib/romaneio-geocode", async () => {
  const real = await vi.importActual<typeof import("@/lib/romaneio-geocode")>("@/lib/romaneio-geocode");
  return {
    ...real,
    geocodificarEndereco: (...args: unknown[]) => mockGeocodificarEndereco(...args),
  };
});

let chamadas: ChamadaFrom[] = [];
let filaSelect: Record<string, Resultado[]> = {};

function fabricarAdmin() {
  const contadorSelect: Record<string, number> = {};
  return {
    from(tabela: string) {
      const ops: Operacao[] = [];
      chamadas.push({ tabela, ops });
      const builder: Record<string, unknown> = {};
      const encadear = (metodo: string) => (...args: unknown[]) => {
        ops.push({ metodo, args });
        return builder;
      };
      for (const m of ["select", "eq", "in", "lt", "gt", "or", "order", "limit", "not", "maybeSingle", "single", "upsert", "insert"]) {
        builder[m] = encadear(m);
      }
      builder.update = encadear("update");
      builder.then = (resolve: (v: Resultado) => unknown, reject: (e: unknown) => unknown) => {
        const ehSelect = ops[0]?.metodo === "select";
        let resultado: Resultado = { data: ehSelect ? [] : null, error: null };
        if (ehSelect) {
          const i = contadorSelect[tabela] ?? 0;
          contadorSelect[tabela] = i + 1;
          resultado = filaSelect[tabela]?.[i] ?? { data: [], error: null };
        }
        return Promise.resolve(resultado).then(resolve, reject);
      };
      return builder;
    },
    rpc: vi.fn().mockResolvedValue({ data: [], error: null }),
  };
}

vi.mock("@/lib/supabase/admin", () => ({
  createAdminClient: () => fabricarAdmin(),
}));

function updatesDe(tabela: string) {
  return chamadas
    .filter((c) => c.tabela === tabela && c.ops[0]?.metodo === "update")
    .map((c) => ({
      payload: c.ops[0].args[0] as Record<string, unknown>,
      id: (c.ops.find((o) => o.metodo === "eq" && o.args[0] === "id")?.args[1] as string) ?? null,
    }));
}

function requisicao() {
  return new Request("http://localhost/api/romaneio/processar-geocode", {
    method: "POST",
    headers: { "x-motor-key": "segredo-teste" },
  });
}

const MAX_TENTATIVAS = 10; // MAX_TENTATIVAS_FALLBACK_UNITRAC em route.ts -- nao exportado, ver comentario la'.

beforeEach(() => {
  vi.resetModules();
  vi.clearAllMocks();
  chamadas = [];
  filaSelect = {};
  process.env.MOTOR_SECRET = "segredo-teste";
  mockBuscarAlvos.mockResolvedValue([]);
});

describe("POST /api/romaneio/processar-geocode -- linhas 'falhou' com veiculo_id nulo (achado 29/08)", () => {
  it("placa orfa AGORA bate com veiculo cadastrado -- reata veiculo_id, NAO gasta tentativa", async () => {
    filaSelect["romaneio_pontos"] = [
      { data: [], error: null }, // candidatos (pendentes) -- vazio, nao interessa a este teste
      { data: [{ id: "p1", nf: "NF1", placa: "ABC1234", veiculo_id: null, geocode_tentativas: 0, endereco_bruto: "RUA TESTE, 1 - BAIRRO, CIDADE - *" }], error: null }, // comLimite
    ];
    filaSelect["veiculos"] = [{ data: [{ id: "v1", placa: "ABC1234" }], error: null }]; // rematch orfao

    const { POST } = await import("./route");
    const res = await POST(requisicao());
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.veiculoIdReatribuido).toBe(1);
    expect(body.esgotaramTentativas).toBe(0);

    const upd = updatesDe("romaneio_pontos");
    const reatado = upd.find((u) => u.id === "p1");
    expect(reatado?.payload).toEqual({ veiculo_id: "v1" });
    // Nao pode ter gasto tentativa nesta linha -- so' reatou.
    expect(upd.filter((u) => u.id === "p1")).toHaveLength(1);
  });

  it("placa orfa continua sem nenhum veiculo cadastrado -- conta tentativa (nao esgotada)", async () => {
    filaSelect["romaneio_pontos"] = [
      { data: [], error: null },
      { data: [{ id: "p2", nf: "NF2", placa: "ZZZ9999", veiculo_id: null, geocode_tentativas: 3, endereco_bruto: "RUA TESTE, 2 - BAIRRO, CIDADE - *" }], error: null },
    ];
    filaSelect["veiculos"] = [{ data: [], error: null }]; // nenhum veiculo com essa placa

    const { POST } = await import("./route");
    const res = await POST(requisicao());
    const body = await res.json();
    expect(body.veiculoIdReatribuido).toBe(0);
    expect(body.esgotaramTentativas).toBe(0);

    const upd = updatesDe("romaneio_pontos").find((u) => u.id === "p2");
    expect(upd?.payload).toMatchObject({ geocode_tentativas: 4 });
    expect(upd?.payload).not.toHaveProperty("geocode_status");
  });

  it("placa orfa esgota as tentativas -- promovida a sem_coordenada_confirmada (o bug real: antes NUNCA chegava aqui)", async () => {
    filaSelect["romaneio_pontos"] = [
      { data: [], error: null },
      { data: [{ id: "p3", nf: "NF3", placa: "YYY0000", veiculo_id: null, geocode_tentativas: MAX_TENTATIVAS - 1, endereco_bruto: "RUA TESTE, 3 - BAIRRO, CIDADE - *" }], error: null },
    ];
    filaSelect["veiculos"] = [{ data: [], error: null }];

    const { POST } = await import("./route");
    const res = await POST(requisicao());
    const body = await res.json();
    expect(body.esgotaramTentativas).toBe(1);

    const upd = updatesDe("romaneio_pontos").find((u) => u.id === "p3");
    expect(upd?.payload).toMatchObject({ geocode_tentativas: MAX_TENTATIVAS, geocode_status: "sem_coordenada_confirmada" });
  });

  it("lote so' com linhas orfas nao pula o fallback Unitrac das linhas com veiculo (guarda de regressao do bug de 'cvsUnicos vazio')", async () => {
    // Esse era o risco de implementar o recasamento DENTRO do bloco
    // `if (cvsUnicos.length > 0)`: um lote 100% orfao deixa cvsUnicos vazio
    // e o bloco inteiro (incluindo a contagem de tentativa) seria pulado.
    filaSelect["romaneio_pontos"] = [
      { data: [], error: null },
      { data: [{ id: "p5", nf: "NF5", placa: "WWW1234", veiculo_id: null, geocode_tentativas: 0, endereco_bruto: "RUA TESTE, 5 - BAIRRO, CIDADE - *" }], error: null },
    ];
    filaSelect["veiculos"] = [{ data: [], error: null }];

    const { POST } = await import("./route");
    const res = await POST(requisicao());
    const body = await res.json();
    // Nao pode ter chamado a Unitrac (nenhum cv disponivel).
    expect(mockBuscarAlvos).not.toHaveBeenCalled();
    // Mas tem que ter contado a tentativa mesmo assim.
    expect(body.esgotaramTentativas).toBe(0);
    const upd = updatesDe("romaneio_pontos").find((u) => u.id === "p5");
    expect(upd?.payload).toMatchObject({ geocode_tentativas: 1 });
  });
});

describe("POST /api/romaneio/processar-geocode -- lote misto e modo degradado (achado da revisao independente 30/08)", () => {
  it("lote com 1 linha orfa E 1 linha com veiculo NO MESMO ciclo -- os dois caminhos rodam, nenhum pisa no outro", async () => {
    filaSelect["romaneio_pontos"] = [
      { data: [], error: null }, // candidatos (pendentes)
      {
        data: [
          { id: "p-orfa", nf: "NFO", placa: "ORF1234", veiculo_id: null, geocode_tentativas: 0, endereco_bruto: "RUA TESTE, 6 - BAIRRO, CIDADE - *" },
          { id: "p-comv", nf: "NFV", placa: "COMV1234", veiculo_id: "v-comv", geocode_tentativas: 0, endereco_bruto: "RUA TESTE, 7 - BAIRRO, CIDADE - *" },
        ],
        error: null,
      },
    ];
    filaSelect["veiculos"] = [
      { data: [{ id: "v-orfa-recem-cadastrado", placa: "ORF1234" }], error: null }, // rematch da orfa
      { data: [{ id: "v-comv", cv: "CV-MISTO", cliente_id: "c-misto" }], error: null }, // cv da linha com veiculo
    ];
    mockBuscarAlvos.mockResolvedValue([
      { placa: "COMV1234", alvodocumento: "NFV", pontolatitude: -22.8, pontolongitude: -43.1, alvosituacaoservico: 0, pontocodigo: 1 },
    ]);

    const { POST } = await import("./route");
    const res = await POST(requisicao());
    const body = await res.json();

    // Linha orfa: reatada, sem gastar tentativa.
    expect(body.veiculoIdReatribuido).toBe(1);
    // Linha com veiculo: achou alvo na Unitrac, virou 'ok'.
    expect(body.fallbackUnitrac).toBe(1);
    expect(body.esgotaramTentativas).toBe(0);
    // buscarAlvos so' foi chamada com o cv da linha COM veiculo -- a orfa nao
    // contribui cv nenhum (ainda nao tinha veiculo_id quando a lista de cvs
    // foi montada).
    expect(mockBuscarAlvos).toHaveBeenCalledWith(["CV-MISTO"]);

    const updOrfa = updatesDe("romaneio_pontos").find((u) => u.id === "p-orfa");
    expect(updOrfa?.payload).toEqual({ veiculo_id: "v-orfa-recem-cadastrado" });
    const updComV = updatesDe("romaneio_pontos").find((u) => u.id === "p-comv");
    expect(updComV?.payload).toEqual({ lat: -22.8, lng: -43.1, geocode_status: "ok" });
  });

  it("modo degradado (comLimite.error, tentativasDisponivel=false): orfa sem veiculo NAO gasta tentativa -- retenta pra sempre, nunca vira terminal sozinha", async () => {
    filaSelect["romaneio_pontos"] = [
      { data: [], error: null }, // candidatos (pendentes)
      { data: null, error: { message: "timeout" } }, // comLimite falha -> cai no semLimite
      { data: [{ id: "p-degradada", nf: "NFD", placa: "DEG0000", veiculo_id: null, endereco_bruto: "RUA TESTE, 8 - BAIRRO, CIDADE - *" }], error: null }, // semLimite
    ];
    filaSelect["veiculos"] = [{ data: [], error: null }]; // nenhum veiculo com essa placa

    const { POST } = await import("./route");
    const res = await POST(requisicao());
    const body = await res.json();

    expect(body.limiteTentativasAtivo).toBe(false);
    expect(body.veiculoIdReatribuido).toBe(0);
    expect(body.esgotaramTentativas).toBe(0);
    // Nao pode ter tentado gravar geocode_tentativas nesta linha -- modo
    // degradado nao gasta orcamento, ver `if (!tentativasDisponivel) return;`
    // em registrarFalhaTentativa.
    const upd = updatesDe("romaneio_pontos").find((u) => u.id === "p-degradada");
    expect(upd).toBeUndefined();
  });
});

describe("POST /api/romaneio/processar-geocode -- regressao: linhas 'falhou' COM veiculo_id (fluxo de ontem, Fase 3)", () => {
  it("acha alvo na Unitrac -- vira 'ok' com a coordenada, sem gastar tentativa", async () => {
    filaSelect["romaneio_pontos"] = [
      { data: [], error: null },
      { data: [{ id: "p4", nf: "NF4", placa: "AAA1111", veiculo_id: "v-existente", geocode_tentativas: 0, endereco_bruto: "RUA TESTE, 4 - BAIRRO, CIDADE - *" }], error: null },
    ];
    filaSelect["veiculos"] = [{ data: [{ id: "v-existente", cv: "CV1", cliente_id: "c1" }], error: null }];
    mockBuscarAlvos.mockResolvedValue([
      { placa: "AAA1111", alvodocumento: "NF4", pontolatitude: -22.9, pontolongitude: -43.2, alvosituacaoservico: 0, pontocodigo: 1 },
    ]);

    const { POST } = await import("./route");
    const res = await POST(requisicao());
    const body = await res.json();
    expect(body.fallbackUnitrac).toBe(1);
    expect(body.esgotaramTentativas).toBe(0);

    const upd = updatesDe("romaneio_pontos").find((u) => u.id === "p4");
    expect(upd?.payload).toEqual({ lat: -22.9, lng: -43.2, geocode_status: "ok" });
  });

  it("nao acha alvo na Unitrac -- continua contando tentativa como sempre (mecanismo de ontem intacto)", async () => {
    filaSelect["romaneio_pontos"] = [
      { data: [], error: null },
      { data: [{ id: "p6", nf: "NF6", placa: "BBB2222", veiculo_id: "v-existente2", geocode_tentativas: 2, endereco_bruto: "RUA TESTE, 9 - BAIRRO, CIDADE - *" }], error: null },
    ];
    filaSelect["veiculos"] = [{ data: [{ id: "v-existente2", cv: "CV2", cliente_id: "c2" }], error: null }];
    mockBuscarAlvos.mockResolvedValue([]); // nenhum alvo casa

    const { POST } = await import("./route");
    const res = await POST(requisicao());
    const body = await res.json();
    expect(body.fallbackUnitrac).toBe(0);
    expect(body.veiculoIdReatribuido).toBe(0);

    const upd = updatesDe("romaneio_pontos").find((u) => u.id === "p6");
    expect(upd?.payload).toMatchObject({ geocode_tentativas: 3 });
  });

  // Achado real 01/09 (auditoria "porque continua cheio de pendente"): 152
  // linhas com geocode_tentativas no teto, enderecos perfeitamente
  // geocodificaveis (confirmado manual via Nominatim puro) -- o orcamento
  // inteiro de tentativas era gasto SO esperando um alvo Unitrac que nunca
  // chega (cliente sem cadastro por documento), porque a cascata de texto
  // so era tentada 1x, no upload. Agora tenta de novo aqui.
  it("nao acha alvo na Unitrac, MAS a retentativa da cascata de texto resolve -- vira 'ok', nao gasta tentativa", async () => {
    filaSelect["romaneio_pontos"] = [
      { data: [], error: null },
      { data: [{ id: "p7", nf: "NF7", placa: "CCC3333", veiculo_id: "v-existente3", geocode_tentativas: 5, endereco_bruto: "RUA TESTE, 10 - BAIRRO, CIDADE - *" }], error: null },
    ];
    filaSelect["veiculos"] = [{ data: [{ id: "v-existente3", cv: "CV3", cliente_id: "c3" }], error: null }];
    mockBuscarAlvos.mockResolvedValue([]); // sem alvo na Unitrac
    mockGeocodificarEndereco.mockResolvedValueOnce({ lat: -22.85, lng: -43.15, fonte: "nominatim" });

    const { POST } = await import("./route");
    const res = await POST(requisicao());
    const body = await res.json();

    expect(body.fallbackUnitrac).toBe(0);
    expect(body.resolvidoViaRetentativaTexto).toBe(1);
    expect(body.esgotaramTentativas).toBe(0);

    const upd = updatesDe("romaneio_pontos").find((u) => u.id === "p7");
    expect(upd?.payload).toEqual({ lat: -22.85, lng: -43.15, geocode_status: "ok" });
    // Nao pode ter registrado tentativa -- resolveu antes.
    expect(upd?.payload).not.toHaveProperty("geocode_tentativas");
  });

  it("nem alvo Unitrac nem retentativa de texto resolvem -- continua contando tentativa (comportamento intacto)", async () => {
    filaSelect["romaneio_pontos"] = [
      { data: [], error: null },
      { data: [{ id: "p8", nf: "NF8", placa: "DDD4444", veiculo_id: "v-existente4", geocode_tentativas: 5, endereco_bruto: "RUA TESTE, 11 - BAIRRO, CIDADE - *" }], error: null },
    ];
    filaSelect["veiculos"] = [{ data: [{ id: "v-existente4", cv: "CV4", cliente_id: "c4" }], error: null }];
    mockBuscarAlvos.mockResolvedValue([]);
    // mockGeocodificarEndereco usa o default (null) -- retentativa tambem falha.

    const { POST } = await import("./route");
    const res = await POST(requisicao());
    const body = await res.json();

    expect(body.resolvidoViaRetentativaTexto).toBe(0);
    const upd = updatesDe("romaneio_pontos").find((u) => u.id === "p8");
    expect(upd?.payload).toMatchObject({ geocode_tentativas: 6 });
  });
});
