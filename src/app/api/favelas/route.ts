// Favelas (áreas de perigo) como GeoJSON com o perímetro preciso.
// Estáticas: cacheadas (mudam raramente), carregam uma vez no mapa.
import pg from "pg";
import { sslContabo } from "@/lib/supabase/contabo-ca";

export const revalidate = 86400; // 1 dia

export async function GET() {
  const client = new pg.Client({
    connectionString: process.env.DATABASE_URL,
    ssl: sslContabo(process.env.DATABASE_URL),
  });
  try {
    await client.connect();
    const fav = await client.query<{ gj: unknown }>(
      `select coalesce(
         jsonb_build_object('type','FeatureCollection','features', jsonb_agg(
           jsonb_build_object(
             'type','Feature',
             'properties', jsonb_build_object('nome', nome),
             'geometry', ST_AsGeoJSON(ST_SimplifyPreserveTopology(geom::geometry, 0.00002))::jsonb
           ))),
         jsonb_build_object('type','FeatureCollection','features','[]'::jsonb)
       ) gj
       from geofences where tipo = 'favela'`
    );
    return Response.json(fav.rows[0].gj, {
      headers: { "Cache-Control": "public, max-age=3600, s-maxage=86400" },
    });
  } catch (e) {
    return Response.json({ type: "FeatureCollection", features: [], erro: String(e) }, { status: 500 });
  } finally {
    await client.end();
  }
}
