import { createAdminClient } from "@/lib/supabase/admin";
import { geocodificarEndereco, geocodificarLocal, geocodificarCnefe, geocodificarGoogle, geocodificarNominatim } from "@/lib/romaneio-geocode";
import { extrairCidadeDoEndereco, expandirCidadeTruncada, extrairBairroDoEndereco, municipioCodigoIbge } from "@/lib/romaneio-geocode-local";
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
    .select("id, endereco_bruto, veiculo_id, placa, nf, cliente_codigo")
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
  let pendentes: { id: string; endereco_bruto: string; veiculo_id: string | null; placa: string; nf: string; cliente_codigo: string | null }[] = [];

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
      .select("id, endereco_bruto, veiculo_id, placa, nf, cliente_codigo");

    if (erroReivindicar) {
      console.error(`Erro ao reivindicar romaneio_pontos: ${erroReivindicar.message}`);
    } else if (reivindicados) {
      pendentes = reivindicados;
    }
  }

  // Cache por (cliente_id, cliente_codigo) -- ver migration 052. Politica
  // write-once: le antes de geocodificar (se ja tem ancora, usa direto,
  // pula a cascata de texto inteira), grava so' na PRIMEIRA vez que um
  // codigo resolve com sucesso (nunca sobrescreve sozinha depois, ver
  // comentario da migration). Precisa do cliente_id por linha ANTES do
  // loop principal -- veiculo->cliente_id so' era resolvido mais abaixo,
  // no bloco de fallback Unitrac, tarde demais pra decidir aqui.
  const veiculoIdsPendentes = [...new Set(pendentes.map((l) => l.veiculo_id).filter((v): v is string => !!v))];
  const clientePorVeiculoAntecipado = new Map<string, string>();
  if (veiculoIdsPendentes.length > 0) {
    const { data: veiculosPendentes } = await admin.from("veiculos").select("id, cliente_id").in("id", veiculoIdsPendentes);
    for (const v of veiculosPendentes ?? []) clientePorVeiculoAntecipado.set(v.id, v.cliente_id);
  }
  const buscarCacheClienteCodigo = async (clienteId: string, clienteCodigo: string) => {
    const { data } = await admin
      .from("romaneio_cliente_codigo_geocode")
      .select("lat, lng, fonte")
      .eq("cliente_id", clienteId)
      .eq("cliente_codigo", clienteCodigo)
      .maybeSingle();
    return data ?? null;
  };
  const salvarCacheClienteCodigoSeNovo = async (clienteId: string, clienteCodigo: string, r: { lat: number; lng: number; fonte: string }) => {
    // ON CONFLICT DO NOTHING (nao upsert de verdade) -- write-once de
    // proposito, ver migration 052. upsert() com ignoreDuplicates:true e'
    // o equivalente do supabase-js pra isso (insert() simples nao aceita
    // onConflict, so' upsert aceita).
    await admin.from("romaneio_cliente_codigo_geocode").upsert(
      {
        cliente_id: clienteId,
        cliente_codigo: clienteCodigo,
        lat: r.lat,
        lng: r.lng,
        fonte: r.fonte,
        n_observacoes: 1,
        primeira_observacao: hojeSP(),
        ultima_observacao: hojeSP(),
      },
      { onConflict: "cliente_id,cliente_codigo", ignoreDuplicates: true }
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
    const chaveCache = `BAIRRO:${bairro.toUpperCase()}:${cidade.toUpperCase()}`;
    const doCache = await buscarCache(chaveCache);
    if (doCache) {
      pontosBairro.set(chave, { lat: doCache.lat, lng: doCache.lng });
      continue;
    }
    const ponto = await geocodificarNominatimThrottled(`${bairro}, ${cidade}`);
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
  const geocodificadosOk: { id: string; veiculo_id: string | null; placa: string; nf: string; lat: number; lng: number; fonte: "google" | "nominatim" | "local" | "cnefe" }[] = [];

  let doCacheClienteCodigo = 0;

  for (const linha of pendentes) {
    // Cache por cliente_codigo primeiro (ver migration 052) -- se esse
    // codigo ja resolveu com sucesso em outro dia, usa a ancora direto e
    // pula a cascata de texto inteira (mais rapido e mais estavel: elimina
    // a variacao de 1-2 coordenadas pro MESMO cliente que a analise de
    // 16/08 achou). So aplica quando o codigo existe e o veiculo tem
    // cliente_id resolvido -- sem isso cai pra cascata normal, igual antes.
    const clienteIdLinha = linha.veiculo_id ? clientePorVeiculoAntecipado.get(linha.veiculo_id) : null;
    let geocode: { lat: number; lng: number; fonte: string } | null = null;
    let viaCacheClienteCodigo = false;

    if (clienteIdLinha && linha.cliente_codigo) {
      const ancora = await buscarCacheClienteCodigo(clienteIdLinha, linha.cliente_codigo);
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
      if (geocode && clienteIdLinha && linha.cliente_codigo) {
        await salvarCacheClienteCodigoSeNovo(clienteIdLinha, linha.cliente_codigo, geocode);
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
        geocodificadosOk.push({ id: linha.id, veiculo_id: linha.veiculo_id, placa: linha.placa, nf: linha.nf, lat: geocode.lat, lng: geocode.lng, fonte: geocode.fonte });
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
  const { data: semGeocode } = await admin
    .from("romaneio_pontos")
    .select("id, nf, placa, veiculo_id")
    .eq("geocode_status", "falhou")
    .not("veiculo_id", "is", null)
    .limit(LOTE_FALLBACK_UNITRAC);

  let fallbackUnitrac = 0;
  let corrigidosViaRomaneio = 0;

  const veiculoIdsTodos = [
    ...new Set([
      ...(semGeocode ?? []).map((l) => l.veiculo_id),
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
        for (const linha of semGeocode ?? []) {
          const alvo = alvoPorPlacaNf.get(`${linha.placa}:${linha.nf}`);
          if (alvo?.pontolatitude && alvo?.pontolongitude) {
            const { error: erroFallback } = await admin
              .from("romaneio_pontos")
              .update({ lat: alvo.pontolatitude, lng: alvo.pontolongitude, geocode_status: "ok" })
              .eq("id", linha.id);
            if (!erroFallback) fallbackUnitrac++;
          }
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
            const { data: presenca } = await admin
              .from("entregas_presenca")
              .select("dia")
              .eq("cliente_id", clienteId)
              .eq("ponto_codigo", alvo.pontocodigo)
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

  return Response.json({ processados: pendentes.length, ok, falhou, doCacheClienteCodigo, fallbackUnitrac, corrigidosViaRomaneio });
}
