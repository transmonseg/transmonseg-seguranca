// Rota HTTP isolada e SIDE-EFFECT-FREE (nunca escreve em nenhuma tabela)
// que expoe a cascata de geocodificacao de endereco ja madura deste
// projeto (CNEFE/IBGE + extrato OSM local + Google + Nominatim, com
// resolucao de ponto de referencia por cidade/bairro pra descartar rua
// homonima em municipio errado -- mesma cascata que
// /api/romaneio/processar-geocode usa em producao) pro projeto IRMAO
// "KPI transmonseg".
//
// Quem chama: o projeto KPI transmonseg, via HTTP local no mesmo VPS
// (transmonseg-vps) -- os dois rodam como processos PM2 separados, repos
// e node_modules independentes, sem import direto possivel. Ver
// investigacao completa em
// KPI transmonseg/.superpowers/sdd/2026-08-23-kpi-romaneio-nutrimax/task-3-report.md.
// Do lado do KPI, ver src/lib/kpi-romaneio/geocode.ts.
//
// Por que essa rota existe (em vez de so' reusar processar-geocode): aquela
// rota e' o motor de desvio em PRODUCAO (cron a cada 30s, reivindica e
// GRAVA romaneio_pontos/romaneio_geocode_cache/pontos_aprendidos) -- nao
// da pra chamar ela de fora sem herdar esse side-effect. Esta rota nova
// reusa as MESMAS funcoes exportadas de src/lib/romaneio-geocode.ts e
// src/lib/romaneio-geocode-local.ts (nenhum arquivo existente foi
// alterado), so' que:
//   - nunca escreve em romaneio_pontos, romaneio_geocode_cache,
//     romaneio_cliente_codigo_geocode nem pontos_aprendidos (so' LE o
//     cache de endereco/cidade/bairro pra acelerar/precisao quando ja
//     existe, nunca grava);
//   - nao tem nocao de veiculo/cliente_codigo (o cache write-once por
//     cliente_codigo e' um conceito do pipeline de upload, nao faz
//     sentido aqui);
//   - responde SINCRONO num unico POST em lote, sem reivindicacao nem
//     retomada entre invocacoes (nao ha nada persistido pra retomar).
//
// Protegida pelo mesmo header x-motor-key + MOTOR_SECRET que as outras
// rotas internas deste projeto (motor, motor-romaneio, processar-geocode)
// -- chamada servidor-a-servidor, nunca do browser.

import { createAdminClient } from "@/lib/supabase/admin";
import { geocodificarEndereco, geocodificarLocal, geocodificarCnefe, geocodificarGoogle, geocodificarNominatim, escolherPontoReferencia, normalizarEndereco } from "@/lib/romaneio-geocode";
import { extrairCidadeDoEndereco, expandirCidadeTruncada, extrairBairroDoEndereco, municipioCodigoIbge, termoBuscaCidade, extrairRuaDoEndereco, normalizarNomeRua } from "@/lib/romaneio-geocode-local";

// Achado real 03/09 (investigacao "geolocalizacao ruim" -- 2 tentativas
// seguidas de geracao do KPI Nutry Max bateram "geocodificacao falhou
// para 100% do lote"): sequencial (1 endereco por vez, throttle de
// Nominatim), um lote com muitos enderecos rurais (sem CNEFE/OSM local
// bom) pode no pior caso passar de qualquer prazo razoavel -- um teste
// isolado de 1 UNICO endereco chegou a levar 35s (pico de lentidao
// pontual do Nominatim publico). Sem controle de prazo, isso significa
// perder TODOS os resultados do lote (fail-open virando fail-CLOSED na
// pratica) -- o chamador so' sabe "a chamada inteira estourou o timeout
// dele", nao "processei 30 dos 40". 280s deixa folga sob o
// GEOCODE_TIMEOUT_MS=300_000 do lado do KPI (geocode.ts la).
export const maxDuration = 280;
const PRAZO_MAXIMO_MS = 280_000;

// Mesmo throttle sequencial de processar-geocode/route.ts -- respeita a
// politica real de 1 req/s do Nominatim publico, independente de quem
// chama.
const ESPERA_ENTRE_CHAMADAS_MS = 1100;

