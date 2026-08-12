import { createClient } from "@/lib/supabase/server";
import { createAdminClient } from "@/lib/supabase/admin";
import { parseRomaneio, extrairDataRomaneio, normalizarPlaca, type LinhaRomaneio } from "@/lib/romaneio";
import { extrairTextoPlanilha } from "@/lib/romaneio-planilha";
import { extrairRomaneioViaLLM, chamarOllama, chamarMistral, type LinhaRomaneioExtraida } from "@/lib/romaneio-llm-extrator";

const EXTENSOES_PLANILHA = [".xlsx", ".xls", ".csv"];

function ehPlanilha(nomeArquivo: string): boolean {
  const nome = nomeArquivo.toLowerCase();
  return EXTENSOES_PLANILHA.some((ext) => nome.endsWith(ext));
}

// Normaliza os dois formatos de linha (parser regex Nutry Max e extrator
// LLM generico) pro mesmo shape de insercao -- carga_destino_* so' existe
// no caminho regex (conceito especifico da Nutry Max, sem analogo generico).
//
// nf e' NOT NULL em romaneio_pontos (confirmado no schema real -- diferente
// de cliente_codigo/carga_destino_*, que sao nullable). NF (nota fiscal) e'
// conceito de integracao especifico da Nutry Max (usado so' pra casar com
// o campo `documento` da Unitrac em montarPontosDeRomaneio, romaneio.ts) --
// outra empresa pode genuinamente nao ter NF nenhuma no romaneio. Em vez de
// migrar o schema pra nullable (o que exigiria auditar todo o pipeline de
// geocodificacao/consumo que assume nf: string nao-nulo), quando o
// extrator LLM nao encontra NF gera um valor sintetico com prefixo
// reconhecivel -- nunca colide com uma NF real (que nao tem esse prefixo)
// e nunca bate por acidente contra nenhum `documento` da Unitrac, dando
// exatamente o comportamento correto ("sem NF pra casar, fica pendente
// por padrao", ja documentado no comentario de montarPontosDeRomaneio).
type LinhaNormalizada = {
  placaBruta: string;
  nf: string;
  clienteCodigo: string | null;
  clienteNome: string;
  enderecoBruto: string;
  cargaDestinoCodigo: string | null;
  cargaDestinoNome: string | null;
};

function normalizarLinhasRegex(linhas: LinhaRomaneio[]): LinhaNormalizada[] {
  return linhas.map((l) => ({
    placaBruta: l.placaBruta,
    nf: l.nf,
    clienteCodigo: l.clienteCodigo,
    clienteNome: l.clienteNome,
    enderecoBruto: l.enderecoBruto,
    cargaDestinoCodigo: l.cargaDestinoCodigo,
    cargaDestinoNome: l.cargaDestinoNome,
  }));
}

function normalizarLinhasLLM(linhas: LinhaRomaneioExtraida[]): LinhaNormalizada[] {
  return linhas.map((l) => ({
    placaBruta: l.placaBruta,
    nf: l.nf ?? `sem-nf:${crypto.randomUUID()}`,
    clienteCodigo: l.clienteCodigo ?? null,
    clienteNome: l.clienteNome,
    enderecoBruto: l.enderecoBruto,
    cargaDestinoCodigo: null,
    cargaDestinoNome: null,
  }));
}

