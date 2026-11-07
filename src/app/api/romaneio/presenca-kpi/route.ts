import pg from "pg";
import { configPoolContabo } from "@/lib/supabase/contabo-ca";
import { lerEntregasKpi, SQL_PRESENCA_KPI } from "@/lib/presenca-kpi";

// POST /api/romaneio/presenca-kpi -- ponte do KPI (x-motor-key). Recebe as
// notas que o Ao vivo deu como ENTREGUE e grava a presenca delas no romaneio,
// pra o desvio da Central Romaneio parar de contar cliente ja' atendido como
// pendente. Ver src/lib/presenca-kpi.ts.
export const maxDuration = 60;

export async function POST(request: Request) {
  const chave = request.headers.get("x-motor-key");
  if (!chave || !process.env.MOTOR_SECRET || chave !== process.env.MOTOR_SECRET) {
    return Response.json({ erro: "nao autorizado" }, { status: 401 });
  }
  let body: unknown;
  try { body = await request.json(); } catch { return Response.json({ erro: "corpo invalido" }, { status: 400 }); }
  const lido = lerEntregasKpi(body, new Date());
  if (!lido) return Response.json({ erro: "esperado { data: AAAA-MM-DD, entregas: [{ nf, placa, chegada }] }" }, { status: 400 });
  if (lido.entregas.length === 0) return Response.json({ ok: true, recebidas: 0, gravadas: 0 });
  const pool = new pg.Pool({ ...configPoolContabo(process.env.DATABASE_URL), max: 1 });
  try {
    const r = await pool.query(SQL_PRESENCA_KPI, [lido.data, JSON.stringify(lido.entregas)]);
    return Response.json({ ok: true, recebidas: lido.entregas.length, gravadas: r.rowCount ?? 0 });
  } catch (err) {
    return Response.json({ ok: false, erro: String(err) }, { status: 500 });
  } finally {
    await pool.end().catch(() => {});
  }
}
