import type { SupabaseClient } from "@supabase/supabase-js";
import { segmentoCalibracaoPreferido } from "./calibracao-desvio";

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
  statusFinal: "resolvido" | "falso_positivo",
  // Qual botao originou (achado 01/08): "Resolver todos" gravava igual ao
  // "Resolver" individual, entao nao dava pra saber se um caso era veredito
  // caso a caso ou clique pra desentupir a tela. Quem le pra medir/calibrar
  // filtra pelas origens individuais.
  origemAcao: "resolver_individual" | "falso_individual" | "resolver_massa",
  motivoFalsoPositivo?:
    | "detector_errado" | "dado_entrada_errado"
    | "NAO_FOI_AO_CLIENTE" | "NAO_SAIU_DA_BASE" | "DESATUALIZADO" | "MUDOU_DE_ROTA"
): Promise<void> {
  if (ids.length === 0) return;
  try {
    const { data: alertasDesvio, error: errAlertas } = await admin
      .from("alertas")
      .select("id, veiculo_id, tipo, contexto, desde")
      .in("id", ids)
      .eq("modo_teste", false)
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

      // Achado real 13/08 (pesquisa + auditoria adversarial: segmentoCalibracaoPreferido
      // tinha testes completos mas NUNCA era chamada em codigo real -- so'
      // aparecia em comentarios. recalibrar-desvio le
      // contexto_detector->'calibracao'->>'segmento', mas nada nunca escrevia
      // essa chave -- a segmentacao FINA (origem:X, corredor_veredito:X) nunca
      // funcionou de verdade, so' a grosseira tipo:desvio. Calcula e injeta
      // aqui, no MESMO snapshot que ja protege contra o STRIP_PESADO.
      const contextoOriginal = (a.contexto ?? {}) as Record<string, unknown>;
      const origemDesvio = contextoOriginal.origem_desvio as
        | "comportamental"
        | "cerca_virtual"
        | "saida_parada"
        | "classe_viaria"
        | "rumo_diverge"
        | "afastando_geral"
        | "rua_rara_frota"
        | undefined;
      const segmento = segmentoCalibracaoPreferido({ tipo: a.tipo, origemDesvio }, null);

      await admin.from("casos_desvio_revisao").insert({
        alerta_id: a.id,
        veiculo_id: a.veiculo_id,
        status_final: statusFinal,
        origem_acao: origemAcao,
        contexto_detector: segmento ? { ...contextoOriginal, calibracao: { segmento } } : contextoOriginal,
        trilha: trilha ?? [],
        motivo_falso_positivo: motivoFalsoPositivo ?? null,
      });
    }
  } catch (err) {
    console.warn(`Aviso: erro ao registrar casos_desvio_revisao: ${String(err)}`);
  }
}
