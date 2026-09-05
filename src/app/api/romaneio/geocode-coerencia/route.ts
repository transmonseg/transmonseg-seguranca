import { createAdminClient } from "@/lib/supabase/admin";
import { normalizarNomeRua } from "@/lib/romaneio-geocode-local";
import {
  resolverGrupoPorCoerencia,
  municipiosDaZona,
  zonasConhecidas,
  type CandidatoCluster,
  type ResultadoParada,
} from "@/lib/romaneio-geocode-coerencia";

// POST /api/romaneio/geocode-coerencia -- geocodificacao por COERENCIA DE
// GRUPO pra romaneio que so' traz o NOME DA RUA por parada (sem numero,
// bairro ou cidade) -- caso real Rio Quality, achado 05/09. Ver a lib
// src/lib/romaneio-geocode-coerencia.ts (algoritmo, medicoes) e a migration
// contabo/071 (funcoes SQL de candidatos).
//
// Corpo: { grupos: [{ id, zona?, ruas: string[] }] }
//   - id: chave livre do chamador (placa, "placa|dia"...), so' devolvida de volta
//   - zona: uma de zonasConhecidas() (CAPITAL, BAIXADA, LESTE, LAGOS, SERRANA,
//     SUL_FLUMINENSE, NORTE_FLUMINENSE, COSTA_VERDE) -- prior FRACO; quem
//     traduz o nome da rota do cliente ("SUDOESTE 2") pra zona e' o chamador
//   - ruas: nomes crus como vem no romaneio ("AV. AUTOMOVEL CLUBE"), a ordem
//     NAO importa (nao e' ordem de rota) mas e' preservada na resposta
// Resposta: { grupos: [{ id, resultados: ResultadoParada[] }] } -- um
// resultado por rua, na mesma ordem; lat/lng null quando sem candidato.
//
// Protegida por x-motor-key + MOTOR_SECRET como as outras rotas de ponte.
// Sem efeito colateral (nao escreve cache) -- o chamador decide o que fazer
// com "baixa"/"sem_candidato" (o KPI marca no relatorio em vez de inventar).

export const maxDuration = 120;

const MAX_GRUPOS = 150;
const MAX_RUAS_TOTAL = 4000;
const LIMITE_CLUSTERS_SIMILARIDADE = 40;
const CONCORRENCIA_SIMILARIDADE = 4;

type GrupoEntrada = { id: string; zona?: string | null; ruas: string[] };

