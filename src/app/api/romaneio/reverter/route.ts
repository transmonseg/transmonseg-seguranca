import { createClient } from "@/lib/supabase/server";
import { createAdminClient } from "@/lib/supabase/admin";

// Achado real 31/07 (cliente Nutry Max): usuario quer poder desfazer um
// romaneio processado (ex.: subiu o arquivo errado, ou quer reprocessar do
// zero). Apaga TODAS as linhas daquele romaneio_data (teste e reais) -- e'
// um "comeca de novo" pra aquele dia, nao um desfazer parcial.
export async function POST(request: Request) {
  const auth = await createClient();
  const { data: { user } } = await auth.auth.getUser();
  if (!user) return Response.json({ ok: false, erro: "nao autorizado" }, { status: 401 });

  const body = await request.json().catch(() => null);
  const romaneioData = typeof body?.romaneioData === "string" ? body.romaneioData : null;
  if (!romaneioData) {
    return Response.json({ ok: false, erro: "romaneioData obrigatorio" }, { status: 400 });
  }

  const admin = createAdminClient();
  const { data, error } = await admin
    .from("romaneio_pontos")
    .delete()
    .eq("romaneio_data", romaneioData)
    .select("id");

  if (error) {
    return Response.json({ ok: false, erro: `Erro ao reverter: ${error.message}` }, { status: 500 });
  }

  return Response.json({ ok: true, linhasRemovidas: data?.length ?? 0 });
}
