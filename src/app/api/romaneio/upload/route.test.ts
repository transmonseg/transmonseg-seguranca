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
vi.mock("@/lib/romaneio", () => ({
  parseRomaneio: mockParseRomaneio,
  extrairDataRomaneio: mockExtrairDataRomaneio,
  normalizarPlaca: mockNormalizarPlaca,
}));

const mockExtrairTextoPlanilha = vi.fn();
vi.mock("@/lib/romaneio-planilha", () => ({
  extrairTextoPlanilha: mockExtrairTextoPlanilha,
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

const mockInsert = vi.fn();
const mockSelect = vi.fn();
vi.mock("@/lib/supabase/admin", () => ({
  createAdminClient: () => ({
    from: (tabela: string) => {
      if (tabela === "veiculos") {
        return { select: () => ({ in: mockSelect }) };
      }
      return { insert: mockInsert };
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

function criarRequisicao(nomeArquivo: string, conteudo = "conteudo") {
  const formData = new FormData();
  const arquivo = new File([conteudo], nomeArquivo);
  formData.append("arquivo", arquivo);
  return new Request("http://localhost/api/romaneio/upload", { method: "POST", body: formData });
}

describe("POST /api/romaneio/upload -- roteamento de extracao", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockGetUser.mockResolvedValue({ data: { user: { id: "u1", email: "op@x.com" } } });
    mockExtrairDataRomaneio.mockReturnValue("2026-08-12");
    mockSelect.mockResolvedValue({ data: [] });
    mockInsert.mockResolvedValue({ error: null });
  });

  it("PDF que bate o regex Nutry Max: usa parseRomaneio, NAO chama o extrator LLM", async () => {
    mockParseRomaneio.mockReturnValue([
      { placaBruta: "ABC1D23", motorista: "M", cargaDestinoCodigo: "1", cargaDestinoNome: "N", nf: "1", clienteCodigo: "C1", clienteNome: "Cliente", enderecoBruto: "Rua X" },
    ]);
    const { POST } = await import("./route");
    const res = await POST(criarRequisicao("romaneio.pdf"));
    expect(res.status).toBe(200);
    expect(mockExtrairRomaneioViaLLM).not.toHaveBeenCalled();
    expect(mockInsert).toHaveBeenCalled();
  });

  it("PDF que NAO bate o regex (0 linhas): cai pro extrator LLM", async () => {
    mockParseRomaneio.mockReturnValue([]);
    mockExtrairRomaneioViaLLM.mockResolvedValue([
      { placaBruta: "XYZ9W88", enderecoBruto: "Av Brasil, 500", clienteNome: "Loja X" },
    ]);
    const { POST } = await import("./route");
    const res = await POST(criarRequisicao("romaneio-outro-formato.pdf"));
    expect(res.status).toBe(200);
    expect(mockExtrairRomaneioViaLLM).toHaveBeenCalledTimes(1);
  });

  it("Excel: nunca chama parseRomaneio, vai direto pro extrator LLM", async () => {
    mockExtrairTextoPlanilha.mockReturnValue("TEXTO DA PLANILHA");
    mockExtrairRomaneioViaLLM.mockResolvedValue([
      { placaBruta: "XYZ9W88", enderecoBruto: "Av Brasil, 500", clienteNome: "Loja X" },
    ]);
    const { POST } = await import("./route");
    const res = await POST(criarRequisicao("romaneio.xlsx"));
    expect(res.status).toBe(200);
    expect(mockParseRomaneio).not.toHaveBeenCalled();
    expect(mockExtrairTextoPlanilha).toHaveBeenCalledTimes(1);
    expect(mockExtrairRomaneioViaLLM).toHaveBeenCalledTimes(1);
  });

  it("CSV: mesmo caminho do Excel (extensao .csv reconhecida)", async () => {
    mockExtrairTextoPlanilha.mockReturnValue("TEXTO DO CSV");
    mockExtrairRomaneioViaLLM.mockResolvedValue([
      { placaBruta: "XYZ9W88", enderecoBruto: "Av Brasil, 500", clienteNome: "Loja X" },
    ]);
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
    expect(mockInsert).not.toHaveBeenCalled();
  });

  it("linha extraida sem endereco (ambigua) e aceita, nao bloqueia o upload", async () => {
    mockParseRomaneio.mockReturnValue([]);
    mockExtrairRomaneioViaLLM.mockResolvedValue([
      { placaBruta: "ABC1D23", enderecoBruto: "", clienteNome: "Cliente sem endereco" },
    ]);
    const { POST } = await import("./route");
    const res = await POST(criarRequisicao("romaneio.pdf"));
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.totalLinhas).toBe(1);
  });

  it("linhas do caminho LLM inserem carga_destino_codigo/nome como null e um nf sintetico nao-nulo quando o LLM nao extraiu NF", async () => {
    mockParseRomaneio.mockReturnValue([]);
    mockExtrairRomaneioViaLLM.mockResolvedValue([
      { placaBruta: "ABC1D23", enderecoBruto: "Rua X", clienteNome: "Cliente" },
    ]);
    const { POST } = await import("./route");
    await POST(criarRequisicao("romaneio.pdf"));
    const linhasInseridas = mockInsert.mock.calls[0][0];
    expect(linhasInseridas[0].carga_destino_codigo).toBeNull();
    expect(linhasInseridas[0].carga_destino_nome).toBeNull();
    // nf e' NOT NULL no banco -- nunca pode inserir null aqui.
    expect(linhasInseridas[0].nf).toEqual(expect.stringMatching(/^sem-nf:/));
  });
});
