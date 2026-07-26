// Retorna snapshot atual de um veiculo.
// Tenta a API Unitrac primeiro (campos brutos completos: sensores, datagps, tipevnome).
// Se a Unitrac retornar null, usa posicoes_atuais do banco como fallback.
import pg from "pg";
import { buscarPosicaoUnica } from "@/lib/unitrac";
import { createClient } from "@/lib/supabase/server";
import { sslContabo } from "@/lib/supabase/contabo-ca";

export const dynamic = "force-dynamic";

export async function GET(request: Request) {
  const auth = await createClient();
  const { data: { user } } = await auth.auth.getUser();
  if (!user) return Response.json({ erro: "nao autorizado" }, { status: 401 });

  const { searchParams } = new URL(request.url);
  const cv = searchParams.get("cv");
  if (!cv) return Response.json({ erro: "parametro cv e obrigatorio" }, { status: 400 });

  // 1) Tenta Unitrac — retorna objeto bruto completo (posicvelocidade, posicignicao,
  //    posicentrada1..10, posicsaida1..4, datagps, tipevnome, etc.)
  try {
    const raw = await buscarPosicaoUnica(cv);
    if (raw) return Response.json({ posicao: raw });
  } catch { /* segue para fallback */ }

  // 2) Fallback: banco normalizado — monta objeto com os campos que PainelVeiculoAlerta espera
  const client = new pg.Client({
    connectionString: process.env.DATABASE_URL,
    ssl: sslContabo(process.env.DATABASE_URL),
  });
  try {
    await client.connect();
    const res = await client.query<{
      velocidade: number | null;
      ignicao: boolean | null;
      atraso_min: number | null;
      local: string | null;
      lat: number | null;
      lng: number | null;
    }>(
      `SELECT p.velocidade, p.ignicao, p.atraso_min, p.local, p.lat, p.lng
       FROM posicoes_atuais p
       JOIN veiculos v ON v.id = p.veiculo_id
       WHERE v.cv = $1
       LIMIT 1`,
      [cv]
    );
    if (!res.rows[0]) return Response.json({ posicao: null });
    const r = res.rows[0];
    // Retorna campos no formato raw que PainelVeiculoAlerta consome
    return Response.json({
      posicao: {
        posicvelocidade: String(r.velocidade ?? 0),
        posicignicao:    r.ignicao ? "1" : "0",
        atraso:          String(r.atraso_min ?? 0),
        tipevnome:       r.local ?? "",
        posiclatitude:   r.lat != null ? String(r.lat) : "",
        posiclongitude:  r.lng != null ? String(r.lng) : "",
        datagps:         null,
      },
    });
  } catch (e) {
    return Response.json({ erro: String(e) }, { status: 500 });
  } finally {
    await client.end();
  }
}
