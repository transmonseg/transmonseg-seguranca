// Geocodificacao de enderecos do romaneio (endereco -> coordenada), com
// cache e cadeia de fallback. Espelha o padrao ja usado no motor pro
// geocode REVERSO (coordenada -> endereco, ver geocodeReverso em
// api/motor/route.ts) -- mesma chave do Google, mesmo User-Agent do
// Nominatim -- so na direcao contraria.

import { extrairRuaDoEndereco, extrairNumeroDoEndereco, normalizarNomeRua, montarVariantesParaGeocode } from "./romaneio-geocode-local";
import { haversineM } from "./unitrac";

export function normalizarEndereco(enderecoBruto: string): string {
  return enderecoBruto.trim().toUpperCase().replace(/\s+/g, " ");
}

const DISTANCIA_MAX_MATCH_LOCAL_M = 30_000; // 30km -- nome bateu, mas e outra regiao

// Compartilhado entre geocodificarLocal (OSM) e geocodificarCnefe (IBGE) --
// quando ha mais de um candidato (rua repetida em cidades diferentes),
// escolhe o mais proximo do ponto de referencia da cidade (resolvido 1x
// por lote, ver processar-geocode/route.ts).
//
// Desvio deliberado da spec original do match OSM (que so checava
// distancia com 2+ candidatos, deixando candidato UNICO passar direto):
// candidato unico TAMBEM e checado contra o ponto de cidade quando ele
// existe. Motivo descoberto durante essa feature (ver achado lateral da
// Task 5 de 22/07): nome de cidade pode ser ambiguo no Brasil inteiro
// (ex.: "Natividade" existe no RJ E no Tocantins, ~1500km de distancia)
// -- se a resolucao de cidade (Nominatim) acertar a cidade ERRADA, um
// candidato local UNICO e "correto" segundo o nome ainda estaria a
// milhares de km do ponto de cidade (tambem errado) resolvido nesse
// ciclo. Checar sempre que ha ponto de cidade disponivel pega esse caso;
// SEM ponto de cidade, nao ha nada pra comparar, entao o candidato unico
// passa direto como antes.
//
// Achado real 26/08 (RBJ-2J67, grupo DESVIO DE ROTA): cidade truncada na
// origem do romaneio ("SANTO ANTONIO D" em vez de "SANTO ANTONIO DE
// PADUA") impediu a resolucao de pontoCidade -- com pontoCidade null e
// MULTIPLOS candidatos (rua comum, repetida em varias cidades), o
// primeiro da lista passava direto sem NENHUMA checagem, foi parar a
// +200km da rota real (Rio de Janeiro capital). Sem pontoCidade e com
// ambiguidade real (mais de 1 candidato), nao ha como saber qual e' o
// certo -- devolve null em vez de arriscar. Candidato UNICO sem
// pontoCidade continua passando direto (nao muda, nada pra comparar
// mesmo, ver teste "um candidato, sem ponto de cidade").
// Achado real 05/09 (diagnostico dos pendentes do KPI Nutry Max de 03/09):
// 226 dos 382 pendentes tinham coordenada mas o caminhao nunca passou a
// menos de 1,5km dela -- media de 14km. No nivel "so rua" o CNEFE devolve
// ate 200 pontos da rua INTEIRA e a escolha era pela proximidade ao CENTRO
// DA CIDADE; em via longa, numeros bem distantes colapsavam no MESMO ponto
// ("AV LUCIO COSTA, 2900 / 5700 / 16580", avenida de ~18km, todos em
// -23.01391,-43.31373). Com o numero do romaneio em maos, o desempate certo
// e' pelo NUMERO mais proximo. O teto de distancia do ponto de cidade
// continua valendo depois (rua homonima em cidade errada segue barrada).
function soDigitos(n: string | null | undefined): number | null {
  if (!n) return null;
  const so = String(n).replace(/\D/g, "");
  if (!so) return null;
  const v = Number(so);
  return Number.isFinite(v) && v > 0 ? v : null;
}

