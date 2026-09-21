// Episodio novo de desvio reabre o alerta existente (21/09).
//
// Problema medido: o motor faz dedupe por TIPO (route.ts, `alertaExistente =
// alertasAbertos.find(a => a.tipo === alerta.tipo)`) e desvio nunca fecha
// sozinho (decisao do usuario de 11/07 -- NAO reintroduzir auto-fechamento).
// Um desvio aberto e velho (quase sempre o falso "iniciando rota" da manha)
// escondia todos os episodios seguintes do mesmo veiculo: 445 de 892 episodios
// novos de 14-20/09 (50%) contra 270 de 1066 (25%) em 24-28/08.
//
// Solucao: quando um episodio NOVO comeca (>= EPISODIO_DESVIO_GAP_MIN minutos
// sem disparo desse veiculo) sobre um alerta ja aberto, o alerta existente e
// REABERTO (sobe `desde`, volta a 'ativo', contexto.episodios++), sem fechar
// nada e sem criar linha nova. A UI ja ordena por `desde`, colore por idade e
// protege alerta novo da acao em massa (elegivelParaAcaoMassa), entao subir
// `desde` basta pra ele reaparecer no topo.
//
// Tudo aqui e' funcao pura: o motor so' fornece o ultimo disparo (query) e
// aplica o UPDATE.

export const EPISODIO_DESVIO_GAP_MIN = 10;

// Origens que gravam em desvio_disparo_log (a unica evidencia de "quando foi o
// ultimo disparo"). Desvio vindo de cerca virtual/classe viaria/saida de
// parada nao grava la' -- para eles nao ha' como medir o gap, entao nunca
// reabrem (comportamento anterior preservado, sem risco de reabrir a cada
// ciclo).
export const ORIGENS_DESVIO_COM_LOG_DE_DISPARO: ReadonlySet<string> = new Set([
  "afastando_geral",
  "rua_rara_frota",
  "sem_destinos",
]);

export type EntradaReaberturaDesvio = {
  flagAtiva: boolean;
  tipoAlerta: string;
  origemDesvio: string | undefined;
  nivelNovo: string;
  nivelExistente: string;
  // Ultimo disparo (afastando_geral/rua_rara_frota) ANTERIOR ao ciclo atual;
  // null = sem registro / falha na consulta => nao reabre (fail-safe).
  ultimoDisparoEmMs: number | null;
  agoraMs: number;
  desdeExistenteMs: number;
  gapMin?: number;
};

export function deveReabrirDesvio(e: EntradaReaberturaDesvio): boolean {
  if (!e.flagAtiva) return false;
  if (e.tipoAlerta !== "desvio") return false;
  if (!e.origemDesvio || !ORIGENS_DESVIO_COM_LOG_DE_DISPARO.has(e.origemDesvio)) return false;
  // Nunca rebaixa nem "reabre" um critico existente com um sinal mais fraco.
  if (e.nivelExistente === "critico" && e.nivelNovo !== "critico") return false;
  if (e.ultimoDisparoEmMs == null || !Number.isFinite(e.ultimoDisparoEmMs)) return false;
  if (!Number.isFinite(e.desdeExistenteMs)) return false;
  const gapMs = (e.gapMin ?? EPISODIO_DESVIO_GAP_MIN) * 60_000;
  // Sem disparo ha' >= gap E o proprio alerta ja' tem >= gap de vida (nao
  // reabre um alerta recem criado).
  return e.agoraMs - e.ultimoDisparoEmMs >= gapMs && e.agoraMs - e.desdeExistenteMs >= gapMs;
}

// Contexto do alerta reaberto: o contexto novo do ciclo + contador de
// episodios + marca de reabertura. `desde_primeiro_episodio` preserva o
// horario original (o operador ve quando o veiculo foi flagrado a 1a vez).
export function montarContextoReabertura(
  contextoNovo: Record<string, unknown>,
  contextoExistente: unknown,
  agoraIso: string,
  desdeExistente: string
): Record<string, unknown> {
  const anterior =
    contextoExistente && typeof contextoExistente === "object"
      ? (contextoExistente as Record<string, unknown>)
      : {};
  const episodiosAnt = typeof anterior.episodios === "number" && anterior.episodios >= 1 ? anterior.episodios : 1;
  const primeiro =
    typeof anterior.desde_primeiro_episodio === "string" ? anterior.desde_primeiro_episodio : desdeExistente;
  return {
    ...contextoNovo,
    episodios: episodiosAnt + 1,
    reaberto_em: agoraIso,
    desde_primeiro_episodio: primeiro,
  };
}

// Rotulo curto pra UI (null = alerta nunca reaberto).
export function formatarReabertura(contexto: unknown): string | null {
  if (!contexto || typeof contexto !== "object") return null;
  const n = (contexto as Record<string, unknown>).episodios;
  if (typeof n !== "number" || n < 2) return null;
  return `Reaberto — ${n}º episódio`;
}
