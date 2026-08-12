import { createClient } from "@/lib/supabase/server";
import { createAdminClient } from "@/lib/supabase/admin";

// Achado real 31/07 (cliente Nutry Max): usuario quer poder desfazer um
// romaneio processado (ex.: subiu o arquivo errado, ou quer reprocessar do
// zero). E' um "comeca de novo" pra aquele dia, nao um desfazer parcial.
//
// Achado real 12/08: a versao original apagava TODAS as linhas daquele
// romaneio_data de uma vez (teste e reais juntas, sem distincao) --
// resetar o romaneio real de producao apagava silenciosamente qualquer
// romaneio de modo teste do mesmo dia (e vice-versa), sem nenhum aviso
// disso. Agora sempre escopado por modoTeste -- reseta so' o que a tela
// tinha selecionado no momento do clique, nunca os dois juntos.
export async function POST(request: Request) {
  const auth = await createClient();
  const { data: { user } } = await auth.auth.getUser();
  if (!user) return Response.json({ ok: false, erro: "nao autorizado" }, { status: 401 });

  const body = await request.json().catch(() => null);
  const romaneioData = typeof body?.romaneioData === "string" ? body.romaneioData : null;
  const modoTeste = body?.modoTeste === true;
  if (!romaneioData) {
    return Response.json({ ok: false, erro: "romaneioData obrigatorio" }, { status: 400 });
  }

  const admin = createAdminClient();
  const { data, error } = await admin
    .from("romaneio_pontos")
    .delete()
    .eq("romaneio_data", romaneioData)
    .eq("modo_teste", modoTeste)
    .select("id");

  if (error) {
    return Response.json({ ok: false, erro: `Erro ao reverter: ${error.message}` }, { status: 500 });
  }

  return Response.json({ ok: true, linhasRemovidas: data?.length ?? 0 });
}
