import { createClient } from "@/lib/supabase/server";
import { createAdminClient } from "@/lib/supabase/admin";
import { parseEscala, extrairDataEscala } from "@/lib/escala";
import { normalizarPlaca } from "@/lib/romaneio";
import { resolverDestinoEscala } from "@/lib/escala-geocode";
import { geocodificarGoogle, geocodificarNominatim } from "@/lib/romaneio-geocode";

export const maxDuration = 60;

export async function POST(request: Request) {
  // Rotas de API nao passam pelo proxy.ts (so protege paginas) -- validar
  // sessao aqui, mesmo padrao que /api/romaneio/upload ja usa.
  const auth = await createClient();
  const { data: { user } } = await auth.auth.getUser();
  if (!user) return Response.json({ ok: false, erro: "nao autorizado" }, { status: 401 });

  const formData = await request.formData();
  const arquivo = formData.get("arquivo");
  if (!(arquivo instanceof File)) {
    return Response.json({ ok: false, erro: "Nenhum arquivo enviado." }, { status: 400 });
  }

  // pdf-parse v2: classe PDFParse, nao funcao direta (mesmo padrao do
  // upload do romaneio). Buffer nunca escrito em disco.
  const { PDFParse } = await import("pdf-parse");
  const buffer = Buffer.from(await arquivo.arrayBuffer());
  const parser = new PDFParse({ data: buffer });
  const { text } = await parser.getText();

  const escalaData = extrairDataEscala(text);
  if (!escalaData) {
    return Response.json({ ok: false, erro: "Não consegui achar a data no cabeçalho do PDF. Confirma que é a escala certa." }, { status: 422 });
  }
  const linhas = parseEscala(text);
  if (linhas.length === 0) {
    return Response.json({ ok: false, erro: "PDF processado, mas nenhuma linha de carga foi encontrada -- formato pode ter mudado." }, { status: 422 });
  }

  const admin = createAdminClient();

  const placasUnicas = [...new Set(linhas.map((l) => normalizarPlaca(l.placaBruta)))];
  const { data: veiculos } = await admin.from("veiculos").select("id, placa").in("placa", placasUnicas);
  const veiculoPorPlaca = new Map((veiculos ?? []).map((v) => [v.placa, v]));
  const placasNaoEncontradas = placasUnicas.filter((p) => !veiculoPorPlaca.has(p));

  const { data: apelidos } = await admin.from("escala_apelidos").select("apelido_texto, cidade_destino");
  const mapaApelidos = new Map((apelidos ?? []).map((a) => [a.apelido_texto, a.cidade_destino]));

  const deps = {
    geocodificarGoogleDep: geocodificarGoogle,
    geocodificarNominatimDep: geocodificarNominatim,
    buscarApelidoDep: async (texto: string) => mapaApelidos.get(texto) ?? null,
  };

  const destinosUnicos = [...new Set(linhas.map((l) => l.destinoNormalizado))];
  const resolucaoPorDestino = new Map<string, Awaited<ReturnType<typeof resolverDestinoEscala>>>();
  for (const destino of destinosUnicos) {
    resolucaoPorDestino.set(destino, await resolverDestinoEscala(destino, deps));
  }

  const enviadoPor = (user.user_metadata?.nome as string | undefined) ?? user.email ?? null;
  const linhasParaInserir = linhas.map((l) => {
    const placaNormalizada = normalizarPlaca(l.placaBruta);
    const veiculo = veiculoPorPlaca.get(placaNormalizada);
    const resolucao = resolucaoPorDestino.get(l.destinoNormalizado)!;
    const resolvida = resolucao.via !== "nao_resolvido";
    return {
      veiculo_id: veiculo?.id ?? null,
      placa: placaNormalizada,
      escala_data: escalaData,
      carga_codigo: l.cargaCodigo,
      destino_texto: l.destinoTexto,
      destino_normalizado: l.destinoNormalizado,
      lat: resolvida ? resolucao.lat : null,
      lng: resolvida ? resolucao.lng : null,
      raio_m: resolvida ? resolucao.raioM : null,
      resolvido_via: resolucao.via,
      entregas: l.entregas,
      nfs: l.nfs,
      enviado_por: enviadoPor,
    };
  });

  // Reenvio do mesmo dia substitui as linhas anteriores -- volume baixo
  // (uma escala por dia) nao justifica um endpoint de reverter separado
  // como o romaneio tem.
  const { error: erroDelete } = await admin.from("escala_pontos").delete().eq("escala_data", escalaData);
  if (erroDelete) {
    return Response.json({ ok: false, erro: `Erro ao substituir escala anterior: ${erroDelete.message}` }, { status: 500 });
  }
  const { error: erroInsert } = await admin.from("escala_pontos").insert(linhasParaInserir);
  if (erroInsert) {
    return Response.json({ ok: false, erro: `Erro ao salvar: ${erroInsert.message}` }, { status: 500 });
  }

  const naoResolvidos = linhasParaInserir.filter((l) => l.resolvido_via === "nao_resolvido");
  return Response.json({
    ok: true,
    escalaData,
    totalLinhas: linhas.length,
    placasNaoEncontradas,
    destinosNaoResolvidos: [...new Set(naoResolvidos.map((l) => l.destino_normalizado))],
  });
}
