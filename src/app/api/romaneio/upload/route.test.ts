// src/app/api/romaneio/upload/route.test.ts
//
// Testa só o ROTEAMENTO (qual caminho de extração é escolhido pra cada
// tipo de arquivo/formato) via mock dos módulos de extração -- não bate
// no banco real nem faz chamada de rede. Segue o mesmo padrão de mock de
// módulo já usado em outros testes de rota deste repo.
import { describe, it, expect, vi, beforeEach } from "vitest";

const mockParseRomaneio = vi.fn();
const mockExtrairDataRomaneio = vi.fn();
const mockNormalizarPlaca = vi.fn((p: string) => p);
vi.mock("@/lib/romaneio", async (importOriginal) => {
  // variantesOZero/resolverPlacaNoCadastro (DR-05) sao puras: usa a real.
  const real = await importOriginal<typeof import("@/lib/romaneio")>();
  return {
    variantesOZero: real.variantesOZero,
    resolverPlacaNoCadastro: real.resolverPlacaNoCadastro,
    parseRomaneio: mockParseRomaneio,
    extrairDataRomaneio: mockExtrairDataRomaneio,
    normalizarPlaca: mockNormalizarPlaca,
  };
});

const mockExtrairTextoPlanilha = vi.fn();
vi.mock("@/lib/romaneio-planilha", () => ({
  extrairTextoPlanilha: mockExtrairTextoPlanilha,
}));

const mockParseRomaneioTabular = vi.fn();
const mockExtrairDataTabular = vi.fn();
vi.mock("@/lib/romaneio-tabular", () => ({
  parseRomaneioTabular: mockParseRomaneioTabular,
  extrairDataTabular: mockExtrairDataTabular,
}));

const mockExtrairRomaneioViaLLM = vi.fn();
vi.mock("@/lib/romaneio-llm-extrator", () => ({
  extrairRomaneioViaLLM: mockExtrairRomaneioViaLLM,
  chamarOllama: vi.fn(),
  chamarMistral: vi.fn(),
}));

const mockGetUser = vi.fn();
vi.mock("@/lib/supabase/server", () => ({
  createClient: async () => ({ auth: { getUser: mockGetUser } }),
}));

// upsert(linhas, opcoes).select("id") -- mock encadeado no mesmo formato
// do client real (ver route.ts). Por padrao simula "nada era duplicata":
// devolve uma linha por linha enviada. Testes que precisam simular
// duplicata setam proximoUpsertResultado ANTES de chamar POST -- variavel
// simples em vez de mockResolvedValueOnce: a fila de "once" do vitest nao
// e' limpa por clearAllMocks(), entao um item nao consumido numa chamada
// extra de upsert dentro de um teste vazaria pro proximo teste.
let proximoUpsertResultado: { data: unknown[]; error: unknown } | null = null;
const mockUpsertSelect = vi.fn();
const mockUpsert = vi.fn((linhas: unknown[], _opcoes?: unknown) => {
  const resultado = proximoUpsertResultado ?? {
    data: (linhas as unknown[]).map((_, i) => ({ id: `linha-${i}` })),
    error: null,
  };
  proximoUpsertResultado = null;
  mockUpsertSelect.mockImplementation(async () => resultado);
  return { select: mockUpsertSelect };
});
const mockSelect = vi.fn();
// Linhas ja gravadas no dia (leitura antes do upsert, regra de reenvio 03/11).
let existentesDoDia: { nf: string; carga_destino_codigo: string | null; placa: string; trocado_em?: string | null; removida_em?: string | null }[] = [];
// DSV-06: updates em romaneio_pontos (removida_em) com os filtros usados.
const updatesPontos: { patch: Record<string, unknown>; filtros: [string, string, unknown][] }[] = [];
const cadeiaUpdate = (patch: Record<string, unknown>) => {
  const reg = { patch, filtros: [] as [string, string, unknown][] };
  updatesPontos.push(reg);
  const c = {
    eq: (col: string, v: unknown) => { reg.filtros.push(["eq", col, v]); return c; },
    in: (col: string, v: unknown) => { reg.filtros.push(["in", col, v]); return c; },
    is: (col: string, v: unknown) => { reg.filtros.push(["is", col, v]); return c; },
    then: (ok: (r: unknown) => unknown) => Promise.resolve({ error: null }).then(ok),
  };
  return c;
};
let semColunas093 = false;
const cadeiaExistentes = (cols = "") => {
  const erro = semColunas093 && cols.includes("trocado_em") ? { message: "column romaneio_pontos.trocado_em does not exist" } : null;
  const c = { eq: () => c, order: () => c, range: async () => (erro ? { data: null, error: erro } : { data: existentesDoDia, error: null }) };
  return c;
};
vi.mock("@/lib/supabase/admin", () => ({
  createAdminClient: () => ({
    from: (tabela: string) => {
      if (tabela === "veiculos") {
        return { select: () => ({ in: mockSelect }) };
      }
      return { upsert: mockUpsert, select: (cols?: string) => cadeiaExistentes(cols), update: cadeiaUpdate };
    },
  }),
}));