function esperar(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// Teto defensivo por chamada -- reduzido do lado do KPI (LOTE_MAX_ENDERECOS
// em geocode.ts la, 120->40, mesma investigacao) especificamente pra
// diminuir a chance de precisar do corte de prazo abaixo. Rejeitar
// explicitamente acima disso (em vez de truncar em silencio) forca o
// chamador a dividir em lotes menores se um dia precisar.
const MAX_ENDERECOS_POR_CHAMADA = 300;

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

  const enderecos = (body as { enderecos?: unknown })?.enderecos;
  if (!Array.isArray(enderecos) || !enderecos.every((e) => typeof e === "string")) {
    return Response.json({ erro: "'enderecos' precisa ser um array de strings" }, { status: 400 });
  }
  if (enderecos.length > MAX_ENDERECOS_POR_CHAMADA) {
    return Response.json({ erro: `no maximo ${MAX_ENDERECOS_POR_CHAMADA} enderecos por chamada` }, { status: 400 });
  }
  if (enderecos.length === 0) {
    return Response.json({ resultados: [] });
  }

  const lista = enderecos as string[];
  const admin = createAdminClient();
  const inicioRequisicao = Date.now();
  const prazoEsgotado = () => Date.now() - inicioRequisicao > PRAZO_MAXIMO_MS;

  const salvarCacheNoop = async (): Promise<void> => {};

  const geocodificarNominatimThrottled = async (enderecoBruto: string) => {
    await esperar(ESPERA_ENTRE_CHAMADAS_MS);
    return geocodificarNominatim(enderecoBruto);
  };

  const buscarCandidatosPorNome = async (nomeNormalizado: string) => {
    const { data } = await admin.from("vias_nomes").select("lat, lng").eq("nome_sem_conectores", nomeNormalizado);
    return data ?? [];
  };
  const buscarCnefePorRuaNumero = async (nomeNormalizado: string, numero: string, municipioCodigo: string | null) => {
    let query = admin.from("cnefe_enderecos").select("lat, lng").eq("nome_normalizado", nomeNormalizado).eq("numero", numero).limit(50);
    if (municipioCodigo) query = query.eq("municipio_codigo", municipioCodigo);
    const { data } = await query;
    return data ?? [];
  };
  // `numero` vem junto pro desempate por numero mais proximo em via longa
  // (achado 05/09, ver escolherPorNumeroMaisProximo em romaneio-geocode.ts).
  const buscarCnefePorRua = async (nomeNormalizado: string, municipioCodigo: string | null, numeroAlvo: number | null) => {
    // Com numero: ordena PELO NUMERO no banco (migration 074) -- rua longa
    // tem milhares de pontos e um LIMIT sem ordenacao pode nem trazer o
    // numero certo. Sem numero (S/N): amostra da rua, como antes.
    if (numeroAlvo !== null) {
      const { data } = await admin.rpc("cnefe_buscar_por_rua_numero_proximo", {
        nome: nomeNormalizado,
        numero_alvo: numeroAlvo,
        filtro_municipio_codigo: municipioCodigo,
        limite: 5,
      });
      if (data && data.length > 0) return data;
    }
    let query = admin.from("cnefe_enderecos").select("lat, lng, numero").eq("nome_normalizado", nomeNormalizado).limit(200);
    if (municipioCodigo) query = query.eq("municipio_codigo", municipioCodigo);
    const { data } = await query;
    return data ?? [];
  };
  const buscarCnefePorSimilaridade = async (nomeNormalizado: string, municipioCodigo: string | null) => {
    const { data } = await admin.rpc("cnefe_buscar_por_similaridade", { termo: nomeNormalizado, limite: 5, filtro_municipio_codigo: municipioCodigo });
    return data ?? [];
  };

  // Achado real 06/09 (KPI Rio Quality, arquivo com cidade/bairro em quase
  // toda linha -- ate' entao so' a Nutry Max usava esta ponte): resolver o
  // ponto de referencia de CIDADE e de BAIRRO gasta 1-2 chamadas Nominatim
  // (throttled a 1,1s cada, ESPERA_ENTRE_CHAMADAS_MS) por cidade/bairro
  // UNICO do lote -- mas esse ponto so' e' consultado dentro da cascata
  // quando ha' pelo menos 1 candidato (CNEFE ou OSM local) pra validar
  // contra ele (ver escolherCandidatoMaisProximo em romaneio-geocode.ts:
  // 0 candidatos nunca olha pontoCidade). Pre-checar aqui, so' no banco
  // (sem Nominatim, paralelo, barato), se ALGUM endereco mapeado pra cada
  // cidade/bairro tem candidato em qualquer uma das 3 fontes evita boa
  // parte das chamadas Nominatim quando o lote resolve quase todo via
  // CNEFE puro (caso comum: cidade grande do RJ, rua real cadastrada).
  // Sobre-aproximacao deliberada (nunca marca "nao precisa" por engano):
  // usa a consulta de rua MAIS AMPLA (sem filtro de numero) como proxy pra
  // "a etapa rua+numero tambem teria achado algo" (subconjunto), e checa
  // similaridade tambem (pega variacao de grafia que o match exato perde).
  async function precisaDePontoReferencia(enderecoBruto: string, municipioCodigo: string | null): Promise<boolean> {
    const rua = extrairRuaDoEndereco(enderecoBruto);
    const nomeNormalizado = normalizarNomeRua(rua);
    const [porRua, porSimilaridade, porLocal] = await Promise.all([
      buscarCnefePorRua(nomeNormalizado, municipioCodigo, null),
      buscarCnefePorSimilaridade(nomeNormalizado, municipioCodigo),
      buscarCandidatosPorNome(nomeNormalizado),
    ]);
    return porRua.length > 0 || porSimilaridade.length > 0 || porLocal.length > 0;
  }

  // Achado real 03/09 (grupo KPI AJUSTES, geocode de Nutry Max do dia):
  // endereco em Carmo-RJ ("RODOVIA RIO BAHIA, KM 72 - INFLUENCIA, CARMO")
  // foi geocodificado a ~90km de distancia, em Muriae-MG -- OUTRO ESTADO --
  // fonte="local" (extrato OSM). Rastreado ate aqui: quando a resolucao do
  // PONTO DE CIDADE falha (rede/rate-limit pontual do Nominatim), pontoCidade
  // fica null, e escolherCandidatoMaisProximo (romaneio-geocode.ts) aceita
  // um candidato UNICO sem NENHUMA validacao de distancia quando nao ha
  // ponto de cidade pra comparar -- comportamento ja documentado la' como
  // risco conhecido (mesma classe do caso "MANGUINHOS, ARMAÇO DOS BZIO"
  // de 12/08). Uma retentativa aqui, na resolucao do ponto de cidade,
  // cobre o caso comum (falha pontual, nao "cidade genuinamente
  // irresolvivel") sem precisar de heuristica geografica (bounding
  // box nao discrimina: Muriae-MG fica na MESMA faixa de latitude que o
  // norte do RJ, ex. Itaperuna -- nao da pra separar so' por retangulo).
  const resolverPontoComRetry = async (termo: string) => {
    const primeira = await geocodificarNominatimThrottled(termo);
    if (primeira) return primeira;
    return geocodificarNominatimThrottled(termo);
  };

  // Endereco -> municipioCodigo, calculado 1x (usado no pre-check abaixo E
  // no loop principal mais adiante).
  const cidadePorEndereco = new Map<string, string | null>(
    lista.map((e) => {
      const bruta = extrairCidadeDoEndereco(e);
      return [e, bruta ? expandirCidadeTruncada(bruta) : null];
    })
  );
  const municipioCodigoPorEndereco = new Map<string, string | null>(
    lista.map((e) => {
      const cidade = cidadePorEndereco.get(e) ?? null;
      return [e, cidade ? municipioCodigoIbge(cidade) : null];
    })
  );

  // Pre-check (achado real 06/09, KPI Rio Quality): pontoCidade/pontoBairro
  // so' e' consultado dentro da cascata quando ha' >=1 candidato CNEFE/OSM
  // pra validar contra ele (escolherCandidatoMaisProximo, romaneio-geocode.ts,
  // nunca olha o ponto quando candidatos.length===0). Descobrir isso ANTES
  // (so' Postgres, paralelo, sem Nominatim) evita gastar 1-2 chamadas
  // throttled (1,1s cada) por cidade/bairro cujos enderecos vao resolver
  // (ou falhar) so' no CNEFE/OSM, sem nunca precisar do ponto. So' pula a
  // resolucao Nominatim quando NENHUM endereco daquela cidade/bairro tem
  // candidato em NENHUMA das 3 fontes (sobre-aproximacao seguro: nunca
  // marca "nao precisa" por engano, ver precisaDePontoReferencia acima).
  const precisaPorEndereco = new Map<string, boolean>(
    await Promise.all(
      lista.map(async (e): Promise<[string, boolean]> => [e, await precisaDePontoReferencia(e, municipioCodigoPorEndereco.get(e) ?? null)])
    )
  );

  // Pontos de referencia de cidade/bairro -- mesma tecnica de
  // processar-geocode/route.ts (achado real 12/08: sem isso, rua homonima
  // em cidade/municipio errado pode passar como candidato "unico"), so'
  // que aqui SEM gravar no cache (so' le, se ja existir de um ciclo do
  // cron de producao).
  const cidadesUnicas = [...new Set(
    lista.filter((e) => precisaPorEndereco.get(e)).map((e) => cidadePorEndereco.get(e)).filter((c): c is string => c !== null)
  )];
  const bairroCidadeUnicos = [...new Set(
    lista
      .filter((e) => precisaPorEndereco.get(e))
      .map((e) => {
        const bairro = extrairBairroDoEndereco(e);
        const cidade = cidadePorEndereco.get(e) ?? null;
        return bairro && cidade ? `${bairro}|${cidade}` : null;
      })
      .filter((x): x is string => x !== null)
  )];

  // Cache de endereco -- SO' LEITURA aqui (nunca upsert, ver comentario no
  // topo do arquivo). Reaproveita o que o cron de producao ja resolveu, sem
  // nunca escrever em cima. Achado real 06/09: era 1 SELECT por chave, em
  // sequencia (cidade, depois bairro, depois cada endereco do lote
  // principal) -- puro round-trip de rede pros hits, sem nenhum throttle
  // envolvido (Nominatim so' entra na chamada QUANDO nao ha cache). Uma
  // unica leitura em lote (.in()) evita centenas de idas e vindas ao banco
  // quando o lote e' bem cacheado (cron de producao roda a cada 30s).
  const chavesCache = [
    ...cidadesUnicas.map((c) => `CIDADE:${termoBuscaCidade(c).toUpperCase()}`),
    ...bairroCidadeUnicos.map((par) => {
      const [bairro, cidade] = par.split("|");
      return `BAIRRO:${bairro.toUpperCase()}:${termoBuscaCidade(cidade).toUpperCase()}`;
    }),
    ...lista.map((e) => normalizarEndereco(e)),
  ];
  const cacheMap = new Map<string, { lat: number; lng: number; fonte: string }>();
  const TAMANHO_LOTE_CACHE = 150; // margem confortavel abaixo de qualquer teto de URL/params do PostgREST
  for (let i = 0; i < chavesCache.length; i += TAMANHO_LOTE_CACHE) {
    const lote = [...new Set(chavesCache.slice(i, i + TAMANHO_LOTE_CACHE))];
    const { data } = await admin.from("romaneio_geocode_cache").select("endereco_normalizado, lat, lng, fonte").in("endereco_normalizado", lote);
    for (const row of data ?? []) cacheMap.set(row.endereco_normalizado as string, { lat: row.lat as number, lng: row.lng as number, fonte: row.fonte as string });
  }
  const buscarCache = async (chaveNormalizada: string) => cacheMap.get(chaveNormalizada) ?? null;

  const pontosCidade = new Map<string, { lat: number; lng: number }>();
  for (const cidade of cidadesUnicas) {
    // Achado real 03/09 (ver PRAZO_MAXIMO_MS no topo): corta a resolucao
    // de referencia ANTES do loop principal de enderecos consumir todo o
    // prazo -- cidade sem ponto de referencia ainda geocodifica (so' sem
    // a checagem de distancia, comportamento ja existente), nao trava a
    // resposta inteira.
    if (prazoEsgotado()) break;
    // termoBuscaCidade acrescenta ", RJ, Brasil" quando a cidade e' do RJ
    // -- a rota processar-geocode ja fazia assim; esta (a ponte do KPI)
    // consultava so' o nome cru, o que joga o Nominatim pra cidade homonima
    // de outro estado (achado 05/09).
    const termoCidade = termoBuscaCidade(cidade);
    const chaveCidade = `CIDADE:${termoCidade.toUpperCase()}`;
    const doCache = await buscarCache(chaveCidade);
    if (doCache) {
      pontosCidade.set(cidade, { lat: doCache.lat, lng: doCache.lng });
      continue;
    }
    const ponto = await resolverPontoComRetry(termoCidade);
    if (ponto) pontosCidade.set(cidade, ponto);
  }

  const pontosBairro = new Map<string, { lat: number; lng: number }>();
  for (const chave of bairroCidadeUnicos) {
    if (prazoEsgotado()) break;
    const [bairro, cidade] = chave.split("|");
    const termoBairro = `${bairro}, ${termoBuscaCidade(cidade)}`;
    const chaveCache = `BAIRRO:${bairro.toUpperCase()}:${termoBuscaCidade(cidade).toUpperCase()}`;
    const doCache = await buscarCache(chaveCache);
    if (doCache) {
      pontosBairro.set(chave, { lat: doCache.lat, lng: doCache.lng });
      continue;
    }
    // Mesma retentativa do ponto de cidade acima -- mesmo risco (falha
    // transitoria vira "sem ponto de referencia", que por sua vez vira
    // "candidato unico aceito sem checagem" em escolherCandidatoMaisProximo).
    const ponto = await resolverPontoComRetry(termoBairro);
    if (ponto) pontosBairro.set(chave, ponto);
  }

  // Achado real 03/09 (ver PRAZO_MAXIMO_MS no topo): resposta PARCIAL
  // (array mais curto que `lista`) em vez de arriscar a chamada inteira
  // estourar o timeout do chamador e perder TODOS os resultados ja
  // calculados. O lado do KPI (geocode.ts la) ja e' defensivo pra isso --
  // mapeia por indice contra a lista original e preenche null pro que
  // faltar, nunca assume o mesmo tamanho de volta. Enderecos nao
  // alcancados aqui ficam null nesta chamada, mas nao sao perdidos pra
  // sempre: a proxima geracao/regeracao tenta de novo.
  const resultados: ({ lat: number; lng: number } | null)[] = [];
  for (const enderecoBruto of lista) {
    if (prazoEsgotado()) break;
    const cidade = cidadePorEndereco.get(enderecoBruto) ?? null;
    const bairro = extrairBairroDoEndereco(enderecoBruto);
    const chaveBairro = bairro && cidade ? `${bairro}|${cidade}` : null;
    // Ponto do bairro so' vale se estiver DENTRO da cidade -- ver
    // escolherPontoReferencia (achado 05/09: "CENTRO, CAMBUCI" resolvia em
    // Sao Paulo capital e derrubava o endereco certo pelo teto de 30km;
    // achado 06/09: Rio capital ganha teto maior la' dentro, municipio
    // gigante onde bairro correto pode ficar bem mais longe do "centro").
    const municipioCodigo = municipioCodigoPorEndereco.get(enderecoBruto) ?? null;
    const pontoReferencia = escolherPontoReferencia(
      (chaveBairro && pontosBairro.get(chaveBairro)) || null,
      (cidade ? pontosCidade.get(cidade) : null) || null,
      municipioCodigo,
    );

    const geocode = await geocodificarEndereco(enderecoBruto, pontoReferencia, {
      buscarCache,
      salvarCache: salvarCacheNoop,
      geocodificarCnefeDep: (endereco, ponto) => geocodificarCnefe(endereco, ponto, municipioCodigo, {
        buscarPorRuaNumero: buscarCnefePorRuaNumero,
        buscarPorRua: buscarCnefePorRua,
        buscarPorSimilaridade: buscarCnefePorSimilaridade,
      }),
      geocodificarLocalDep: (endereco, ponto) => geocodificarLocal(endereco, ponto, buscarCandidatosPorNome),
      geocodificarGoogle,
      geocodificarNominatim: geocodificarNominatimThrottled,
    });

    resultados.push(geocode ? { lat: geocode.lat, lng: geocode.lng } : null);
  }

  return Response.json({ resultados });
}