function escolherPorNumeroMaisProximo(
  candidatos: { lat: number; lng: number; numero?: string | null }[],
  numeroAlvo: number
): { lat: number; lng: number } | null {
  let melhor: { lat: number; lng: number } | null = null;
  let menorDif = Infinity;
  for (const c of candidatos) {
    const n = soDigitos(c.numero);
    if (n === null) continue;
    const dif = Math.abs(n - numeroAlvo);
    if (dif < menorDif) { menorDif = dif; melhor = { lat: c.lat, lng: c.lng }; }
  }
  return melhor;
}

// Achado real 05/09: dos 380 pendentes do KPI Nutry Max de 03/09, 132
// ficaram SEM COORDENADA -- concentrados em cidade pequena do interior. A
// causa comum: o ponto de referencia (usado pra validar o geocode contra o
// teto de 30km) e' o do BAIRRO, preferido sobre o da cidade, e o bairro e'
// resolvido SOZINHO no Nominatim ("CENTRO, CAMBUCI"). Medido contra o
// Nominatim real:
//   "CENTRO, CAMBUCI"      -> Sao Paulo capital (~350km de Cambuci-RJ)
//   "CENTRO, ITAOCARA"     -> Rua Itaocara, Duque de Caxias
//   "VILA NOVA, MIRACEMA"  -> Rua Miracema, Nova Iguacu
// Com a referencia errada, o endereco CERTO cai fora do teto e vira null.
// Bairro fica DENTRO da propria cidade: se o ponto do bairro esta longe do
// da cidade, e' ele que esta errado -- descarta e usa o da cidade.
export const RAIO_MAX_BAIRRO_DA_CIDADE_M = 25_000;

// Achado real 06/09 (KPI Rio Quality, 15 de 46 pendentes de UM so'
// caminhao, rota inteira em Campo Grande/Guaratiba/Sepetiba/Santa Cruz --
// Zona Oeste): "ESTRADA DO MATO ALTO" e "RUA BARROS ALARCAO" EXISTEM no
// CNEFE, dentro do municipio certo (Rio de Janeiro capital, 3304557) -- mas
// o ponto de BAIRRO (Campo Grande, ~40km do Centro) era descartado pelo
// teto de 25km acima e o de CIDADE (perto do Centro) tambem rejeitava os
// candidatos reais por estarem a mais de 30km dele
// (DISTANCIA_MAX_MATCH_LOCAL_M). Rio capital tem ~1200km2, ~60km de ponta a
// ponta -- bairro correto pode legitimamente estar bem mais longe do
// "centro da cidade" do que em qualquer outro municipio do estado. Isso e'
// DIFERENTE do erro que motivou o teto original (Nominatim resolvendo
// "CENTRO, CAMBUCI" em Sao Paulo, ~350km, outro estado) -- teto maior aqui
// nao reabre aquele buraco (350km >> mesmo o teto ampliado). So' o
// municipio do Rio ganha folga; todo o resto do estado mantem o teto
// original (cidade pequena com bairro a 40km+ do centro dela CONTINUA
// sendo o mesmo tipo de erro de antes).
//
// Achado real 06/09 (auditoria do KPI Nutry Max, par RBG2D21/RQP4A68):
// mesmo padrao em Angra dos Reis -- "Centro, Angra dos Reis" e "Frade
// (Cunhambebe), Angra dos Reis" ficam a ~30km um do outro (municipio
// costeiro alongado, ~825km2), e o par de placas so' "trocava carga" com
// os HORARIOS DAS DUAS PARADAS SE SOBREPONDO -- sinal de que um dos dois
// enderecos geocodificou perto do trajeto do OUTRO caminhao por causa do
// mesmo problema (bairro descartado, cai pro ponto de cidade errado pra um
// municipio grande demais).
// Achado real 06/09 (auditoria proativa, sem incidente ainda): Campos dos
// Goytacazes e' o MAIOR municipio do estado (~4.030km2, mais de 3x o Rio
// capital) -- a Nutry Max tem rotas inteiras la' (CAMPOS, CAMPOS 2, CAMPOS
// 3, CAMPOS 4, alto volume diario). Mesmo raciocinio geometrico do Rio e
// Angra: bairro correto pode estar bem mais longe do "centro" administrativo
// do que o teto pequeno cobre. Adicionado preventivamente, mesmo sem um
// caso de "carga transferida" que o tenha exposto ainda.
const RAIO_MAX_BAIRRO_DA_CIDADE_GRANDE_M = 70_000;
const MUNICIPIOS_GRANDES = new Set([
  "3304557", // Rio de Janeiro (capital)
  "3300100", // Angra dos Reis
  "3301009", // Campos dos Goytacazes
]);

