// Consulta ao Overpass API (OSM) para verificar se existe POI legitimo
// (posto, restaurante, farmacia etc.) num raio de 80m ao redor de um ponto.
// Resultado cacheado 7 dias na tabela poi_cache para nao saturar a API.
//
// CONTRATO (revisao final de branch 27/08, achado I3): o boolean devolvido e
// sempre um VEREDITO ("tem POI" / "nao tem POI"). Quando a checagem nao pode
// ser feita -- Overpass fora do ar, timeout, HTTP de erro, corpo invalido, ou
// falha de pool/query no poi_cache -- a funcao LANCA. Quem chama decide o
// fail-open (os dois motores assumem POI presente e marcam o ciclo como nao
// confiavel). Nunca devolva `false` por falha: "nao consegui checar" virando
// "nao ha POI" libera os 3 detectores de parada pra frota inteira de uma vez.
//
// Tipos de amenity considerados "parada legitima" de caminhao:
//   fuel (posto), restaurant, fast_food, pharmacy, supermarket, bank,
//   hospital, bus_station, parking, car_wash, car_service, atm

import pg from "pg";

const AMENITIES = [
  "fuel", "restaurant", "fast_food", "pharmacy", "supermarket",
  "bank", "hospital", "bus_station", "parking", "car_wash", "atm",
].join("|");

// Achado real 30/08 (varredura de sistema): overpass-api.de comecou a
// recusar conexao (TCP "connection refused" nos 4 IPs, v4 e v6) do VPS de
// producao a partir de 27/08 -- provavel ban por volume de chamadas do
// endpoint publico gratuito. Efeito real: temPOIProximo lancava exceçao em
// TODO ciclo havia 3 dias, e o fail-open documentado (`catch` em
// motor/route.ts) assume POI presente pra NAO gerar ruido -- ou seja, os 3
// detectores de parada suspeita perto de POI (parada_anomala,
// saida_nao_autorizada parado, parada_fora_tapete) ficaram silenciosamente
// mais permissivos (risco de recall) pra frota inteira por 3 dias, sem
// ninguem perceber (poi_cache zerou de escritas novas nesse periodo).
// Trocado pro mirror overpass.osm.ch em 30/08 (confirmado alcancavel na
// epoca) -- ACHADO REAL 02/09 (investigacao de "por que parada_anomala nao
// voltou ao patamar antigo"): overpass.osm.ch e' um mirror REGIONAL, so'
// cobre a Suica. `poi_cache` tinha 1956 linhas, ZERO com tem_poi=true, desde
// 30/08 -- a checagem respondia HTTP 200 (nunca lancava, nunca disparava o
// fail-open) mas SEMPRE devolvia total=0 pra qualquer coordenada do Brasil,
// silenciosamente. Trocamos "sempre suprime" (Overpass banido) por "nunca
// suprime" (Overpass mundial mas respondendo dado errado) -- pior ainda,
// porque nao lanca excecao nenhuma, entao nenhum sinal de erro aparecia.
//
// Trocado pra overpass.mail.ru (maps.mail.ru), confirmado mundial de
// verdade: retornou 13 postos reais no Rio (raio 5km centro), 266
// restaurantes reais em SP (raio 2km centro), 0 no meio do oceano
// atlantico (-25,-35). overpass-api.de (oficial) confirmado NAO mais
// banido (sem connection refused), mas respondendo 504/dispatcher timeout
// por sobrecarga do publico gratuito -- nao usado como principal por isso,
// mas pode voltar a ser candidato se ficar estavel.
//
// LICAO: qualquer troca de mirror Overpass PRECISA de teste-canario com
// coordenada de fora do pais de origem do mirror antes de confiar (nao
// basta "respondeu 200" nem "respondeu com JSON valido" -- precisa
// responder CERTO). Nao ha teste automatizado disso ainda -- considerar
// adicionar um canario real (ex: checagem periodica que valida total>0 pra
// uma coordenada brasileira conhecida) em vez de so' confiar visualmente
// na proxima investigacao manual.
const OVERPASS_URL = "https://maps.mail.ru/osm/tools/overpass/api/interpreter";
const RAIO_M = 80;
const CACHE_DIAS = 7;

// Arredonda lat/lng a 3 casas decimais (~111m de resolucao) para maximizar cache hits.
function arredondar(v: number): number {
  return Math.round(v * 1000) / 1000;
}

