// Retorna o historico de posicoes (rastro) de um veiculo nas ultimas N horas.
import { buscarRastro, removerPicosRastro } from "@/lib/unitrac";
import { ajustarRastroParaRuas } from "@/lib/rastro-matching";
import { createClient } from "@/lib/supabase/server";

export const dynamic = "force-dynamic";
// MAX_CHAMADAS subiu de 40 pra 200 (ver rastro-matching.ts) — margem de
// segurança pra janelas de 96h bem esparsas, medido em ~5,6s pra 122
// chamadas reais; o default de maxDuration da Vercel seria curto demais.
export const maxDuration = 30;

// Cache EM MEMORIA (nao e tabela no banco — nao pesa o Supabase, nao precisa
// de limpeza/retencao) por cv+horas: se 2 operadores abrirem o MESMO veiculo
// quase ao mesmo tempo (ou o mesmo operador clicar "Atualizar" 2x seguidas),
// a 2a chamada reaproveita o resultado em vez de refazer buscarRastro +
// remocao de picos + ate 200 chamadas de ajuste de rua (OSRM) do zero.
// Some sozinho quando a funcao serverless reciclar; nunca cresce sem limite
// (no maximo 1 entrada por veiculo da frota ja visto neste processo quente).
type RastroCacheEntry = { pontos: { lat: number; lng: number }[]; expiraEm: number };
const RASTRO_CACHE_MS = 30_000;
const cacheRastroPorChave = new Map<string, RastroCacheEntry>();

export async function GET(request: Request) {
  // Rastro e dado sensivel de frota: exige operador logado.
  const auth = await createClient();
  const { data: { user } } = await auth.auth.getUser();
  if (!user) return Response.json({ erro: "nao autorizado" }, { status: 401 });

  const { searchParams } = new URL(request.url);
  const cv = searchParams.get("cv");
  if (!cv) {
    return Response.json({ erro: "parametro cv e obrigatorio" }, { status: 400 });
  }

  // horas: default 24, clamp entre 1 e 96
  const horasRaw = Number(searchParams.get("horas") ?? "24");
  const horas = Number.isFinite(horasRaw)
    ? Math.min(96, Math.max(1, Math.round(horasRaw)))
    : 24;

  const chave = `${cv}:${horas}`;
  const cache = cacheRastroPorChave.get(chave);
  if (cache && cache.expiraEm > Date.now()) {
    return Response.json({ pontos: cache.pontos });
  }

  try {
    const pontos = await buscarRastro(cv, horas);
    const semPicos = removerPicosRastro(pontos);
    const pontosAjustados = await ajustarRastroParaRuas(semPicos);
    cacheRastroPorChave.set(chave, { pontos: pontosAjustados, expiraEm: Date.now() + RASTRO_CACHE_MS });
    return Response.json({ pontos: pontosAjustados });
  } catch (e) {
    return Response.json({ erro: String(e) }, { status: 500 });
  }
}
