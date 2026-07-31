import { createClient } from "@/lib/supabase/server";
import { createAdminClient } from "@/lib/supabase/admin";
import { parseRomaneio, extrairDataRomaneio, normalizarPlaca } from "@/lib/romaneio";

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

  // pdf-parse v2: classe PDFParse, nao funcao direta (API mudou da v1 --
  // confirmado ao investigar o texto real na Task 2). Import dinamico
  // mantido isolado aqui (nao vaza pro resto do codigo tipado).
  const { PDFParse } = await import("pdf-parse");
  const buffer = Buffer.from(await arquivo.arrayBuffer());
  const parser = new PDFParse({ data: buffer }); // buffer nunca escrito em disco
  const { text } = await parser.getText();

  const romaneioData = extrairDataRomaneio(text);
  if (!romaneioData) {
    return Response.json({ ok: false, erro: "Não consegui achar a data no cabeçalho do PDF. Confirma que é o romaneio certo." }, { status: 422 });
  }

  const linhas = parseRomaneio(text);
  if (linhas.length === 0) {
    return Response.json({ ok: false, erro: "PDF processado, mas nenhuma linha de entrega foi encontrada -- formato pode ter mudado." }, { status: 422 });
  }

  const admin = createAdminClient();

  // Resolve veiculo_id por placa normalizada.
  const placasUnicas = [...new Set(linhas.map((l) => normalizarPlaca(l.placaBruta)))];
  const { data: veiculos } = await admin.from("veiculos").select("id, placa").in("placa", placasUnicas);
  const veiculoPorPlaca = new Map((veiculos ?? []).map((v) => [v.placa, v]));
  const placasNaoEncontradas = placasUnicas.filter((p) => !veiculoPorPlaca.has(p));

  const enviadoPor = (user.user_metadata?.nome as string | undefined) ?? user.email ?? null;

  const linhasParaInserir = linhas.map((l) => {
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
  // responde na hora, sem esperar nenhuma chamada de rede externa.
  return Response.json({
    ok: true,
    romaneioData,
    totalLinhas: linhas.length,
    placasNaoEncontradas,
    modoTeste,
  });
}