function raioMaxBairroDaCidade(municipioCodigo: string | null): number {
  return municipioCodigo && MUNICIPIOS_GRANDES.has(municipioCodigo)
    ? RAIO_MAX_BAIRRO_DA_CIDADE_GRANDE_M
    : RAIO_MAX_BAIRRO_DA_CIDADE_M;
}

export function escolherPontoReferencia(
  pontoBairro: { lat: number; lng: number } | null,
  pontoCidade: { lat: number; lng: number } | null,
  municipioCodigo: string | null = null
): { lat: number; lng: number } | null {
  if (!pontoBairro) return pontoCidade;
  if (!pontoCidade) return pontoBairro;
  const d = haversineM(pontoCidade.lat, pontoCidade.lng, pontoBairro.lat, pontoBairro.lng);
  return d <= raioMaxBairroDaCidade(municipioCodigo) ? pontoBairro : pontoCidade;
}

// Achado real 06/09 (KPI Nutry Max, NF 2358062): quando a resolucao do
// PONTO DE CIDADE falha por instabilidade transitoria do Nominatim (varios
// processos concorrentes disputando o mesmo limite de 1 req/s no mesmo
// dia), um candidato de SIMILARIDADE (pg_trgm, nome PARECIDO, nao exato)
// UNICO passava direto sem nenhuma validacao -- "ESTRADA SANTA MARIA, 661"
// (Campo Grande, existe EXATO no CNEFE) foi parar em "SANTA MARIA
// ROSSELLO" (~35km de distancia, outro bairro) so' porque o pontoCidade
// nao estava disponivel naquele ciclo. Diferente de um match EXATO (rua+
// numero ou so'-rua) -- que ja' tem o nome batendo 100%, candidato unico
// sem referencia e' aceitavel -- similaridade e' uma APOSTA de nome (pode
// ser a rua errada com grafia parecida); exige `exigirReferencia=true` (so'
// usado pelo chamador de similaridade) pra nunca aceitar as cegas: sem
// ponto de referencia disponivel, similaridade sempre falha (fica pra
// tentar de novo no proximo ciclo) em vez de arriscar a rua errada.
function escolherCandidatoMaisProximo(
  candidatos: { lat: number; lng: number }[],
  pontoCidade: { lat: number; lng: number } | null,
  exigirReferencia = false
): { lat: number; lng: number } | null {
  if (candidatos.length === 0) return null;
  if (!pontoCidade) return !exigirReferencia && candidatos.length === 1 ? candidatos[0] : null;

  let melhor = candidatos[0];
  let menorDist = haversineM(pontoCidade.lat, pontoCidade.lng, melhor.lat, melhor.lng);
  for (const c of candidatos.slice(1)) {
    const d = haversineM(pontoCidade.lat, pontoCidade.lng, c.lat, c.lng);
    if (d < menorDist) { menorDist = d; melhor = c; }
  }
  // so' lat/lng: candidato do CNEFE pode vir com `numero` junto (usado no
  // desempate) e isso nao deve vazar pro resultado/cache.
  return menorDist <= DISTANCIA_MAX_MATCH_LOCAL_M ? { lat: melhor.lat, lng: melhor.lng } : null;
}

