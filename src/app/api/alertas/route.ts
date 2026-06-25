import { createAdminClient } from "@/lib/supabase/admin";
import { createClient } from "@/lib/supabase/server";

export const dynamic = "force-dynamic";

export async function GET(request: Request) {
  const auth = await createClient();
  const {
    data: { user },
  } = await auth.auth.getUser();
  if (!user) return Response.json({ erro: "nao autorizado" }, { status: 401 });

  const { searchParams } = new URL(request.url);
  const cod = searchParams.get("cliente");
  if (!cod) return Response.json({ alertas: [] });

  const supabase = createAdminClient();

  const { data: clienteData } = await supabase
    .from("clientes")
    .select("id")
    .eq("cod_user_unitrac", cod)
    .single();
  if (!clienteData) return Response.json({ alertas: [] });

  const clienteId = clienteData.id;

  const { data: veiculosRaw } = await supabase
    .from("veiculos")
    .select("id, cv, placa")
    .eq("cliente_id", clienteId);

  const veiculoIds = (veiculosRaw ?? []).map(
    (v: { id: string }) => v.id
  );

  const [{ data: alertasRaw }, { data: posicoesRaw }] = await Promise.all([
    supabase
      .from("alertas")
      .select("id, veiculo_id, nivel, tipo, motivo, desde, status, score")
      .eq("cliente_id", clienteId)
      .in("status", ["ativo", "reconhecido"]),
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
        ...a,
        cv: veiculo?.cv ?? "",
        placa: veiculo?.placa ?? "?????",
        lat: pos?.lat ?? null,
        lng: pos?.lng ?? null,
        velocidade: pos?.velocidade ?? null,
        ignicao: pos?.ignicao ?? null,
        atraso_min: pos?.atraso_min ?? null,
        local: pos?.local ?? null,
      };
    }
  );

  return Response.json({ alertas });
}
