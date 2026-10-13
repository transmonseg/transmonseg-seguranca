// src/app/api/romaneio/rioquality/route.ts
//
// Ponte estruturada KPI -> Monitoramento para a Rio Quality. A RQ não sobe
// PDF/planilha; o KPI (dados da Fusion) manda as linhas do romaneio já
// parseadas por este endpoint, servidor-a-servidor (x-motor-key), com a DATA
// do dia FIXA (nunca inferida de texto -- era o bug de "data" que zerava o
// mapa). Insere em romaneio_pontos com lat/lng nulos e geocode_status
// 'pendente'; a geocodificação roda depois no cron (igual ao /upload). O
// upsert com a mesma chave única torna o reenvio do dia idempotente.
import { createClient } from "@/lib/supabase/server";
import { createAdminClient } from "@/lib/supabase/admin";
import { normalizarPlaca } from "@/lib/romaneio";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// Mesma chave do /upload (migration 059): romaneio_data,placa,nf,modo_teste,origem.
const CHAVE_UNICA_ROMANEIO_PONTOS = "romaneio_data,placa,nf,modo_teste,origem";

type LinhaRQ = {
  placa?: unknown; nf?: unknown; clienteCodigo?: unknown;
  clienteNome?: unknown; enderecoBruto?: unknown;
};

function str(v: unknown): string | null {
  return typeof v === "string" && v.trim() !== "" ? v.trim() : null;
}

export async function POST(request: Request) {
  const chaveMotor = request.headers.get("x-motor-key");
  const viaKpi = !!chaveMotor && !!process.env.MOTOR_SECRET && chaveMotor === process.env.MOTOR_SECRET;
  const auth = await createClient();
  const user = viaKpi ? null : (await auth.auth.getUser()).data.user;
  if (!viaKpi && !user) return Response.json({ ok: false, erro: "nao autorizado" }, { status: 401 });

  const body = (await request.json().catch(() => null)) as { data?: unknown; linhas?: unknown } | null;
  const data = str(body?.data);
  const linhas = Array.isArray(body?.linhas) ? (body!.linhas as LinhaRQ[]) : null;
  // data YYYY-MM-DD; linhas tem que ser array.
  if (!data || !/^\d{4}-\d{2}-\d{2}$/.test(data) || !linhas) {
    return Response.json({ ok: false, erro: "Payload inválido (data YYYY-MM-DD + linhas[])." }, { status: 400 });
  }

  // Linhas sem placa ou nf não viram ponto (nf é NOT NULL em romaneio_pontos).
  const validas = linhas
    .map((l) => ({ placa: normalizarPlaca(str(l.placa) ?? ""), nf: str(l.nf),
      clienteCodigo: str(l.clienteCodigo), clienteNome: str(l.clienteNome), enderecoBruto: str(l.enderecoBruto) }))
    .filter((l) => l.placa !== "" && l.nf);

  const admin = createAdminClient();
  const placasUnicas = [...new Set(validas.map((l) => l.placa))];
  const { data: veiculos } = placasUnicas.length
    ? await admin.from("veiculos").select("id, placa").in("placa", placasUnicas)
    : { data: [] as { id: string; placa: string }[] };
  const veiculoPorPlaca = new Map((veiculos ?? []).map((v) => [v.placa, v]));
  const placasNaoEncontradas = placasUnicas.filter((p) => !veiculoPorPlaca.has(p));

  const enviadoPor = `${(request.headers.get("x-enviado-por") ?? "KPI Rio Quality").slice(0, 80)} (pelo Ao vivo do KPI)`;

  const paraInserir = validas.map((l) => ({
    veiculo_id: veiculoPorPlaca.get(l.placa)?.id ?? null,
    placa: l.placa,
    romaneio_data: data,
    nf: l.nf,
    cliente_codigo: l.clienteCodigo,
    cliente_nome: l.clienteNome,
    endereco_bruto: l.enderecoBruto,
    carga_destino_codigo: null,
    carga_destino_nome: null,
    lat: null,
    lng: null,
    geocode_status: "pendente",
    modo_teste: false,
    enviado_por: enviadoPor,
    origem: "romaneio",
  }));

  let linhasInseridas = 0;
  if (paraInserir.length) {
    const { data: inseridas, error } = await admin
      .from("romaneio_pontos")
      .upsert(paraInserir, { onConflict: CHAVE_UNICA_ROMANEIO_PONTOS, ignoreDuplicates: true })
      .select("id");
    if (error) return Response.json({ ok: false, erro: `Erro ao salvar: ${error.message}` }, { status: 500 });
    linhasInseridas = inseridas?.length ?? 0;
  }

  return Response.json({ ok: true, romaneioData: data, linhasInseridas, placasNaoEncontradas });
}
