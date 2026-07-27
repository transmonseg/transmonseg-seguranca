import type { SupabaseClient } from "@supabase/supabase-js";

const JANELA_TRILHA_ANTES_MIN = 15;
const JANELA_TRILHA_CAP_HORAS = 6;

// Achado real 26/07: alertas de desvio podem ficar 'ativo' por muito tempo
// (o job expirar-alertas-ativos-esquecidos so fecha depois de 7 dias) --
// sem um teto, a trilha de um caso assim puxaria dias de posicoes_historico.
// Janela = [max(desde - 15min, agora - 6h), agora].
export function calcularJanelaTrilha(desde: Date, agora: Date): { inicio: Date; fim: Date } {
  const antesMs = JANELA_TRILHA_ANTES_MIN * 60 * 1000;
  const capMs = JANELA_TRILHA_CAP_HORAS * 60 * 60 * 1000;
  const inicioBruto = new Date(desde.getTime() - antesMs);
  const capInicio = new Date(agora.getTime() - capMs);
  const inicio = inicioBruto.getTime() > capInicio.getTime() ? inicioBruto : capInicio;
  return { inicio, fim: agora };
}

// Tipos cobertos pelo snapshot de casos_desvio_revisao -- escopo original
// (spec de 26/07) era so 'desvio'. 'parada_fora_tapete' adicionado 27/07
// (revisao adversarial, caso TTK-4D14): esse gatilho ganhou tipo proprio no
// mesmo ciclo (deixou de reusar tipo='desvio', ver
// detectores.ts/TIPOS_NAO_GERENCIADOS), e sem entrar aqui ficaria
// SILENCIOSAMENTE fora do pipeline de calibracao -- recalibrar-desvio nunca
// aprenderia a taxa de falso positivo real desta regra (mesma motivacao de
// todo outro segmento de origem: saida_parada, classe_viaria, etc.).
const TIPOS_CASO_REVISAO = ["desvio", "parada_fora_tapete"];

// Copia o contexto do detector + a trilha de posicao do veiculo pra
// casos_desvio_revisao ANTES do STRIP_PESADO (acoes-alertas.ts) apagar o
// contexto original do alerta. So processa os tipos em TIPOS_CASO_REVISAO --
// outros tipos nao entram nesta tabela (escopo da feature, ver spec de
// 26/07 e o achado de 27/07 acima).
// Nao lanca erro: falha aqui NUNCA deve bloquear o operador de
// resolver/marcar falso positivo (e' um recurso de analise, nao a acao
// principal) -- so loga um aviso, mesmo padrao ja usado pro insert em lote
// de posicoes_historico no motor.
export async function registrarCasosDesvioRevisao(
  admin: SupabaseClient,
  ids: string[],
  statusFinal: "resolvido" | "falso_positivo"
): Promise<void> {
  if (ids.length === 0) return;
  try {
    const { data: alertasDesvio, error: errAlertas } = await admin
      .from("alertas")
      .select("id, veiculo_id, contexto, desde")
      .in("id", ids)
      .in("tipo", TIPOS_CASO_REVISAO);
    if (errAlertas || !alertasDesvio || alertasDesvio.length === 0) return;

    const agora = new Date();
    for (const a of alertasDesvio) {
      const { inicio, fim } = calcularJanelaTrilha(new Date(a.desde), agora);
      const { data: trilha } = await admin
        .from("posicoes_historico")
        .select("lat, lng, velocidade, ignicao, atraso_min, criado_em")
        .eq("veiculo_id", a.veiculo_id)
        .gte("criado_em", inicio.toISOString())
        .lte("criado_em", fim.toISOString())
        .order("criado_em", { ascending: true });

      await admin.from("casos_desvio_revisao").insert({
        alerta_id: a.id,
        veiculo_id: a.veiculo_id,
        status_final: statusFinal,
        contexto_detector: a.contexto ?? {},
        trilha: trilha ?? [],
      });
    }
  } catch (err) {
    console.warn(`Aviso: erro ao registrar casos_desvio_revisao: ${String(err)}`);
  }
}
