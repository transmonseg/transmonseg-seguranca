import { createAdminClient } from "@/lib/supabase/admin";
import { createClient } from "@/lib/supabase/server";

export const dynamic = "force-dynamic";

// Espelha /api/alertas/route.ts, mas lê alertas_romaneio (motor de desvio
// paralelo alimentado pelo romaneio — spec
// 2026-08-22-motor-romaneio-paralelo). Arquivo NOVO e isolado: a Central usa
// só /api/alertas, nunca este; uma falha aqui não pode afetar a Central.
// Diferenças de schema vs. alertas: sem coluna modo_teste (por isso sem esse
// filtro/param aqui) e sem 3ª tabela "modo_teste" de segmentação de cache.
type AlertasCacheEntry = { body: { alertas: unknown[] }; expiraEm: number };
const CACHE_MS = 8_000;
const cachePorCliente = new Map<string, AlertasCacheEntry>();

export async function GET(request: Request) {
  const auth = await createClient();
  const {
    data: { user },
  } = await auth.auth.getUser();
  if (!user) return Response.json({ erro: "nao autorizado" }, { status: 401 });

  const { searchParams } = new URL(request.url);
  const cod = searchParams.get("cliente");
  if (!cod) return Response.json({ alertas: [] });
  const chaveCache = cod;

  const cached = cachePorCliente.get(chaveCache);
  if (cached && cached.expiraEm > Date.now()) {
    return Response.json(cached.body);
  }

  const supabase = createAdminClient();

  const { data: clienteData } = await supabase
    .from("clientes")
    .select("id")
    .eq("cod_user_unitrac", cod)
    .single();
  if (!clienteData) return Response.json({ alertas: [] });

  const clienteId = clienteData.id;

  const { data: alertasRaw, error: erroAlertas } = await supabase
    .from("alertas_romaneio")
    .select("id, veiculo_id, nivel, tipo, motivo, desde, status, score, lat, lng, contexto")
    .eq("cliente_id", clienteId)
    .in("status", ["ativo", "reconhecido"]);
  if (erroAlertas) {
    console.error(`Erro ao buscar alertas_romaneio (cliente=${cod}):`, erroAlertas);
  }

  const veiculoIds = [...new Set((alertasRaw ?? []).map((a: { veiculo_id: string }) => a.veiculo_id))];

  const [{ data: veiculosRaw }, { data: posicoesRaw }] = veiculoIds.length === 0
    ? [{ data: [] }, { data: [] }]
    : await Promise.all([
        supabase.from("veiculos").select("id, cv, placa").in("id", veiculoIds),
        supabase
          .from("posicoes_atuais")
          .select("veiculo_id, lat, lng, velocidade, ignicao, atraso_min, local")
          .in("veiculo_id", veiculoIds),
      ]);

  const veiculoMap = new Map(
    (veiculosRaw ?? []).map(
      (v: { id: string; cv: string; placa: string }) => [v.id, v]
    )
  );
  const posicaoMap = new Map(
    (posicoesRaw ?? []).map(
      (p: {
        veiculo_id: string;
        lat: number | null;
        lng: number | null;
        velocidade: number | null;
        ignicao: boolean | null;
        atraso_min: number | null;
        local: string | null;
      }) => [p.veiculo_id, p]
    )
  );

  const alertas = (alertasRaw ?? []).map(
    (a: {
      id: string;
      veiculo_id: string;
      nivel: string;
      tipo: string;
      motivo: string | null;
      desde: string;
      status: string;
      score: number | null;
      lat: number | null;
      lng: number | null;
      contexto: { rota_concluida?: unknown; progresso_destino?: { delta_m: number }; placar_sombra?: { placar: number; componentes: Record<string, number | boolean | string> }; calibracao?: { segmento: string | null; taxa_falso_positivo: number } } | null;
    }) => {
      const veiculo = veiculoMap.get(a.veiculo_id) as
        | { id: string; cv: string; placa: string }
        | undefined;
      const pos = posicaoMap.get(a.veiculo_id) as
        | {
            lat: number | null;
            lng: number | null;
            velocidade: number | null;
            ignicao: boolean | null;
            atraso_min: number | null;
            local: string | null;
          }
        | undefined;
      return {
        id: a.id,
        veiculo_id: a.veiculo_id,
        nivel: a.nivel,
        tipo: a.tipo,
        motivo: a.motivo,
        desde: a.desde,
        status: a.status,
        score: a.score,
        cv: veiculo?.cv ?? "",
        placa: veiculo?.placa ?? "?????",
        lat: pos?.lat ?? null,
        lng: pos?.lng ?? null,
        origemLat: a.lat,
        origemLng: a.lng,
        velocidade: pos?.velocidade ?? null,
        ignicao: pos?.ignicao ?? null,
        atraso_min: pos?.atraso_min ?? null,
        local: pos?.local ?? null,
        rotaConcluida: a.contexto?.rota_concluida != null,
        progressoDestinoM: a.contexto?.progresso_destino?.delta_m ?? null,
        placarSombra: a.contexto?.placar_sombra ?? null,
        calibracao: a.contexto?.calibracao ?? null,
      };
    }
  );

  const body = { alertas };
  cachePorCliente.set(chaveCache, { body, expiraEm: Date.now() + CACHE_MS });
  return Response.json(body);
}
