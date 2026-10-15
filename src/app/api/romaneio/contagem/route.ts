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
  // Por cliente (auditoria 15/10, KP-04): a contagem sem filtro somava a Rio
  // Quality, entao "o monitoramento tem romaneio" ficava verdadeiro mesmo com a
  // Nutry sem nada. `cod` = cod_user_unitrac do cliente; sem ele, o dia todo.
  const cod = new URL(request.url).searchParams.get("cod");
  if (cod !== null && !/^\d{1,10}$/.test(cod)) {
    return Response.json({ erro: "parametro cod invalido" }, { status: 400 });
  }
  const admin = createAdminClient();
  let clienteId: string | null = null;
  if (cod !== null) {
    const { data: cli, error: erroCli } = await admin.from("clientes").select("id").eq("cod_user_unitrac", cod).maybeSingle();
    if (erroCli) return Response.json({ erro: "falha na consulta" }, { status: 500 });
    if (!cli) return Response.json({ erro: "cliente desconhecido" }, { status: 404 });
    clienteId = cli.id as string;
  }
  let consulta = admin
    .from("romaneio_pontos")
    .select(clienteId ? "id, veiculos!inner(cliente_id)" : "id", { count: "exact", head: true })
    .eq("romaneio_data", data)
    .eq("modo_teste", false)
    .eq("origem", "romaneio");
  if (clienteId) consulta = consulta.eq("veiculos.cliente_id", clienteId);
  const { count, error } = await consulta;
  // Erro de consulta nao vira "zero linhas": o KPI trata como desconhecido e nao reenvia.
  if (error) return Response.json({ erro: "falha na consulta" }, { status: 500 });
  return Response.json({ data, linhas: count ?? 0 });
}