vi.mock("pdf-parse", () => ({
  PDFParse: class {
    async getText() {
      return { text: "TEXTO EXTRAIDO DO PDF" };
    }
  },
}));

function criarRequisicao(nomeArquivo: string, conteudo = "conteudo", campos: Record<string, string> = {}) {
  const formData = new FormData();
  const arquivo = new File([conteudo], nomeArquivo);
  formData.append("arquivo", arquivo);
  for (const [chave, valor] of Object.entries(campos)) formData.append(chave, valor);
  return new Request("http://localhost/api/romaneio/upload", { method: "POST", body: formData });
}

function linhaRegexValida() {
  return { placaBruta: "ABC1D23", motorista: "M", cargaDestinoCodigo: "1", cargaDestinoNome: "N", nf: "1", clienteCodigo: "C1", clienteNome: "Cliente", enderecoBruto: "Rua X" };
}

describe("POST /api/romaneio/upload -- roteamento de extracao", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    proximoUpsertResultado = null;
    existentesDoDia = [];
    mockGetUser.mockResolvedValue({ data: { user: { id: "u1", email: "op@x.com" } } });
    mockExtrairDataRomaneio.mockReturnValue("2026-08-12");
    mockSelect.mockResolvedValue({ data: [] });
  });

  it("PDF que bate o regex Nutry Max: usa parseRomaneio, NAO chama o extrator LLM", async () => {
    mockParseRomaneio.mockReturnValue([
      { placaBruta: "ABC1D23", motorista: "M", cargaDestinoCodigo: "1", cargaDestinoNome: "N", nf: "1", clienteCodigo: "C1", clienteNome: "Cliente", enderecoBruto: "Rua X" },
    ]);
    const { POST } = await import("./route");
    const res = await POST(criarRequisicao("romaneio.pdf"));
    expect(res.status).toBe(200);
    expect(mockExtrairRomaneioViaLLM).not.toHaveBeenCalled();
    expect(mockUpsert).toHaveBeenCalled();
    const body = await res.json();
    expect(body.fonteExtracao).toBe("regex");
  });

  it("PDF que NAO bate o regex (0 linhas): cai pro extrator LLM", async () => {
    mockParseRomaneio.mockReturnValue([]);
    mockExtrairRomaneioViaLLM.mockResolvedValue({
      linhas: [{ placaBruta: "XYZ9W88", enderecoBruto: "Av Brasil, 500", clienteNome: "Loja X" }],
      fonte: "ollama",
    });
    const { POST } = await import("./route");
    const res = await POST(criarRequisicao("romaneio-outro-formato.pdf"));
    expect(res.status).toBe(200);
    expect(mockExtrairRomaneioViaLLM).toHaveBeenCalledTimes(1);
    const body = await res.json();
    expect(body.fonteExtracao).toBe("ollama");
  });

  // ─── Achado real 24-25/08: "Escala do Pao"/"Programacao Congelado" --
  // formato tabular por carro, agora com parser deterministico proprio
  // (romaneio-tabular.ts), tentado ANTES do caminho generico via IA.

  it("PDF tabular (Escala do Pao): usa parseRomaneioTabular, NAO chama o extrator LLM", async () => {
    mockParseRomaneio.mockReturnValue([]);
    mockParseRomaneioTabular.mockReturnValue([
      { placaBruta: "ABC1D23", nf: "1", clienteNome: "Cliente", enderecoBruto: "Rua X, Bairro Y" },
    ]);
    mockExtrairDataTabular.mockReturnValue("2026-08-25");
    const { POST } = await import("./route");
    const res = await POST(criarRequisicao("escala-do-pao.pdf"));
    expect(res.status).toBe(200);
    expect(mockExtrairRomaneioViaLLM).not.toHaveBeenCalled();
    expect(mockUpsert).toHaveBeenCalled();
    const body = await res.json();
    expect(body.fonteExtracao).toBe("regex_tabular");
    expect(body.romaneioData).toBe("2026-08-25");
  });

  it("PDF tabular sem data no cabecalho: 422, nao cai pro LLM (mesma politica estrita do regex Nutry Max)", async () => {
    mockParseRomaneio.mockReturnValue([]);
    mockParseRomaneioTabular.mockReturnValue([
      { placaBruta: "ABC1D23", nf: "1", clienteNome: "Cliente", enderecoBruto: "Rua X" },
    ]);
    mockExtrairDataTabular.mockReturnValue(null);
    const { POST } = await import("./route");
    const res = await POST(criarRequisicao("escala-do-pao.pdf"));
    expect(res.status).toBe(422);
    expect(mockUpsert).not.toHaveBeenCalled();
    expect(mockExtrairRomaneioViaLLM).not.toHaveBeenCalled();
  });

  it("parseRomaneioTabular devolve null (formato nao reconhecido): cai pro extrator LLM normalmente", async () => {
    mockParseRomaneio.mockReturnValue([]);
    mockParseRomaneioTabular.mockReturnValue(null);
    mockExtrairRomaneioViaLLM.mockResolvedValue({
      linhas: [{ placaBruta: "XYZ9W88", enderecoBruto: "Av Brasil, 500", clienteNome: "Loja X" }],
      fonte: "mistral",
    });
    const { POST } = await import("./route");
    const res = await POST(criarRequisicao("romaneio-desconhecido.pdf"));
    expect(res.status).toBe(200);
    expect(mockExtrairRomaneioViaLLM).toHaveBeenCalledTimes(1);
    const body = await res.json();
    expect(body.fonteExtracao).toBe("mistral");
  });

  it("parseRomaneioTabular devolve array vazio (CARRO reconhecido mas 0 entregas): cai pro extrator LLM, nao 422 direto", async () => {
    mockParseRomaneio.mockReturnValue([]);
    mockParseRomaneioTabular.mockReturnValue([]);
    mockExtrairRomaneioViaLLM.mockResolvedValue({
      linhas: [{ placaBruta: "XYZ9W88", enderecoBruto: "Av Brasil, 500", clienteNome: "Loja X" }],
      fonte: "mistral",
    });
    const { POST } = await import("./route");
    const res = await POST(criarRequisicao("escala-do-pao-vazia.pdf"));
    expect(res.status).toBe(200);
    expect(mockExtrairRomaneioViaLLM).toHaveBeenCalledTimes(1);
  });

  it("Excel: nunca tenta o parser tabular (so' PDF)", async () => {
    mockExtrairTextoPlanilha.mockReturnValue("TEXTO DA PLANILHA");
    mockExtrairRomaneioViaLLM.mockResolvedValue({
      linhas: [{ placaBruta: "XYZ9W88", enderecoBruto: "Av Brasil, 500", clienteNome: "Loja X" }],
      fonte: "mistral",
    });
    const { POST } = await import("./route");
    await POST(criarRequisicao("romaneio.xlsx"));
    expect(mockParseRomaneioTabular).not.toHaveBeenCalled();
  });

  it("Excel: nunca chama parseRomaneio, vai direto pro extrator LLM", async () => {
    mockExtrairTextoPlanilha.mockReturnValue("TEXTO DA PLANILHA");
    mockExtrairRomaneioViaLLM.mockResolvedValue({
      linhas: [{ placaBruta: "XYZ9W88", enderecoBruto: "Av Brasil, 500", clienteNome: "Loja X" }],
      fonte: "mistral",
    });
    const { POST } = await import("./route");
    const res = await POST(criarRequisicao("romaneio.xlsx"));
    expect(res.status).toBe(200);
    expect(mockParseRomaneio).not.toHaveBeenCalled();
    expect(mockExtrairTextoPlanilha).toHaveBeenCalledTimes(1);
    expect(mockExtrairRomaneioViaLLM).toHaveBeenCalledTimes(1);
    const body = await res.json();
    expect(body.fonteExtracao).toBe("mistral");
  });

  it("CSV: mesmo caminho do Excel (extensao .csv reconhecida)", async () => {
    mockExtrairTextoPlanilha.mockReturnValue("TEXTO DO CSV");
    mockExtrairRomaneioViaLLM.mockResolvedValue({
      linhas: [{ placaBruta: "XYZ9W88", enderecoBruto: "Av Brasil, 500", clienteNome: "Loja X" }],
      fonte: "ollama",
    });
    const { POST } = await import("./route");
    const res = await POST(criarRequisicao("romaneio.csv"));
    expect(res.status).toBe(200);
    expect(mockExtrairTextoPlanilha).toHaveBeenCalledTimes(1);
  });

  it("regex nao bate E extrator LLM falha (null): rejeita com 422, nao insere nada", async () => {
    mockParseRomaneio.mockReturnValue([]);
    mockExtrairRomaneioViaLLM.mockResolvedValue(null);
    const { POST } = await import("./route");
    const res = await POST(criarRequisicao("romaneio-ilegivel.pdf"));
    expect(res.status).toBe(422);
    expect(mockUpsert).not.toHaveBeenCalled();
  });

  it("linha extraida sem endereco (ambigua) e aceita, nao bloqueia o upload", async () => {
    mockParseRomaneio.mockReturnValue([]);
    mockExtrairRomaneioViaLLM.mockResolvedValue({
      linhas: [{ placaBruta: "ABC1D23", enderecoBruto: "", clienteNome: "Cliente sem endereco" }],
      fonte: "ollama",
    });
    const { POST } = await import("./route");
    const res = await POST(criarRequisicao("romaneio.pdf"));
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.totalLinhas).toBe(1);
  });

  it("linhas do caminho LLM inserem carga_destino_codigo/nome como null e um nf sintetico nao-nulo quando o LLM nao extraiu NF", async () => {
    mockParseRomaneio.mockReturnValue([]);
    mockExtrairRomaneioViaLLM.mockResolvedValue({
      linhas: [{ placaBruta: "ABC1D23", enderecoBruto: "Rua X", clienteNome: "Cliente" }],
      fonte: "ollama",
    });
    const { POST } = await import("./route");
    await POST(criarRequisicao("romaneio.pdf"));
    const linhasInseridas = mockUpsert.mock.calls[0][0] as Array<{
      carga_destino_codigo: unknown;
      carga_destino_nome: unknown;
      nf: string;
    }>;
    expect(linhasInseridas[0].carga_destino_codigo).toBeNull();
    expect(linhasInseridas[0].carga_destino_nome).toBeNull();
    // nf e' NOT NULL no banco -- nunca pode inserir null aqui.
    expect(linhasInseridas[0].nf).toEqual(expect.stringMatching(/^sem-nf:/));
  });

  // ─── Finding 1: gate de data nao pode bloquear o caminho generico/LLM
  // antes do roteamento -- so o caminho regex (Nutry Max) e' estrito.

  it("regex Nutry Max sem data no cabecalho: 422 exatamente como antes (regressao)", async () => {
    mockParseRomaneio.mockReturnValue([
      { placaBruta: "ABC1D23", motorista: "M", cargaDestinoCodigo: "1", cargaDestinoNome: "N", nf: "1", clienteCodigo: "C1", clienteNome: "Cliente", enderecoBruto: "Rua X" },
    ]);
    mockExtrairDataRomaneio.mockReturnValue(null);
    const { POST } = await import("./route");
    const res = await POST(criarRequisicao("romaneio.pdf"));
    expect(res.status).toBe(422);
    expect(mockUpsert).not.toHaveBeenCalled();
    expect(mockExtrairRomaneioViaLLM).not.toHaveBeenCalled();
  });

  it("Excel com data solta dd/mm/yyyy (sem hora, nao bate o padrao estrito): aceito, data extraida do texto", async () => {
    mockExtrairDataRomaneio.mockReturnValue(null); // padrao estrito (com hora) nao bate
    mockExtrairTextoPlanilha.mockReturnValue("Romaneio 20/08/2026\nXYZ9W88\tAv Brasil, 500\tLoja X");
    mockExtrairRomaneioViaLLM.mockResolvedValue({
      linhas: [{ placaBruta: "XYZ9W88", enderecoBruto: "Av Brasil, 500", clienteNome: "Loja X" }],
      fonte: "ollama",
    });
    const { POST } = await import("./route");
    const res = await POST(criarRequisicao("romaneio.xlsx"));
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.romaneioData).toBe("2026-08-20");
  });

  it("Excel sem NENHUMA data reconhecivel: nao 422, cai pra data de hoje", async () => {
    mockExtrairDataRomaneio.mockReturnValue(null);
    mockExtrairTextoPlanilha.mockReturnValue("XYZ9W88\tAv Brasil, 500\tLoja X (sem data em lugar nenhum)");
    mockExtrairRomaneioViaLLM.mockResolvedValue({
      linhas: [{ placaBruta: "XYZ9W88", enderecoBruto: "Av Brasil, 500", clienteNome: "Loja X" }],
      fonte: "ollama",
    });
    const { POST } = await import("./route");
    const res = await POST(criarRequisicao("romaneio.xlsx"));
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(typeof body.romaneioData).toBe("string");
    expect(body.romaneioData).toMatch(/^\d{4}-\d{2}-\d{2}$/);
  });

  // ─── Finding 6: extracao de texto (planilha corrompida / PDF invalido)
  // nao pode virar 500 opaco.

  // ─── Origem do lote (migration 059): romaneio x escala do Pao deixaram de
  // ser indistinguiveis no banco. O valor vem do CLIENTE, entao a allowlist
  // e' o que impede string arbitraria de ser gravada.

  it("origem 'escala_pao' e gravada em todas as linhas inseridas", async () => {
    mockParseRomaneio.mockReturnValue([linhaRegexValida(), { ...linhaRegexValida(), nf: "2" }]);
    const { POST } = await import("./route");
    const res = await POST(criarRequisicao("romaneio.pdf", "conteudo", { origem: "escala_pao" }));
    expect(res.status).toBe(200);
    const linhasInseridas = mockUpsert.mock.calls[0][0] as Array<{ origem: string }>;
    expect(linhasInseridas).toHaveLength(2);
    expect(linhasInseridas.every((l) => l.origem === "escala_pao")).toBe(true);
    expect((await res.json()).origem).toBe("escala_pao");
  });

  it("sem campo origem: grava 'romaneio' (comportamento de antes da coluna existir)", async () => {
    mockParseRomaneio.mockReturnValue([linhaRegexValida()]);
    const { POST } = await import("./route");
    await POST(criarRequisicao("romaneio.pdf"));
    const linhas = mockUpsert.mock.calls[0][0] as Array<{ origem: string }>;
    expect(linhas[0].origem).toBe("romaneio");
  });

  it("origem arbitraria vinda do cliente NUNCA chega ao banco: cai pro padrao", async () => {
    mockParseRomaneio.mockReturnValue([linhaRegexValida()]);
    const { POST } = await import("./route");
    await POST(criarRequisicao("romaneio.pdf", "conteudo", { origem: "'; drop table romaneio_pontos; --" }));
    const linhas = mockUpsert.mock.calls[0][0] as Array<{ origem: string }>;
    expect(linhas[0].origem).toBe("romaneio");
  });

  it("planilha corrompida (XLSX.read lanca exception): 422 claro, nao 500", async () => {
    mockExtrairTextoPlanilha.mockImplementation(() => {
      throw new Error("arquivo corrompido, nao e' uma planilha valida");
    });
    const { POST } = await import("./route");
    const res = await POST(criarRequisicao("romaneio-corrompido.xlsx"));
    expect(res.status).toBe(422);
    const body = await res.json();
    expect(body.ok).toBe(false);
    expect(mockUpsert).not.toHaveBeenCalled();
  });

  // ─── Task "evitar duplicacao silenciosa no upload de romaneio" (27/08 --
  // ver migration 065): reenviar o mesmo arquivo nao pode mais duplicar
  // linhas em romaneio_pontos. O endpoint troca insert() por
  // upsert(..., { onConflict, ignoreDuplicates: true }) -- o teste real de
  // "o banco rejeita a segunda copia" e' da constraint (migration 065,
  // fora do alcance de um teste unitario de rota), mas aqui garantimos que
  // a ROTA chama o upsert do jeito certo (chave da constraint, DO NOTHING)
  // e reporta corretamente quantas linhas eram duplicata.

  it("upsert usa a chave da constraint (migration 065) com ignoreDuplicates -- nunca insert() puro", async () => {
    mockParseRomaneio.mockReturnValue([linhaRegexValida()]);
    const { POST } = await import("./route");
    await POST(criarRequisicao("romaneio.pdf"));
    expect(mockUpsert).toHaveBeenCalledTimes(1);
    const opcoes = mockUpsert.mock.calls[0][1];
    expect(opcoes).toEqual({
      onConflict: "romaneio_data,placa,nf,modo_teste,origem",
      ignoreDuplicates: true,
    });
  });

  it("03/11: reenvio depois de troca de veiculo nao recria a NF na placa do documento", async () => {
    mockParseRomaneio.mockReturnValue([linhaRegexValida(), { ...linhaRegexValida(), nf: "2" }]);
    // NF 1 da carga 1 ja foi movida pela troca pra outra placa.
    existentesDoDia = [{ nf: "1", carga_destino_codigo: "1", placa: "RQU-2G47", trocado_em: "2026-11-03T14:00:00Z" }];
    const { POST } = await import("./route");
    const body = await (await POST(criarRequisicao("romaneio.pdf"))).json();
    expect(mockUpsert.mock.calls[0][0].map((l: { nf: string }) => l.nf)).toEqual(["2"]);
    expect(body.jaMovidasPorTroca).toBe(1);
    expect(body.totalLinhas).toBe(2);
    // a linha trocada nao e' marcada como removida
    expect(updatesPontos.filter((u) => u.patch.removida_em)).toEqual([]);
  });

  it("DSV-06: reenvio corrigido sem troca move a NF e a linha da placa antiga sai da rota (marcada, nao apagada)", async () => {
    updatesPontos.length = 0;
    mockParseRomaneio.mockReturnValue([{ ...linhaRegexValida(), placaBruta: "BBB-2B22" }]);
    existentesDoDia = [{ nf: "1", carga_destino_codigo: "1", placa: "AAA-1A11", trocado_em: null, removida_em: null }];
    const { POST } = await import("./route");
    const body = await (await POST(criarRequisicao("romaneio.pdf"))).json();
    expect((mockUpsert.mock.calls[0][0] as { placa: string }[]).map((l) => l.placa)).toEqual(["BBB-2B22"]);
    expect(body.nfsRetiradas).toBe(1);
    const marcadas = updatesPontos.filter((u) => typeof u.patch.removida_em === "string");
    expect(marcadas).toHaveLength(1);
    expect(marcadas[0].filtros).toEqual(expect.arrayContaining([["eq", "placa", "AAA-1A11"], ["eq", "carga_destino_codigo", "1"], ["in", "nf", ["1"]], ["is", "removida_em", null], ["is", "trocado_em", null]]));
  });

  it("DSV-06: antes da migration 093 o upload nao para e segue a regra antiga", async () => {
    updatesPontos.length = 0;
    semColunas093 = true;
    try {
      mockParseRomaneio.mockReturnValue([{ ...linhaRegexValida(), placaBruta: "BBB-2B22" }]);
      existentesDoDia = [{ nf: "1", carga_destino_codigo: "1", placa: "AAA-1A11" }];
      const { POST } = await import("./route");
      const res = await POST(criarRequisicao("romaneio.pdf"));
      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.jaMovidasPorTroca).toBe(1);
      expect(body.nfsRetiradas).toBe(0);
      expect(updatesPontos).toEqual([]);
    } finally {
      semColunas093 = false;
    }
  });

  it("DSV-06: NF que volta num reenvio volta pra rota", async () => {
    updatesPontos.length = 0;
    mockParseRomaneio.mockReturnValue([linhaRegexValida()]);
    existentesDoDia = [{ nf: "1", carga_destino_codigo: "1", placa: "ABC1D23", trocado_em: null, removida_em: "2026-11-03T15:00:00Z" }];
    const { POST } = await import("./route");
    const body = await (await POST(criarRequisicao("romaneio.pdf"))).json();
    expect(body.nfsDevolvidas).toBe(1);
    expect(updatesPontos.some((u) => u.patch.removida_em === null)).toBe(true);
  });

  it("reenviar o mesmo arquivo duas vezes: a segunda vez nao insere nenhuma linha nova (upsert devolve 0 linhas) e o retorno reflete isso em linhasDuplicadas", async () => {
    mockParseRomaneio.mockReturnValue([linhaRegexValida(), { ...linhaRegexValida(), nf: "2" }]);
    const { POST } = await import("./route");

    // 1o upload: as 2 linhas sao novas (comportamento padrao do mock).
    const res1 = await POST(criarRequisicao("romaneio.pdf"));
    const body1 = await res1.json();
    expect(body1.totalLinhas).toBe(2);
    expect(body1.linhasInseridas).toBe(2);
    expect(body1.linhasDuplicadas).toBe(0);

    // 2o upload do MESMO arquivo -- simula o banco reconhecendo as 2
    // linhas como conflito na constraint (ON CONFLICT DO NOTHING: nenhuma
    // linha volta no .select()).
    proximoUpsertResultado = { data: [], error: null };
    const res2 = await POST(criarRequisicao("romaneio.pdf"));
    const body2 = await res2.json();
    expect(res2.status).toBe(200);
    expect(body2.totalLinhas).toBe(2);
    expect(body2.linhasInseridas).toBe(0);
    expect(body2.linhasDuplicadas).toBe(2);
  });

  it("upload parcialmente duplicado: linhasInseridas + linhasDuplicadas soma totalLinhas", async () => {
    mockParseRomaneio.mockReturnValue([
      linhaRegexValida(),
      { ...linhaRegexValida(), nf: "2" },
      { ...linhaRegexValida(), nf: "3" },
    ]);
    // Simula banco: so' 1 das 3 linhas era nova (2 ja existiam).
    proximoUpsertResultado = { data: [{ id: "linha-nova" }], error: null };
    const { POST } = await import("./route");
    const res = await POST(criarRequisicao("romaneio.pdf"));
    const body = await res.json();
    expect(body.totalLinhas).toBe(3);
    expect(body.linhasInseridas).toBe(1);
    expect(body.linhasDuplicadas).toBe(2);
  });
});

