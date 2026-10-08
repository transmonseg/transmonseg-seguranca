import { createAdminClient } from "@/lib/supabase/admin";
import { extrairCidadeDoEndereco, expandirCidadeTruncada, extrairBairroDoEndereco, municipioCodigoIbge } from "@/lib/romaneio-geocode-local";
import { validarTerritorio } from "@/lib/territorio";
import { montarDepsTerritorio } from "../geocode/territorio-deps";

// Auditoria 07/10 (KPI Nutry Max): 26 NFs sairam ENTREGUE por parada no
// cadastro da Unitrac a 2-134 km do endereco do romaneio, em outro bairro ou
// municipio. O KPI pergunta aqui se a PARADA que confirmou cai no municipio e
// no bairro do endereco -- mesma guarda (e mesmo fail-open) do geocode. So'
// via ponte (x-motor-key).
const MAX_PONTOS = 500;

type Ponto = { id: string; lat: unknown; lng: unknown; endereco: unknown };

export async function POST(request: Request) {
  const chave = request.headers.get("x-motor-key");
  if (!chave || !process.env.MOTOR_SECRET || chave !== process.env.MOTOR_SECRET) {
    return Response.json({ erro: "nao autorizado" }, { status: 401 });
  }
  let body: { pontos?: unknown };
  try { body = await request.json(); } catch { return Response.json({ erro: "corpo invalido" }, { status: 400 }); }
  const pontos = body.pontos;
  if (!Array.isArray(pontos) || pontos.length > MAX_PONTOS) {
    return Response.json({ erro: `esperado { pontos: [{ id, lat, lng, endereco }] } (no maximo ${MAX_PONTOS})` }, { status: 400 });
  }
  const deps = montarDepsTerritorio(createAdminClient());
  const resultados = [];
  for (const p of pontos as Ponto[]) {
    const id = String(p?.id ?? "");
    if (typeof p?.lat !== "number" || typeof p?.lng !== "number" || !Number.isFinite(p.lat) || !Number.isFinite(p.lng) || typeof p.endereco !== "string") {
      resultados.push({ id, ok: null });
      continue;
    }
    const cidade = extrairCidadeDoEndereco(p.endereco);
    const municipioCodigo = cidade ? municipioCodigoIbge(expandirCidadeTruncada(cidade)) : null;
    const t = await validarTerritorio({ lat: p.lat, lng: p.lng }, { municipioCodigo, bairro: extrairBairroDoEndereco(p.endereco) }, deps);
    resultados.push(t.ok ? { id, ok: true } : { id, ok: false, motivo: t.motivo });
  }
  return Response.json({ resultados });
}
