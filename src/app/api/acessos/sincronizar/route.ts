import { createAdminClient } from "@/lib/supabase/admin";
import { clienteDaConta, type Conta } from "@/lib/acesso-sync";

// Logins separados por cliente (06/10): o KPI (dono dos perfis) manda, a cada
// ciclo, quem pode ver o que; aqui vira operadores.cliente_id (null = central,
// vê todas). So' contas que ja' existem no monitoramento, casadas por e-mail.
// So' via ponte (x-motor-key).
export async function POST(request: Request) {
  const chave = request.headers.get("x-motor-key");
  if (!chave || !process.env.MOTOR_SECRET || chave !== process.env.MOTOR_SECRET) {
    return Response.json({ erro: "nao autorizado" }, { status: 401 });
  }
  const body = (await request.json().catch(() => null)) as { contas?: Conta[] } | null;
  if (!body || !Array.isArray(body.contas)) return Response.json({ erro: "esperado { contas: [] }" }, { status: 400 });

  const admin = createAdminClient();
  const { data: clientes } = await admin.from("clientes").select("id, nome");
  const idPorNome = new Map((clientes ?? []).map((c) => [c.nome as string, c.id as string]));
  const usuarios: { id: string; email?: string }[] = [];
  for (let pagina = 1; pagina <= 20; pagina++) {
    const { data, error } = await admin.auth.admin.listUsers({ page: pagina, perPage: 200 });
    if (error) return Response.json({ erro: error.message }, { status: 500 });
    usuarios.push(...data.users);
    if (data.users.length < 200) break;
  }
  const idPorEmail = new Map(usuarios.filter((u) => u.email).map((u) => [u.email!.toLowerCase(), u.id]));

  const alterados: string[] = [];
  for (const c of body.contas) {
    const alvo = clienteDaConta(c);
    if (alvo === undefined) continue;
    const id = idPorEmail.get(String(c.email).toLowerCase());
    if (!id) continue;
    const clienteId = alvo === null ? null : idPorNome.get(alvo) ?? undefined;
    if (clienteId === undefined) continue;
    const { data: op } = await admin.from("operadores").select("cliente_id").eq("id", id).maybeSingle();
    if (op && (op.cliente_id ?? null) === clienteId) continue;
    if (op) await admin.from("operadores").update({ cliente_id: clienteId }).eq("id", id);
    else await admin.from("operadores").insert({ id, nome: c.email, papel: "operador", cliente_id: clienteId });
    alterados.push(`${c.email} -> ${alvo ?? "todas"}`);
  }
  return Response.json({ ok: true, alterados });
}
