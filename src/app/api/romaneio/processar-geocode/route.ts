import { createAdminClient } from "@/lib/supabase/admin";
import { geocodificarEndereco, geocodificarLocal, geocodificarCnefe, geocodificarGoogle, geocodificarNominatim, normalizarEndereco } from "@/lib/romaneio-geocode";
import { extrairCidadeDoEndereco, expandirCidadeTruncada, extrairBairroDoEndereco, municipioCodigoIbge, termoBuscaCidade } from "@/lib/romaneio-geocode-local";
import { buscarAlvos, deveCorrigirComRomaneio } from "@/lib/unitrac";

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

// Item 5 da blindagem de geocodificacao (27/08) -- ver migration
// contabo/061 pro racional completo. Resumo: a fase de fallback Unitrac (no
// fim deste arquivo) roda a cada 30s sobre TODOS os 'falhou' historicos e
// nunca desistia -- as 397 linhas 'falhou' de hoje eram consultadas e
// descartadas 2.880 vezes por dia, pra sempre, e ainda ocupavam o orcamento
// de 30 linhas por ciclo que uma falha NOVA (com chance real de resolver)
// precisaria.
//
// 10 tentativas: teto do intervalo proposto no plano (5-10). O custo de
// tentar de novo e' baixo (a linha entra numa consulta que ja acontece de
// qualquer jeito) e o custo de desistir cedo demais e' alto -- e' uma
// entrega ficando sem coordenada, e o produto e' deteccao de desvio de
// rota.
const MAX_TENTATIVAS_FALLBACK_UNITRAC = 10;
// Espacamento minimo entre tentativas da MESMA linha. Sem isso o contador
// seria inutil: com a fila curta, todas as linhas sao tentadas a cada ciclo
// de 30s e as 10 tentativas se esgotariam em 5 MINUTOS -- antes de a
// entrega do dia acontecer, que e' justamente quando o alvo da Unitrac
// aparece. 30 min x 10 tentativas cobre ~5 horas, uma janela que abrange o
// dia de entrega.
const ESPERA_ENTRE_RETENTATIVAS_MIN = 30;
// Estado TERMINAL: nao inventa coordenada, so' para de retentar sozinho.
// Dai pra frente e' revisao manual.
const STATUS_SEM_COORDENADA = "sem_coordenada_confirmada";