type LinhaExato = { nome: string; municipio_codigo: string; lat: number; lng: number; qtd: number };
type LinhaSimilar = { nome_cnefe: string; similaridade: number; municipio_codigo: string; lat: number; lng: number; qtd: number };

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
      { erro: "'grupos' precisa ser um array de { id: string, zona?: string, ruas: string[] }" },
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
  const zonaInvalida = grupos.find((g) => g.zona && !municipiosDaZona(g.zona));
  if (zonaInvalida) {
    return Response.json(
      { erro: `zona desconhecida '${zonaInvalida.zona}'; use uma de: ${zonasConhecidas().join(", ")}` },
      { status: 400 },
    );
  }
  if (grupos.length === 0) return Response.json({ grupos: [] });

  const admin = createAdminClient();

  // 1) normaliza tudo e busca candidatos EXATOS em lote (uma RPC pra todos os grupos)
  const nomesUnicos = new Set<string>();
  const gruposNorm = grupos.map((g) => ({
    ...g,
    nomes: g.ruas.map((r) => normalizarNomeRua(r)),
  }));
  for (const g of gruposNorm) for (const n of g.nomes) if (n) nomesUnicos.add(n);

  const candidatosPorNome = new Map<string, CandidatoCluster[]>();
  const t0 = Date.now();
  const { data: exatos, error: erroExato } = await admin.rpc("cnefe_candidatos_por_rua", { nomes: [...nomesUnicos] });
  const msExato = Date.now() - t0;
  if (erroExato) {
    return Response.json({ erro: `cnefe_candidatos_por_rua: ${erroExato.message}` }, { status: 500 });
  }
  for (const l of (exatos ?? []) as LinhaExato[]) {
    const lista = candidatosPorNome.get(l.nome) ?? [];
    lista.push({ municipioCodigo: l.municipio_codigo, lat: Number(l.lat), lng: Number(l.lng), qtd: Number(l.qtd), similaridade: 1 });
    candidatosPorNome.set(l.nome, lista);
  }

  // 2) similaridade pros nomes que o exato nao resolveu -- uma RPC por nome,
  //    em paralelo com concorrencia limitada (achado real 05/09: ~0,5s cada
  //    com o limiar fixado no indice pela migration 072; antes eram ~12s).
  //    Nomes curtos (<6) nao valem o risco de casar rua errada.
  //
  //    Entra aqui tambem o nome que TEM match exato mas NENHUM dentro da zona
  //    do grupo (achado 05/09, conferencia manual da Rio Quality): "RUA
  //    RAIMUNDO CORREIA" na rota SUL 1 (capital, rua de Copacabana) foi parar
  //    em Duque de Caxias porque o CNEFE grafa "RAIMUNDO CORREA" no Rio --
  //    sem match exato na capital, mas com exato em Caxias/Macae/Belford
  //    Roxo. Match exato FORA da zona nao pode ganhar de nome parecido DENTRO
  //    dela.
  const semExatoNaZona = new Set<string>();
  for (const g of gruposNorm) {
    const zona = municipiosDaZona(g.zona);
    if (!zona) continue;
    for (const nome of g.nomes) {
      const exatos = candidatosPorNome.get(nome);
      if (exatos && exatos.length > 0 && !exatos.some((c) => zona.has(c.municipioCodigo))) {
        semExatoNaZona.add(nome);
      }
    }
  }
  const candidatosSimilares = new Map<string, CandidatoCluster[]>();
  const pendentes = [...nomesUnicos].filter(
    (n) => (!candidatosPorNome.has(n) || semExatoNaZona.has(n)) && n.length >= 6,
  );
  let viaSimilaridade = 0;
  const buscarSimilar = async (nome: string) => {
    const { data: similares, error: erroSim } = await admin.rpc("cnefe_candidatos_por_similaridade", {
      nome,
      limite_clusters: LIMITE_CLUSTERS_SIMILARIDADE,
    });
    if (erroSim || !similares || similares.length === 0) return;
    const linhas = similares as LinhaSimilar[];
    // so' os aglomerados do nome CNEFE mais parecido (nao mistura ruas diferentes)
    const melhor = Math.max(...linhas.map((l) => Number(l.similaridade)));
    const lista: CandidatoCluster[] = linhas
      .filter((l) => Number(l.similaridade) >= melhor - 0.05)
      .map((l) => ({ municipioCodigo: l.municipio_codigo, lat: Number(l.lat), lng: Number(l.lng), qtd: Number(l.qtd), similaridade: Number(l.similaridade) }));
    if (lista.length > 0) {
      // guardado a parte: o exato continua valendo pra quem tem candidato na
      // propria zona; o similar so' entra pra quem nao tem (ver montagem por
      // grupo abaixo).
      candidatosSimilares.set(nome, lista);
      if (!candidatosPorNome.has(nome)) candidatosPorNome.set(nome, lista);
      viaSimilaridade++;
    }
  };
  const t1 = Date.now();
  for (let i = 0; i < pendentes.length; i += CONCORRENCIA_SIMILARIDADE) {
    await Promise.all(pendentes.slice(i, i + CONCORRENCIA_SIMILARIDADE).map(buscarSimilar));
  }
  const msSimilaridade = Date.now() - t1;

  // 3) resolve cada grupo (puro, em memoria). Monta o mapa de candidatos DO
  //    GRUPO: quando o exato nao tem nada na zona e a similaridade tem, usa a
  //    similaridade (nunca vira ancora e a confianca ja' e' rebaixada na lib).
  const saida = gruposNorm.map((g) => {
    const zona = municipiosDaZona(g.zona);
    const doGrupo = new Map(candidatosPorNome);
    if (zona) {
      for (const nome of g.nomes) {
        if (!semExatoNaZona.has(nome)) continue;
        const similares = candidatosSimilares.get(nome);
        if (similares?.some((c) => zona.has(c.municipioCodigo))) doGrupo.set(nome, similares);
      }
    }
    const resultados: ResultadoParada[] = resolverGrupoPorCoerencia(
      g.nomes.map((nomeNormalizado) => ({ nomeNormalizado })),
      doGrupo,
      zona,
    );
    return { id: g.id, resultados };
  });

  return Response.json({
    grupos: saida,
    meta: { nomesUnicos: nomesUnicos.size, viaSimilaridade, pendentesSimilaridade: pendentes.length, msExato, msSimilaridade },
  });
}

function ehGrupoValido(g: unknown): g is GrupoEntrada {
  if (!g || typeof g !== "object") return false;
  const o = g as Record<string, unknown>;
  return (
    typeof o.id === "string" &&
    (o.zona === undefined || o.zona === null || typeof o.zona === "string") &&
    Array.isArray(o.ruas) &&
    o.ruas.every((r) => typeof r === "string")
  );
}