describe("POST /api/romaneio/upload -- repasse do Ao vivo do KPI (06/10)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    proximoUpsertResultado = null;
    existentesDoDia = [];
    mockGetUser.mockResolvedValue({ data: { user: null } });
    mockExtrairDataRomaneio.mockReturnValue("2026-10-06");
    mockSelect.mockResolvedValue({ data: [] });
    process.env.MOTOR_SECRET = "segredo-teste";
  });

  function comChave(chave: string | null) {
    const req = criarRequisicao("romaneio.pdf");
    const headers = new Headers(req.headers);
    if (chave) headers.set("x-motor-key", chave);
    headers.set("x-enviado-por", "erica@x.com");
    return new Request(req, { headers });
  }

  it("chave certa e sem sessao: aceita e grava como enviado pelo Ao vivo do KPI", async () => {
    mockParseRomaneio.mockReturnValue([linhaRegexValida()]);
    const { POST } = await import("./route");
    const res = await POST(comChave("segredo-teste"));
    expect(res.status).toBe(200);
    expect(mockGetUser).not.toHaveBeenCalled();
    expect(mockUpsert).toHaveBeenCalled();
  });

  it("chave errada e sem sessao: 401, nao grava nada", async () => {
    mockParseRomaneio.mockReturnValue([linhaRegexValida()]);
    const { POST } = await import("./route");
    const res = await POST(comChave("outra"));
    expect(res.status).toBe(401);
    expect(mockUpsert).not.toHaveBeenCalled();
  });
});

