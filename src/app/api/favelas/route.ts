// Favelas (áreas de perigo) como GeoJSON com o perímetro preciso.
// Estáticas: cacheadas (mudam raramente), carregam uma vez no mapa.
import pg from "pg";
import { configPoolContabo } from "@/lib/supabase/contabo-ca";
import { createClient } from "@/lib/supabase/server";

export const revalidate = 86400; // 1 dia

export async function GET() {
  // Achado real 30/08 (varredura de seguranca, mesma classe do fix em
  // /api/alvos e /api/bases): rota fazia query direta via pg.Client
  // (bypassa RLS por completo) sem NENHUMA checagem de auth -- respondia
  // 200 com o GeoJSON inteiro pra qualquer requisicao nao autenticada.
  // Dado aqui e' de sensibilidade menor (perimetro de favela, camada de
  // referencia estatica, nao geofence de cliente especifico), mas o padrao
  // do repo e' exigir sessao em toda rota consumida pela tela autenticada.
  const auth = await createClient();
  const { data: { user } } = await auth.auth.getUser();
  if (!user) return Response.json({ erro: "nao autorizado" }, { status: 401 });

  const client = new pg.Client({
    ...configPoolContabo(process.env.DATABASE_URL),
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
