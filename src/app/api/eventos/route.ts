// Linha do tempo de eventos nativos da Unitrac (tipevnome) por veiculo.
// GET /api/eventos?clienteId={uuid}&cv={cv}
import pg from "pg";
import { createClient } from "@/lib/supabase/server";
import { configPoolContabo } from "@/lib/supabase/contabo-ca";

export const dynamic = "force-dynamic";

export async function GET(request: Request) {
  // Dado de operacao do veiculo: exige operador logado.
  const auth = await createClient();
  const { data: { user } } = await auth.auth.getUser();
  if (!user) return Response.json({ erro: "nao autorizado" }, { status: 401 });

  const { searchParams } = new URL(request.url);
  const clienteId = searchParams.get("clienteId");
  const cv = searchParams.get("cv");
  if (!clienteId || !cv) return Response.json({ eventos: [] });

  const client = new pg.Client({
    ...configPoolContabo(process.env.DATABASE_URL),
  });

  try {
    await client.connect();
    const veic = await client.query<{ id: string }>(
      "select id from veiculos where cliente_id = $1 and cv = $2 limit 1",
      [clienteId, cv]
    );
    const veiculoId = veic.rows[0]?.id;
    if (!veiculoId) return Response.json({ eventos: [] });

    const { rows } = await client.query<{ tipo: string; ts: string }>(
      `select tipo, ts from eventos where veiculo_id = $1 order by ts desc limit 20`,
      [veiculoId]
    );
    return Response.json({ eventos: rows });
  } catch (e) {
    return Response.json({ erro: String(e) }, { status: 500 });
  } finally {
    await client.end();
  }
}
