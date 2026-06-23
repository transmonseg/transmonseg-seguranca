// Retorna a posicao atual (snapshot) de um veiculo pelo CV.
import { buscarPosicaoUnica } from "@/lib/unitrac";
import { createClient } from "@/lib/supabase/server";

export const dynamic = "force-dynamic";

export async function GET(request: Request) {
  // Posicao de veiculo e dado sensivel: exige operador logado.
  const auth = await createClient();
  const { data: { user } } = await auth.auth.getUser();
  if (!user) return Response.json({ erro: "nao autorizado" }, { status: 401 });

  const { searchParams } = new URL(request.url);
  const cv = searchParams.get("cv");
  if (!cv) {
    return Response.json({ erro: "parametro cv e obrigatorio" }, { status: 400 });
  }

  try {
    const posicao = await buscarPosicaoUnica(cv);
    return Response.json({ posicao });
  } catch (e) {
    return Response.json({ erro: String(e) }, { status: 500 });
  }
}
