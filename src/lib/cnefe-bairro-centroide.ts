// Centroide do bairro no CNEFE -- ultimo passo da cascata antes do Photon
// (geocodificarCnefePorBairro em romaneio-geocode.ts). F4-01 do plano mestre
// da Central (GEO-26, auditoria 23/10).
//
// Antes: `.eq(municipio_codigo).ilike('localidade', '%X%')` direto em
// cnefe_enderecos (8,8 M linhas), sem indice, sem limite e sem prazo: Parallel
// Seq Scan de 50 s e 167 mil linhas para CAMPO GRANDE, e o '%X%' misturava
// localidades -- "MARE" juntava 15 (Marechal Hermes inclusa) e o centroide
// ficava a 8,1 km da Mare.
//
// Agora (com a migration contabo/091 aplicada): tabela pequena
// cnefe_bairros_centroide, uma linha por (municipio_codigo, localidade_norm)
// com a media dos pontos do Censo (o mesmo calculo de antes, so' que por
// localidade), lida por igualdade. Sem igualdade (ou com menos de 10 pontos),
// a UNICA localidade do municipio que contem o bairro como palavra inteira
// ("CANAA" -> "VILA CANAA") ou, para bairro cortado no romaneio (>= 10
// letras), a UNICA que comeca com ele ("GRANJA DOS CAVALEIRO" ->
// "GRANJA DOS CAVALEIROS"). Mais de uma candidata = ambiguo = sem centroide
// (o endereco segue para o Photon). Nunca inventa ponto: sempre um grupo real
// de pontos de campo do IBGE.
//
// Sem a migration (tabela ausente no PostgREST): a consulta antiga, igual a de
// antes, agora com prazo. Prazo estourado = status "timeout": a rota marca o
// endereco como incompleto se nada mais o resolver (o KPI nao grava cache
// negativo de algo que nao foi tentado por inteiro).
import type { SupabaseClient } from "@supabase/supabase-js";

export type GrupoBairro = { localidade_norm: string; n_pontos: number; lat: number; lng: number };
export type CentroideBairro = { lat: number; lng: number; qtd: number };
export type ResultadoCentroide = { status: "ok"; data: CentroideBairro | null } | { status: "timeout" | "erro" };

// Mesmo minimo de geocodificarCnefePorBairro (romaneio-geocode.ts).
const MIN_PONTOS = 10;
const MIN_LETRAS_PREFIXO = 10;
const MAX_CANDIDATAS = 200;
export const PRAZO_TABELA_MS = 5_000;
// A consulta antiga levava ate' ~50 s (Campo Grande): 60 s mantem o resultado
// de hoje enquanto a migration nao entra, so' corta o caso patologico.
export const PRAZO_LEGADO_MS = 60_000;

// Mesma chave de cnefe_bairros.localidade_norm (migration 082) e de
// normalizarBairro (territorio.ts): sem acento, maiusculo, espacos colapsados.
export function normalizarLocalidadeBairro(s: string): string {
  return s.normalize("NFD").replace(/[̀-ͯ]/g, "").toUpperCase().replace(/\s+/g, " ").trim();
}

function contemPalavra(localidade: string, bairro: string): boolean {
  return ` ${localidade} `.includes(` ${bairro} `);
}

export function escolherGrupoBairro(bairroNorm: string, grupos: GrupoBairro[]): { grupo: GrupoBairro; modo: "igual" | "contido" | "prefixo" } | null {
  const suficiente = (x: GrupoBairro) => x.n_pontos >= MIN_PONTOS;
  const igual = grupos.find((x) => x.localidade_norm === bairroNorm);
  if (igual && suficiente(igual)) return { grupo: igual, modo: "igual" };
  const outros = grupos.filter((x) => x.localidade_norm !== bairroNorm);
  const contidos = outros.filter((x) => contemPalavra(x.localidade_norm, bairroNorm));
  if (contidos.length === 1) return suficiente(contidos[0]) ? { grupo: contidos[0], modo: "contido" } : null;
  if (contidos.length > 1) return null;
  if (bairroNorm.length < MIN_LETRAS_PREFIXO) return null;
  const prefixos = outros.filter((x) => x.localidade_norm.startsWith(bairroNorm));
  if (prefixos.length === 1 && suficiente(prefixos[0])) return { grupo: prefixos[0], modo: "prefixo" };
  return null;
}

type ErroPg = { code?: string; message?: string } | null;

