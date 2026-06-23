// Dados do mapa: veículos do cliente, bases e a malha de pontos de entrega.
import pg from "pg";
import { buscarAlvos, agruparPontosPorPlaca } from "@/lib/unitrac";
import { createClient } from "@/lib/supabase/server";

export const dynamic = "force-dynamic";

export async function GET(request: Request) {
  // Posições de frota são dado sensível: exige operador logado.
  const auth = await createClient();
  const { data: { user } } = await auth.auth.getUser();
  if (!user) return Response.json({ erro: "nao autorizado" }, { status: 401 });

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
      await client.query<{ cv: string }>(
        `select v.placa, v.cv, p.lat, p.lng, p.nivel, p.velocidade, p.ignicao,
                p.local, p.entregas_feitas, p.entregas_total, p.atraso_min
         from posicoes_atuais p join veiculos v on v.id = p.veiculo_id
         where v.cliente_id = $1 and p.lat is not null and p.atraso_min <= 720`,
        [clienteId]
      )
    ).rows;

    // Malha de pontos de entrega PENDENTES do cliente (a "rota" que a frota
    // deveria cobrir). Um veículo longe de toda a malha = candidato a desvio.
    // Dedupe por coordenada; limite defensivo para não pesar o mapa.
    let pontosEntrega: { lat: number; lng: number }[] = [];
    try {
      const cvs = (
        await client.query<{ cv: string }>(
          `select cv from veiculos where cliente_id = $1 and ativo = true`,
          [clienteId]
        )
      ).rows.map((r) => r.cv);
      if (cvs.length) {
        const alvos = await buscarAlvos(cvs);
        const porPlaca = agruparPontosPorPlaca(alvos);
        const vistos = new Set<string>();
        for (const pts of porPlaca.values()) {
          for (const pt of pts) {
            if (pt.feito) continue;
            const k = `${pt.lat.toFixed(4)},${pt.lng.toFixed(4)}`;
            if (vistos.has(k)) continue;
            vistos.add(k);
            pontosEntrega.push({ lat: pt.lat, lng: pt.lng });
          }
        }
      }
    } catch {
      pontosEntrega = []; // malha é opcional; nunca derruba o mapa
    }

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

    return Response.json({ veiculos, bases: basesRes.rows[0].gj, pontos: pontosEntrega });
  } catch (e) {
    return Response.json({ erro: String(e) }, { status: 500 });
  } finally {
    await client.end();
  }
}
