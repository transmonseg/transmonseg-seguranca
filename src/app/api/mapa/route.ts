// Dados do mapa: veículos do cliente, bases e favelas (GeoJSON simplificado).
import pg from "pg";

export const dynamic = "force-dynamic";

export async function GET(request: Request) {
  const { searchParams } = new URL(request.url);
  const cod = searchParams.get("cliente") || "4096";

  const client = new pg.Client({
    connectionString: process.env.DATABASE_URL,
    ssl: { rejectUnauthorized: false },
  });

  try {
    await client.connect();
    const cli = await client.query<{ id: string }>(
      "select id from clientes where cod_user_unitrac=$1",
      [cod]
    );
    const clienteId = cli.rows[0]?.id;
    if (!clienteId) {
      return Response.json({ veiculos: [], bases: [] });
    }

    const veiculos = (
      await client.query(
        `select v.placa, v.cv, p.lat, p.lng, p.nivel, p.velocidade, p.ignicao,
                p.local, p.entregas_feitas, p.entregas_total, p.atraso_min
         from posicoes_atuais p join veiculos v on v.id = p.veiculo_id
         where v.cliente_id = $1 and p.lat is not null and p.atraso_min <= 720`,
        [clienteId]
      )
    ).rows;

    // Bases como GeoJSON (polígono do perímetro real, não círculo).
    const basesRes = await client.query<{ gj: unknown }>(
      `select coalesce(
         jsonb_build_object('type','FeatureCollection','features', jsonb_agg(
           jsonb_build_object(
             'type','Feature',
             'properties', jsonb_build_object('nome', nome),
             'geometry', ST_AsGeoJSON(geom::geometry)::jsonb
           ))),
         jsonb_build_object('type','FeatureCollection','features','[]'::jsonb)
       ) gj
       from bases where cliente_id = $1`,
      [clienteId]
    );

    return Response.json({ veiculos, bases: basesRes.rows[0].gj });
  } catch (e) {
    return Response.json({ erro: String(e) }, { status: 500 });
  } finally {
    await client.end();
  }
}
