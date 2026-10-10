import { createAdminClient } from "@/lib/supabase/admin";

// Reparo do KPI (10/10): o tick do Ao vivo pergunta quantas linhas de romaneio
// o monitoramento tem no dia (modo real, origem romaneio) pra saber se precisa
// reenviar os PDFs guardados. Leve (count head) e so' via ponte (x-motor-key).
export async function GET(request: Request) {
  const chave = request.headers.get("x-motor-key");
  if (!chave || !process.env.MOTOR_SECRET || chave !== process.env.MOTOR_SECRET) {
    return Response.json({ erro: "nao autorizado" }, { status: 401 });
  }
  const data = new URL(request.url).searchParams.get("data");
  if (!data || !/^\d{4}-\d{2}-\d{2}$/.test(data)) {
    return Response.json({ erro: "parametro data (YYYY-MM-DD) obrigatorio" }, { status: 400 });
  }
  const { count, error } = await createAdminClient()
    .from("romaneio_pontos")
    .select("id", { count: "exact", head: true })
    .eq("romaneio_data", data)
    .eq("modo_teste", false)
    .eq("origem", "romaneio");
  // Erro de consulta nao vira "zero linhas": o KPI trata como desconhecido e nao reenvia.
  if (error) return Response.json({ erro: "falha na consulta" }, { status: 500 });
  return Response.json({ data, linhas: count ?? 0 });
}
