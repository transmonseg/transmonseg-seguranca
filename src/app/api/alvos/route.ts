import { buscarAlvos, agruparPontosPorPlaca } from "@/lib/unitrac";

export async function GET(request: Request) {
  const { searchParams } = new URL(request.url);
  const cv = searchParams.get("cv");
  if (!cv) return Response.json({ pontos: [] }, { status: 400 });

  try {
    const raw = await buscarAlvos([cv]);
    const mapa = agruparPontosPorPlaca(raw);
    const todos = [...mapa.values()].flat();
    return Response.json({ pontos: todos });
  } catch (err) {
    return Response.json({ pontos: [], erro: String(err) });
  }
}