function esperar(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function hojeSP(): string {
  return new Intl.DateTimeFormat("en-CA", { timeZone: "America/Sao_Paulo" }).format(new Date());
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
    .select("id, endereco_bruto, veiculo_id, placa, nf, cliente_codigo, romaneio_data")
    .or(`geocode_status.eq.pendente,and(geocode_status.eq.processando,geocode_reivindicado_em.lt.${expiraAntesDe})`)
    .order("criado_em", { ascending: true })
    .limit(LOTE_POR_INVOCACAO);

  if (erroCandidatos) {
    console.error(`Erro ao buscar romaneio_pontos pendentes: ${erroCandidatos.message}`);
  }

  // Achado real 31/07: este `if` costumava dar `return` direto aqui quando
  // nao havia nada pendente -- o caso NORMAL do dia a dia, uma vez que o
  // lote inicial de um romaneio ja foi processado. Isso deixava a fase de
  // fallback Unitrac (mais abaixo) INALCANCAVEL na pratica -- o cron roda
  // toda vez sem nada pendente, sempre retornava antes de chegar la. Agora
  // so pula o processamento principal (pendentes = []), sem `return`, pra
  // sempre chegar no fallback.
  let pendentes: { id: string; endereco_bruto: string; veiculo_id: string | null; placa: string; nf: string; cliente_codigo: string | null; romaneio_data: string }[] = [];

  if (candidatos && candidatos.length > 0) {
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
    const { data: reivindicados, error: erroReivindicar } = await admin
      .from("romaneio_pontos")
      .update({ geocode_status: "processando", geocode_reivindicado_em: new Date().toISOString() })
      .in("id", idsCandidatos)
      .or(`geocode_status.eq.pendente,and(geocode_status.eq.processando,geocode_reivindicado_em.lt.${expiraAntesDe})`)
      .select("id, endereco_bruto, veiculo_id, placa, nf, cliente_codigo, romaneio_data");

    if (erroReivindicar) {
      console.error(`Erro ao reivindicar romaneio_pontos: ${erroReivindicar.message}`);
    } else if (reivindicados) {
      pendentes = reivindicados;
    }
  }

  // Cache por (cliente_id, cliente_codigo, endereco_chave) -- migration 052,
  // rechaveado pela 069. Politica write-once: le antes de geocodificar (se
  // ja tem ancora, usa direto, pula a cascata de texto inteira), grava so'
  // na PRIMEIRA vez que um endereco daquele codigo resolve com sucesso
  // (nunca sobrescreve sozinha depois, ver comentario da migration).
  // Precisa do cliente_id por linha ANTES do loop principal -- veiculo->
  // cliente_id so' era resolvido mais abaixo, no bloco de fallback Unitrac,
  // tarde demais pra decidir aqui.
  //
  // endereco_chave entrou na chave em 31/08 (migration 069): a chave antiga
  // (so' cliente_codigo) assumia "1 codigo = 1 lugar", falso no dado real --
  // SODEXO (codigo 138748) entrega em 25 enderecos distintos do estado
  // inteiro, NUTRIMED (139450) em 9 hospitais. Todos liam a MESMA ancora,
  // e cada parada real em endereco diferente entrava na mesma media
  // ponderada do lado da escrita (confirmar-presenca-romaneio.mjs),
  // produzindo centroide a ~60km de qualquer endereco real. Mesma
  // normalizacao de romaneio_geocode_cache (normalizarEndereco).
  const veiculoIdsPendentes = [...new Set(pendentes.map((l) => l.veiculo_id).filter((v): v is string => !!v))];
  const clientePorVeiculoAntecipado = new Map<string, string>();
  if (veiculoIdsPendentes.length > 0) {
    const { data: veiculosPendentes } = await admin.from("veiculos").select("id, cliente_id").in("id", veiculoIdsPendentes);
    for (const v of veiculosPendentes ?? []) clientePorVeiculoAntecipado.set(v.id, v.cliente_id);
  }
  const buscarCacheClienteCodigo = async (clienteId: string, clienteCodigo: string, enderecoChave: string) => {
    const { data } = await admin
      .from("romaneio_cliente_codigo_geocode")
      .select("lat, lng, fonte")
      .eq("cliente_id", clienteId)
      .eq("cliente_codigo", clienteCodigo)
      .eq("endereco_chave", enderecoChave)
      .maybeSingle();
    return data ?? null;
  };
  const salvarCacheClienteCodigoSeNovo = async (clienteId: string, clienteCodigo: string, enderecoChave: string, r: { lat: number; lng: number; fonte: string }) => {
    // ON CONFLICT DO NOTHING (nao upsert de verdade) -- write-once de
    // proposito, ver migration 052. upsert() com ignoreDuplicates:true e'
    // o equivalente do supabase-js pra isso (insert() simples nao aceita
    // onConflict, so' upsert aceita).
    await admin.from("romaneio_cliente_codigo_geocode").upsert(
      {
        cliente_id: clienteId,
        cliente_codigo: clienteCodigo,
        endereco_chave: enderecoChave,
        lat: r.lat,
        lng: r.lng,
        fonte: r.fonte,
        n_observacoes: 1,
        primeira_observacao: hojeSP(),
        ultima_observacao: hojeSP(),
      },
      { onConflict: "cliente_id,cliente_codigo,endereco_chave", ignoreDuplicates: true }
    );
  };

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
  // termoBuscaCidade (achado real 27/08, item 3 da blindagem): o nome
  // PELADO ia pro Nominatim e nome de municipio se repete pelo Brasil
  // inteiro -- o cache de producao tinha CIDADE:NATIVIDADE apontando pra
  // Natividade/TO (~1500km), CIDADE:VALENÇA pra Valença/BA, CIDADE:MESQUITA
  // pra Mesquita/MG, e mais uma duzia iguais, todos EM USO como regua de
  // validacao de distancia dos outros enderecos. Municipio reconhecido do
  // RJ agora vai qualificado com ", RJ, Brasil". O termo qualificado e'
  // tambem a CHAVE de cache, entao as entradas envenenadas antigas
  // simplesmente deixam de ser lidas -- sem precisar apagar nada do banco.
  const pontosCidade = new Map<string, { lat: number; lng: number }>();
  for (const cidade of cidadesUnicas) {
    const termoCidade = termoBuscaCidade(cidade);
    const chaveCidade = `CIDADE:${termoCidade.toUpperCase()}`;
    const doCache = await buscarCache(chaveCidade);
    if (doCache) {
      pontosCidade.set(cidade, { lat: doCache.lat, lng: doCache.lng });
      continue;
    }
    const ponto = await geocodificarNominatimThrottled(termoCidade);
    if (ponto) {
      await salvarCache(chaveCidade, { ...ponto, fonte: "nominatim" });
      pontosCidade.set(cidade, ponto);
    }
  }

  // Achado real 12/08 (romaneio de hoje, casos SEPETIBA/CAMPOS): o ponto de
  // cidade acima e' bom pra pegar cidade ERRADA (ex. rua homonima em outro
  // estado), mas Rio de Janeiro (cidade) e' grande demais pra discriminar
  // bairro errado DENTRO da cidade certa -- rua comprida sem numero exato
  // no CNEFE caia no candidato mais proximo do centro da CIDADE, nao do
  // bairro real do endereco, as vezes dezenas de km errado mesmo "dentro"
  // do teto de 30km (DISTANCIA_MAX_MATCH_LOCAL_M em romaneio-geocode.ts).
  // extrairBairroDoEndereco ja existia (usado so pra montar o texto do
  // Nominatim) -- agora tambem resolve um ponto de referencia mais
  // apertado (bairro+cidade), mesmo padrao de cache/throttle do ponto de
  // cidade, chave "BAIRRO:<bairro>:<cidade>" pra nao colidir. Quando falha
  // (bairro raro sem match no Nominatim) cai pro ponto de cidade, nunca
  // bloqueia a geocodificacao.
  const bairroCidadeUnicos = [...new Set(
    pendentes
      .map((l) => {
        const bairro = extrairBairroDoEndereco(l.endereco_bruto);
        const cidadeBruta = extrairCidadeDoEndereco(l.endereco_bruto);
        const cidade = cidadeBruta ? expandirCidadeTruncada(cidadeBruta) : null;
        return bairro && cidade ? `${bairro}|${cidade}` : null;
      })
      .filter((x): x is string => x !== null)
  )];
  const pontosBairro = new Map<string, { lat: number; lng: number }>();
  for (const chave of bairroCidadeUnicos) {
    const [bairro, cidade] = chave.split("|");
    // Mesma qualificacao de estado do ponto de cidade acima -- "Centro,
    // Natividade" sozinho tem a mesma ambiguidade nacional.
    const termoBairro = `${bairro}, ${termoBuscaCidade(cidade)}`;
    const chaveCache = `BAIRRO:${bairro.toUpperCase()}:${termoBuscaCidade(cidade).toUpperCase()}`;
    const doCache = await buscarCache(chaveCache);
    if (doCache) {
      pontosBairro.set(chave, { lat: doCache.lat, lng: doCache.lng });
      continue;
    }
    const ponto = await geocodificarNominatimThrottled(termoBairro);
    if (ponto) {
      await salvarCache(chaveCache, { ...ponto, fonte: "nominatim" });
      pontosBairro.set(chave, ponto);
    }
  }

  // nome_sem_conectores (nao nome_normalizado direto): achado real 31/07,
  // conectores (de/da/do) aparecem de forma inconsistente entre o romaneio
  // e o OSM nos dois sentidos -- coluna gerada (migration 021) remove dos
  // dois lados pra bater independente de qual fonte inclui o conector.
  // normalizarNomeRua ja aplica a mesma remocao no termo de busca.
  const buscarCandidatosPorNome = async (nomeNormalizado: string) => {
    const { data } = await admin.from("vias_nomes").select("lat, lng").eq("nome_sem_conectores", nomeNormalizado);
    return data ?? [];
  };

  // CNEFE (IBGE, Censo 2022) -- achado real 31/07, ver migration
  // contabo/022_cnefe_enderecos.sql. Roda ANTES do match OSM
  // (buscarCandidatosPorNome acima) na cadeia de geocodificarEndereco --
  // endereco+coordenada real de campo, mais preciso que nome de rua + ponto
  // medio do trecho.
  // municipioCodigo (achado real 12/08 -- ver
  // docs/superpowers/specs/2026-08-12-precisao-geocodificacao-romaneio-design.md):
  // filtro RIGIDO na query, nao so proximidade depois -- rua homonima em
  // municipio errado (ex. "Avenida Liberdade" em Sao Joao da Barra E no
  // Rio, ~270km de distancia) nao aparece nem como candidato quando o
  // municipio nao bate.
  const buscarCnefePorRuaNumero = async (nomeNormalizado: string, numero: string, municipioCodigo: string | null) => {
    let query = admin.from("cnefe_enderecos").select("lat, lng").eq("nome_normalizado", nomeNormalizado).eq("numero", numero).limit(50);
    if (municipioCodigo) query = query.eq("municipio_codigo", municipioCodigo);
    const { data } = await query;
    return data ?? [];
  };
  const buscarCnefePorRua = async (nomeNormalizado: string, municipioCodigo: string | null) => {
    let query = admin.from("cnefe_enderecos").select("lat, lng").eq("nome_normalizado", nomeNormalizado).limit(200);
    if (municipioCodigo) query = query.eq("municipio_codigo", municipioCodigo);
    const { data } = await query;
    return data ?? [];
  };
  // pg_trgm -- pega variacao tipo abreviacao ("FRANCISCO" vs "F.") que nem
  // o match exato da rua resolve. RPC (nao dá pra fazer ORDER BY
  // similarity() pelo query builder do Supabase-js). filtro_municipio_codigo
  // -- migration contabo/045.
  const buscarCnefePorSimilaridade = async (nomeNormalizado: string, municipioCodigo: string | null) => {
    const { data } = await admin.rpc("cnefe_buscar_por_similaridade", { termo: nomeNormalizado, limite: 5, filtro_municipio_codigo: municipioCodigo });
    return data ?? [];
  };

  let ok = 0;
  let falhou = 0;
  const geocodificadosOk: { id: string; veiculo_id: string | null; placa: string; nf: string; lat: number; lng: number; fonte: "google" | "nominatim" | "local" | "cnefe"; romaneio_data: string }[] = [];

  let doCacheClienteCodigo = 0;

  for (const linha of pendentes) {
    // Cache por (cliente_codigo, endereco) primeiro (migrations 052/069) --
    // se esse codigo ja resolveu ESTE endereco com sucesso em outro dia,
    // usa a ancora direto e pula a cascata de texto inteira (mais rapido e
    // mais estavel: elimina a variacao de 1-2 coordenadas pro MESMO cliente
    // que a analise de 16/08 achou). So aplica quando o codigo existe e o
    // veiculo tem cliente_id resolvido -- sem isso cai pra cascata normal,
    // igual antes.
    const clienteIdLinha = linha.veiculo_id ? clientePorVeiculoAntecipado.get(linha.veiculo_id) : null;
    const enderecoChaveLinha = normalizarEndereco(linha.endereco_bruto);
    let geocode: { lat: number; lng: number; fonte: string } | null = null;
    let viaCacheClienteCodigo = false;

    if (clienteIdLinha && linha.cliente_codigo) {
      const ancora = await buscarCacheClienteCodigo(clienteIdLinha, linha.cliente_codigo, enderecoChaveLinha);
      if (ancora) {
        geocode = { lat: ancora.lat, lng: ancora.lng, fonte: ancora.fonte };
        viaCacheClienteCodigo = true;
        doCacheClienteCodigo++;
      }
    }

    if (!geocode) {
      const cidadeBruta = extrairCidadeDoEndereco(linha.endereco_bruto);
      const cidade = cidadeBruta ? expandirCidadeTruncada(cidadeBruta) : null;
      const bairro = extrairBairroDoEndereco(linha.endereco_bruto);
      const chaveBairro = bairro && cidade ? `${bairro}|${cidade}` : null;
      const pontoReferencia = (chaveBairro && pontosBairro.get(chaveBairro)) || (cidade ? pontosCidade.get(cidade) : null) || null;
      const municipioCodigo = cidade ? municipioCodigoIbge(cidade) : null;

      geocode = await geocodificarEndereco(linha.endereco_bruto, pontoReferencia, {
        buscarCache,
        salvarCache,
        geocodificarCnefeDep: (endereco, ponto) => geocodificarCnefe(endereco, ponto, municipioCodigo, {
          buscarPorRuaNumero: buscarCnefePorRuaNumero,
          buscarPorRua: buscarCnefePorRua,
          buscarPorSimilaridade: buscarCnefePorSimilaridade,
        }),
        geocodificarLocalDep: (endereco, ponto) => geocodificarLocal(endereco, ponto, buscarCandidatosPorNome),
        geocodificarGoogle,
        geocodificarNominatim: geocodificarNominatimThrottled,
      });

      // Grava a ancora write-once (nunca sobrescreve, ver migration 052)
      // so' quando veio FRESCO da cascata -- um hit de cache nao deve se
      // regravar em cima de si mesmo (nao é' o caso aqui, ja' que so' entra
      // aqui quando geocode ainda era null, mas deixa explicito o porque).
      // Checagem de enderecoChaveLinha not vazia (achado da revisao 31/08):
      // simetrica a confirmar-presenca-romaneio.mjs, que ja guarda contra
      // isso -- sem essa checagem aqui, este caminho podia gravar uma linha
      // de chave '' que o .mjs nunca leria nem escreveria (hoje teorico,
      // endereco_bruto e' NOT NULL e sem linhas vazias em producao, mas
      // mantem os dois escritores com a mesma garantia).
      if (geocode && clienteIdLinha && linha.cliente_codigo && enderecoChaveLinha) {
        await salvarCacheClienteCodigoSeNovo(clienteIdLinha, linha.cliente_codigo, enderecoChaveLinha, geocode);
      }
    }

    const geocodeStatus = geocode ? "ok" : "falhou";
    if (geocode) {
      ok++;
      // Hits de cache nao entram em geocodificadosOk: deveCorrigirComRomaneio
      // exige fonte==="cnefe" pra comparar contra a Unitrac (ver
      // src/lib/unitrac.ts) -- um hit de cache e' reuso de um resultado
      // antigo, nao uma geocodificacao fresca, nao faz sentido competir
      // com a Unitrac de novo pra corrigir pontos_aprendidos.
      if (linha.veiculo_id && !viaCacheClienteCodigo && (geocode.fonte === "google" || geocode.fonte === "nominatim" || geocode.fonte === "local" || geocode.fonte === "cnefe")) {
        geocodificadosOk.push({ id: linha.id, veiculo_id: linha.veiculo_id, placa: linha.placa, nf: linha.nf, lat: geocode.lat, lng: geocode.lng, fonte: geocode.fonte, romaneio_data: linha.romaneio_data });
      }
    } else {
      falhou++;
    }

    const { error: erroUpdate } = await admin
      .from("romaneio_pontos")
      .update({ lat: geocode?.lat ?? null, lng: geocode?.lng ?? null, geocode_status: geocodeStatus })
      .eq("id", linha.id);

    if (erroUpdate) {
      console.warn(`Aviso: erro ao atualizar geocode_status do ponto ${linha.id}: ${erroUpdate.message}`);
    }
  }

  // Fallback Unitrac pros que falharam de vez (nenhuma fonte gratuita achou)
  // -- achado real 31/07, pedido explicito do usuario: pros poucos casos
  // que sobram depois de CNEFE+OSM+similaridade+Nominatim, prefere usar a
  // coordenada da Unitrac (mesmo sabendo que pode ser imprecisa, mesmo
  // motivo do achado de 15/07) a deixar a entrega sem coordenada nenhuma.
  // Diferente da decisao de 15/07 (que era sobre a MAIORIA cair nesse
  // fallback): aqui e' so os ~8% residuais que nada mais resolveu, risco
  // bem menor. Roda sobre TODOS os falhou historicos (nao so o lote de
  // hoje), limitado por ciclo pra nao estourar o orcamento de tempo.
  const LOTE_FALLBACK_UNITRAC = 30;
  const tentavelAntesDe = new Date(Date.now() - ESPERA_ENTRE_RETENTATIVAS_MIN * 60_000).toISOString();
  // Consulta nova (com limite de tentativas) com degradacao pra antiga --
  // ver migration contabo/061. Enquanto a migration nao estiver aplicada,
  // as colunas nao existem e o PostgREST devolve erro; nesse caso a rota
  // volta ao comportamento de hoje (retentar sem limite) em vez de parar de
  // fazer o fallback por completo. Mesmo padrao ja usado pra coluna
  // `origem` em romaneio/status/route.ts.
  type LinhaFallback = { id: string; nf: string; placa: string; veiculo_id: string | null; geocode_tentativas?: number | null };
  let tentativasDisponivel = true;
  let semGeocode: LinhaFallback[] | null = null;

  // Achado real 29/08 (varredura de sistema): ate ontem esta consulta so'
  // pegava `veiculo_id IS NOT NULL` -- linhas 'falhou' com veiculo_id nulo
  // (placa ainda nao cadastrada NO MOMENTO do upload, ver
  // romaneio/upload/route.ts) nunca entravam aqui nem na fase principal (que
  // so' reprocessa pendente/processando), ficavam presas pra sempre e nunca
  // chegavam ao estado terminal que dispara revisao manual. 305 linhas assim
  // em producao, presas desde 31/07.
  //
  // Investigacao (READ-ONLY) derrubou a hipotese inicial de que a placa
  // "nunca" bateria com um veiculo: 283 das 305 (93%) HOJE ja tem um
  // veiculo cadastrado com a mesma placa -- o veiculo so' foi cadastrado
  // DEPOIS do upload do romaneio, e veiculo_id e' resolvido so' uma vez, no
  // insert. Ou seja, reprocessar tem chance real de resolver: nao e' so'
  // "promover mais rapido pro terminal", e' "tentar recasar a placa de
  // novo" (ver bloco logo abaixo, secao "reata veiculo_id orfao").
  // Por isso o filtro `.not("veiculo_id", "is", null)` sai daqui -- as
  // linhas orfas agora entram no MESMO orcamento de tentativas/espera que
  // ja existia (reaproveita geocode_tentativas/geocode_ultima_tentativa_em,
  // nao duplica mecanismo), e por isso tambem chegam ao STATUS_SEM_COORDENADA
  // terminal quando esgotam, do jeito que ja acontecia pras linhas com
  // veiculo.
  const comLimite = await admin
    .from("romaneio_pontos")
    .select("id, nf, placa, veiculo_id, geocode_tentativas")
    .eq("geocode_status", "falhou")
    .lt("geocode_tentativas", MAX_TENTATIVAS_FALLBACK_UNITRAC)
    .or(`geocode_ultima_tentativa_em.is.null,geocode_ultima_tentativa_em.lt.${tentavelAntesDe}`)
    // Sem ORDER BY (comportamento antigo) o `limit` pegava sempre o mesmo
    // punhado de linhas velhas e uma falha NOVA -- a unica com chance real
    // de resolver, porque o alvo da Unitrac ainda existe hoje -- podia
    // nunca ser tentada. Menos tentativas primeiro, e entre iguais a que
    // esperou mais.
    .order("geocode_tentativas", { ascending: true })
    .order("geocode_ultima_tentativa_em", { ascending: true, nullsFirst: true })
    .limit(LOTE_FALLBACK_UNITRAC);

  if (comLimite.error) {
    tentativasDisponivel = false;
    const semLimite = await admin
      .from("romaneio_pontos")
      .select("id, nf, placa, veiculo_id")
      .eq("geocode_status", "falhou")
      .limit(LOTE_FALLBACK_UNITRAC);
    semGeocode = semLimite.data as LinhaFallback[] | null;
  } else {
    semGeocode = comLimite.data as LinhaFallback[] | null;
  }

  let fallbackUnitrac = 0;
  let esgotaramTentativas = 0;
  let corrigidosViaRomaneio = 0;
  let veiculoIdReatribuido = 0;

  // Conta uma tentativa que NAO resolveu (nem achou alvo da Unitrac, nem
  // recasou a placa com um veiculo) e, esgotado o limite, promove ao estado
  // terminal. Extraido pra funcao porque agora tem DOIS chamadores: o loop
  // de fallback Unitrac de sempre (linhas com veiculo_id) e o bloco novo de
  // recasamento de placa (linhas orfas que continuam sem veiculo
  // cadastrado).
  const registrarFalhaTentativa = async (linha: LinhaFallback) => {
    if (!tentativasDisponivel) return;
    const tentativas = (linha.geocode_tentativas ?? 0) + 1;
    const esgotou = tentativas >= MAX_TENTATIVAS_FALLBACK_UNITRAC;
    const { error: erroTentativa } = await admin
      .from("romaneio_pontos")
      .update({
        geocode_tentativas: tentativas,
        geocode_ultima_tentativa_em: new Date().toISOString(),
        ...(esgotou ? { geocode_status: STATUS_SEM_COORDENADA } : {}),
      })
      .eq("id", linha.id);
    if (erroTentativa) {
      console.warn(`Aviso: erro ao contar tentativa de geocode do ponto ${linha.id}: ${erroTentativa.message}`);
    } else if (esgotou) {
      esgotaramTentativas++;
      console.warn(
        `Aviso: ponto de romaneio ${linha.id} (placa=${linha.placa} nf=${linha.nf}) esgotou ${MAX_TENTATIVAS_FALLBACK_UNITRAC} tentativas de geocode -- marcado como ${STATUS_SEM_COORDENADA}, precisa de revisao manual (nao sera mais reprocessado automaticamente)`
      );
    }
  };

  // Separa quem tem veiculo_id (segue pro fallback Unitrac de sempre, mais
  // abaixo) de quem nao tem (reata veiculo_id orfao, bloco a seguir). Feito
  // ANTES de qualquer chamada a Unitrac de proposito: uma linha orfa nao
  // contribui `cv` nenhum pra buscarAlvos (precisa de veiculo_id pra isso),
  // entao ela tem que ser tratada num caminho que nao dependa de
  // `cvsUnicos.length > 0` -- um lote inteiro de linhas orfas deixaria esse
  // `if` vazio e o bloco inteiro de contagem de tentativa seria pulado.
  const semGeocodeComVeiculo = (semGeocode ?? []).filter((l): l is LinhaFallback & { veiculo_id: string } => !!l.veiculo_id);
  const semGeocodeOrfaos = (semGeocode ?? []).filter((l) => !l.veiculo_id);

  // Reata veiculo_id orfao: se a placa foi cadastrada DEPOIS do upload
  // (achado real 29/08, ver comentario acima), o veiculo existe agora --
  // corrige a linha pra que o proximo ciclo (30s) processe ela pelo
  // caminho normal (com cv/alvo Unitrac de verdade). So' uma consulta local
  // (sem API externa), por isso roda todo ciclo, fora do orcamento de
  // tentativas. Quando NAO acha veiculo, conta como tentativa igual ao
  // fallback Unitrac -- reaproveita o mesmo mecanismo, nao inventa um novo.
  if (semGeocodeOrfaos.length > 0) {
    const placasOrfas = [...new Set(semGeocodeOrfaos.map((l) => l.placa))];
    const { data: veiculosOrfaos, error: erroVeiculosOrfaos } = await admin.from("veiculos").select("id, placa").in("placa", placasOrfas);
    if (erroVeiculosOrfaos) {
      console.warn(`Aviso: erro ao buscar veiculos pra recasar placas orfas: ${erroVeiculosOrfaos.message}`);
    }
    const veiculoIdPorPlacaOrfa = new Map((veiculosOrfaos ?? []).map((v) => [v.placa, v.id as string]));

    for (const linha of semGeocodeOrfaos) {
      const veiculoIdNovo = veiculoIdPorPlacaOrfa.get(linha.placa);
      if (veiculoIdNovo) {
        const { error: erroReatar } = await admin.from("romaneio_pontos").update({ veiculo_id: veiculoIdNovo }).eq("id", linha.id);
        if (erroReatar) {
          console.warn(`Aviso: erro ao recasar veiculo_id do ponto ${linha.id}: ${erroReatar.message}`);
        } else {
          veiculoIdReatribuido++;
        }
        // Resolvido (ou tentativa de resolver) sem gastar tentativa -- nao
        // achou coordenada ainda, so' deixou a linha elegivel pro caminho
        // normal no proximo ciclo.
        continue;
      }
      // Placa continua sem veiculo cadastrado: unica coisa possivel de
      // tentar pra esta linha era o recasamento acima, ja' feito e falhou.
      // Conta a tentativa igual ao fallback Unitrac.
      await registrarFalhaTentativa(linha);
    }
  }

  const veiculoIdsTodos = [
    ...new Set([
      ...semGeocodeComVeiculo.map((l) => l.veiculo_id),
      ...geocodificadosOk.map((l) => l.veiculo_id),
    ].filter((v): v is string => !!v)),
  ];

  if (veiculoIdsTodos.length > 0) {
    const { data: veiculosData } = await admin.from("veiculos").select("id, cv, cliente_id").in("id", veiculoIdsTodos);
    const cvsUnicos = [...new Set((veiculosData ?? []).map((v) => v.cv).filter((cv): cv is string => !!cv))];
    const clientePorVeiculo = new Map((veiculosData ?? []).map((v) => [v.id, v.cliente_id]));

    if (cvsUnicos.length > 0) {
      try {
        const alvos = await buscarAlvos(cvsUnicos);
        const alvoPorPlacaNf = new Map(alvos.map((a) => [`${a.placa}:${a.alvodocumento}`, a]));

        // Fallback existente: geocode falhou, usa coordenada da Unitrac.
        for (const linha of semGeocodeComVeiculo) {
          const alvo = alvoPorPlacaNf.get(`${linha.placa}:${linha.nf}`);
          if (alvo?.pontolatitude && alvo?.pontolongitude) {
            const { error: erroFallback } = await admin
              .from("romaneio_pontos")
              .update({ lat: alvo.pontolatitude, lng: alvo.pontolongitude, geocode_status: "ok" })
              .eq("id", linha.id);
            if (!erroFallback) {
              fallbackUnitrac++;
              continue;
            }
          }

          // Nao resolveu nesta tentativa. Conta a tentativa e, esgotado o
          // limite, para de retentar automaticamente (ver migration
          // contabo/061). Nao inventa coordenada: STATUS_SEM_COORDENADA e'
          // terminal e pede revisao manual. Enquanto a migration nao
          // estiver aplicada, mantem o comportamento antigo (sem contador,
          // retenta pra sempre) em vez de arriscar update em coluna
          // inexistente.
          await registrarFalhaTentativa(linha);
        }

        // Correcao nova: geocode do romaneio funcionou, compara com a
        // Unitrac e corrige pontos_aprendidos se a entrega estiver
        // confirmada e a coordenada divergir (ver
        // docs/superpowers/specs/2026-08-12-correcao-pontos-via-romaneio-design.md).
        for (const linha of geocodificadosOk) {
          const alvo = alvoPorPlacaNf.get(`${linha.placa}:${linha.nf}`);
          const clienteId = linha.veiculo_id ? clientePorVeiculo.get(linha.veiculo_id) : null;
          if (!alvo?.pontocodigo || !alvo?.pontolatitude || !alvo?.pontolongitude || !clienteId) continue;

          const entregaFeitaUnitrac = alvo.alvosituacaoservico !== 0;
          let entregaConfirmada = entregaFeitaUnitrac;
          if (!entregaConfirmada) {
            // Achado real 25/08: sem filtrar por dia, presenca de QUALQUER
            // dia passado (ex: visita de 08/11) contava como "confirmado"
            // pra autorizar sobrescrever pontos_aprendidos com o endereco
            // geocodificado HOJE -- isso nao prova que o endereco de hoje
            // esta certo, so' que o cliente foi visitado alguma vez. So' a
            // presenca do PROPRIO dia deste romaneio prova que a entrega
            // aconteceu on'de o romaneio de hoje diz que ela aconteceu.
            const { data: presenca } = await admin
              .from("entregas_presenca")
              .select("dia")
              .eq("cliente_id", clienteId)
              .eq("ponto_codigo", alvo.pontocodigo)
              .eq("dia", linha.romaneio_data)
              .limit(1)
              .maybeSingle();
            entregaConfirmada = presenca !== null;
          }

          if (!deveCorrigirComRomaneio(
            { lat: alvo.pontolatitude, lng: alvo.pontolongitude },
            { lat: linha.lat, lng: linha.lng },
            entregaConfirmada,
            linha.fonte
          )) continue;

          const { error: erroCorrecao } = await admin.from("pontos_aprendidos").upsert(
            {
              cliente_id: clienteId,
              ponto_codigo: alvo.pontocodigo,
              lat: linha.lat,
              lng: linha.lng,
              raio_m: 30,
              n_observacoes: 1,
              primeira_observacao: hojeSP(),
              ultima_observacao: hojeSP(),
              fonte: "romaneio",
            },
            { onConflict: "cliente_id,ponto_codigo" }
          );
          if (!erroCorrecao) corrigidosViaRomaneio++;
          else console.warn(`Aviso: erro ao gravar correcao via romaneio (cliente=${clienteId} ponto=${alvo.pontocodigo}): ${erroCorrecao.message}`);
        }
      } catch (e) {
        console.warn(`Aviso: erro no fallback/correcao Unitrac do geocode: ${e}`);
      }
    }
  }

  return Response.json({ processados: pendentes.length, ok, falhou, doCacheClienteCodigo, fallbackUnitrac, corrigidosViaRomaneio, esgotaramTentativas, veiculoIdReatribuido, limiteTentativasAtivo: tentativasDisponivel });
}
