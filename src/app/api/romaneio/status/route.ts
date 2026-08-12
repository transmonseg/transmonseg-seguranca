import { createClient } from "@/lib/supabase/server";
import { createAdminClient } from "@/lib/supabase/admin";

export async function GET(request: Request) {
  const auth = await createClient();
  const { data: { user } } = await auth.auth.getUser();
  if (!user) return Response.json({ ok: false, erro: "nao autorizado" }, { status: 401 });

  const { searchParams } = new URL(request.url);
  const data = searchParams.get("data");
  const modoTeste = searchParams.get("modoTeste") === "true";
  if (!data) return Response.json({ ok: false, erro: "parametro data obrigatorio" }, { status: 400 });

  const admin = createAdminClient();

  // Achado real 12/08: sem o filtro de modo_teste, o status misturava
  // contagem de romaneio real e de teste do mesmo dia quando os dois
  // existiam -- mesma classe de bug do /api/romaneio/reverter.
  const { data: pontosRaw } = await admin
    .from("romaneio_pontos")
    .select("nf, cliente_nome, endereco_bruto, lat, lng, geocode_status")
    .eq("romaneio_data", data)
    .eq("modo_teste", modoTeste);

  const linhas = pontosRaw ?? [];
  const contagens = { total: linhas.length, geocodadosOk: 0, falhou: 0, pendente: 0 };
  for (const l of linhas) {
    if (l.geocode_status === "ok") contagens.geocodadosOk++;
    else if (l.geocode_status === "falhou") contagens.falhou++;
    else contagens.pendente++;
  }

  return Response.json({
    ok: true,
    ...contagens,
    pontos: linhas.map((l) => ({
      nf: l.nf,
      clienteNome: l.cliente_nome,
      enderecoBruto: l.endereco_bruto,
      lat: l.lat,
      lng: l.lng,
      geocodeStatus: l.geocode_status,
    })),
  });
}
