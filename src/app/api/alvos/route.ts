import { buscarAlvos, agruparPontosPorPlaca } from "@/lib/unitrac";

export async function GET(request: Request) {
  const { searchParams } = new URL(request.url);
  // Suporta ?cv=X (único) ou múltiplos ?cv=A&cv=B (frota completa)
  const cvs = searchParams.getAll("cv");
  if (cvs.length === 0) return Response.json({ pontos: [] }, { status: 400 });

  try {
    const raw = await buscarAlvos(cvs);
    const mapa = agruparPontosPorPlaca(raw);
    const todos = [...mapa.values()].flat();
    return Response.json({ pontos: todos });
  } catch (err) {
    return Response.json({ pontos: [], erro: String(err) });
  }
}
