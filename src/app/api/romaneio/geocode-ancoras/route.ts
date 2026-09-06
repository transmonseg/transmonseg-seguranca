import { createAdminClient } from "@/lib/supabase/admin";
import { normalizarNomeRua } from "@/lib/romaneio-geocode-local";
import { reposicionarPorAncoraMaisProxima, type Ancora } from "@/lib/romaneio-geocode-ancoras";

// POST /api/romaneio/geocode-ancoras -- passo 7 do motor de geolocalizacao
// universal (docs/superpowers/specs/2026-09-05-motor-geolocalizacao-
// universal-design.md): resgata endereco que a cascata PRECISA (cidade+
// bairro, ver geocode/route.ts) nao resolveu, usando como ancora as
// coordenadas de OUTRAS entregas do MESMO caminhao/dia que ja' resolveram.
// Ver lib pura em src/lib/romaneio-geocode-ancoras.ts.
//
// Corpo: { grupos: [{ id, ruas: string[], ancoras: {lat,lng}[] }] }
//   - id: chave livre (placa+dia), so' devolvida de volta
//   - ruas: nome cru da rua de cada endereco NAO resolvido desse grupo
//   - ancoras: coordenadas das entregas JA' resolvidas do mesmo grupo
// Resposta: { grupos: [{ id, resultados: ({lat,lng}|null)[] }] } -- null
// quando nao ha candidato CNEFE pro nome, ou o mais proximo fica fora do
// raio (RAIO_ANCORA_CONHECIDA_M) -- nunca inventa coordenada.
//
// Protegida por x-motor-key + MOTOR_SECRET como as outras rotas de ponte.
// Sem efeito colateral (nao escreve cache).

export const maxDuration = 60;

const MAX_GRUPOS = 150;
const MAX_RUAS_TOTAL = 4000;

type GrupoEntrada = { id: string; ruas: string[]; ancoras: Ancora[] };

export async function POST(request: Request) {
  const chave = request.headers.get("x-motor-key");
  if (!chave || chave !== process.env.MOTOR_SECRET) {
    return Response.json({ erro: "nao autorizado" }, { status: 401 });
  }

  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return Response.json({ erro: "corpo invalido, esperado JSON" }, { status: 400 });
  }

  const grupos = (body as { grupos?: unknown })?.grupos;
  if (!Array.isArray(grupos) || !grupos.every(ehGrupoValido)) {
    return Response.json(
      { erro: "'grupos' precisa ser um array de { id: string, ruas: string[], ancoras: {lat,lng}[] }" },
      { status: 400 },
    );
  }
  if (grupos.length > MAX_GRUPOS) {
    return Response.json({ erro: `no maximo ${MAX_GRUPOS} grupos por chamada` }, { status: 400 });
  }
  const totalRuas = grupos.reduce((s, g) => s + g.ruas.length, 0);
  if (totalRuas > MAX_RUAS_TOTAL) {
    return Response.json({ erro: `no maximo ${MAX_RUAS_TOTAL} ruas no total por chamada` }, { status: 400 });
  }
  if (grupos.length === 0) return Response.json({ grupos: [] });

  const admin = createAdminClient();

  const nomesUnicos = new Set<string>();
  const gruposNorm = grupos.map((g) => ({ ...g, nomes: g.ruas.map((r) => normalizarNomeRua(r)) }));
  for (const g of gruposNorm) for (const n of g.nomes) if (n) nomesUnicos.add(n);

  // Candidatos CNEFE por nome, SEM filtro de municipio -- a ancora (ponto
  // real do caminhao) e' quem localiza geograficamente, o teto de
  // RAIO_ANCORA_CONHECIDA_M ja' descarta candidato de outra regiao.
  const candidatosPorNome = new Map<string, { lat: number; lng: number }[]>();
  if (nomesUnicos.size > 0) {
    const { data, error } = await admin.rpc("cnefe_candidatos_por_rua", { nomes: [...nomesUnicos] });
    if (error) {
      return Response.json({ erro: `cnefe_candidatos_por_rua: ${error.message}` }, { status: 500 });
    }
    for (const l of (data ?? []) as { nome: string; lat: number; lng: number }[]) {
      const lista = candidatosPorNome.get(l.nome) ?? [];
      lista.push({ lat: Number(l.lat), lng: Number(l.lng) });
      candidatosPorNome.set(l.nome, lista);
    }
  }

  const saida = gruposNorm.map((g) => ({
    id: g.id,
    resultados: g.nomes.map((nome) =>
      reposicionarPorAncoraMaisProxima(candidatosPorNome.get(nome) ?? [], g.ancoras)
    ),
  }));

  return Response.json({ grupos: saida });
}

function ehGrupoValido(g: unknown): g is GrupoEntrada {
  if (!g || typeof g !== "object") return false;
  const o = g as Record<string, unknown>;
  return (
    typeof o.id === "string" &&
    Array.isArray(o.ruas) &&
    o.ruas.every((r) => typeof r === "string") &&
    Array.isArray(o.ancoras) &&
    o.ancoras.every((a) => typeof a === "object" && a !== null && typeof (a as Ancora).lat === "number" && typeof (a as Ancora).lng === "number")
  );
}
