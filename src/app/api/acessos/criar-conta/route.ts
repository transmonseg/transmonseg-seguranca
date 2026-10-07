import { createAdminClient } from "@/lib/supabase/admin";
import { validarNovaConta } from "@/lib/acesso-sync";

// Conta nova pelo convite do KPI (06/10): o KPI cria a conta la' e aqui, com a
// mesma senha, ja' presa ao cliente do convite. Unico jeito de nascer conta
// (o cadastro aberto da tela de login foi fechado). So' via ponte (x-motor-key).
// Conta que ja' existe: nao troca a senha; o cliente segue pela sincronizacao.
export async function POST(request: Request) {
  const chave = request.headers.get("x-motor-key");
  if (!chave || !process.env.MOTOR_SECRET || chave !== process.env.MOTOR_SECRET) {
    return Response.json({ erro: "nao autorizado" }, { status: 401 });
  }
  const v = validarNovaConta(await request.json().catch(() => null));
  if ("erro" in v) return Response.json({ erro: v.erro }, { status: 400 });

  const admin = createAdminClient();
  let clienteId: string | null = null;
  if (v.cliente) {
    const { data } = await admin.from("clientes").select("id").eq("nome", v.cliente).maybeSingle();
    if (!data) return Response.json({ erro: `cliente ${v.cliente} nao cadastrado` }, { status: 400 });
    clienteId = data.id as string;
  }
  const { data: criado, error } = await admin.auth.admin.createUser({
    email: v.email, password: v.senha, email_confirm: true,
    role: "authenticated", // GoTrue self-hosted nao preenche sozinho (ver login/actions)
    user_metadata: { nome: v.email },
  });
  if (error || !criado?.user) {
    const m = (error?.message ?? "").toLowerCase();
    if (m.includes("already") || m.includes("registered") || m.includes("exists")) return Response.json({ ok: true, existente: true });
    return Response.json({ erro: error?.message ?? "erro ao criar" }, { status: 500 });
  }
  const { error: e2 } = await admin.from("operadores").insert({ id: criado.user.id, nome: v.email, papel: "operador", cliente_id: clienteId });
  if (e2) {
    // Sem registro em operadores a conta nao entra em nada; desfaz pra nao sobrar meia conta.
    await admin.auth.admin.deleteUser(criado.user.id);
    return Response.json({ erro: e2.message }, { status: 500 });
  }
  return Response.json({ ok: true, cliente: v.cliente ?? "todas" });
}
