// Retorna o historico de posicoes (rastro) de um veiculo nas ultimas N horas.
import { buscarRastro, removerPicosRastro } from "@/lib/unitrac";
import { ajustarRastroParaRuas } from "@/lib/rastro-matching";
import { createClient } from "@/lib/supabase/server";

export const dynamic = "force-dynamic";
// MAX_CHAMADAS subiu de 40 pra 200 (ver rastro-matching.ts) — margem de
// segurança pra janelas de 96h bem esparsas, medido em ~5,6s pra 122
// chamadas reais; o default de maxDuration da Vercel seria curto demais.
export const maxDuration = 30;

export async function GET(request: Request) {
  // Rastro e dado sensivel de frota: exige operador logado.
  const auth = await createClient();
  const { data: { user } } = await auth.auth.getUser();
  if (!user) return Response.json({ erro: "nao autorizado" }, { status: 401 });

  const { searchParams } = new URL(request.url);
  const cv = searchParams.get("cv");
  if (!cv) {
    return Response.json({ erro: "parametro cv e obrigatorio" }, { status: 400 });
  }

  // horas: default 24, clamp entre 1 e 96
  const horasRaw = Number(searchParams.get("horas") ?? "24");
  const horas = Number.isFinite(horasRaw)
    ? Math.min(96, Math.max(1, Math.round(horasRaw)))
    : 24;

  try {
    const pontos = await buscarRastro(cv, horas);
    const semPicos = removerPicosRastro(pontos);
    const pontosAjustados = await ajustarRastroParaRuas(semPicos);
    return Response.json({ pontos: pontosAjustados });
  } catch (e) {
    return Response.json({ erro: String(e) }, { status: 500 });
  }
}
