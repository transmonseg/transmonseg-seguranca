// 09/11: "Confirmar entrega" na tela Entrega no mapa. Quem guarda a
// conferência é o KPI (kpi_nf_resolucao): aqui só repassamos, servidor a
// servidor (x-motor-key), com o email de quem confirmou. O KPI já grava a
// presença no romaneio daqui (desvio para de cobrar o cliente).

export type FrotaKpi = "nutrimax" | "rioquality";
export type AcaoConferencia = "confirmar" | "desfazer";
export type ConferenciaKpi = { id: number; nf: string; resolucao: string; responsavel: string; criadoEm: string; observacao: string | null } | null;

export function frotaKpi(v: unknown): FrotaKpi | null {
  return v === "nutrimax" || v === "rioquality" ? v : null;
}

/** NF que dá pra conferir (RQ sem número real e SEMNF não identificam a entrega). */
export function nfConferivel(frota: FrotaKpi, nf: string): boolean {
  if (!nf || nf.length > 40 || nf.startsWith("SEMNF")) return false;
  if (frota === "rioquality" && /^([A-Z]{3}\d[A-Z0-9]\d{2})?-\d+$/.test(nf)) return false;
  return true;
}

const base = () => process.env.KPI_URL ?? "http://127.0.0.1:3020";

export async function lerConferenciaKpi(frota: FrotaKpi, data: string, nf: string, fetchFn: typeof fetch = fetch): Promise<ConferenciaKpi> {
  const chave = process.env.MOTOR_SECRET;
  if (!chave) return null;
  try {
    const q = new URLSearchParams({ cliente: frota, data, nf });
    const r = await fetchFn(`${base()}/api/kpi/conferencia-externa?${q}`, { headers: { "x-motor-key": chave }, cache: "no-store", signal: AbortSignal.timeout(8000) });
    if (!r.ok) return null;
    const j = (await r.json()) as { conferencia?: ConferenciaKpi };
    return j.conferencia ?? null;
  } catch {
    return null;
  }
}

export async function conferirNoKpi(
  p: { frota: FrotaKpi; data: string; nf: string; acao: AcaoConferencia; responsavel: string; observacao?: string | null },
  fetchFn: typeof fetch = fetch,
): Promise<{ ok: true; conferencia: ConferenciaKpi } | { ok: false; status: number; erro: string }> {
  const chave = process.env.MOTOR_SECRET;
  if (!chave) return { ok: false, status: 500, erro: "Chave do KPI ausente no servidor." };
  try {
    const r = await fetchFn(`${base()}/api/kpi/conferencia-externa`, {
      method: "POST",
      headers: { "content-type": "application/json", "x-motor-key": chave },
      body: JSON.stringify({ cliente: p.frota, data: p.data, nf: p.nf, acao: p.acao, responsavel: p.responsavel, observacao: p.observacao ?? null }),
      signal: AbortSignal.timeout(20_000),
    });
    const j = (await r.json().catch(() => ({}))) as { ok?: boolean; conferencia?: ConferenciaKpi; erro?: string };
    if (!r.ok || !j.ok) return { ok: false, status: r.status >= 400 ? r.status : 502, erro: j.erro ?? `KPI respondeu ${r.status}` };
    return { ok: true, conferencia: j.conferencia ?? null };
  } catch (e) {
    return { ok: false, status: 502, erro: `Não consegui falar com o KPI (${e instanceof Error ? e.message : String(e)}).` };
  }
}
