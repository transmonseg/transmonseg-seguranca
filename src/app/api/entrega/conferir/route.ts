import { createClient } from "@/lib/supabase/server";
import { createAdminClient } from "@/lib/supabase/admin";
import { acessoDoUsuario } from "@/lib/acesso-cliente";
import { clienteDaEntrega, codUnitracDaFrota } from "@/lib/entrega-mapa";
import { conferirNoKpi, frotaKpi, nfConferivel } from "@/lib/conferencia-kpi";

// POST /api/entrega/conferir (09/11) -- botão "Confirmar entrega"/"Desfazer"
// da tela Entrega no mapa. Só quem enxerga a frota da NF; grava no KPI com o
// email de quem está logado.
export async function POST(request: Request) {
  const auth = await createClient();
  const { data: { user } } = await auth.auth.getUser();
  if (!user) return Response.json({ ok: false, erro: "Sessão vencida. Entre de novo." }, { status: 401 });
  const b = (await request.json().catch(() => null)) as Record<string, unknown> | null;
  const frota = frotaKpi(b?.frota);
  const data = typeof b?.data === "string" ? b.data : "";
  const nf = typeof b?.nf === "string" ? b.nf.trim() : "";
  const acao = b?.acao === "confirmar" || b?.acao === "desfazer" ? b.acao : null;
  const observacao = typeof b?.observacao === "string" ? b.observacao.trim().slice(0, 300) : null;
  if (!frota || !/^\d{4}-\d{2}-\d{2}$/.test(data) || !acao || !nfConferivel(frota, nf)) {
    return Response.json({ ok: false, erro: "Pedido inválido." }, { status: 400 });
  }
  const acesso = await acessoDoUsuario();
  const { data: cli } = await createAdminClient().from("clientes").select("id").eq("cod_user_unitrac", codUnitracDaFrota(frota)).maybeSingle();
  const da = clienteDaEntrega(acesso, (cli?.id as string | undefined) ?? null);
  if (da.tipo === "nenhum" || !cli) return Response.json({ ok: false, erro: "Esta conta não pode conferir notas desta frota." }, { status: 403 });
  const r = await conferirNoKpi({ frota, data, nf, acao, responsavel: user.email ?? user.id, observacao });
  if (!r.ok) return Response.json({ ok: false, erro: r.erro }, { status: r.status });
  return Response.json({ ok: true, conferencia: r.conferencia });
}
