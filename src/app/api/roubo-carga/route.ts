// Roubo de carga por município do RJ (ISP-RJ, últimos 12 meses) como GeoJSON
// para o coroplético do mapa, mais o ranking. Protegido por login.
import { obterRouboCarga } from "@/lib/roubocarga";
import { createClient } from "@/lib/supabase/server";

export async function GET() {
  const auth = await createClient();
  const { data: { user } } = await auth.auth.getUser();
  if (!user) return Response.json({ erro: "nao autorizado" }, { status: 401 });

  const dados = await obterRouboCarga();
  if (!dados) return Response.json({ geojson: null, ranking: [], total: 0, periodo: "" });
  return Response.json(dados, {
    headers: { "Cache-Control": "private, max-age=3600, s-maxage=21600" },
  });
}
