import { createClient } from "@/lib/supabase/server";
import { createAdminClient } from "@/lib/supabase/admin";
import { parseRomaneio, extrairDataRomaneio, normalizarPlaca, type LinhaRomaneio } from "@/lib/romaneio";
import { parseRomaneioTabular, extrairDataTabular } from "@/lib/romaneio-tabular";
import { extrairTextoPlanilha } from "@/lib/romaneio-planilha";
import { extrairRomaneioViaLLM, chamarOllama, chamarMistral, type LinhaRomaneioExtraida } from "@/lib/romaneio-llm-extrator";
import { normalizarOrigem } from "@/lib/romaneio-origem";

// Ollama (ate 35s) + Mistral (ate 30s) rodam sequenciais e sincronos dentro
// do POST no caminho generico/LLM -- pior caso ~65s. 120s da folga (mesmo
// valor usado em escala/upload, outra rota com chamada de rede longa) sem
// ficar justo contra proxy/gateway.
export const maxDuration = 120;

const EXTENSOES_PLANILHA = [".xlsx", ".xls", ".csv"];

// Chave natural de "esta e' a mesma linha de entrega" -- ver migration 065
// (scripts/migrations/contabo/) pra investigacao completa do dado real por
// tras dessa escolha. Precisa bater exatamente com o UNIQUE criado la' --
// o upsert abaixo depende de existir uma constraint real sobre essas
// colunas (PostgREST exige um UNIQUE/PK pro on_conflict funcionar).
const CHAVE_UNICA_ROMANEIO_PONTOS = "romaneio_data,placa,nf,modo_teste,origem";

function ehPlanilha(nomeArquivo: string): boolean {
  const nome = nomeArquivo.toLowerCase();
  return EXTENSOES_PLANILHA.some((ext) => nome.endsWith(ext));
}

function hojeSP(): string {
  return new Intl.DateTimeFormat("en-CA", { timeZone: "America/Sao_Paulo" }).format(new Date());
}

