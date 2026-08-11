// src/app/api/clientes/modo-teste/route.ts
//
// Liga/desliga o modo teste por cliente (coluna clientes.modo_teste_ativo,
// ja consumida pelo motor em src/app/api/motor/route.ts). GET devolve o
// valor atual pra permitir que o toggle no menu de configuracoes reflita
// o estado real do banco ao carregar a pagina, em vez de sempre comecar
// em "false".
import { createAdminClient } from "@/lib/supabase/admin";
import { createClient } from "@/lib/supabase/server";

export async function GET(request: Request) {
  const auth = await createClient();
  const { data: { user } } = await auth.auth.getUser();
  if (!user) return Response.json({ erro: "nao autorizado" }, { status: 401 });

  const { searchParams } = new URL(request.url);
  const clienteId = searchParams.get("clienteId");
  if (!clienteId) return Response.json({ ativo: false });

  const supabase = createAdminClient();
  const { data } = await supabase
    .from("clientes")
    .select("modo_teste_ativo")
    .eq("id", clienteId)
    .single();

  return Response.json({ ativo: data?.modo_teste_ativo === true });
}

export async function POST(request: Request) {
  const auth = await createClient();
  const { data: { user } } = await auth.auth.getUser();
  if (!user) return Response.json({ erro: "nao autorizado" }, { status: 401 });

  const { clienteId, ativo } = await request.json();
  if (!clienteId || typeof ativo !== "boolean") {
    return Response.json({ erro: "parametros invalidos" }, { status: 400 });
  }

  const supabase = createAdminClient();
  const { error } = await supabase
    .from("clientes")
    .update({ modo_teste_ativo: ativo })
    .eq("id", clienteId);

  if (error) return Response.json({ erro: error.message }, { status: 500 });
  return Response.json({ ok: true });
}