// Geocodificacao LOCAL via extrato OSM (vias_nomes) -- ver
// docs/superpowers/specs/2026-07-22-geocodificacao-local-romaneio-design.md.
// Bate o nome da rua contra candidatos ja ingeridos.
export async function geocodificarLocal(
  enderecoBruto: string,
  pontoCidade: { lat: number; lng: number } | null,
  buscarCandidatosPorNome: (nomeNormalizado: string) => Promise<{ lat: number; lng: number }[]>
): Promise<{ lat: number; lng: number } | null> {
  const rua = extrairRuaDoEndereco(enderecoBruto);
  const nomeNormalizado = normalizarNomeRua(rua);
  const candidatos = await buscarCandidatosPorNome(nomeNormalizado);
  return escolherCandidatoMaisProximo(candidatos, pontoCidade);
}

// Geocodificacao via CNEFE (IBGE, Censo 2022) -- achado real 31/07, ver
// migration contabo/022_cnefe_enderecos.sql. Endereco+coordenada real
// coletado por recenseador em campo, mais preciso que o extrato OSM (que
// so tem nome de rua + ponto medio do trecho) pra rua de cidade pequena/
// bairro informal -- por isso roda ANTES do match OSM na cadeia de
// geocodificarEndereco. Tres niveis, do mais preciso pro mais amplo:
// (1) rua+numero exato (imovel especifico), (2) so rua (qualquer numero
// naquela rua), (3) similaridade de nome via pg_trgm (pega variacao tipo
// abreviacao -- "FRANCISCO" vs "F." -- que nem o match exato da rua
// resolve). Cada nivel so roda se o anterior nao achou nada.
// municipioCodigo (achado real 12/08, ver
// docs/superpowers/specs/2026-08-12-precisao-geocodificacao-romaneio-design.md):
// filtro RIGIDO na propria query CNEFE, nao so proximidade depois --
// rua/nome_normalizado pode se repetir em municipios diferentes (o caso
// real que gerou isso: "Avenida Liberdade" existe em Sao Joao da Barra E
// no Rio de Janeiro, ~270km de distancia), e o teto de 30km em
// escolherCandidatoMaisProximo nao discrimina bem quando o ponto de
// referencia e' a cidade inteira (municipio grande) ou quando nao ha
// candidato bom por perto. Passado adiante pros 3 niveis -- o filtro nao
// deve se perder no fallback rua+numero -> so-rua -> similaridade.
export async function geocodificarCnefe(
  enderecoBruto: string,
  pontoCidade: { lat: number; lng: number } | null,
  municipioCodigo: string | null,
  deps: {
    buscarPorRuaNumero: (nomeNormalizado: string, numero: string, municipioCodigo: string | null) => Promise<{ lat: number; lng: number }[]>;
    // `numeroAlvo` (3o arg) permite ao produtor ORDENAR pelo numero no banco
    // -- rua longa tem milhares de pontos no CNEFE e um LIMIT sem ordenacao
    // pode nem trazer o numero certo (ver migration 074). `numero` na
    // resposta e' OPCIONAL: sem ele, o desempate por numero nao se aplica.
    buscarPorRua: (nomeNormalizado: string, municipioCodigo: string | null, numeroAlvo: number | null) => Promise<{ lat: number; lng: number; numero?: string | null }[]>;
    buscarPorSimilaridade: (nomeNormalizado: string, municipioCodigo: string | null) => Promise<{ lat: number; lng: number }[]>;
  }
): Promise<{ lat: number; lng: number } | null> {
  const rua = extrairRuaDoEndereco(enderecoBruto);
  const nomeNormalizado = normalizarNomeRua(rua);
  const numero = extrairNumeroDoEndereco(enderecoBruto);

  if (numero && !/^S\/?N$/i.test(numero)) {
    const porRuaNumero = await deps.buscarPorRuaNumero(nomeNormalizado, numero, municipioCodigo);
    const resultado = escolherCandidatoMaisProximo(porRuaNumero, pontoCidade);
    if (resultado) return resultado;
  }

  const numeroAlvo = soDigitos(numero);
  const porRua = await deps.buscarPorRua(nomeNormalizado, municipioCodigo, numeroAlvo);
  // Com numero do romaneio: desempata pelo numero mais proximo entre os
  // pontos da rua (ver escolherPorNumeroMaisProximo). O ponto escolhido
  // ainda passa pelo teto de distancia do ponto de cidade.
  if (numeroAlvo !== null) {
    const porNumero = escolherPorNumeroMaisProximo(porRua, numeroAlvo);
    if (porNumero) {
      const validado = escolherCandidatoMaisProximo([porNumero], pontoCidade);
      if (validado) return validado;
    }
  }
  const resultadoRua = escolherCandidatoMaisProximo(porRua, pontoCidade);
  if (resultadoRua) return resultadoRua;

  const porSimilaridade = await deps.buscarPorSimilaridade(nomeNormalizado, municipioCodigo);
  return escolherCandidatoMaisProximo(porSimilaridade, pontoCidade, true);
}