// DR-05 (auditoria 15/10): placa do documento com O/0 trocado resolve contra o
// cadastro; ambigua nao e' reatada por chute.
describe("POST /api/romaneio/upload -- placa O/0 contra o cadastro (DR-05)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    proximoUpsertResultado = null;
    existentesDoDia = [];
    mockGetUser.mockResolvedValue({ data: { user: { id: "u1", email: "op@x.com" } } });
    mockExtrairDataRomaneio.mockReturnValue("2026-10-15");
  });

  // F1-05: antes a linha ficava com o veiculo certo mas a placa do documento
  // (RQ0-9H37: 47 pontos em 06-08/10), e a troca/consultas por placa erravam.
  it("RQ0-9H37 do documento reata no veiculo RQO-9H37 do cadastro e grava a placa do cadastro", async () => {
    mockParseRomaneio.mockReturnValue([{ ...linhaRegexValida(), placaBruta: "RQ0-9H37" }]);
    mockSelect.mockResolvedValue({ data: [{ id: "veic-24343", placa: "RQO-9H37" }] });
    const { POST } = await import("./route");
    const res = await POST(criarRequisicao("romaneio.pdf"));
    expect(res.status).toBe(200);
    const linhas = mockUpsert.mock.calls[0][0] as Array<{ veiculo_id: string | null; placa: string }>;
    expect(linhas[0].veiculo_id).toBe("veic-24343");
    expect(linhas[0].placa).toBe("RQO-9H37");
    // a consulta incluiu a variante O/0
    expect(mockSelect.mock.calls[0][1]).toContain("RQO-9H37");
  });

  it("duas candidatas O/0 no cadastro: fica sem veiculo (nao chuta)", async () => {
    mockParseRomaneio.mockReturnValue([{ ...linhaRegexValida(), placaBruta: "R00-1A11" }]);
    mockSelect.mockResolvedValue({ data: [{ id: "a", placa: "RO0-1A11" }, { id: "b", placa: "R0O-1A11" }] });
    const { POST } = await import("./route");
    await POST(criarRequisicao("romaneio.pdf"));
    const linhas = mockUpsert.mock.calls[0][0] as Array<{ veiculo_id: string | null; placa: string }>;
    expect(linhas[0].veiculo_id).toBeNull();
    // fora do cadastro: fica a placa do documento (a troca casa pela compacta)
    expect(linhas[0].placa).toBe("R00-1A11");
  });
});