export async function POST(request: Request) {
  // Rotas de API nao passam pelo proxy.ts (so protege paginas) -- validar
  // sessao aqui, mesmo padrao que /api/mapa ja usa.
  const auth = await createClient();
  const { data: { user } } = await auth.auth.getUser();
  if (!user) return Response.json({ ok: false, erro: "nao autorizado" }, { status: 401 });

  const formData = await request.formData();
  const arquivo = formData.get("arquivo");
  if (!(arquivo instanceof File)) {
    return Response.json({ ok: false, erro: "Nenhum arquivo enviado." }, { status: 400 });
  }
  const modoTeste = formData.get("modoTeste") === "true";
  const buffer = Buffer.from(await arquivo.arrayBuffer());
  const isPlanilha = ehPlanilha(arquivo.name);

  let texto: string;
  if (isPlanilha) {
    texto = extrairTextoPlanilha(buffer);
  } else {
    // pdf-parse v2: classe PDFParse, nao funcao direta (API mudou da v1 --
    // confirmado ao investigar o texto real na Task 2 do plano original de
    // upload). Import dinamico mantido isolado aqui (nao vaza pro resto do
    // codigo tipado).
    const { PDFParse } = await import("pdf-parse");
    const parser = new PDFParse({ data: buffer }); // buffer nunca escrito em disco
    const { text } = await parser.getText();
    texto = text;
  }

  const romaneioData = extrairDataRomaneio(texto);
  if (!romaneioData) {
    return Response.json({ ok: false, erro: "Não consegui achar a data no cabeçalho do arquivo. Confirma que é o romaneio certo." }, { status: 422 });
  }

  // Planilha nunca tem regex dedicado (nao existe romaneio Excel da Nutry
  // Max hoje) -- so PDF tenta o regex primeiro. Regex que nao reconhece o
  // formato devolve 0 linhas, cai pro extrator via IA.
  const linhasRegex = isPlanilha ? [] : parseRomaneio(texto);
  let linhasNormalizadas: LinhaNormalizada[];
  if (linhasRegex.length > 0) {
    linhasNormalizadas = normalizarLinhasRegex(linhasRegex);
  } else {
    const linhasLLM = await extrairRomaneioViaLLM(texto, { chamarOllama, chamarMistral });
    if (!linhasLLM) {
      return Response.json({ ok: false, erro: "Não consegui extrair as linhas de entrega desse arquivo. Confirma o formato ou tenta novamente." }, { status: 422 });
    }
    linhasNormalizadas = normalizarLinhasLLM(linhasLLM);
  }

  if (linhasNormalizadas.length === 0) {
    return Response.json({ ok: false, erro: "Arquivo processado, mas nenhuma linha de entrega foi encontrada -- formato pode ter mudado." }, { status: 422 });
  }

  const admin = createAdminClient();

  // Resolve veiculo_id por placa normalizada.
  const placasUnicas = [...new Set(linhasNormalizadas.map((l) => normalizarPlaca(l.placaBruta)))];
  const { data: veiculos } = await admin.from("veiculos").select("id, placa").in("placa", placasUnicas);
  const veiculoPorPlaca = new Map((veiculos ?? []).map((v) => [v.placa, v]));
  const placasNaoEncontradas = placasUnicas.filter((p) => !veiculoPorPlaca.has(p));

  const enviadoPor = (user.user_metadata?.nome as string | undefined) ?? user.email ?? null;

  const linhasParaInserir = linhasNormalizadas.map((l) => {
    const placaNormalizada = normalizarPlaca(l.placaBruta);
    const veiculo = veiculoPorPlaca.get(placaNormalizada);
    return {
      veiculo_id: veiculo?.id ?? null,
      placa: placaNormalizada,
      romaneio_data: romaneioData,
      nf: l.nf,
      cliente_codigo: l.clienteCodigo,
      cliente_nome: l.clienteNome,
      endereco_bruto: l.enderecoBruto,
      carga_destino_codigo: l.cargaDestinoCodigo,
      carga_destino_nome: l.cargaDestinoNome,
      lat: null,
      lng: null,
      geocode_status: "pendente",
      modo_teste: modoTeste,
      enviado_por: enviadoPor,
    };
  });

  const { error: erroInsert } = await admin.from("romaneio_pontos").insert(linhasParaInserir);
  if (erroInsert) {
    return Response.json({ ok: false, erro: `Erro ao salvar: ${erroInsert.message}` }, { status: 500 });
  }

  // Geocodificacao roda em background (ver /api/romaneio/processar-geocode,
  // disparado por pg_cron) -- upload so insere as linhas como 'pendente' e
  // responde na hora, sem esperar nenhuma chamada de rede externa de
  // geocodificacao (a chamada de extracao via IA, quando usada, ja
  // aconteceu sincrona acima -- so a geocodificacao fica pro cron).
  return Response.json({
    ok: true,
    romaneioData,
    totalLinhas: linhasNormalizadas.length,
    placasNaoEncontradas,
    modoTeste,
  });
}
