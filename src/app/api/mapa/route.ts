// Dados do mapa: veículos do cliente, bases e a malha de pontos de entrega.
import pg from "pg";
import { buscarAlvos, agruparPontosPorPlaca } from "@/lib/unitrac";
import { createClient } from "@/lib/supabase/server";

export const dynamic = "force-dynamic";

// Pool de módulo (sobrevive entre invocações "quentes" da função serverless).
// Essa rota é pollada a cada 10s por CADA navegador aberto — abrir uma
// conexão Postgres nova por request (como era antes) não escala com o
// número de telas simultâneas. Mesmo padrão de pool do motor.
const pool = new pg.Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: { rejectUnauthorized: false },
  max: 5,
});

// Bases (GeoJSON) e malha de entregas pendentes quase não mudam segundo a
// segundo — bases são perímetros fixos, a malha de entregas do dia muda em
// minutos, não em 10s. Cachear por cliente evita reconsultar (e rechamar a
// API do Unitrac) a cada poll de CADA sessão. TTL curto o bastante pra
// refletir mudança de rota em até 1min.
type CacheEntry = { bases: unknown; pontosEntrega: { lat: number; lng: number }[]; expiraEm: number };
const CACHE_MS = 60_000;
const cachePorCliente = new Map<string, CacheEntry>();

export async function GET(request: Request) {
  // Posições de frota são dado sensível: exige operador logado.
  const auth = await createClient();
  const { data: { user } } = await auth.auth.getUser();
  if (!user) return Response.json({ erro: "nao autorizado" }, { status: 401 });

  const { searchParams } = new URL(request.url);
  const cod = searchParams.get("cliente") || "4096";

  const client = await pool.connect();

  try {
    const cli = await client.query<{ id: string }>(
      "select id from clientes where cod_user_unitrac=$1",
      [cod]
    );
    const clienteId = cli.rows[0]?.id;
    if (!clienteId) {
      return Response.json({ veiculos: [], bases: [] });
    }

    // LEFT JOIN LATERAL busca o tipo do alerta ativo de maior prioridade por veiculo.
    // Prioridade: critico antes de atencao; dentro do mesmo nivel, ordem alfabetica (estavel).
    // Veiculos sem alerta retornam tipo = null.
    const veiculos = (
      await client.query<{ cv: string }>(
        `select v.placa, v.cv, p.lat, p.lng, p.nivel, p.velocidade, p.ignicao,
                p.local, p.entregas_feitas, p.entregas_total, p.atraso_min,
                p.rumo, al.tipo
         from posicoes_atuais p
         join veiculos v on v.id = p.veiculo_id
         left join lateral (
           select a.tipo
           from alertas a
           where a.veiculo_id = v.id
             and a.status in ('ativo', 'reconhecido')
           order by (a.nivel = 'critico') desc, a.tipo
           limit 1
         ) al on true
         where v.cliente_id = $1 and p.lat is not null and p.atraso_min <= 720`,
        [clienteId]
      )
    ).rows;

    // Bases + malha de entregas: cacheadas por cliente (ver CACHE_MS acima).
    let cache = cachePorCliente.get(clienteId);
    if (!cache || cache.expiraEm <= Date.now()) {
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

      cache = { bases: basesRes.rows[0].gj, pontosEntrega, expiraEm: Date.now() + CACHE_MS };
      cachePorCliente.set(clienteId, cache);
    }

    // Dados de calor de incidentes (30 dias). Carregado apenas quando solicitado
    // explicitamente (?heat=1) para nao pesar o poll de 10 segundos de posicoes.
    let alertasGeo: { lat: number; lng: number }[] = [];
    const wantHeat = new URL(request.url).searchParams.get("heat") === "1";
    if (wantHeat) {
      try {
        const alertasRes = await client.query<{ lat: number; lng: number }>(
          `SELECT lat, lng
           FROM alertas
           WHERE cliente_id = $1
             AND lat IS NOT NULL
             AND lng IS NOT NULL
             AND desde >= now() - interval '30 days'
           ORDER BY desde DESC
           LIMIT 2000`,
          [clienteId]
        );
        alertasGeo = alertasRes.rows;
      } catch {
        alertasGeo = [];
      }
    }

    return Response.json({ veiculos, bases: cache.bases, pontos: cache.pontosEntrega, alertas_geo: alertasGeo });
  } catch (e) {
    return Response.json({ erro: String(e) }, { status: 500 });
  } finally {
    client.release();
  }
}