// SEM fallback pra coordenada da Unitrac de proposito -- achado real 15/07:
// no romaneio de teste (22 pontos, veiculo TUL1C38), 18 cairiam no fallback
// da Unitrac (Nominatim gratuito nao cobre a maioria das ruas de cidade
// pequena do interior, e GOOGLE_MAPS_API_KEY server-side nao esta
// configurada) -- ou seja, a MAIORIA dos pontos continuaria usando a
// coordenada "as vezes errada" que o romaneio existe pra evitar. Decisao
// explicita do usuario: se nao geocodificar, o ponto fica sem coordenada
// (excluido da lista de pendentes pelo motor) em vez de reusar a Unitrac.
export type ResultadoGeocode = { lat: number; lng: number; fonte: "google" | "nominatim" | "local" | "cnefe" } | null;

type Deps = {
  buscarCache: (chave: string) => Promise<{ lat: number; lng: number; fonte: string } | null>;
  salvarCache: (chave: string, r: { lat: number; lng: number; fonte: string }) => Promise<void>;
  geocodificarCnefeDep: (enderecoBruto: string, pontoCidade: { lat: number; lng: number } | null) => Promise<{ lat: number; lng: number } | null>;
  geocodificarLocalDep: (enderecoBruto: string, pontoCidade: { lat: number; lng: number } | null) => Promise<{ lat: number; lng: number } | null>;
  geocodificarGoogle: (enderecoBruto: string) => Promise<{ lat: number; lng: number } | null>;
  geocodificarNominatim: (enderecoBruto: string) => Promise<{ lat: number; lng: number } | null>;
};

// Item 4 da blindagem de geocodificacao (27/08). Quando CNEFE/OSM devolvem
// um resultado SEM pontoCidade disponivel, a validacao de distancia de
// escolherCandidatoMaisProximo NAO roda -- nao ha contra o que comparar --
// e o resultado e' aceito na fé. Com pontoCidade a coordenada e' checada
// contra os 30km; sem ele, o unico filtro que sobrou (depois da blindagem
// do item 1) e' "so passa se for candidato UNICO". Isso e' bem mais fraco:
// candidato unico da rua errada, do municipio errado, ainda passa -- foi
// assim que "MANGUINHOS, ARMAÇO DOS BZIO" foi parar ~160km longe, no
// Manguinhos do Rio capital.
//
// Ate hoje isso era 100% silencioso: nao dava pra saber, olhando o log,
// que uma coordenada entrou por esse caminho sem validacao. O aviso abaixo
// e' o gancho pra olho humano -- se aparecer MUITO, a causa quase sempre e'
// a mesma (cidade que nao resolveu por truncamento/corrupcao no romaneio),
// e o conserto e' em expandirCidadeTruncada/extrairCidadeDoEndereco, nao
// aqui. Mesmo padrao de console.warn ja usado no resto do fluxo do
// romaneio (ver processar-geocode/route.ts e motor-romaneio/route.ts).
function avisarSemPontoCidade(
  fonte: "cnefe" | "local",
  enderecoBruto: string,
  r: { lat: number; lng: number },
  pontoCidade: { lat: number; lng: number } | null
): void {
  if (pontoCidade) return;
  console.warn(
    `Aviso: geocode do romaneio aceito SEM ponto de referencia de cidade (validacao de distancia nao rodou) -- fonte=${fonte} lat=${r.lat} lng=${r.lng} endereco=${JSON.stringify(enderecoBruto)}`
  );
}