function tabelaAusente(e: ErroPg): boolean {
  if (!e) return false;
  return e.code === "PGRST205" || e.code === "42P01" || /could not find the table|does not exist/i.test(e.message ?? "");
}

function foiPrazo(e: unknown): boolean {
  const m = (e as { message?: string; name?: string } | null)?.message ?? "";
  const n = (e as { name?: string } | null)?.name ?? "";
  return n === "AbortError" || /abort/i.test(m);
}

async function comPrazo<T>(ms: number, consulta: (sinal: AbortSignal) => PromiseLike<{ data: T | null; error: ErroPg }>): Promise<{ data: T | null; error: ErroPg; prazo: boolean }> {
  const ctl = new AbortController();
  const t = setTimeout(() => ctl.abort(), ms);
  try {
    const r = await consulta(ctl.signal);
    return { data: r.data, error: r.error, prazo: ctl.signal.aborted || foiPrazo(r.error) };
  } catch (e) {
    return { data: null, error: { message: String((e as Error)?.message ?? e) }, prazo: ctl.signal.aborted || foiPrazo(e) };
  } finally {
    clearTimeout(t);
  }
}

async function buscarLegado(admin: SupabaseClient, bairro: string, municipioCodigo: string): Promise<ResultadoCentroide> {
  const r = await comPrazo<{ lat: number; lng: number }[]>(PRAZO_LEGADO_MS, (sinal) =>
    admin.from("cnefe_enderecos").select("lat, lng").eq("municipio_codigo", municipioCodigo).ilike("localidade", `%${bairro}%`).abortSignal(sinal),
  );
  if (r.error || r.prazo) {
    console.error(`[cnefe-bairro] consulta antiga (sem a migration 091) falhou para "${bairro}"/${municipioCodigo}: ${r.prazo ? "prazo" : r.error?.message}`);
    return { status: r.prazo ? "timeout" : "erro" };
  }
  const data = r.data ?? [];
  if (data.length === 0) return { status: "ok", data: null };
  const lat = data.reduce((s, p) => s + p.lat, 0) / data.length;
  const lng = data.reduce((s, p) => s + p.lng, 0) / data.length;
  return { status: "ok", data: { lat, lng, qtd: data.length } };
}

export async function buscarCentroideBairro(admin: SupabaseClient, bairro: string, municipioCodigo: string): Promise<ResultadoCentroide> {
  const norm = normalizarLocalidadeBairro(bairro);
  if (!norm) return { status: "ok", data: null };
  const igual = await comPrazo<GrupoBairro[]>(PRAZO_TABELA_MS, (sinal) =>
    admin.from("cnefe_bairros_centroide").select("localidade_norm, n_pontos, lat, lng").eq("municipio_codigo", municipioCodigo).eq("localidade_norm", norm).limit(1).abortSignal(sinal),
  );
  if (tabelaAusente(igual.error)) return buscarLegado(admin, bairro, municipioCodigo);
  if (igual.error || igual.prazo) {
    console.error(`[cnefe-bairro] cnefe_bairros_centroide falhou para "${norm}"/${municipioCodigo}: ${igual.prazo ? "prazo" : igual.error?.message}`);
    return { status: igual.prazo ? "timeout" : "erro" };
  }
  let grupos = igual.data ?? [];
  const achouIgual = escolherGrupoBairro(norm, grupos);
  if (!achouIgual && !/[%_\\]/.test(norm)) {
    const contem = await comPrazo<GrupoBairro[]>(PRAZO_TABELA_MS, (sinal) =>
      admin.from("cnefe_bairros_centroide").select("localidade_norm, n_pontos, lat, lng").eq("municipio_codigo", municipioCodigo).ilike("localidade_norm", `%${norm}%`).limit(MAX_CANDIDATAS).abortSignal(sinal),
    );
    if (contem.error || contem.prazo) {
      console.error(`[cnefe-bairro] busca por localidade que contem "${norm}"/${municipioCodigo} falhou: ${contem.prazo ? "prazo" : contem.error?.message}`);
      return { status: contem.prazo ? "timeout" : "erro" };
    }
    grupos = [...grupos, ...(contem.data ?? []).filter((x) => x.localidade_norm !== norm)];
  }
  const escolhido = achouIgual ?? escolherGrupoBairro(norm, grupos);
  if (!escolhido) return { status: "ok", data: null };
  return { status: "ok", data: { lat: escolhido.grupo.lat, lng: escolhido.grupo.lng, qtd: escolhido.grupo.n_pontos } };
}
