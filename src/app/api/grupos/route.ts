// Retorna os veiculos do cliente agrupados por grupo Unitrac (gvc/gvn).
// GET /api/grupos?cliente={cod_unitrac}
import { createClient } from "@/lib/supabase/server";

export const dynamic = "force-dynamic";

interface VeiculoRaw {
  ne: string;
  ce: string;
  gvn: string;
  gvc: number;
  identificacao: string;
  placa: string;
  cv: string | number;
}

interface GrupoSaida {
  gvc: number;
  gvn: string;
  veiculos: { placa: string; cv: string }[];
}

export async function GET(request: Request) {
  const auth = await createClient();
  const {
    data: { user },
  } = await auth.auth.getUser();
  if (!user) return Response.json({ erro: "nao autorizado" }, { status: 401 });

  const { searchParams } = new URL(request.url);
  const cod = searchParams.get("cliente");
  if (!cod) return Response.json({ grupos: [] });

  try {
    const res = await fetch(
      `https://datalayer.portalunitrac.com/veiculos/masn/${cod}`,
      { headers: { accept: "application/json" }, cache: "no-store" }
    );
    if (!res.ok) return Response.json({ grupos: [] });

    const data = (await res.json()) as { veiculos: VeiculoRaw[] };
    const lista: VeiculoRaw[] = Array.isArray(data?.veiculos) ? data.veiculos : [];

    // Agrupa por gvc/gvn preservando a ordem de aparicao
    const mapa = new Map<number, GrupoSaida>();
    for (const v of lista) {
      const gvc = Number(v.gvc);
      if (!mapa.has(gvc)) {
        mapa.set(gvc, { gvc, gvn: v.gvn ?? `Grupo ${gvc}`, veiculos: [] });
      }
      mapa.get(gvc)!.veiculos.push({
        placa: v.placa ?? "",
        cv: String(v.cv),
      });
    }

    return Response.json({ grupos: Array.from(mapa.values()) });
  } catch {
    return Response.json({ grupos: [] });
  }
}
