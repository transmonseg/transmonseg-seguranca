import { createAdminClient } from "@/lib/supabase/admin";
import MonitorV2 from "./central-v2/MonitorV2";

export const dynamic = "force-dynamic";

interface Cliente { id: string; nome: string; cod_user_unitrac: string; }
interface Veiculo { id: string; cliente_id: string; placa: string; cv: string; }
interface PosicaoAtual { veiculo_id: string; lat: number | null; lng: number | null; velocidade: number; ignicao: boolean; atraso_min: number; local: string | null; }
interface Alerta { id: string; cliente_id: string; veiculo_id: string; nivel: "critico" | "atencao"; tipo: string; motivo: string | null; desde: string; status: string; score: number | null; lat: number | null; lng: number | null; contexto: { rota_concluida?: unknown; progresso_destino?: { delta_m: number }; placar_sombra?: { placar: number; componentes: Record<string, number | boolean | string> } } | null; }

function ordemSeveridade(tipo: string): number {
  const t = tipo?.toLowerCase() ?? "";
  if (t === "panico") return 0; if (t === "bau") return 1; if (t === "favela") return 2;
  if (t === "tiroteio") return 3; if (t === "ignicao_noturna") return 4;
  if (t === "saida_nao_autorizada") return 5; if (t === "parada_cliente") return 6;
  if (t === "parada_anomala") return 7; if (t === "parada_longa") return 8;
  if (t === "desvio" || t === "excesso" || t === "parada_fora_tapete") return 9;
  if (t === "jammer" || t.includes("sinal") || t.includes("bloqueio")) return 11;
  return 10;
}

export default async function CentralPage({
  searchParams,
}: {
  searchParams: Promise<{ [key: string]: string | string[] | undefined }>;
}) {
  const { cliente: clienteParam } = await searchParams;
  const supabase = createAdminClient();

  const [{ data: clientesRaw }, { data: veiculosRaw }, { data: posicoesRaw }, { data: alertasRaw }] =
    await Promise.all([
      supabase.from("clientes").select("id, nome, cod_user_unitrac").order("cod_user_unitrac"),
      supabase.from("veiculos").select("id, cliente_id, placa, cv"),
      supabase.from("posicoes_atuais").select("veiculo_id, lat, lng, velocidade, ignicao, atraso_min, local"),
      supabase.from("alertas").select("id, cliente_id, veiculo_id, nivel, tipo, motivo, desde, status, score, lat, lng, contexto").in("status", ["ativo", "reconhecido"]),
    ]);

  const clientes: Cliente[] = clientesRaw ?? [];
  const todosVeiculos: Veiculo[] = veiculosRaw ?? [];
  const todasPosicoes: PosicaoAtual[] = (posicoesRaw ?? []) as PosicaoAtual[];
  const todosAlertas: Alerta[] = (alertasRaw ?? []) as Alerta[];

  const codParam = typeof clienteParam === "string" ? clienteParam : undefined;
  const clienteAtivo: Cliente = (codParam && clientes.find(c => c.cod_user_unitrac === codParam)) || clientes[0];
  if (!clienteAtivo) return null;

  const veiculos = todosVeiculos.filter(v => v.cliente_id === clienteAtivo.id);
  const veiculoIds = new Set(veiculos.map(v => v.id));
  const posicaoPorVeiculo = new Map(todasPosicoes.filter(p => veiculoIds.has(p.veiculo_id)).map(p => [p.veiculo_id, p]));
  const veiculoById = new Map(veiculos.map(v => [v.id, v]));

  const enriquecer = (a: Alerta) => {
    const v = veiculoById.get(a.veiculo_id);
    const p = posicaoPorVeiculo.get(a.veiculo_id);
    return {
      ...a,
      cv: v?.cv ?? "", placa: v?.placa ?? "?????", local: p?.local ?? null,
      // lat/lng = posição ATUAL do veículo (posicoes_atuais); origemLat/Lng =
      // ponto de ORIGEM do próprio alerta (para "desvio": onde começou).
      lat: p?.lat ?? null, lng: p?.lng ?? null,
      origemLat: a.lat, origemLng: a.lng,
      velocidade: p?.velocidade ?? null, ignicao: p?.ignicao ?? null, atraso_min: p?.atraso_min ?? null,
      rotaConcluida: (a.contexto as { rota_concluida?: unknown } | null)?.rota_concluida != null,
      progressoDestinoM: (a.contexto as { progresso_destino?: { delta_m: number } } | null)?.progresso_destino?.delta_m ?? null,
      placarSombra: (a.contexto as { placar_sombra?: { placar: number; componentes: Record<string, number | boolean | string> } } | null)?.placar_sombra ?? null,
      contexto: undefined,
    };
  };

  const alertasIniciais = [
    ...todosAlertas.filter(a => a.cliente_id === clienteAtivo.id && a.nivel === "critico").map(enriquecer).sort((a, b) => ordemSeveridade(a.tipo) - ordemSeveridade(b.tipo)),
    ...todosAlertas.filter(a => a.cliente_id === clienteAtivo.id && a.nivel === "atencao").map(enriquecer).sort((a, b) => ordemSeveridade(a.tipo) - ordemSeveridade(b.tipo)),
  ];

  return (
    <MonitorV2
      key={clienteAtivo.id}
      cliente={clienteAtivo.cod_user_unitrac}
      clientes={clientes.map(c => ({ id: c.id, nome: c.nome, cod: c.cod_user_unitrac }))}
      clienteAtivoId={clienteAtivo.id}
      veiculos={veiculos.map(v => ({ placa: v.placa, cv: v.cv }))}
      alertasIniciais={alertasIniciais}
    />
  );
}
