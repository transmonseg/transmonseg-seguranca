// Presenca vinda do KPI (07/11). O motor de desvio da Central Romaneio so'
// tira um cliente dos "pendentes" quando presenca_confirmada_em e' gravada, e
// isso so' acontecia pelo cron confirmar-presenca-romaneio (parada no ponto do
// romaneio). Nota entregue com o ponto do romaneio fora do lugar ficava
// pendente o dia todo: em 06/11, 54 dos 147 desvios "afastando de todos" da
// Nutry tinham TODOS os pendentes ja' entregues no KPI antes do alerta -- era o
// caminhao voltando pra base. O KPI (Ao vivo, a cada 10 min) manda aqui as
// notas que ele deu como ENTREGUE, com o horario de chegada.
//
// So' tira cliente que tem entrega comprovada: o detector continua vendo todo
// cliente nao entregue, entao nao perde desvio real
// ([[feedback_desvio_priorizar_recall]]).

export type EntregaKpi = { nf: string; placa: string; ts: string | null };

export const MAX_ENTREGAS_PRESENCA_KPI = 6000;

const placaLimpa = (p: string) => p.toUpperCase().replace(/[^A-Z0-9]/g, "");

/** "HH:MM" de Brasilia no dia `data` -> ISO; nunca no futuro (vira `agora`). */
export function horarioChegadaIso(data: string, hhmm: unknown, agora: Date): string | null {
  if (typeof hhmm !== "string" || !/^\d{2}:\d{2}$/.test(hhmm)) return null;
  const t = new Date(`${data}T${hhmm}:00-03:00`);
  if (Number.isNaN(t.getTime())) return null;
  return (t.getTime() > agora.getTime() ? agora : t).toISOString();
}

/** Valida o corpo da ponte. null = corpo malformado (400). */
export function lerEntregasKpi(body: unknown, agora: Date): { data: string; entregas: EntregaKpi[] } | null {
  if (!body || typeof body !== "object") return null;
  const { data, entregas } = body as { data?: unknown; entregas?: unknown };
  if (typeof data !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(data)) return null;
  if (!Array.isArray(entregas) || entregas.length > MAX_ENTREGAS_PRESENCA_KPI) return null;
  const out: EntregaKpi[] = [];
  for (const e of entregas as { nf?: unknown; placa?: unknown; chegada?: unknown }[]) {
    if (typeof e?.nf !== "string" || !e.nf.trim() || typeof e?.placa !== "string") continue;
    const placa = placaLimpa(e.placa);
    if (!placa) continue;
    out.push({ nf: e.nf.trim(), placa, ts: horarioChegadaIso(data, e.chegada, agora) });
  }
  return { data, entregas: out };
}

/** Grava so' onde ainda nao ha presenca (nunca sobrescreve a do GPS/motor).
 *  Casa NF + dia + placa (ou a placa de antes da troca de carro). */
export const SQL_PRESENCA_KPI = `
UPDATE romaneio_pontos r
   SET presenca_confirmada_em = coalesce(e.ts, now()), presenca_metodo = 'kpi'
  FROM jsonb_to_recordset($2::jsonb) AS e(nf text, placa text, ts timestamptz)
 WHERE r.romaneio_data = $1::date
   AND r.nf = e.nf
   AND r.presenca_confirmada_em IS NULL
   AND r.modo_teste = false
   AND r.removida_em IS NULL
   AND (regexp_replace(upper(r.placa), '[^A-Z0-9]', '', 'g') = e.placa
        OR regexp_replace(upper(coalesce(r.trocado_de, '')), '[^A-Z0-9]', '', 'g') = e.placa)`;
