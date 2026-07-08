import { buscarAlvos, agruparPontosPorPlaca } from "@/lib/unitrac";

// Cache EM MEMORIA (nao e tabela no banco, some sozinho, nunca precisa de
// limpeza) pela lista exata de cv's pedida — evita rebater na Unitrac quando
// varias telas pedem a mesma placa (ou a malha da frota inteira) quase ao
// mesmo tempo. TTL curto: alvos do dia mudam em minutos, nao em segundos.
type AlvosCacheEntry = { pontos: unknown[]; expiraEm: number };
const ALVOS_CACHE_MS = 30_000;
const cacheAlvosPorChave = new Map<string, AlvosCacheEntry>();

export async function GET(request: Request) {
  const { searchParams } = new URL(request.url);
  // Suporta ?cv=X (único) ou múltiplos ?cv=A&cv=B (frota completa)
  const cvs = searchParams.getAll("cv");
  if (cvs.length === 0) return Response.json({ pontos: [] }, { status: 400 });

  const chave = [...cvs].sort().join(",");
  const cache = cacheAlvosPorChave.get(chave);
  if (cache && cache.expiraEm > Date.now()) {
    return Response.json({ pontos: cache.pontos });
  }

  try {
    const raw = await buscarAlvos(cvs);
    const mapa = agruparPontosPorPlaca(raw);
    const todos = [...mapa.values()].flat();
    cacheAlvosPorChave.set(chave, { pontos: todos, expiraEm: Date.now() + ALVOS_CACHE_MS });
    return Response.json({ pontos: todos });
  } catch (err) {
    return Response.json({ pontos: [], erro: String(err) });
  }
}
