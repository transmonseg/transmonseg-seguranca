// Carga inicial da home da Central (src/app/(app)/page.tsx).
//
// F1-15 (AC-02): a home baixava os alertas ativos de TODOS os clientes, sem
// filtro nem limite (76 MB, 3,1-3,4 s a cada abertura -- a Central recria o
// iframe e passa por "/" a cada clique em "Monitoramento"), e so' depois
// filtrava pelo cliente aberto no Node. Agora resolve o cliente primeiro e
// pede ao banco so' a frota, as posicoes e os alertas dele, como
// /api/alertas (poll de 30 s) ja' fazia.
import type { SupabaseClient } from "@supabase/supabase-js";
import { filtrarPorAcesso, type AcessoCliente } from "./acesso-cliente";

export interface ClienteCentral { id: string; nome: string; cod_user_unitrac: string; }
export interface VeiculoCentral { id: string; cliente_id: string; placa: string; cv: string; }
export interface PosicaoCentral { veiculo_id: string; lat: number | null; lng: number | null; velocidade: number; ignicao: boolean; atraso_min: number; local: string | null; }
export interface AlertaCentral {
  id: string; cliente_id: string; veiculo_id: string; nivel: "critico" | "atencao"; tipo: string; motivo: string | null;
  desde: string; status: string; score: number | null; lat: number | null; lng: number | null;
  contexto: Record<string, unknown> | null;
}

export async function carregarCentralInicial(
  supabase: SupabaseClient,
  acesso: AcessoCliente,
  codParam: string | undefined,
): Promise<{
  clientes: ClienteCentral[];
  clienteAtivo: ClienteCentral;
  veiculos: VeiculoCentral[];
  posicoes: PosicaoCentral[];
  alertas: AlertaCentral[];
} | null> {
  const { data: clientesRaw } = await supabase
    .from("clientes").select("id, nome, cod_user_unitrac").eq("ativo", true).order("cod_user_unitrac");
  // Conta de um cliente só (ex.: login da Nutry Max) não vê as outras abas.
  const clientes = filtrarPorAcesso(acesso, (clientesRaw ?? []) as ClienteCentral[]);
  const clienteAtivo = (codParam && clientes.find((c) => c.cod_user_unitrac === codParam)) || clientes[0];
  if (!clienteAtivo) return null;

  // posicoes_atuais fica sem filtro no banco (~550 linhas, pequeno): um
  // .in() com a frota inteira (176 uuids) estouraria o tamanho de URL.
  const [{ data: veiculosRaw }, { data: posicoesRaw }, { data: alertasRaw }] = await Promise.all([
    // So' a frota ativa (tela Veiculos, 05/10): placa tirada da frota sai da Central.
    supabase.from("veiculos").select("id, cliente_id, placa, cv").eq("ativo", true).eq("cliente_id", clienteAtivo.id),
    supabase.from("posicoes_atuais").select("veiculo_id, lat, lng, velocidade, ignicao, atraso_min, local"),
    supabase.from("alertas")
      .select("id, cliente_id, veiculo_id, nivel, tipo, motivo, desde, status, score, lat, lng, contexto")
      .eq("cliente_id", clienteAtivo.id)
      .eq("modo_teste", false)
      .in("status", ["ativo", "reconhecido"]),
  ]);
  const veiculos = (veiculosRaw ?? []) as VeiculoCentral[];
  const ids = new Set(veiculos.map((v) => v.id));

  return {
    clientes,
    clienteAtivo,
    veiculos,
    posicoes: ((posicoesRaw ?? []) as PosicaoCentral[]).filter((p) => ids.has(p.veiculo_id)),
    alertas: (alertasRaw ?? []) as AlertaCentral[],
  };
}
