import { createAdminClient } from "@/lib/supabase/admin";
import { ENVIADO_POR_RQ_ANTIGO, SUFIXO_ENVIADO_POR_RQ } from "@/lib/romaneio-rioquality";

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
  // F2-04: `rq=1` soma as linhas sem veiculo (placa fora do cadastro) que a
  // ponte da Rio Quality gravou -- e' o que o KPI compara com as NFs do dia.
  // Monitoramento antigo ignora o parametro (so' a frota; o KPI reenvia a mais).
  const rq = new URL(request.url).searchParams.get("rq") === "1";
  if (rq && cod === null) return Response.json({ erro: "rq=1 exige cod" }, { status: 400 });
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
  let linhas = count ?? 0;
  if (rq) {
    const semVeiculo = () => admin.from("romaneio_pontos").select("id", { count: "exact", head: true })
      .eq("romaneio_data", data).eq("modo_teste", false).eq("origem", "romaneio").is("veiculo_id", null);
    const [antigo, novo] = await Promise.all([
      semVeiculo().eq("enviado_por", ENVIADO_POR_RQ_ANTIGO),
      semVeiculo().like("enviado_por", `%${SUFIXO_ENVIADO_POR_RQ}`),
    ]);
    if (antigo.error || novo.error) return Response.json({ erro: "falha na consulta" }, { status: 500 });
    linhas += (antigo.count ?? 0) + (novo.count ?? 0);
  }
  return Response.json({ data, linhas });
}
