import pg from "pg";
import { configPoolContabo } from "@/lib/supabase/contabo-ca";

export async function GET(request: Request) {
  const { searchParams } = new URL(request.url);
  const clienteId = searchParams.get("clienteId");
  if (!clienteId) return Response.json({ type: "FeatureCollection", features: [] }, { status: 400 });

  const pool = new pg.Pool({
    ...configPoolContabo(process.env.DATABASE_URL),
    max: 2,
  });
  const client = await pool.connect();
  try {
    const { rows } = await client.query<{ nome: string; geojson: string }>(
      `SELECT nome, ST_AsGeoJSON(geom::geometry) AS geojson FROM bases WHERE cliente_id = $1`,
      [clienteId]
    );
    const features = rows
      .filter(r => r.geojson)
      .map(r => ({
        type: "Feature" as const,
        geometry: JSON.parse(r.geojson) as object,
        properties: { nome: r.nome },
      }));
    return Response.json({ type: "FeatureCollection", features });
  } catch {
    return Response.json({ type: "FeatureCollection", features: [] });
  } finally {
    client.release();
    await pool.end();
  }
}