export async function geocodificarEndereco(
  enderecoBruto: string,
  pontoCidade: { lat: number; lng: number } | null,
  deps: Deps
): Promise<ResultadoGeocode> {
  const chave = normalizarEndereco(enderecoBruto);
  const doCache = await deps.buscarCache(chave);
  if (doCache) return { lat: doCache.lat, lng: doCache.lng, fonte: doCache.fonte as "google" | "nominatim" | "local" | "cnefe" };

  // CNEFE roda ANTES do OSM (geocodificarLocalDep) -- achado real 31/07:
  // endereco+coordenada real de campo (IBGE) e' mais preciso que o extrato
  // OSM (nome de rua + ponto medio) pra rua de cidade pequena/bairro
  // informal, exatamente o gargalo que restava depois de descartar Google
  // Geocoding (usuario recusou vincular faturamento).
  const cnefe = await deps.geocodificarCnefeDep(enderecoBruto, pontoCidade);
  if (cnefe) {
    avisarSemPontoCidade("cnefe", enderecoBruto, cnefe, pontoCidade);
    await deps.salvarCache(chave, { ...cnefe, fonte: "cnefe" });
    return { ...cnefe, fonte: "cnefe" };
  }

  const local = await deps.geocodificarLocalDep(enderecoBruto, pontoCidade);
  if (local) {
    avisarSemPontoCidade("local", enderecoBruto, local, pontoCidade);
    await deps.salvarCache(chave, { ...local, fonte: "local" });
    return { ...local, fonte: "local" };
  }
  // Google/Nominatim recebem uma string enxuta (rua+numero, bairro, cidade
  // -- com cidade cortada ja expandida -- RJ, Brasil), SEM o sufixo de
  // complemento de entrega do romaneio (ex. "LOJA 02", "KM 270 QUADRA F
  // 101") -- achado real 31/07: mandar isso pro geocoder direto atrapalha
  // mais do que ajuda. geocodificarLocalDep acima usa enderecoBruto original
  // de proposito (so extrai a rua, sufixo nao atrapalha esse parsing).
  // Variantes da consulta externa (completa -> sem bairro): achado 05/09,
  // o bairro derrubava o match do Nominatim em cidade pequena do interior.
  // Ver montarVariantesParaGeocode.
  const variantes = montarVariantesParaGeocode(enderecoBruto);
  const enderecoParaGeocode = variantes[0];
  // Achado real 12/08 (segunda rodada de melhoria pos-deploy): CNEFE/local
  // acima ja tem checagem de distancia contra pontoCidade
  // (escolherCandidatoMaisProximo, dentro de geocodificarCnefe/geocodificarLocal)
  // -- Google/Nominatim NUNCA tiveram essa protecao, aceitavam qualquer
  // resultado direto. Sem pontoCidade (endereco sem cidade reconhecida),
  // nada pra comparar, aceita como sempre.
  const perto = (p: { lat: number; lng: number }) =>
    !pontoCidade || haversineM(pontoCidade.lat, pontoCidade.lng, p.lat, p.lng) <= DISTANCIA_MAX_MATCH_LOCAL_M;

  for (const variante of variantes) {
    const google = await deps.geocodificarGoogle(variante);
    if (google && perto(google)) {
      await deps.salvarCache(chave, { ...google, fonte: "google" });
      return { ...google, fonte: "google" };
    }
  }
  for (const variante of variantes) {
    const nominatim = await deps.geocodificarNominatim(variante);
    if (nominatim && perto(nominatim)) {
      await deps.salvarCache(chave, { ...nominatim, fonte: "nominatim" });
      return { ...nominatim, fonte: "nominatim" };
    }
  }
  return null;
}

