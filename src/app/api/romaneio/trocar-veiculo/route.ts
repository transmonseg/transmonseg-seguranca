import { createAdminClient } from "@/lib/supabase/admin";

// Troca de carro do dia (06/10, "Confirmar troca" no Ao vivo do KPI): as
// entregas do dia que estavam no carro da escala passam pro carro que rodou de
// verdade -- desvio/rota no monitoramento acompanham o carro certo. So' via
// ponte (x-motor-key), chamada pelo KPI depois da confirmacao da operacao.
const norm = (p: string) => p.toUpperCase().replace(/[^A-Z0-9]/g, "");

export async function POST(request: Request) {
  const chave = request.headers.get("x-motor-key");
  if (!chave || !process.env.MOTOR_SECRET || chave !== process.env.MOTOR_SECRET) {
    return Response.json({ erro: "nao autorizado" }, { status: 401 });
  }
  let body: { data?: unknown; placaDe?: unknown; placaPara?: unknown; nfs?: unknown };
  try { body = await request.json(); } catch { return Response.json({ erro: "corpo invalido" }, { status: 400 }); }
  const { data, placaDe, placaPara } = body;
  if (typeof data !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(data) || typeof placaDe !== "string" || typeof placaPara !== "string") {
    return Response.json({ erro: "esperado { data: YYYY-MM-DD, placaDe, placaPara, nfs? }" }, { status: 400 });
  }
  // nfs (07/10): so' as notas da carga trocada. Sem isso, troca mutua (dois
  // carros escalados trocaram de carga entre si, RQV5F67 x RBG4F53 em 07/10)
  // terminava com as duas cargas no mesmo carro (a 2a troca levava tudo de volta).
  const nfs = Array.isArray(body.nfs) ? body.nfs.filter((n): n is string => typeof n === "string" && n.length > 0) : null;
  if (Array.isArray(body.nfs) && (!nfs || nfs.length === 0)) {
    return Response.json({ erro: "nfs vazio" }, { status: 400 });
  }
  const admin = createAdminClient();
  const { data: veiculos, error: e1 } = await admin.from("veiculos").select("id, placa");
  if (e1) return Response.json({ erro: e1.message }, { status: 500 });
  const de = (veiculos ?? []).filter((v) => norm(v.placa) === norm(placaDe));
  const para = (veiculos ?? []).find((v) => norm(v.placa) === norm(placaPara));
  if (!para) return Response.json({ erro: `placa ${placaPara} fora da frota do monitoramento` }, { status: 404 });
  const placasDe = [...new Set([...de.map((v) => v.placa), placaDe])];
  let q = admin.from("romaneio_pontos")
    .update({ veiculo_id: para.id, placa: para.placa })
    .eq("romaneio_data", data).in("placa", placasDe);
  if (nfs) q = q.in("nf", nfs);
  const { data: trocados, error: e2 } = await q.select("id");
  if (e2) return Response.json({ erro: e2.message }, { status: 500 });
  return Response.json({ ok: true, pontos: trocados?.length ?? 0, para: para.placa });
}
