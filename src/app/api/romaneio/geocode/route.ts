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
import { geocodificarEndereco, geocodificarLocal, geocodificarCnefe, geocodificarCnefePorBairro, geocodificarGoogle, geocodificarNominatim, consultarPhoton, consultarNominatim, criarContadorErrosExternos, normalizarEndereco } from "@/lib/romaneio-geocode";
import { extrairCidadeDoEndereco, expandirCidadeTruncada, extrairBairroDoEndereco, municipioCodigoIbge, extrairRuaDoEndereco, normalizarNomeRua, extrairNumeroDoEndereco } from "@/lib/romaneio-geocode-local";
import { validarTerritorio, cepConfirmaPonto, type MotivoTerritorio } from "@/lib/territorio";
import { extrairCepDoEndereco } from "@/lib/cnefe-escolha";
import { montarDepsTerritorio } from "./territorio-deps";
import { criarReferencias, chaveCidade, chaveBairro } from "@/lib/referencia-cidade";
import { buscarSimilaridadeLimitada } from "@/lib/cnefe-similaridade-limitada";
import { buscarCentroideBairro } from "@/lib/cnefe-bairro-centroide";

// Teto de pontos da rua lidos do CNEFE (avenida longa do Rio passa de mil).
const LIMITE_PONTOS_RUA_CNEFE = 4000;

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

  // Guarda territorial: OPT-IN. Rio Quality, Porte Frio e o motor de desvio
  // usam esta mesma rota e nao podem mudar de comportamento -- so' a geracao
  // do Nutry Max liga. Ver a secao "Nao-objetivos" da spec de 12/09.
  const validarTerritorioLigado = (body as { validarTerritorio?: unknown })?.validarTerritorio === true;
  // Incidente 01/10 (ver src/lib/cnefe-similaridade-limitada.ts): o KPI liga
  // isto quando a geracao ja' passou do teto de buscas por similaridade --
  // o passo e' pulado e os enderecos afetados voltam em `incompletos`.
  const semSimilaridade = (body as { semSimilaridade?: unknown })?.semSimilaridade === true;

  const lista = enderecos as string[];
  const admin = createAdminClient();
  const inicioRequisicao = Date.now();
  const prazoEsgotado = () => Date.now() - inicioRequisicao > PRAZO_MAXIMO_MS;

  const salvarCacheNoop = async (): Promise<void> => {};

  const geocodificarNominatimThrottled = async (enderecoBruto: string) => {
    await esperar(ESPERA_ENTRE_CHAMADAS_MS);
    return geocodificarNominatim(enderecoBruto);
  };

  // GEO3-05: na cascata, Photon e Nominatim respondem com status -- falha de
  // rede (timeout/429/5xx) manda o endereco em `incompletos`.
  const consultarPhotonThrottled = async (enderecoBruto: string, pontoCidade?: { lat: number; lng: number } | null) => {
    await esperar(ESPERA_ENTRE_CHAMADAS_MS);
    return consultarPhoton(enderecoBruto, pontoCidade ?? null);
  };
  const consultarNominatimThrottled = async (enderecoBruto: string) => {
    await esperar(ESPERA_ENTRE_CHAMADAS_MS);
    return consultarNominatim(enderecoBruto);
  };
  const errosRede = criarContadorErrosExternos();

  const buscarCandidatosPorNome = async (nomeNormalizado: string) => {
    const { data } = await admin.from("vias_nomes").select("lat, lng").eq("nome_sem_conectores", nomeNormalizado);
    return data ?? [];
  };
  const buscarCnefePorRuaNumero = async (nomeNormalizado: string, numero: string, municipioCodigo: string | null) => {
    // cep/localidade: escolha por CEP/bairro do Censo (auditoria 20/10, cnefe-escolha.ts).
    let query = admin.from("cnefe_enderecos").select("lat, lng, numero, cep, localidade, tipo:logradouro_tipo").eq("nome_normalizado", nomeNormalizado).eq("numero", numero).order("id").limit(50);
    if (municipioCodigo) query = query.eq("municipio_codigo", municipioCodigo);
    const { data } = await query;
    return data ?? [];
  };
  // `numero` vem junto pro desempate por numero mais proximo em via longa
  // (achado 05/09, ver escolherPorNumeroMaisProximo em romaneio-geocode.ts).
  const buscarCnefePorRua = async (nomeNormalizado: string, municipioCodigo: string | null, numeroAlvo: number | null, cep: string | null = null) => {
    // Auditoria 20/10 (GEO-07): rua no municipio ordenada por id
    // (deterministico), com cep/localidade -- antes era o top 5 por numero
    // (sem CEP) ou uma amostra de 200 SEM ORDER BY (S/N virava sorteio, ex.
    // RUA UM em Caxias: 200 de 1.123 pontos em 16 CEPs). Rua com mais pontos
    // que o teto (Estr. dos Bandeirantes 11 mil): junta o trecho do CEP do
    // endereco e os 5 numeros mais proximos (migration 074) pra nao perder o
    // trecho certo.
    type Linha = { lat: number; lng: number; numero?: string | null; cep?: string | null; localidade?: string | null; tipo?: string | null };
    let rua = admin.from("cnefe_enderecos").select("lat, lng, numero, cep, localidade, tipo:logradouro_tipo").eq("nome_normalizado", nomeNormalizado);
    if (municipioCodigo) rua = rua.eq("municipio_codigo", municipioCodigo);
    const consultas: PromiseLike<{ data: unknown }>[] = [rua.order("id").limit(LIMITE_PONTOS_RUA_CNEFE)];
    if (cep) {
      let doCep = admin.from("cnefe_enderecos").select("lat, lng, numero, cep, localidade, tipo:logradouro_tipo").eq("nome_normalizado", nomeNormalizado).eq("cep", cep);
      if (municipioCodigo) doCep = doCep.eq("municipio_codigo", municipioCodigo);
      consultas.push(doCep.order("id").limit(LIMITE_PONTOS_RUA_CNEFE));
    }
    if (numeroAlvo !== null) consultas.push(admin.rpc("cnefe_buscar_por_rua_numero_proximo", { nome: nomeNormalizado, numero_alvo: numeroAlvo, filtro_municipio_codigo: municipioCodigo, limite: 5 }));
    const respostas = await Promise.all(consultas);
    return respostas.flatMap((r) => (Array.isArray(r.data) ? (r.data as Linha[]) : []));
  };
  // Incidente 01/10: semaforo GLOBAL do processo (2 simultaneas, somando
  // todas as requisicoes/geracoes em andamento) + timeout por busca. Timeout
  // ou passo pulado = "nao achado nesse passo" pra cascata (lista vazia, a
  // logica de match nao muda), mas o endereco vai em `incompletos` pra o KPI
  // nao gravar cache negativo de algo que nao foi tentado por inteiro.
  let buscasSimilaridade = 0;
  const buscarCnefePorSimilaridadeLimitada = async (nomeNormalizado: string, municipioCodigo: string | null) => {
    const r = await buscarSimilaridadeLimitada<{ lat: number; lng: number }>(
      async (sinal) => {
        buscasSimilaridade++;
        const { data } = await admin
          .rpc("cnefe_buscar_por_similaridade", { termo: nomeNormalizado, limite: 5, filtro_municipio_codigo: municipioCodigo })
          .abortSignal(sinal);
        return data ?? [];
      },
      { pular: semSimilaridade, rotulo: nomeNormalizado },
    );
    return r;
  };
  // Achado real 08/09 (ver geocodificarCnefePorBairro em romaneio-geocode.ts):
  // ultimo recurso antes de sair pra rede -- centroide dos pontos do CNEFE
  // da localidade do bairro do endereco. F4-01 (GEO-26): por igualdade na
  // tabela cnefe_bairros_centroide (migration 091), com prazo; sem a
  // migration, a consulta antiga (ILIKE de 50 s), agora com prazo. Ver
  // src/lib/cnefe-bairro-centroide.ts. A busca por endereco fica no loop
  // (marca o endereco como incompleto quando o prazo estoura).

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
  // GEO3-03 (03/11): desde entao so' decide se o BAIRRO fora do cache vai ao
  // Nominatim; a cidade entra sempre (o Photon tambem usa a referencia).
  async function precisaDePontoReferencia(enderecoBruto: string, municipioCodigo: string | null): Promise<boolean> {
    const rua = extrairRuaDoEndereco(enderecoBruto);
    const nomeNormalizado = normalizarNomeRua(rua);
    const [porRua, porLocal] = await Promise.all([
      buscarCnefePorRua(nomeNormalizado, municipioCodigo, null),
      buscarCandidatosPorNome(nomeNormalizado),
    ]);
    if (porRua.length > 0 || porLocal.length > 0) return true;
    // Similaridade so' quando as consultas exatas (baratas) nao bastaram --
    // mesmo resultado booleano, sem gastar a busca pesada a toa. Timeout ou
    // passo pulado: assume que precisa (mesma sobre-aproximacao segura).
    const porSimilaridade = await buscarCnefePorSimilaridadeLimitada(nomeNormalizado, municipioCodigo);
    return porSimilaridade.status !== "ok" || porSimilaridade.data.length > 0;
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

  // Cache de endereco + pontos de referencia -- SO' LEITURA aqui (nunca
  // upsert, ver comentario no topo do arquivo). Uma unica leitura em lote
  // (.in()), achado 06/09: era 1 SELECT por chave, em sequencia.
  // GEO3-03 (auditoria 03/11): a referencia da cidade entra para TODO
  // endereco, sempre do cache. Antes so' entrava quando o pre-check achava
  // candidato CNEFE/OSM -- mas o Photon tambem usa a referencia (sem ela,
  // a primeira rua homonima do pais: Paraty -> PE). O pre-check fica so'
  // para gastar Nominatim com BAIRRO que nao esta no cache.
  const chavesCache = [
    ...lista.flatMap((e) => {
      const cidade = cidadePorEndereco.get(e) ?? null;
      if (!cidade) return [];
      const bairro = extrairBairroDoEndereco(e);
      return bairro ? [chaveCidade(cidade), chaveBairro(bairro, cidade)] : [chaveCidade(cidade)];
    }),
    ...lista.map((e) => normalizarEndereco(e)),
  ];
  const cacheMap = new Map<string, { lat: number; lng: number; fonte: string; validado: boolean }>();
  const TAMANHO_LOTE_CACHE = 150; // margem confortavel abaixo de qualquer teto de URL/params do PostgREST
  for (let i = 0; i < chavesCache.length; i += TAMANHO_LOTE_CACHE) {
    const lote = [...new Set(chavesCache.slice(i, i + TAMANHO_LOTE_CACHE))];
    const { data } = await admin.from("romaneio_geocode_cache").select("endereco_normalizado, lat, lng, fonte, validado").in("endereco_normalizado", lote);
    for (const row of data ?? []) cacheMap.set(row.endereco_normalizado as string, { lat: row.lat as number, lng: row.lng as number, fonte: row.fonte as string, validado: (row as { validado?: boolean }).validado ?? true });
  }
  const buscarCache = async (chaveNormalizada: string) => cacheMap.get(chaveNormalizada) ?? null;

  // Referencia fora do cache: Nominatim com retentativa, cortado pelo prazo
  // (achado 03/09) -- cidade sempre (sao 92 no RJ, quase todas no cache);
  // bairro so' quando o pre-check acha que o CNEFE/OSM vai precisar.
  const depsTerritorio = montarDepsTerritorio(admin);
  const referencias = criarReferencias({
    lerCacheEmLote: async (chaves) => new Map(chaves.flatMap((k) => {
      const c = cacheMap.get(k);
      return c ? [[k, { lat: c.lat, lng: c.lng }] as const] : [];
    })),
    resolverExterno: resolverPontoComRetry,
    prazoEsgotado,
    // GEO3-04: referencia fora do municipio esperado nao vira regua.
    municipioDaCoordenada: depsTerritorio.municipioDaCoordenada,
  });
  await referencias.carregar(lista, { resolverBairroExterno: (e) => precisaPorEndereco.get(e) ?? false });

  // Achado real 03/09 (ver PRAZO_MAXIMO_MS no topo): resposta PARCIAL
  // (array mais curto que `lista`) em vez de arriscar a chamada inteira
  // estourar o timeout do chamador e perder TODOS os resultados ja
  // calculados. O lado do KPI (geocode.ts la) ja e' defensivo pra isso --
  // mapeia por indice contra a lista original e preenche null pro que
  // faltar, nunca assume o mesmo tamanho de volta. Enderecos nao
  // alcancados aqui ficam null nesta chamada, mas nao sao perdidos pra
  // sempre: a proxima geracao/regeracao tenta de novo.
  // Achado real 11-12/09 (auditoria KPI Nutry Max): `fonte` e `validado`
  // passam a viajar junto com a coordenada. Sem isso o KPI nao tinha como
  // distinguir match exato de rua de um chute de bairro (ou de uma rua
  // homonima em outro municipio, aceita sem validacao de cidade) -- e
  // tratava os dois como verdade, gerando "carga transferida" falsa e
  // "nao foi ao cliente" em cima de ponto errado. Campos ADITIVOS: chamador
  // antigo que so' le lat/lng continua funcionando igual.
  const resultados: ({ lat: number; lng: number; fonte: string; validado: boolean; motivo?: MotivoTerritorio } | null)[] = [];
  const incompletos: number[] = [];
  // Subconjunto de `incompletos` por falha de rede (campo aditivo: KPI antigo ignora).
  const incompletosRede: number[] = [];
  for (const enderecoBruto of lista) {
    if (prazoEsgotado()) break;
    let similaridadeIncompleta = false;
    let bairroIncompleto = false;
    let redeFalhou = false;
    const buscarCnefePorLocalidade = async (bairroBusca: string, municipioBusca: string) => {
      const r = await buscarCentroideBairro(admin, bairroBusca, municipioBusca);
      if (r.status !== "ok") {
        bairroIncompleto = true;
        return null;
      }
      return r.data;
    };
    const buscarCnefePorSimilaridade = async (nomeNormalizado: string, municipioCodigo: string | null) => {
      const r = await buscarCnefePorSimilaridadeLimitada(nomeNormalizado, municipioCodigo);
      if (r.status !== "ok") {
        similaridadeIncompleta = true;
        return [];
      }
      return r.data;
    };
    const bairro = extrairBairroDoEndereco(enderecoBruto);
    const municipioCodigo = municipioCodigoPorEndereco.get(enderecoBruto) ?? null;
    // Ponto do bairro so' vale DENTRO da cidade (escolherPontoReferencia).
    const referencia = referencias.referenciaDaCidade(cidadePorEndereco.get(enderecoBruto) ?? null, bairro);
    const pontoReferencia = referencia?.ponto ?? null;
    const precisaoBairro = referencia?.precisao === "bairro";

    const geocode = await geocodificarEndereco(enderecoBruto, pontoReferencia, {
      buscarCache,
      salvarCache: salvarCacheNoop,
      geocodificarCnefeDep: (endereco, ponto) => geocodificarCnefe(endereco, ponto, municipioCodigo, {
        buscarPorRuaNumero: buscarCnefePorRuaNumero,
        buscarPorRua: buscarCnefePorRua,
        buscarPorSimilaridade: buscarCnefePorSimilaridade,
      }, precisaoBairro),
      geocodificarLocalDep: (endereco, ponto) => geocodificarLocal(endereco, ponto, buscarCandidatosPorNome, precisaoBairro),
      geocodificarCnefeBairroDep: (endereco) => geocodificarCnefePorBairro(endereco, municipioCodigo, buscarCnefePorLocalidade),
      geocodificarGoogle,
      geocodificarPhoton: consultarPhotonThrottled,
      geocodificarNominatim: consultarNominatimThrottled,
      aoErroExterno: (provedor, motivo) => { redeFalhou = true; errosRede.registrar(provedor, motivo); },
    });

    if (!geocode) {
      if (similaridadeIncompleta || bairroIncompleto || redeFalhou) incompletos.push(resultados.length);
      if (redeFalhou) incompletosRede.push(resultados.length);
      resultados.push(null);
      continue;
    }
    let validado = geocode.validado;
    let motivo: MotivoTerritorio | undefined;
    if (validarTerritorioLigado) {
      // F4-05 (GEO-14): ponto CNEFE exato com o numero e o CEP especifico do
      // romaneio batendo (<= 300 m) nao reprova por bairro. Consulta so' quando
      // o bairro ia reprovar (ver validarTerritorio).
      const numeroRomaneio = extrairNumeroDoEndereco(enderecoBruto);
      const cepRomaneio = extrairCepDoEndereco(enderecoBruto);
      const ponto = { lat: geocode.lat, lng: geocode.lng };
      const confirmacaoCep = geocode.fonte === "cnefe" && geocode.precisao === "exato" && numeroRomaneio && cepRomaneio
        ? async () => cepConfirmaPonto(
          ponto,
          await buscarCnefePorRuaNumero(normalizarNomeRua(extrairRuaDoEndereco(enderecoBruto)), numeroRomaneio, municipioCodigo),
          { numero: numeroRomaneio, cep: cepRomaneio },
        )
        : undefined;
      const t = await validarTerritorio(
        ponto,
        { municipioCodigo, bairro },
        depsTerritorio,
        confirmacaoCep,
      );
      if (!t.ok) {
        validado = false;
        motivo = t.motivo;
      }
    }
    resultados.push({ lat: geocode.lat, lng: geocode.lng, fonte: geocode.fonte, validado, motivo, ...(geocode.precisao ? { precisao: geocode.precisao, raioM: geocode.raioM } : {}) });
  }

  errosRede.logar(`ponte KPI, ${lista.length} endereco(s)`);
  return Response.json({ resultados, incompletos, incompletosRede, buscasSimilaridade });
}