// Chamadas HTTP reais -- SEM cache/fallback, isso fica por conta de
// geocodificarEndereco acima. Nao testadas por teste automatizado (chamada
// de rede real); validadas manualmente na Task 5 contra enderecos reais do
// romaneio.
export async function geocodificarGoogle(enderecoBruto: string): Promise<{ lat: number; lng: number } | null> {
  const chave = process.env.GOOGLE_MAPS_API_KEY;
  if (!chave) return null;
  try {
    const url = `https://maps.googleapis.com/maps/api/geocode/json?address=${encodeURIComponent(enderecoBruto)}&language=pt-BR&region=br&key=${chave}`;
    const res = await fetch(url, { signal: AbortSignal.timeout(4000) });
    if (!res.ok) return null;
    const data = (await res.json()) as { results?: { geometry?: { location?: { lat: number; lng: number } } }[] };
    const loc = data.results?.[0]?.geometry?.location;
    return loc ? { lat: loc.lat, lng: loc.lng } : null;
  } catch (err) {
    // Achado real 30/08: rede, quota, ou chave invalida/expirada saiam
    // por aqui sem log -- degradacao pro proximo tier da cascata (CNEFE/
    // OSM ja resolveram antes, entao hoje isso quase nunca importa), mas
    // se a chave expirar de vez isso fica invisivel pra sempre sem log.
    console.error("geocodificarGoogle: falha na chamada:", err);
    return null;
  }
}

// Achado real 27/08 (grupo KPI AJUSTES, "não está identificando os
// clientes certo" -- caso BAIRRO:CENTRO:RIO DE JANEIRO): busca de
// "bairro, cidade" pode devolver em 1o lugar um match de CIDADE/ESTADO
// inteiro em vez do bairro pedido -- Nominatim interpretou "Centro, Rio
// de Janeiro" como busca dentro do ESTADO do Rio, casando com o
// municipio de Nova Friburgo (importance mais alto que o bairro certo),
// que só aparecia em 2o lugar. limit=1 antigo nem deixava o resultado
// certo aparecer na resposta. Tipos "amplos demais" pra responder uma
// busca que pediu algo mais especifico que uma cidade inteira.
const NOMINATIM_TIPOS_AMPLOS_DEMAIS = new Set(["city", "town", "state", "region", "country", "county"]);

export async function geocodificarNominatim(enderecoBruto: string): Promise<{ lat: number; lng: number } | null> {
  try {
    const url = `https://nominatim.openstreetmap.org/search?q=${encodeURIComponent(enderecoBruto)}&format=json&limit=5&countrycodes=br`;
    const res = await fetch(url, {
      headers: { "User-Agent": "TransmonsegCentral/1.0" },
      signal: AbortSignal.timeout(3000),
    });
    if (!res.ok) return null;
    const data = (await res.json()) as { lat?: string; lon?: string; addresstype?: string }[];
    if (data.length === 0) return null;
    // So aplica a preferencia quando a query pediu algo mais especifico
    // que uma cidade sozinha (tem virgula, ex: "Centro, Rio de Janeiro"
    // ou um endereco completo) -- busca de CIDADE pura (sem virgula)
    // deve mesmo aceitar um resultado tipo "city", nao filtrar. Sem
    // nenhum resultado fora da lista ampla demais, cai pro 1o mesmo
    // (nunca rejeita tudo so por causa deste filtro).
    const candidatos = enderecoBruto.includes(",")
      ? data.filter(d => !NOMINATIM_TIPOS_AMPLOS_DEMAIS.has(d.addresstype ?? ""))
      : [];
    const escolhido = candidatos[0] ?? data[0];
    if (!escolhido?.lat || !escolhido?.lon) return null;
    return { lat: parseFloat(escolhido.lat), lng: parseFloat(escolhido.lon) };
  } catch (err) {
    // Achado real 30/08: mesmo motivo do catch de geocodificarGoogle acima.
    console.error("geocodificarNominatim: falha na chamada:", err);
    return null;
  }
}
