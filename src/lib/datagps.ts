// Hora do GPS da Unitrac (Frente H, RAS-02 / DSV-08, auditoria 03/11).
//
// A Unitrac manda `datagps` como texto "dd/mm/aaaa hh:mm:ss" (às vezes
// "dd/mm/aa") na hora de Brasília. Até a correção, o parse colava "Z" e
// gravava 3 h a menos em posicoes_atuais.datagps, eventos.ts e
// romaneio_desvio_estado.ultimo_datagps. O Brasil não tem horário de verão
// desde 2019, então o fuso é -03:00 fixo.
//
// Vazio ou inválido devolve null. O antigo fallback "?? agora" misturava
// relógio real com o mascarado e envenenava o marco de idempotência.

const BRT = "-03:00";
const TRES_HORAS_MS = 3 * 60 * 60 * 1000;
const FOLGA_FUTURO_MS = 5 * 60 * 1000;

/**
 * Instante (ISO, UTC) a partir do qual o motor grava datagps certo.
 * PLACEHOLDER: o dono ajusta para o horário real do deploy da Frente H.
 * Na dúvida, use um horário um pouco ANTES do deploy: um corte cedo demais
 * só faz o motor reprocessar leituras; um corte tarde demais faria valores já
 * certos ganharem +3 h (a guarda de datagpsReal segura quase todos os casos).
 */
export const DATAGPS_CORRIGIDO_DESDE = "2026-11-04T00:55:00Z";

function montar(y: number, mo: number, d: number, hh: number, mi: number, ss: number): string | null {
  if (mo < 1 || mo > 12 || d < 1 || d > 31 || hh > 23 || mi > 59 || ss > 59) return null;
  const p2 = (n: number) => String(n).padStart(2, "0");
  const t = Date.parse(`${y}-${p2(mo)}-${p2(d)}T${p2(hh)}:${p2(mi)}:${p2(ss)}${BRT}`);
  if (!Number.isFinite(t)) return null;
  // Rejeita data que "rola" (31/02 vira 03/03 em alguns motores).
  const conferir = new Date(t - TRES_HORAS_MS);
  if (conferir.getUTCDate() !== d || conferir.getUTCMonth() + 1 !== mo) return null;
  return new Date(t).toISOString();
}

/** Converte o datagps da Unitrac em ISO UTC; null se vazio ou inválido. */
export function parseDatagps(raw: string | undefined | null): string | null {
  if (raw == null) return null;
  const s = String(raw).trim();
  if (!s) return null;

  const br = s.match(/^(\d{2})\/(\d{2})\/(\d{2}|\d{4})\s+(\d{2}):(\d{2})(?::(\d{2}))?$/);
  if (br) {
    const [, d, mo, y, hh, mi, ss] = br;
    const ano = y.length === 2 ? 2000 + Number(y) : Number(y);
    return montar(ano, Number(mo), Number(d), Number(hh), Number(mi), Number(ss ?? "0"));
  }

  const iso = s.match(/^(\d{4})-(\d{2})-(\d{2})[T ](\d{2}):(\d{2})(?::(\d{2})(?:\.\d+)?)?(Z|[+-]\d{2}:?\d{2})?$/i);
  if (iso) {
    if (iso[7]) {
      const t = Date.parse(s.replace(" ", "T"));
      return Number.isFinite(t) ? new Date(t).toISOString() : null;
    }
    // Sem fuso: hora de Brasília (nunca a do servidor, que roda em CEST).
    const [, y, mo, d, hh, mi, ss] = iso;
    return montar(Number(y), Number(mo), Number(d), Number(hh), Number(mi), Number(ss ?? "0"));
  }
  return null;
}

function paraMs(v: string | Date | null | undefined): number {
  if (v == null) return NaN;
  return v instanceof Date ? v.getTime() : new Date(v).getTime();
}

/**
 * Instante real de um datagps já gravado. Valor gravado antes do corte
 * (`gravadoEm` < DATAGPS_CORRIGIDO_DESDE) está 3 h atrás: soma 3 h.
 *
 * Guarda: só soma se o resultado não passar de `gravadoEm` + 5 min. Leitura
 * real nunca é posterior à própria gravação; se passaria, o valor já estava
 * certo (corte configurado tarde) e somar empurraria o marco pro futuro,
 * fazendo o motor-romaneio pular o carro por 3 h (perda de recall).
 * `gravadoEm` desconhecido: devolve como está (lado seguro).
 */
export function datagpsReal(
  datagps: string | Date | null | undefined,
  gravadoEm: string | Date | null | undefined,
  corte: string = DATAGPS_CORRIGIDO_DESDE,
): Date | null {
  const t = paraMs(datagps);
  if (!Number.isFinite(t)) return null;
  const g = paraMs(gravadoEm);
  const c = Date.parse(corte);
  if (!Number.isFinite(g) || !Number.isFinite(c) || g >= c) return new Date(t);
  const corrigido = t + TRES_HORAS_MS;
  if (corrigido > g + FOLGA_FUTURO_MS) return new Date(t);
  return new Date(corrigido);
}