// Fallback de data pro caminho generico/LLM (planilha ou PDF fora do padrao
// Nutry Max) -- documento nao segue o cabecalho "dd/mm/yyyy HH:MM" que
// extrairDataRomaneio (romaneio.ts) exige, entao aceita formatos mais
// soltos antes de desistir e cair pra data de hoje. NAO usado no caminho
// regex (Nutry Max) -- esse continua estrito, ver POST abaixo.
function extrairDataPermissiva(texto: string): string | null {
  const iso = texto.match(/\b(\d{4})-(\d{2})-(\d{2})\b/);
  if (iso) return `${iso[1]}-${iso[2]}-${iso[3]}`;
  const br = texto.match(/\b(\d{2})\/(\d{2})\/(\d{4})\b/);
  if (br) return `${br[3]}-${br[2]}-${br[1]}`;
  return null;
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
  // Origem do lote (romaneio principal x escala do Pao) -- ver migration 059.
  // Campo vem do cliente, entao passa pela allowlist de normalizarOrigem:
  // valor desconhecido nunca chega ao banco, cai no padrao 'romaneio', que
  // e' tambem o comportamento de quem nao manda o campo (compatibilidade
  // com qualquer chamada antiga).
  const origem = normalizarOrigem(formData.get("origem"));
  const buffer = Buffer.from(await arquivo.arrayBuffer());
  const isPlanilha = ehPlanilha(arquivo.name);

  let texto: string;
  try {
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
  } catch {
    // XLSX.read (arquivo corrompido/nao-planilha) e PDFParse.getText() (nao
    // e' PDF de verdade) lancam exception -- essa rota agora aceita "o que
    // o usuario mandar", entao arquivo invalido/mal-nomeado e' cenario
    // esperado, nao caso extremo. 422 claro em vez de 500 opaco.
    return Response.json({ ok: false, erro: "Não consegui ler esse arquivo. Confirma que é um PDF, Excel (.xlsx/.xls) ou CSV válido." }, { status: 422 });
  }

  // Planilha nunca tem regex dedicado (nao existe romaneio Excel da Nutry
  // Max hoje) -- so PDF tenta os regex primeiro. Nenhum regex reconhecer o
  // formato cai pro extrator via IA.
  const linhasRegex = isPlanilha ? [] : parseRomaneio(texto);
  // Achado real 24-25/08 ("Escala do Pao"/"Programacao Congelado" -- mesmo
  // documento, nomes diferentes quase todo dia): formato tabular por carro,
  // 100% consistente entre arquivos de dias diferentes (ver romaneio-
  // tabular.ts) -- so' tentado quando o regex da Nutry Max NAO bateu (os
  // dois formatos sao mutuamente exclusivos por construcao: um exige
  // "PLACA/MOTORISTA:" em texto corrido, o outro exige linha "CARRO" em
  // tabela). Reconhecido = nunca mais precisa de LLM pra esse documento --
  // zero custo, zero risco de timeout/infra (Ollama/Mistral), determinismo
  // total. null = formato nao reconhecido, cai pro caminho via IA como
  // antes.
  const linhasTabular = isPlanilha || linhasRegex.length > 0 ? null : parseRomaneioTabular(texto);

  let linhasNormalizadas: LinhaNormalizada[];
  let romaneioData: string;
  let fonteExtracao: "regex" | "regex_tabular" | "ollama" | "mistral";

  if (linhasRegex.length > 0) {
    // Nutry Max via regex -- caminho vivo/testado do unico cliente em
    // producao hoje. Data tem que bater o padrao estrito "dd/mm/yyyy HH:MM"
    // do cabecalho impresso, exatamente como antes -- NAO relaxar aqui.
    const data = extrairDataRomaneio(texto);
    if (!data) {
      return Response.json({ ok: false, erro: "Não consegui achar a data no cabeçalho do arquivo. Confirma que é o romaneio certo." }, { status: 422 });
    }
    romaneioData = data;
    linhasNormalizadas = normalizarLinhasRegex(linhasRegex);
    fonteExtracao = "regex";
  } else if (linhasTabular && linhasTabular.length > 0) {
    // Escala do Pao / Programacao Congelado -- data vem do cabecalho
    // "DATA\t<dd/mm/yyyy>" proprio desse formato (SEM horario, por isso um
    // extrator dedicado -- extrairDataRomaneio exigiria HH:MM e nunca
    // bateria aqui). Sem esse cabecalho e' formato inesperado -- 422 em vez
    // de arriscar data errada (mesma politica do caminho regex da Nutry
    // Max, ao contrario do caminho generico via IA que tem fallback pra
    // "hoje").
    const data = extrairDataTabular(texto);
    if (!data) {
      return Response.json({ ok: false, erro: "Não consegui achar a data no cabeçalho do arquivo. Confirma que é o romaneio certo." }, { status: 422 });
    }
    romaneioData = data;
    linhasNormalizadas = normalizarLinhasLLM(linhasTabular);
    fonteExtracao = "regex_tabular";
  } else {
    // Planilha OU PDF de formato desconhecido -- caminho generico via IA.
    // So' 422 se as LINHAS DE ENTREGA nao saem (esse e' o unico bloqueio
    // real). Data nunca bloqueia esse caminho: tenta o padrao estrito
    // (pode bater por coincidencia), cai pra um padrao mais solto, e como
    // ultimo recurso usa a data de hoje em vez de rejeitar o upload.
    const resultado = await extrairRomaneioViaLLM(texto, { chamarOllama, chamarMistral });
    if (!resultado) {
      return Response.json({ ok: false, erro: "Não consegui extrair as linhas de entrega desse arquivo. Confirma o formato ou tenta novamente." }, { status: 422 });
    }
    linhasNormalizadas = normalizarLinhasLLM(resultado.linhas);
    fonteExtracao = resultado.fonte;
    romaneioData = extrairDataRomaneio(texto) ?? extrairDataPermissiva(texto) ?? hojeSP();
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
      origem,
    };
  });

  // upsert + ON CONFLICT DO NOTHING (ignoreDuplicates) em vez de insert()
  // puro -- reenviar o mesmo arquivo (achado real: 2291 linhas duplicadas
  // em 18/08, mais casos em 31/07, 10/08, 24/08, 26/08, todos reenvio do
  // MESMO romaneio) nao duplica mais, so' ignora silenciosamente a linha
  // que ja existe. DO NOTHING (nao DO UPDATE) de proposito: um reenvio e'
  // sempre o mesmo conteudo (confirmado investigando os grupos duplicados
  // reais -- endereco/cliente/geocode_status identicos dentro de cada
  // grupo), entao nao ha nada pra "atualizar" -- e DO NOTHING preserva
  // geocode_status/lat/lng/presenca_confirmada_em ja processados na linha
  // existente em vez de arriscar sobrescrever com os valores 'pendente'
  // desse novo insert.
  //
  // .select("id") depois do upsert: com ignoreDuplicates, o PostgREST so'
  // devolve (RETURNING) as linhas que realmente foram inseridas -- as que
  // bateram em conflito nao aparecem. E' assim que contamos duplicata sem
  // outra query.
  const { data: linhasInseridas, error: erroInsert } = await admin
    .from("romaneio_pontos")
    .upsert(linhasParaInserir, { onConflict: CHAVE_UNICA_ROMANEIO_PONTOS, ignoreDuplicates: true })
    .select("id");
  if (erroInsert) {
    return Response.json({ ok: false, erro: `Erro ao salvar: ${erroInsert.message}` }, { status: 500 });
  }
  const totalInseridas = linhasInseridas?.length ?? 0;
  const linhasDuplicadas = linhasParaInserir.length - totalInseridas;

  // Geocodificacao roda em background (ver /api/romaneio/processar-geocode,
  // disparado por pg_cron) -- upload so insere as linhas como 'pendente' e
  // responde na hora, sem esperar nenhuma chamada de rede externa de
  // geocodificacao (a chamada de extracao via IA, quando usada, ja
  // aconteceu sincrona acima -- so a geocodificacao fica pro cron).
  return Response.json({
    ok: true,
    romaneioData,
    totalLinhas: linhasNormalizadas.length,
    linhasInseridas: totalInseridas,
    linhasDuplicadas,
    placasNaoEncontradas,
    modoTeste,
    origem,
    fonteExtracao,
  });
}
