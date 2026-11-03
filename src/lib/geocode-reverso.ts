// Geocode reverso do rótulo "local" do veículo (motor da Central).
//
// GEO3-01 (auditoria 03/11): o billing do Google foi desligado, a chave
// continuou no .env e o código tratava "ter chave" como "Google funciona": o
// Google responde REQUEST_DENIED (HTTP 200, results vazio), o retorno virava
// null, o Nominatim nunca era chamado e o COALESCE do upsert mantinha o
// rótulo velho ("Em deslocamento" num carro parado). Agora:
//   - status do Google diferente de OK = falha, com log
//     "[geocode-reverso] google negado" e Google desligado por 10 min;
//   - cai no Nominatim (1 req/s, política pública do OSM);
//   - o resultado diz se falhou de verdade (rótulo velho deve ser limpo) ou se
//     só acabou o orçamento do ciclo (tenta no próximo).
export type ResultadoGeocodeReverso =
  | { status: "ok"; endereco: string }
  | { status: "falhou" }
  | { status: "sem_orcamento" };

type PoolMinimo = { connect(): Promise<{ query(sql: string, params?: unknown[]): Promise<unknown>; release(): void }> };

type Deps = {
  fetch?: (url: string, init?: RequestInit) => Promise<Response>;
  agora?: () => number;
  dormir?: (ms: number) => Promise<void>;
};

/** Novos por ciclo: com Google ativo, 30; só Nominatim (1 req/s), 5. */
export const LIMITE_GEOCODES_GOOGLE = 30;
export const LIMITE_GEOCODES_NOMINATIM = 5;
const GOOGLE_PAUSA_APOS_NEGADO_MS = 10 * 60_000;
const NOMINATIM_INTERVALO_MS = 1000;

let googleDesligadoAte = 0;
let proximaJanelaNominatim = 0;

/** Só para teste. */
export function _resetGeocodeReverso(): void {
  googleDesligadoAte = 0;
  proximaJanelaNominatim = 0;
}

export function chaveGeocode(lat: number, lng: number): string {
  const latR = Math.round(lat * 10000) / 10000;
  const lngR = Math.round(lng * 10000) / 10000;
  return `${latR}:${lngR}`;
}

function googleAtivo(agora: number): boolean {
  return !!process.env.GOOGLE_MAPS_API_KEY && agora >= googleDesligadoAte;
}

/** Orçamento de geocodes novos deste ciclo, conforme o provedor que vai responder. */
export function limiteGeocodesNovos(agora = Date.now()): number {
  return googleAtivo(agora) ? LIMITE_GEOCODES_GOOGLE : LIMITE_GEOCODES_NOMINATIM;
}

async function viaGoogle(lat: number, lng: number, f: NonNullable<Deps["fetch"]>, agora: number): Promise<string | null> {
  const url = `https://maps.googleapis.com/maps/api/geocode/json?latlng=${lat},${lng}&language=pt-BR&key=${process.env.GOOGLE_MAPS_API_KEY}`;
  try {
    const res = await f(url, { signal: AbortSignal.timeout(4000) });
    if (!res.ok) { console.warn(`[geocode-reverso] google HTTP ${res.status}`); return null; }
    const data = (await res.json()) as { status?: string; results?: { formatted_address?: string }[] };
    if (data.status === "REQUEST_DENIED" || data.status === "OVER_QUERY_LIMIT" || data.status === "OVER_DAILY_LIMIT") {
      googleDesligadoAte = agora + GOOGLE_PAUSA_APOS_NEGADO_MS;
      console.warn(`[geocode-reverso] google negado (${data.status}); usando Nominatim por 10 min`);
      return null;
    }
    if (data.status !== "OK") return null;
    const fa = data.results?.[0]?.formatted_address;
    return fa ? fa.split(",").map((p) => p.trim()).slice(0, 2).join(", ") : null;
  } catch (e) {
    console.warn(`[geocode-reverso] google falhou: ${String(e)}`);
    return null;
  }
}

async function viaNominatim(lat: number, lng: number, deps: Required<Deps>): Promise<string | null> {
  // Reserva a janela ANTES de esperar: chamadas em paralelo (lotes de 8 do
  // motor) saem uma por segundo.
  const agora = deps.agora();
  const janela = Math.max(agora, proximaJanelaNominatim);
  proximaJanelaNominatim = janela + NOMINATIM_INTERVALO_MS;
  if (janela > agora) await deps.dormir(janela - agora);
  try {
    const url = `https://nominatim.openstreetmap.org/reverse?lat=${lat}&lon=${lng}&format=json&accept-language=pt-BR`;
    const res = await deps.fetch(url, { headers: { "User-Agent": "TransmonsegCentral/1.0" }, signal: AbortSignal.timeout(3000) });
    if (!res.ok) { console.warn(`[geocode-reverso] nominatim HTTP ${res.status}`); return null; }
    const data = (await res.json()) as { display_name?: string };
    return data.display_name ? data.display_name.split(",").map((p) => p.trim()).slice(0, 3).join(", ") : null;
  } catch (e) {
    console.warn(`[geocode-reverso] nominatim falhou: ${String(e)}`);
    return null;
  }
}

export async function geocodeReverso(
  lat: number,
  lng: number,
  pool: PoolMinimo,
  contadorNovos: { valor: number },
  cacheGeocode: Map<string, string>,
  depsParcial: Deps = {},
): Promise<ResultadoGeocodeReverso> {
  const deps: Required<Deps> = {
    fetch: depsParcial.fetch ?? ((u, i) => fetch(u, i)),
    agora: depsParcial.agora ?? Date.now,
    dormir: depsParcial.dormir ?? ((ms) => new Promise((r) => setTimeout(r, ms))),
  };
  const chave = chaveGeocode(lat, lng);
  const doCache = cacheGeocode.get(chave);
  if (doCache !== undefined) return { status: "ok", endereco: doCache };

  if (contadorNovos.valor >= limiteGeocodesNovos(deps.agora())) return { status: "sem_orcamento" };
  contadorNovos.valor += 1;

  let endereco: string | null = null;
  if (googleAtivo(deps.agora())) endereco = await viaGoogle(lat, lng, deps.fetch, deps.agora());
  if (!endereco) endereco = await viaNominatim(lat, lng, deps);
  if (!endereco) return { status: "falhou" };

  // Cache em memória (outro veículo na mesma célula ~11 m, mesmo ciclo) e no banco.
  cacheGeocode.set(chave, endereco);
  try {
    const pg = await pool.connect();
    try {
      await pg.query(
        `INSERT INTO geocode_cache (lat, lng, endereco) VALUES ($1, $2, $3)
         ON CONFLICT (lat, lng) DO NOTHING`,
        [Math.round(lat * 10000) / 10000, Math.round(lng * 10000) / 10000, endereco],
      );
    } finally {
      pg.release();
    }
  } catch { /* cache do banco é opcional; o rótulo já vale */ }
  return { status: "ok", endereco };
}

/** UPDATE dos rótulos: ok grava; falhou limpa (null) o rótulo velho; sem orçamento não mexe. */
export function atualizacaoDeLocais(
  itens: { veiculo_id: string; r: ResultadoGeocodeReverso }[],
): { veiculoIds: string[]; locais: (string | null)[] } {
  const veiculoIds: string[] = [];
  const locais: (string | null)[] = [];
  for (const { veiculo_id, r } of itens) {
    if (r.status === "sem_orcamento") continue;
    veiculoIds.push(veiculo_id);
    locais.push(r.status === "ok" ? r.endereco : null);
  }
  return { veiculoIds, locais };
}
