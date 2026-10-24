// src/app/api/veiculos/rioquality/route.ts
//
// F2-15 (MON-12, plano mestre 23/10): frota da Rio Quality vinda do KPI,
// servidor-a-servidor (x-motor-key). A masn/598 da Unitrac nao abre para nos,
// entao quem descobre os cvs da RQ e' o KPI (scripts/descobrir-cv-rq.ts, so'
// as propostas "ok") e ele manda a frota inteira depois de cada varredura.
// Aqui so' entra o cv que falta; veiculo ja' cadastrado nunca e' renomeado
// nem desativado (divergencia volta como conflito, para uma pessoa olhar).
// Body: { veiculos: [{ placa, cv }], simular?: boolean }.
import { createAdminClient } from "@/lib/supabase/admin";
import { COD_UNITRAC_RQ } from "@/lib/romaneio-rioquality";
import { lerVeiculosRQ, planejarFrotaRQ, type VeiculoExistente } from "@/lib/frota-rioquality";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const MAX_VEICULOS = 2000;

export async function POST(request: Request) {
  const chave = request.headers.get("x-motor-key");
  if (!chave || !process.env.MOTOR_SECRET || chave !== process.env.MOTOR_SECRET) {
    return Response.json({ ok: false, erro: "nao autorizado" }, { status: 401 });
  }
  const body = (await request.json().catch(() => null)) as { veiculos?: unknown; simular?: unknown } | null;
  if (!Array.isArray(body?.veiculos) || body.veiculos.length > MAX_VEICULOS) {
    return Response.json({ ok: false, erro: `Payload inválido (veiculos[] com até ${MAX_VEICULOS} itens).` }, { status: 400 });
  }
  const recebidos = lerVeiculosRQ(body.veiculos as unknown[]);
  const admin = createAdminClient();
  const { data: cli, error: eCli } = await admin.from("clientes").select("id").eq("cod_user_unitrac", COD_UNITRAC_RQ).maybeSingle();
  if (eCli || !cli) return Response.json({ ok: false, erro: `cliente RQ não encontrado${eCli ? `: ${eCli.message}` : ""}` }, { status: 500 });
  const clienteId = cli.id as string;

  const { data: daRQ, error: e1 } = await admin.from("veiculos").select("id, cliente_id, cv, placa").eq("cliente_id", clienteId);
  if (e1) return Response.json({ ok: false, erro: `frota RQ: ${e1.message}` }, { status: 500 });
  const placas = [...new Set(recebidos.map((r) => r.placa))];
  const { data: mesmasPlacas, error: e2 } = placas.length
    ? await admin.from("veiculos").select("id, cliente_id, cv, placa").in("placa", placas)
    : { data: [], error: null };
  if (e2) return Response.json({ ok: false, erro: `placas: ${e2.message}` }, { status: 500 });
  const existentes = new Map<string, VeiculoExistente>();
  for (const v of [...(daRQ ?? []), ...(mesmasPlacas ?? [])] as VeiculoExistente[]) existentes.set(v.id, { ...v, cv: String(v.cv) });

  const plano = planejarFrotaRQ(clienteId, [...existentes.values()], recebidos);
  const resumo = { jaExistiam: plano.jaExistiam, conflitos: plano.conflitos, recebidos: recebidos.length };
  if (body.simular === true) {
    return Response.json({ ok: true, simulado: true, inseridos: plano.inserir.map((v) => v.placa), ...resumo });
  }
  let inseridos: string[] = [];
  if (plano.inserir.length > 0) {
    const { data, error } = await admin.from("veiculos").insert(plano.inserir).select("placa");
    if (error) return Response.json({ ok: false, erro: `inserção: ${error.message}`, ...resumo }, { status: 500 });
    inseridos = (data ?? []).map((v) => v.placa as string);
  }
  return Response.json({ ok: true, inseridos, ...resumo });
}