export async function temPOIProximo(
  lat: number,
  lng: number,
  pool: pg.Pool
): Promise<boolean> {
  const latR = arredondar(lat);
  const lngR = arredondar(lng);

  const pgClient = await pool.connect();
  try {
    // Verificar cache
    const { rows } = await pgClient.query<{ tem_poi: boolean; atualizado_em: Date }>(
      `SELECT tem_poi, atualizado_em FROM poi_cache WHERE lat = $1 AND lng = $2`,
      [latR, lngR]
    );
    if (rows.length > 0) {
      const idadeMs = Date.now() - rows[0].atualizado_em.getTime();
      const idadeDias = idadeMs / (1000 * 60 * 60 * 24);
      if (idadeDias < CACHE_DIAS) return rows[0].tem_poi;
    }

    // Consultar Overpass
    const query =
      `[out:json][timeout:5];` +
      `(node[amenity~"${AMENITIES}"](around:${RAIO_M},${lat},${lng});` +
      `way[amenity~"${AMENITIES}"](around:${RAIO_M},${lat},${lng});` +
      `);out count;`;

    // Falha de consulta (rede, timeout, HTTP != 2xx, JSON invalido) LANCA --
    // nunca vira `false` silencioso. Achado da revisao final de branch (27/08,
    // I3): a versao anterior engolia o erro de fetch e devolvia false, entao
    // os dois motores (motor/route.ts e motor-romaneio/route.ts) tinham um
    // `catch { temPOI = true; ... }` que so disparava por falha de
    // pool/query no poi_cache -- praticamente NUNCA por queda real do
    // Overpass. Efeito pratico do bug: durante uma instabilidade do Overpass,
    // "nao consegui checar" virava "confirmei que nao ha POI", o que (a)
    // libera os 3 detectores de parada pra frota inteira ao mesmo tempo
    // (flood de falso positivo, exatamente o que aquele catch existia pra
    // evitar) e (b) na Central Romaneio deixava `overpassFalhou` false, entao
    // o gate de auto-resolve considerava o ciclo confiavel e podia FECHAR
    // sozinho um alerta de parada real.
    //
    // Contrato pros chamadores: `true`/`false` = veredito de verdade; excecao
    // = "nao deu pra checar", trate como o caminho de falha que voce ja tem.
    // Os dois call sites atuais ja faziam exatamente isso (fail-open,
    // temPOI=true) pro caminho de erro de pool/DB -- nenhum precisou mudar,
    // so passaram a ser acionados pelo caso que importa.
    let temPoi = false;
    let res: Response;
    try {
      res = await fetch(OVERPASS_URL, {
        method: "POST",
        headers: { "Content-Type": "application/x-www-form-urlencoded" },
        body: `data=${encodeURIComponent(query)}`,
        signal: AbortSignal.timeout(6000),
      });
    } catch (err) {
      throw new Error(`Overpass indisponivel (rede/timeout): ${String(err)}`);
    }
    if (!res.ok) {
      // 429 (rate limit) e 504 (gateway timeout) sao os dois modos de falha
      // recorrentes do overpass-api.de publico -- ambos sao "nao consegui
      // checar", nunca "nao ha POI".
      throw new Error(`Overpass respondeu HTTP ${res.status}`);
    }
    try {
      // Achado real 30/08: a API Overpass devolve `tags.total` de `out
      // count;` como STRING (ex: "14"), nunca number -- confirmado com
      // chamada real, tanto no mirror antigo quanto no novo. O `typeof
      // total === "number"` original nunca era verdadeiro, entao SEMPRE
      // caia no fallback `elements.length > 0`, que por sua vez e' SEMPRE
      // true pra `out count;` (ela devolve exatamente 1 elemento mesmo
      // quando total=0) -- ou seja, temPoi vinha sempre `true`,
      // independente de existir POI de verdade. So' nao foi percebido
      // porque a API estava banida (achado acima) e a funcao nunca
      // chegava a esta linha. `Number(total)` converte a string real.
      const json = (await res.json()) as { elements?: { tags?: { total?: number | string } }[] };
      const total = json.elements?.[0]?.tags?.total;
      temPoi = total != null ? Number(total) > 0 : (json.elements?.length ?? 0) > 0;
    } catch (err) {
      throw new Error(`Overpass devolveu corpo invalido: ${String(err)}`);
    }

    // Gravar no cache
    await pgClient.query(
      `INSERT INTO poi_cache (lat, lng, tem_poi, atualizado_em)
       VALUES ($1, $2, $3, now())
       ON CONFLICT (lat, lng) DO UPDATE SET tem_poi=$3, atualizado_em=now()`,
      [latR, lngR, temPoi]
    );

    return temPoi;
  } finally {
    pgClient.release();
  }
}
