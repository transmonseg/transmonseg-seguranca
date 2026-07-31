import { createAdminClient } from "@/lib/supabase/admin";
import { geocodificarEndereco, geocodificarLocal, geocodificarGoogle, geocodificarNominatim } from "@/lib/romaneio-geocode";
import { extrairCidadeDoEndereco, expandirCidadeTruncada } from "@/lib/romaneio-geocode-local";

export const maxDuration = 60;

// Achado real 27/07: dado real de um romaneio de 1587 enderecos mostrou
// 74% resolvendo local (rapido, sem API externa) e so 26% precisando do
// caminho throttled -- 60 por lote fica bem dentro da janela de 30s do
// job mais frequente (60 * 0,26 ~= 16 chamadas throttled * 1,1s ~= 17s).
const LOTE_POR_INVOCACAO = 60;
// Reivindicacoes mais velhas que isso sao consideradas abandonadas
// (processo que crashou no meio) e voltam a ficar disponiveis.
const REIVINDICACAO_EXPIRA_MIN = 5;
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

  // Achado real 27/07: agora que o job roda mais de uma vez por minuto
  // (ver migration contabo/005), duas invocacoes podem se sobrepor --
  // sem reivindicar a linha antes de processar, as duas pegariam os
  // MESMOS enderecos "pendente" e chamariam a API externa 2x pra nada.
  // Pega tambem reivindicacoes velhas (processo anterior que crashou no
  // meio) -- senao aquelas linhas ficariam presas pra sempre.
  const expiraAntesDe = new Date(Date.now() - REIVINDICACAO_EXPIRA_MIN * 60_000).toISOString();
  const { data: candidatos, error: erroCandidatos } = await admin
    .from("romaneio_pontos")
    .select("id, endereco_bruto")
    .or(`geocode_status.eq.pendente,and(geocode_status.eq.processando,geocode_reivindicado_em.lt.${expiraAntesDe})`)
    .order("criado_em", { ascending: true })
    .limit(LOTE_POR_INVOCACAO);

  if (erroCandidatos) {
    console.error(`Erro ao buscar romaneio_pontos pendentes: ${erroCandidatos.message}`);
  }

  if (!candidatos || candidatos.length === 0) {
    return Response.json({ processados: 0 });
  }

  // Reivindica ANTES de processar. Achado real 27/07 (pego em teste ao
  // vivo com 2 chamadas concorrentes): so filtrar por id aqui NAO basta
  // -- se 2 invocacoes fizerem o SELECT acima quase ao mesmo tempo,
  // ambas veem as MESMAS linhas ainda "pendente"/"processando" (a raca
  // esta exatamente nessa janela), e um UPDATE só por id reivindicaria
  // pra AMBAS igualmente, processando tudo 2x. Reaplicar a MESMA condicao
  // do SELECT no UPDATE torna a reivindicacao atomica de verdade: a
  // primeira invocacao a rodar o UPDATE muda o status, a segunda tenta
  // atualizar as mesmas linhas mas elas ja nao batem mais na condicao
  // (nao estao mais "pendente" nem com reivindicacao velha) -- o UPDATE
  // dela simplesmente nao afeta essas linhas, e o .select() retorna a
  // lista real (menor) do que ela conseguiu reivindicar de verdade.
  const idsCandidatos = candidatos.map((c) => c.id);
  const { data: pendentes, error: erroReivindicar } = await admin
    .from("romaneio_pontos")
    .update({ geocode_status: "processando", geocode_reivindicado_em: new Date().toISOString() })
    .in("id", idsCandidatos)
    .or(`geocode_status.eq.pendente,and(geocode_status.eq.processando,geocode_reivindicado_em.lt.${expiraAntesDe})`)
    .select("id, endereco_bruto");

  if (erroReivindicar || !pendentes) {
    console.error(`Erro ao reivindicar romaneio_pontos: ${erroReivindicar?.message}`);
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
  // expandirCidadeTruncada ANTES de deduplicar/resolver: achado real 31/07,
  // o PDF de origem corta o nome da cidade em ~15 caracteres (ex. "SANTA
  // MARIA MAD") -- mandar isso pro Nominatim como nome de cidade falha
  // quase sempre. Ver src/lib/romaneio-geocode-local.ts.
  const cidadesUnicas = [...new Set(
    pendentes
      .map((l) => extrairCidadeDoEndereco(l.endereco_bruto))
      .filter((c): c is string => c !== null)
      .map(expandirCidadeTruncada)
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
    const cidadeBruta = extrairCidadeDoEndereco(linha.endereco_bruto);
    const cidade = cidadeBruta ? expandirCidadeTruncada(cidadeBruta) : null;
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
