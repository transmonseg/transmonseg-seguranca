import { createClient } from "@/lib/supabase/server";
import { createAdminClient } from "@/lib/supabase/admin";
import { parseRomaneio, extrairDataRomaneio, normalizarPlaca } from "@/lib/romaneio";
import { geocodificarEndereco, geocodificarGoogle, geocodificarNominatim } from "@/lib/romaneio-geocode";

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

  let geocodadosOk = 0;
  let semCoordenada = 0;

  const buscarCache = async (chave: string) => {
    const { data } = await admin.from("romaneio_geocode_cache").select("lat, lng, fonte").eq("endereco_normalizado", chave).maybeSingle();
    return data ?? null;
  };
  const salvarCache = async (chave: string, r: { lat: number; lng: number; fonte: string }) => {
    await admin.from("romaneio_geocode_cache").upsert({ endereco_normalizado: chave, lat: r.lat, lng: r.lng, fonte: r.fonte, atualizado_em: new Date().toISOString() });
  };

  const linhasParaInserir = [];
  for (const l of linhas) {
    const placaNormalizada = normalizarPlaca(l.placaBruta);
    const veiculo = veiculoPorPlaca.get(placaNormalizada);

    // SEM fallback pra coordenada da Unitrac de proposito (achado real
    // 15/07: a maioria cairia nesse fallback, esvaziando o motivo do
    // romaneio existir -- decisao explicita do usuario). Se nao
    // geocodificar, o ponto fica sem lat/lng e o motor simplesmente nao o
    // usa (ver montarPontosDeRomaneio, filtra por lat/lng nao-nulo).
    const geocode = await geocodificarEndereco(l.enderecoBruto, { buscarCache, salvarCache, geocodificarGoogle, geocodificarNominatim });

    let geocodeStatus: string;
    if (geocode) { geocodadosOk++; geocodeStatus = "ok"; }
    else { semCoordenada++; geocodeStatus = "falhou"; }

    linhasParaInserir.push({
      veiculo_id: veiculo?.id ?? null,
      placa: placaNormalizada,
      romaneio_data: romaneioData,
      nf: l.nf,
      cliente_codigo: l.clienteCodigo,
      cliente_nome: l.clienteNome,
      endereco_bruto: l.enderecoBruto,
      carga_destino_codigo: l.cargaDestinoCodigo,
      carga_destino_nome: l.cargaDestinoNome,
      lat: geocode?.lat ?? null,
      lng: geocode?.lng ?? null,
      geocode_status: geocodeStatus,
    });
  }

  const { error: erroInsert } = await admin.from("romaneio_pontos").insert(linhasParaInserir);
  if (erroInsert) {
    return Response.json({ ok: false, erro: `Erro ao salvar: ${erroInsert.message}` }, { status: 500 });
  }

  return Response.json({
    ok: true,
    romaneioData,
    totalLinhas: linhas.length,
    geocodadosOk,
    semCoordenada,
    placasNaoEncontradas,
  });
}
