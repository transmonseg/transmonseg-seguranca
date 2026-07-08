// Retorna as paradas de um veiculo nas ultimas N horas.
import { buscarStops } from "@/lib/unitrac";
import { createClient } from "@/lib/supabase/server";

export const dynamic = "force-dynamic";

// Cache EM MEMORIA (nao e tabela no banco, some sozinho, nunca precisa de
// limpeza) por cv+horas — mesmo motivo do /api/rastro: 2 operadores no
// mesmo veiculo (ou "Atualizar" 2x) reaproveitam a busca em vez de repetir.
type StopsCacheEntry = { paradas: unknown[]; expiraEm: number };
const STOPS_CACHE_MS = 30_000;
const cacheStopsPorChave = new Map<string, StopsCacheEntry>();

export async function GET(request: Request) {
  // Paradas sao dado sensivel de frota: exige operador logado.
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
  const cache = cacheStopsPorChave.get(chave);
  if (cache && cache.expiraEm > Date.now()) {
    return Response.json({ paradas: cache.paradas });
  }

  try {
    const paradas = await buscarStops(cv, horas);
    cacheStopsPorChave.set(chave, { paradas, expiraEm: Date.now() + STOPS_CACHE_MS });
    return Response.json({ paradas });
  } catch (e) {
    return Response.json({ erro: String(e) }, { status: 500 });
  }
}
