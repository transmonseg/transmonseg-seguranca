import { createAdminClient } from "@/lib/supabase/admin";
import { createClient } from "@/lib/supabase/server";

export const dynamic = "force-dynamic";

// O motor grava alertas 1x/30s; o dashboard busca no tick do Realtime.
// Cache curto por cliente (mesmo padrao de /api/mapa) pra N telas do MESMO
// cliente, com ticks levemente fora de sincronia, dividirem UMA consulta
// em vez de bater o banco uma vez por tela a cada tick.
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
  const modoTeste = searchParams.get("modoTeste") === "true";
  const chaveCache = `${cod}:${modoTeste ? "teste" : "producao"}`;

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

  // Busca os alertas PRIMEIRO — só precisamos de veículo/posição dos que têm
  // alerta ativo, não da frota inteira. Essa rota é pollada a cada 15s pelo
  // painel; buscar todos os veículos (até centenas) e todas as posições a
  // cada poll, quando só alguns têm alerta, foi o que estourou a cota de
  // egress da Supabase em 11 dias (31GB). Mesmo dado, consulta muito menor.
  const { data: alertasRaw, error: erroAlertas } = await supabase
    .from("alertas")
    .select("id, veiculo_id, nivel, tipo, motivo, desde, status, score, lat, lng, contexto")
    .eq("cliente_id", clienteId)
    .eq("modo_teste", modoTeste)
    .in("status", ["ativo", "reconhecido"]);
  if (erroAlertas) {
    console.error(`Erro ao buscar alertas (cliente=${cod}, modoTeste=${modoTeste}):`, erroAlertas);
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
        // Ponto de ORIGEM do próprio alerta (para "desvio": onde a sequência
        // começou) — distinto de lat/lng acima, que é a posição ATUAL do veículo.
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
