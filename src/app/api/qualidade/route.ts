// Qualidade de tratamento: COMO os alertas foram tratados (revisao
// individual vs lote vs limpo vs auto), por operador, com latencia.
// GET /api/qualidade?dias=14&tipo=desvio&nivel=critico
//
// A agregacao em si (SQL) vive em src/lib/qualidade-tratamento.ts
// (apurarQualidade) -- compartilhada com a pagina /analise (Server
// Component) pra nao duplicar a query entre os dois lugares.
import { createClient } from "@/lib/supabase/server";
import { apurarQualidade } from "@/lib/qualidade-tratamento";

export const dynamic = "force-dynamic";

export async function GET(request: Request) {
  const auth = await createClient();
  const { data: { user } } = await auth.auth.getUser();
  if (!user) return Response.json({ erro: "nao autorizado" }, { status: 401 });

  const { searchParams } = new URL(request.url);
  const dias = Math.max(1, Math.min(90, parseInt(searchParams.get("dias") ?? "14", 10) || 14));
  const tipo = searchParams.get("tipo");
  const nivel = searchParams.get("nivel");

  try {
    const resumo = await apurarQualidade(dias, tipo, nivel);
    return Response.json({ dias, tipo, nivel, ...resumo });
  } catch (e) {
    console.error("[api/qualidade] falhou:", e instanceof Error ? e.message : String(e));
    return Response.json({ erro: "falha ao apurar qualidade" }, { status: 500 });
  }
}
