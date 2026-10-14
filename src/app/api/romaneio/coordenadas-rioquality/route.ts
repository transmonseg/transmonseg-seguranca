// src/app/api/romaneio/coordenadas-rioquality/route.ts
//
// O KPI geocodifica a Rio Quality com um geocoder mais fraco que o do
// Monitoramento (sem fallback Unitrac, sem o cache compartilhado) -> ~359 NFs
// ficavam "sem coordenada". Este endpoint devolve as coordenadas que o
// Monitoramento JA' resolveu (cascata completa + Unitrac) pros pontos do dia;
// o KPI casa as placas+nf da RQ e fecha os "sem coordenada", usando a MESMA
// coordenada que aparece no mapa. Servidor-a-servidor (x-motor-key).
import { createClient } from "@/lib/supabase/server";
import { createAdminClient } from "@/lib/supabase/admin";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(request: Request) {
  const chaveMotor = request.headers.get("x-motor-key");
  const viaKpi = !!chaveMotor && !!process.env.MOTOR_SECRET && chaveMotor === process.env.MOTOR_SECRET;
  const auth = await createClient();
  const user = viaKpi ? null : (await auth.auth.getUser()).data.user;
  if (!viaKpi && !user) return Response.json({ ok: false, erro: "nao autorizado" }, { status: 401 });

  const data = new URL(request.url).searchParams.get("data");
  if (!data || !/^\d{4}-\d{2}-\d{2}$/.test(data)) {
    return Response.json({ ok: false, erro: "data YYYY-MM-DD obrigatoria." }, { status: 400 });
  }

  // Todos os pontos geocodificados do dia (NM + RQ). O KPI casa so' por
  // placa+nf da RQ, que nao colidem com as da Nutry Max.
  const { data: rows, error } = await createAdminClient()
    .from("romaneio_pontos")
    .select("placa, nf, lat, lng")
    .eq("romaneio_data", data)
    .not("lat", "is", null);
  if (error) return Response.json({ ok: false, erro: error.message }, { status: 500 });

  return Response.json({ ok: true, pontos: rows ?? [] });
}
