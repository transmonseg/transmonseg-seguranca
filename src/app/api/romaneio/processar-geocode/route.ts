import { createAdminClient } from "@/lib/supabase/admin";
import { geocodificarEndereco, geocodificarLocal, geocodificarGoogle, geocodificarNominatim } from "@/lib/romaneio-geocode";
import { extrairCidadeDoEndereco } from "@/lib/romaneio-geocode-local";

export const maxDuration = 60;

const LOTE_POR_INVOCACAO = 40;
// Espera sequencial ANTES de cada chamada real ao Nominatim -- respeita
// a politica real de 1 req/s do servidor publico. Movido pra DENTRO da
// chamada de Nominatim especificamente (nao mais incondicional no loop)
// -- achado do planejamento: com geocodificacao local resolvendo a
// maioria dos enderecos, o throttle no loop inteiro anularia o ganho de
// velocidade (esperaria 1,1s por linha mesmo sem chamar rede nenhuma).
const ESPERA_ENTRE_CHAMADAS_MS = 1100;

function esperar(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export async function POST(request: Request) {
  const chave = request.headers.get("x-motor-key");
  if (!chave || chave !== process.env.MOTOR_SECRET) {
    return Response.json({ erro: "nao autorizado" }, { status: 401 });
  }

  const admin = createAdminClient();

  const { data: pendentes, error: erroPendentes } = await admin
    .from("romaneio_pontos")
    .select("id, endereco_bruto")
    .eq("geocode_status", "pendente")
    .order("criado_em", { ascending: true })
    .limit(LOTE_POR_INVOCACAO);

  if (erroPendentes) {
    console.error(`Erro ao buscar romaneio_pontos pendentes: ${erroPendentes.message}`);
  }

  if (!pendentes || pendentes.length === 0) {
    return Response.json({ processados: 0 });
  }

  const buscarCache = async (chaveNormalizada: string) => {
    const { data } = await admin.from("romaneio_geocode_cache").select("lat, lng, fonte").eq("endereco_normalizado", chaveNormalizada).maybeSingle();
    return data ?? null;
  };
  const salvarCache = async (chaveNormalizada: string, r: { lat: number; lng: number; fonte: string }) => {
    await admin.from("romaneio_geocode_cache").upsert({ endereco_normalizado: chaveNormalizada, lat: r.lat, lng: r.lng, fonte: r.fonte, atualizado_em: new Date().toISOString() });
  };

  // Nominatim com throttle -- so aqui, na chamada real de rede, nao no
  // loop inteiro (ver comentario no topo do arquivo).
  const geocodificarNominatimThrottled = async (enderecoBruto: string) => {
    await esperar(ESPERA_ENTRE_CHAMADAS_MS);
    return geocodificarNominatim(enderecoBruto);
  };

  // Resolve os pontos de referencia de cidade do lote, 1x cada (nao 1x
  // por endereco) -- cacheados em romaneio_geocode_cache com prefixo
  // "CIDADE:" pra nao colidir com chaves de endereco completo. Poucas
  // dezenas por lote no maximo, throttle simples ja basta.
  const cidadesUnicas = [...new Set(
    pendentes.map((l) => extrairCidadeDoEndereco(l.endereco_bruto)).filter((c): c is string => c !== null)
  )];
  const pontosCidade = new Map<string, { lat: number; lng: number }>();
  for (const cidade of cidadesUnicas) {
    const chaveCidade = `CIDADE:${cidade.toUpperCase()}`;
    const doCache = await buscarCache(chaveCidade);
    if (doCache) {
      pontosCidade.set(cidade, { lat: doCache.lat, lng: doCache.lng });
      continue;
    }
    const ponto = await geocodificarNominatimThrottled(cidade);
    if (ponto) {
      await salvarCache(chaveCidade, { ...ponto, fonte: "nominatim" });
      pontosCidade.set(cidade, ponto);
    }
  }

  const buscarCandidatosPorNome = async (nomeNormalizado: string) => {
    const { data } = await admin.from("vias_nomes").select("lat, lng").eq("nome_normalizado", nomeNormalizado);
    return data ?? [];
  };

  let ok = 0;
  let falhou = 0;

  for (const linha of pendentes) {
    const cidade = extrairCidadeDoEndereco(linha.endereco_bruto);
    const pontoCidade = cidade ? pontosCidade.get(cidade) ?? null : null;

    const geocode = await geocodificarEndereco(linha.endereco_bruto, pontoCidade, {
      buscarCache,
      salvarCache,
      geocodificarLocalDep: (endereco, ponto) => geocodificarLocal(endereco, ponto, buscarCandidatosPorNome),
      geocodificarGoogle,
      geocodificarNominatim: geocodificarNominatimThrottled,
    });

    const geocodeStatus = geocode ? "ok" : "falhou";
    if (geocode) ok++; else falhou++;

    const { error: erroUpdate } = await admin
      .from("romaneio_pontos")
      .update({ lat: geocode?.lat ?? null, lng: geocode?.lng ?? null, geocode_status: geocodeStatus })
      .eq("id", linha.id);

    if (erroUpdate) {
      console.warn(`Aviso: erro ao atualizar geocode_status do ponto ${linha.id}: ${erroUpdate.message}`);
    }
  }

  return Response.json({ processados: pendentes.length, ok, falhou });
}
