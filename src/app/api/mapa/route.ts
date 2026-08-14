// Dados do mapa: veículos do cliente, bases e a malha de pontos de entrega.
import pg from "pg";
import { buscarAlvos, agruparPontosPorPlaca, corrigirComPontoAprendido } from "@/lib/unitrac";
import { createClient } from "@/lib/supabase/server";
import { configPoolContabo } from "@/lib/supabase/contabo-ca";

export const dynamic = "force-dynamic";

// Pool de módulo (sobrevive entre invocações "quentes" da função serverless).
// Essa rota é pollada a cada 10s por CADA navegador aberto — abrir uma
// conexão Postgres nova por request (como era antes) não escala com o
// número de telas simultâneas. Mesmo padrão de pool do motor.
const pool = new pg.Pool({
  ...configPoolContabo(process.env.DATABASE_URL),
  max: 5,
});

// Bases (GeoJSON) e malha de entregas pendentes quase não mudam segundo a
// segundo — bases são perímetros fixos, a malha de entregas do dia muda em
// minutos, não em 10s. Cachear por cliente evita reconsultar (e rechamar a
// API do Unitrac) a cada poll de CADA sessão. TTL curto o bastante pra
// refletir mudança de rota em até 1min.
type CacheEntry = { bases: unknown; pontosEntrega: { lat: number; lng: number; nome: string }[]; expiraEm: number };
const CACHE_MS = 60_000;
const cachePorCliente = new Map<string, CacheEntry>();

// Posições/veículos: o motor grava 1x por minuto, então um cache curtinho
// (10s) faz N telas que buscam no mesmo tick do motor compartilharem UMA
// query — é o que permite muitas telas abertas sem multiplicar egress.
type VeiculosCacheEntry = { veiculos: unknown[]; expiraEm: number };
const VEICULOS_CACHE_MS = 10_000;
const veiculosCachePorCliente = new Map<string, VeiculosCacheEntry>();

export async function GET(request: Request) {
  // Posições de frota são dado sensível: exige operador logado.
  const auth = await createClient();
  const { data: { user } } = await auth.auth.getUser();
  if (!user) return Response.json({ erro: "nao autorizado" }, { status: 401 });

  const dataHojeSP = new Intl.DateTimeFormat("en-CA", { timeZone: "America/Sao_Paulo" }).format(new Date());

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
    // Veiculos sem alerta retornam tipo = null. Cache curto (ver VEICULOS_CACHE_MS).
    let veiculosCache = veiculosCachePorCliente.get(clienteId);
    if (!veiculosCache || veiculosCache.expiraEm <= Date.now()) {
      const veiculosRows = (
        await client.query<{ cv: string }>(
          `select v.placa, v.cv, p.lat, p.lng, p.nivel, p.velocidade, p.ignicao,
                  p.local, p.entregas_feitas, p.entregas_total, p.atraso_min,
                  p.rumo, p.parado_desde, al.tipo,
                  exists (
                    select 1 from romaneio_pontos rp
                    where rp.veiculo_id = v.id and rp.romaneio_data = $2
                      and rp.modo_teste = false
                      and rp.lat is not null and rp.lng is not null
                  ) as tem_romaneio_hoje
           from posicoes_atuais p
           join veiculos v on v.id = p.veiculo_id
           left join lateral (
             select a.tipo
             from alertas a
             where a.veiculo_id = v.id
               and a.status in ('ativo', 'reconhecido')
               and a.modo_teste = false
             order by (a.nivel = 'critico') desc, a.tipo
             limit 1
           ) al on true
           where v.cliente_id = $1 and p.lat is not null and p.atraso_min <= 720`,
          [clienteId, dataHojeSP]
        )
      ).rows;
      veiculosCache = { veiculos: veiculosRows, expiraEm: Date.now() + VEICULOS_CACHE_MS };
      veiculosCachePorCliente.set(clienteId, veiculosCache);
    }
    const veiculos = veiculosCache.veiculos;

    // Bases + malha de entregas: cacheadas por cliente (ver CACHE_MS acima).
    let cache = cachePorCliente.get(clienteId);
    if (!cache || cache.expiraEm <= Date.now()) {
      // Malha de pontos de entrega PENDENTES do cliente (a "rota" que a frota
      // deveria cobrir). Um veículo longe de toda a malha = candidato a desvio.
      // Dedupe por coordenada; limite defensivo para não pesar o mapa.
      let pontosEntrega: { lat: number; lng: number; nome: string }[] = [];
      try {
        const cvs = (
          await client.query<{ cv: string }>(
            `select cv from veiculos where cliente_id = $1 and ativo = true`,
            [clienteId]
          )
        ).rows.map((r) => r.cv);
        if (cvs.length) {
          // Achado real 13/08 (usuario reportou: marcador do mapa nunca
          // "andava" da posicao bruta pra corrigida via romaneio): esta rota
          // buscava os pontos direto de buscarAlvos() sem NUNCA aplicar
          // corrigirComPontoAprendido -- o motor (route.ts) ja aplicava a
          // correcao desde a feature de 12/08, mas o mapa continuava
          // mostrando a coordenada crua da Unitrac pra sempre, deixando os
          // dois desalinhados. Mesmo padrao de carregamento de route.ts:
          // ponto_codigo e' bigint, o driver `pg` devolve como string sem
          // setTypeParser custom -- Number() explicito, senao o Map nunca
          // bate com pt.pontoCodigo (achado real 10/08, mesma licao).
          const { rows: aprendidosRows } = await client.query<{
            ponto_codigo: string;
            lat: number;
            lng: number;
            fonte: "aprendido" | "manual";
          }>(
            `SELECT ponto_codigo, lat, lng, fonte FROM pontos_aprendidos WHERE cliente_id = $1`,
            [clienteId]
          );
          const pontosAprendidos = new Map(
            aprendidosRows.map((r) => [Number(r.ponto_codigo), { lat: r.lat, lng: r.lng, fonte: r.fonte }])
          );

          const alvos = await buscarAlvos(cvs);
          const porPlaca = agruparPontosPorPlaca(alvos);
          const vistos = new Set<string>();
          for (const pts of porPlaca.values()) {
            for (const ptBruto of pts) {
              if (ptBruto.feito) continue;
              const pt = ptBruto.pontoCodigo != null
                ? corrigirComPontoAprendido(ptBruto, pontosAprendidos.get(ptBruto.pontoCodigo))
                : ptBruto;
              const k = `${pt.lat.toFixed(4)},${pt.lng.toFixed(4)}`;
              if (vistos.has(k)) continue;
              vistos.add(k);
              pontosEntrega.push({ lat: pt.lat, lng: pt.lng, nome: pt.nome });
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
