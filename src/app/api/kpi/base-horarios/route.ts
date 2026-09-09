// Rota HTTP isolada e SIDE-EFFECT-FREE (nunca escreve em nenhuma tabela)
// que expoe o historico continuo de posicao (posicoes_historico, ~30-40s
// de cadencia, ja coletado por este projeto pro motor de desvio) pro
// projeto IRMAO "KPI transmonseg" -- mesmo padrao de
// /api/romaneio/geocode (ver comentario la pro raciocinio completo de
// "por que HTTP e nao import direto").
//
// Por que essa rota existe (achado real 25/08, KPI Nutry Max): o KPI
// calculava SAIDA CD/CHEGADA CD e KM PERCORRIDO a partir do feed de
// "paradas" da propria Unitrac (/mapa_servicos/stops), que ja vem
// PRE-AGREGADO pela Unitrac com heuristica propria e opaca --
// reclusterizar isso do lado do KPI (com um limiar de duracao minima pra
// distinguir "parada real" de "blip de transito") criava uma classe
// inteira de casos ambiguos (parada curta mas real vs blip, cluster que
// devolve fim_real menor que o esperado, etc -- ver commit da correcao de
// 25/08 em KPI transmonseg/src/lib/unitrac-api/consolida.ts), e o
// KM PERCORRIDO (so' soma reta ENTRE paradas) subestimava o trajeto real
// em ~45% (140km vs 203km reais, mesmo veiculo/dia -- ver
// calcularKmContinuo abaixo). Este projeto ja tem dado MELHOR pro mesmo
// proposito: posicao continua real (lat/lng a cada ~30-40s, o dia
// inteiro) que o motor de desvio ja usa em producao -- da pra detectar a
// entrada/saida da base por CRUZAMENTO DE GEOFENCE direto no dado bruto
// (sem heuristica de cluster/duracao minima) e somar o km real percorrido
// ponto a ponto, sem pular trecho nenhum.
//
// Protegida pelo mesmo header x-motor-key + MOTOR_SECRET das outras rotas
// internas deste projeto -- chamada servidor-a-servidor, nunca do browser.

import pg from "pg";
import { createAdminClient } from "@/lib/supabase/admin";
import { configPoolContabo } from "@/lib/supabase/contabo-ca";
import { haversineM } from "@/lib/unitrac";

export const maxDuration = 30;

// Mesmo raio ja validado do lado do KPI (RAIO_BASE_METROS em
// kpi-romaneio/constants.ts) -- mantido igual aqui pra nao introduzir uma
// segunda nocao divergente de "o que conta como estar na base".
const RAIO_BASE_M = 500;

const MAX_PLACAS_POR_CHAMADA = 200;

type Posicao = { lat: number; lng: number; criado_em: string };
type BaseCentro = { lat: number; lng: number };

/** Dado o historico continuo (ordenado por tempo) e os centros de base do
 *  cliente, acha o instante em que o veiculo SAIU da base pela 1a vez no
 *  dia (transicao dentro->fora) e o instante em que CHEGOU na base pela
 *  ULTIMA vez (transicao fora->dentro) -- sem cluster, sem duracao minima,
 *  so' o cruzamento de geofence observado direto no dado bruto. Se o
 *  veiculo nunca aparece dentro do raio no dia inteiro (base errada pra
 *  essa rota, ou o veiculo so' opera fora do alcance rastreado), os dois
 *  ficam null -- nunca inventa horario. Se so' saiu mas ainda nao voltou
 *  (dia em andamento), chegada fica null -- mesma filosofia de
 *  "eventosBase.length >= 2" que ja existia do lado do KPI, so' que agora
 *  fundamentada em posicao real, nao em contagem de clusters da Unitrac.
 */
export function acharSaidaEChegadaBase(
  posicoes: Posicao[],
  basesCentro: BaseCentro[],
): { saidaBase: string | null; chegadaBase: string | null } {
  if (basesCentro.length === 0 || posicoes.length === 0) return { saidaBase: null, chegadaBase: null };

  const dentro = (p: Posicao) => basesCentro.some((b) => haversineM(b.lat, b.lng, p.lat, p.lng) <= RAIO_BASE_M);

  let saidaBase: string | null = null;
  let chegadaBase: string | null = null;
  let estadoAnterior: boolean | null = null;
  let anterior: Posicao | null = null;

  for (const p of posicoes) {
    const estaDentro = dentro(p);
    if (estadoAnterior === true && estaDentro === false && anterior) {
      // Transicao dentro->fora: guarda so' a PRIMEIRA do dia (a saida real
      // da manha) -- se ja tiver uma, uma saida posterior no meio do dia
      // (ex: volta rapida pra base e sai de novo) nao substitui.
      if (saidaBase === null) saidaBase = anterior.criado_em;
    }
    if (estadoAnterior === false && estaDentro === true) {
      // Transicao fora->dentro: guarda a ULTIMA do dia (sempre sobrescreve
      // -- a chegada que importa e' a mais recente, mesmo que o veiculo
      // tenha passado pela base mais de uma vez).
      chegadaBase = p.criado_em;
    }
    estadoAnterior = estaDentro;
    anterior = p;
  }

  return { saidaBase, chegadaBase };
}

/** Achado real 25/08 (dado real RBI-0J25): o KM PERCORRIDO do lado do KPI
 *  soma distancia em linha reta so' ENTRE as paradas da Unitrac (~20-30
 *  pontos no dia) -- pula todo o trajeto real entre elas. Comparando os
 *  dois pro mesmo veiculo/dia: 140.2km (so' paradas) vs 203.4km (posicao
 *  continua, ~2100 pontos) -- 45% de subestimativa. Soma haversine entre
 *  TODA leitura consecutiva do dia (~30-40s de cadencia) fica muito mais
 *  perto do km real rodado (ainda uma leve subestimativa em curva fechada
 *  dentro de uma unica janela de ~40s, mas ordens de grandeza melhor que
 *  pular o trajeto inteiro entre paradas distantes).
 *
 *  Achado real 27/08 (grupo KPI AJUSTES, "quilometragem de cada carro
 *  está errada"): investigando RBI-0J25 do dia, o MAIOR salto entre duas
 *  leituras consecutivas era 13.71km em 40 segundos -- ~1234 km/h,
 *  fisicamente impossivel pra um caminhao de entrega. E' glitch de GPS
 *  (leitura pontual errada), nao movimento real -- a soma ingenua tratava
 *  isso como km rodado de verdade. So' os 5 maiores saltos do dia somavam
 *  quase 46km "fantasma" num total de ~200km (>20% inflado). Segmento
 *  cuja velocidade implicita excede VELOCIDADE_MAX_PLAUSIVEL_KMH e'
 *  descartado (nao soma, nao interpola) -- mesma filosofia de "nunca
 *  inventa dado" ja usada no resto do arquivo: melhor subestimar um
 *  trecho raro do que inflar todo santo dia com teleporte de GPS. */
const VELOCIDADE_MAX_PLAUSIVEL_KMH = 150

/** Achado real 27/08 (usuario, grupo KPI AJUSTES): calcularKmContinuo
 *  estava recebendo TODAS as posicoes do dia (00h-24h), nao so' as da
 *  rota -- somava tambem manobra/deriva de GPS de ANTES de sair da base
 *  (parado no patio de madrugada) e, principalmente, de DEPOIS de ja ter
 *  voltado (descarga, manobra, motor ligado no patio por horas ate o fim
 *  do dia). O usuario apontou a correcao certa: o km da rota e' so' entre
 *  a saida e a chegada na base, que este arquivo ja calcula em
 *  acharSaidaEChegadaBase. Sem saidaBase (nunca saiu no dia -- ex: folga,
 *  veiculo parado), devolve o dia inteiro sem filtro: nao ha janela de
 *  rota pra recortar, e o dado bruto de um veiculo parado ja fica proximo
 *  de zero km por si so (ver teste "veiculo parado o dia inteiro").
 *  Chegada nula (rota em andamento, ainda nao voltou) recorta so' o
 *  inicio -- soma ate a ultima leitura disponivel. */
export function filtrarJanelaRota(
  posicoes: Posicao[],
  saidaBase: string | null,
  chegadaBase: string | null,
): Posicao[] {
  if (!saidaBase) return posicoes
  const inicio = new Date(saidaBase).getTime()
  const fim = chegadaBase ? new Date(chegadaBase).getTime() : Infinity
  return posicoes.filter((p) => {
    const t = new Date(p.criado_em).getTime()
    return t >= inicio && t <= fim
  })
}

/** Achado real 28/08 (comparacao contra relatorio oficial Unitrac,
 *  TTK-9B93 26/08 -- ver grupo KPI AJUSTES, "não bateu o KM da KPI com o
 *  do relatorio"): a Unitrac so' atualiza lat/lng a cada ~5-6min, mas
 *  nosso polling insere uma leitura por ciclo (~1min) mesmo quando a
 *  posicao NAO mudou -- repete a mesma coordenada varias vezes ate a
 *  proxima atualizacao chegar. Quando a posicao finalmente muda, o salto
 *  real (ex. ~7km de rodovia) fica comparado so' contra o intervalo entre
 *  a PENULTIMA e a ULTIMA leitura repetida (~1min), nao os ~5-6min reais
 *  em que o deslocamento aconteceu -- ~7km/1min = velocidade implicita de
 *  300-450km/h, o filtro de VELOCIDADE_MAX_PLAUSIVEL_KMH descartava como
 *  "glitch" um trecho de rodovia genuino. Resultado medido: 26.9km
 *  calculados vs 271.25km do relatorio oficial da Unitrac pro mesmo
 *  veiculo/dia -- 90% subestimado.
 *  Fix: remove leituras consecutivas com a MESMA coordenada antes de
 *  somar, mantendo so' a PRIMEIRA de cada sequencia repetida -- isso
 *  reatribui o deslocamento ao intervalo de tempo REAL (desde a ultima
 *  vez que a posicao mudou), nao ao ultimo ciclo de polling. Validado:
 *  com essa mudanca, TTK-9B93 26/08 fecha em 270.9km (0.1% de diferenca
 *  do relatorio oficial), sem precisar descartar nenhum segmento. */
function removerLeiturasRepetidas(posicoes: Posicao[]): Posicao[] {
  const dedupe: Posicao[] = [posicoes[0]]
  for (let i = 1; i < posicoes.length; i++) {
    const anterior = dedupe[dedupe.length - 1]
    if (posicoes[i].lat !== anterior.lat || posicoes[i].lng !== anterior.lng) {
      dedupe.push(posicoes[i])
    }
  }
  return dedupe
}

export function calcularKmContinuo(posicoesBrutas: Posicao[]): number | null {
  if (posicoesBrutas.length < 2) return null
  const posicoes = removerLeiturasRepetidas(posicoesBrutas)
  if (posicoes.length < 2) return 0
  let metros = 0
  for (let i = 1; i < posicoes.length; i++) {
    const distanciaM = haversineM(posicoes[i - 1].lat, posicoes[i - 1].lng, posicoes[i].lat, posicoes[i].lng)
    const horas = (new Date(posicoes[i].criado_em).getTime() - new Date(posicoes[i - 1].criado_em).getTime()) / 3_600_000
    const velocidadeKmh = horas > 0 ? (distanciaM / 1000) / horas : Infinity
    if (velocidadeKmh > VELOCIDADE_MAX_PLAUSIVEL_KMH) continue
    metros += distanciaM
  }
  return metros / 1000
}

// Mesmo raio ja validado do lado do KPI (RAIO_ENTREGA_METROS em
// kpi-romaneio/constants.ts, usado por montarVisitas.ts).
// Achado real 30/08: auditoria dos 396 pendentes de 29/08 achou 69 casos
// (17%) com parada real a 296-497m do ponto -- exatamente a faixa perdida
// pelo piso de 300m. Caso confirmado TOS2B69/SUPERMERCADO BOM PRECO
// (ITABORAI, ver relatorio Unitrac: parada na rua, fora do raio do
// cliente). Subido pra 500m (ver RAIO_PRESENCA_MIN_M em motor/route.ts,
// mesmo raciocinio, decoupled de RAIO_CHEGADA_MIN_M que fica em 300m).
const RAIO_ENTREGA_M = 500;

type PontoEntrega = { id: string; lat: number; lng: number };
type VisitaPonto = { id: string; chegada: string | null; saida: string | null; viaVizinhanca?: boolean; viaRaioAmpliado?: boolean };

// Achado real 30/08 (mesma investigacao do bucket 500m-2km, ver
// RAIO_VIZINHANCA_M em scripts/confirmar-presenca-romaneio.mjs): 27% dos
// pendentes eram o MESMO caminhao fazendo UMA parada real que serve VARIOS
// clientes vizinhos (ex. TTM-2G02/Rocinha, rua estreita, entrega a pe) --
// aumentar RAIO_ENTREGA_M nao resolve isso ponto a ponto. Corroboracao por
// vizinhanca (mesmo raciocinio ja aplicado la, agora tambem aqui pro
// relatorio real que a Erica ve): ponto sem visita propria, mas com OUTRO
// ponto da MESMA placa/dia confirmado a <=RAIO_VIZINHANCA_M, herda a
// janela chegada/saida do vizinho, marcado com viaVizinhanca=true --
// decisao explicita do usuario 30/08: mostrar isso com uma marcacao
// distinta no relatorio (nao como confirmacao direta igual as demais),
// pra Erica saber que o horario e aproximado/emprestado de outra entrega
// proxima, nao a chegada/saida exatas desta loja.
const RAIO_VIZINHANCA_M = 800;

// Achado real 06/09 (KPI Nutry Max, auditoria completa dos 396 pendentes de
// 05/09 pedida pelo usuario): 12 casos com parada real de 7-33min a
// 508-791m do proprio ponto -- fora do RAIO_ENTREGA_M (500m), mas SEM
// nenhum ponto vizinho confirmado por perto (viaVizinhanca tambem falhava).
// montarVisitas.ts (KPI) ja tinha ganhado essa faixa ampliada no dia 05/09
// (RAIO_CONFIRMACAO_AMPLIADO_METROS, so' usada quando esta ponte NAO
// responde nada pra aquela NF) -- mas quando a ponte RESPONDE (fonte
// preferida) e diz null, visitas.ts confia cegamente e APAGA qualquer
// confirmacao que o algoritmo antigo tivesse achado, mesmo a ampliada.
// Resultado: a ponte (mais precisa, olha posicao continua real) ficava
// MAIS RESTRITIVA que o fallback que ela deveria substituir, ao inves de
// so' mais precisa. Mesma faixa ampliada tem que existir aqui tambem,
// senao a ponte "rouba" confirmacoes legitimas do fallback so' por ser a
// fonte preferida.
const RAIO_AMPLIADO_M = 800;

/** Achado real 25/08 (mesma investigacao das duas funcoes acima):
 *  montarVisitas.ts (KPI) casa cada PARADA da Unitrac (ja clusterizada,
 *  opaca) com o ponto de entrega geocodificado mais proximo -- inclui
 *  logica extra so' pra evitar "roubar" a visita de um ponto vizinho
 *  quando 2 enderecos ficam perto. Aqui inverte: cada ponto de entrega
 *  ja' TEM sua propria coordenada, entao checa direto se o veiculo
 *  esteve dentro do raio DAQUELE ponto especifico -- sem competir por
 *  cluster nenhum, sem "roubo" possivel (2 pontos proximos podem os 2
 *  genuinamente detectar a mesma janela de posicao, o que faz sentido se
 *  as 2 entregas aconteceram na mesma parada fisica).
 *
 *  Pra cada ponto: acha todos os blocos contiguos de leituras dentro do
 *  raio, fica com o de MAIOR duracao (mesmo criterio de desempate que
 *  montarVisitas.ts ja usava pra escolher entre paradas concorrentes).
 *  Ponto nunca visitado (raio nunca cruzado no dia) -- chegada/saida
 *  ficam null, nunca inventa.
 *
 *  Achado real 27/08 (grupo KPI AJUSTES, "tempo em loja com certeza tá
 *  errado"): testado contra dado real do dia (RBI-0J25), 4 de 19 visitas
 *  confirmadas vinham com chegada===saida (0 minutos) -- um UNICO ping de
 *  GPS a <=300m do ponto, sem o caminhao ter parado de verdade (so'
 *  passou perto ou cruzou a rua), virava "confirmado" igual uma entrega
 *  real de 20min. Bloco com duracao abaixo de DWELL_MINIMO_MS (~2
 *  leituras reais na cadencia normal de ~30-40s) não conta como visita
 *  confirmada -- fica null, mesma filosofia de "nunca inventa" já usada
 *  no resto da função (melhor não confirmar do que confirmar errado por
 *  um ping isolado). */
const DWELL_MINIMO_MS = 60_000

function acharBlocoDentroDoRaio(
  pt: PontoEntrega,
  posicoes: Posicao[],
  raioM: number,
  basesCentro: BaseCentro[] = [],
): { inicio: string; fim: string; durMs: number } | null {
  type Bloco = { inicio: string; fim: string; durMs: number }
  const blocos: Bloco[] = []
  let atual: { inicio: string; fim: string } | null = null

  for (const p of posicoes) {
    const dentro = haversineM(pt.lat, pt.lng, p.lat, p.lng) <= raioM && !estaMaisPertoDaBaseQueDoPonto(p, pt, basesCentro)
    if (dentro) {
      if (!atual) atual = { inicio: p.criado_em, fim: p.criado_em }
      else atual.fim = p.criado_em
    } else if (atual) {
      blocos.push({ ...atual, durMs: new Date(atual.fim).getTime() - new Date(atual.inicio).getTime() })
      atual = null
    }
  }
  if (atual) blocos.push({ ...atual, durMs: new Date(atual.fim).getTime() - new Date(atual.inicio).getTime() })
  if (blocos.length === 0) return null
  const maior = blocos.reduce((a, b) => (b.durMs > a.durMs ? b : a))
  return maior.durMs >= DWELL_MINIMO_MS ? maior : null
}

// Achado real 08/09 (KPI Nutry Max, placa RQV5F67/KINHA BAR): o caminhao
// ficou parado a 81m da PROPRIA BASE a noite inteira (23:55-02:48) --
// nunca saiu pra rua -- mas o cliente "Kinha Bar" fica coincidentemente a
// ~508m da base (mesmo bairro, Penha), dentro de RAIO_ENTREGA_M. Sem
// excluir as posicoes DENTRO da base, qualquer cliente cadastrado perto o
// bastante do CD (ou dos 2 CDs -- Penha e Campos, ver BASE_COORD_NUTRIMAX*
// no lado do KPI) confirma "entrega" TODA NOITE so' pelo caminhao estar
// estacionado na garagem, nunca por ter saido de verdade. montarVisitas.ts
// (o fallback antigo, do lado do KPI) ja' filtrava isso desde sempre
// (`paradas.filter(p => p.classificacao === 'FORA_BASE')`) -- esta ponte
// (posicao continua, mais fina e' por isso mais suscetivel a esse
// problema especifico) nunca ganhou o mesmo filtro.
//
// Achado real 09/09 (auditoria do proprio fix acima): a base da Penha tem
// VARIOS clientes reais cadastrados no MESMO bairro industrial (Penha
// Circular -- ruas "do Feijao", "da Batata", "do Arroz" etc.), alguns a
// menos de 20m do centro da base. Um filtro CEGO (remover toda posicao a
// <=RAIO_BASE_M de QUALQUER base, antes de checar qualquer ponto)
// tornaria essas entregas genuinas estruturalmente inconfirmaveis pela
// ponte -- os dois circulos de 500m (base e cliente) quase se sobrepoem
// por completo quando cliente e base ficam a poucos metros um do outro,
// entao NENHUMA posicao real de entrega sobraria pra confirmar. Trocado
// por comparacao relativa por ponto (`estaMaisPertoDaBaseQueDoPonto`):
// so' descarta a posicao pra ESTE ponto especifico se ela estiver mais
// perto da base do que do proprio ponto -- preserva a exclusao pro caso
// RQV5F67 (posicao a 81m da base e' MUITO mais perto da base que dos
// 508m do Kinha Bar) sem quebrar confirmacao de cliente vizinho legitimo
// (posicao literalmente na porta do cliente fica mais perto DELE que da
// base, mesmo a poucos metros dela).
function estaMaisPertoDaBaseQueDoPonto(p: Posicao, pt: PontoEntrega, basesCentro: BaseCentro[]): boolean {
  return basesCentro.some((b) => {
    const distBase = haversineM(b.lat, b.lng, p.lat, p.lng)
    if (distBase > RAIO_BASE_M) return false
    const distPonto = haversineM(pt.lat, pt.lng, p.lat, p.lng)
    return distBase <= distPonto
  })
}

export function acharVisitasPorPonto(posicoes: Posicao[], pontos: PontoEntrega[], basesCentro: BaseCentro[] = []): VisitaPonto[] {
  const diretas = pontos.map((pt) => {
    const bloco = acharBlocoDentroDoRaio(pt, posicoes, RAIO_ENTREGA_M, basesCentro)
    return bloco ? { id: pt.id, chegada: bloco.inicio, saida: bloco.fim } : { id: pt.id, chegada: null, saida: null }
  })

  // Achado real 06/09 (ver comentario de RAIO_AMPLIADO_M): antes da
  // vizinhanca (que EMPRESTA horario de outro ponto), tenta o PROPRIO
  // ponto com raio mais largo -- evidencia direta do proprio endereco
  // sempre vale mais que emprestar de vizinho, mesmo que so' passe no
  // raio ampliado. Marcado distinto (viaRaioAmpliado), nunca confirmacao
  // igual a normal -- mesmo criterio de "nunca esconder que foi uma
  // aproximacao" ja usado em viaVizinhanca.
  const comAmpliado = diretas.map((v, i) => {
    if (v.chegada !== null) return v
    const bloco = acharBlocoDentroDoRaio(pontos[i], posicoes, RAIO_AMPLIADO_M, basesCentro)
    if (!bloco) return v
    return { id: v.id, chegada: bloco.inicio, saida: bloco.fim, viaRaioAmpliado: true }
  })

  // Passo 2: corroboracao por vizinhanca (ver comentario de
  // RAIO_VIZINHANCA_M). So' pros pontos que os passos acima nao confirmaram
  // -- dwell direto no PROPRIO endereco (normal ou ampliado) sempre tem
  // prioridade sobre emprestar de vizinho.
  const pontoPorId = new Map(pontos.map((pt) => [pt.id, pt]));
  return comAmpliado.map((v, i) => {
    if (v.chegada !== null) return v;
    const pt = pontoPorId.get(v.id)!;
    let melhor: { chegada: string; saida: string } | null = null;
    let menorDist = Infinity;
    for (let j = 0; j < comAmpliado.length; j++) {
      if (j === i) continue;
      const outro = comAmpliado[j];
      if (outro.chegada === null || outro.saida === null) continue;
      const outroPt = pontos[j];
      const dist = haversineM(pt.lat, pt.lng, outroPt.lat, outroPt.lng);
      if (dist <= RAIO_VIZINHANCA_M && dist < menorDist) {
        menorDist = dist;
        melhor = { chegada: outro.chegada, saida: outro.saida };
      }
    }
    if (!melhor) return v;
    return { id: v.id, chegada: melhor.chegada, saida: melhor.saida, viaVizinhanca: true };
  });
}

function normPlaca(p: string): string {
  return p.toUpperCase().replace(/[^A-Z0-9]/g, "");
}

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

  const { placas, data, pontosPorPlaca: pontosPorPlacaBruto } = body as {
    placas?: unknown;
    data?: unknown;
    // Opcional (achado real 25/08, extensao pra CHEGADA/SAIDA NA LOJA):
    // { [placa]: {id, lat, lng}[] } -- id e' o identificador que o
    // chamador quer de volta (KPI usa o numero da NF). Placa ausente
    // deste mapa simplesmente nao recebe `visitas` na resposta (mesmo
    // fail-open das outras rotas: sem pontos, sem visitas, resto do
    // resultado nao e' afetado).
    pontosPorPlaca?: unknown;
  };
  if (!Array.isArray(placas) || !placas.every((p) => typeof p === "string")) {
    return Response.json({ erro: "'placas' precisa ser um array de strings" }, { status: 400 });
  }
  if (typeof data !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(data)) {
    return Response.json({ erro: "'data' precisa ser YYYY-MM-DD" }, { status: 400 });
  }
  if (placas.length > MAX_PLACAS_POR_CHAMADA) {
    return Response.json({ erro: `no maximo ${MAX_PLACAS_POR_CHAMADA} placas por chamada` }, { status: 400 });
  }
  if (placas.length === 0) {
    return Response.json({ resultados: [] });
  }

  const pontosPorPlaca = new Map<string, PontoEntrega[]>();
  if (pontosPorPlacaBruto !== undefined) {
    if (typeof pontosPorPlacaBruto !== "object" || pontosPorPlacaBruto === null) {
      return Response.json({ erro: "'pontosPorPlaca' precisa ser um objeto" }, { status: 400 });
    }
    for (const [placaChave, pontosBrutos] of Object.entries(pontosPorPlacaBruto as Record<string, unknown>)) {
      if (!Array.isArray(pontosBrutos)) continue;
      const pontosValidos = pontosBrutos.filter(
        (p): p is PontoEntrega =>
          typeof p === "object" && p !== null &&
          typeof (p as PontoEntrega).id === "string" &&
          typeof (p as PontoEntrega).lat === "number" &&
          typeof (p as PontoEntrega).lng === "number",
      );
      if (pontosValidos.length > 0) pontosPorPlaca.set(normPlaca(placaChave), pontosValidos);
    }
  }

  // Brasil nao observa horario de verao -- offset fixo -03:00, sem
  // precisar de conversao de fuso via banco (ver mesmo raciocinio em
  // formatarTituloData do lado do KPI).
  const inicioUTC = new Date(`${data}T00:00:00-03:00`);
  const fimUTC = new Date(inicioUTC.getTime() + 24 * 60 * 60 * 1000);

  const admin = createAdminClient();

  const { data: veiculosRows, error: erroVeiculos } = await admin
    .from("veiculos")
    .select("id, placa, cliente_id");
  if (erroVeiculos) {
    return Response.json({ erro: `erro ao carregar veiculos: ${erroVeiculos.message}` }, { status: 500 });
  }
  const veiculoPorPlacaNorm = new Map((veiculosRows ?? []).map((v) => [normPlaca(v.placa), v]));

  const clientesNecessarios = new Set<string>();
  for (const placaBruta of placas) {
    const v = veiculoPorPlacaNorm.get(normPlaca(placaBruta));
    if (v) clientesNecessarios.add(v.cliente_id);
  }

  const basesPorCliente = new Map<string, BaseCentro[]>();
  if (clientesNecessarios.size > 0) {
    const pool = new pg.Pool({ ...configPoolContabo(process.env.DATABASE_URL), max: 2 });
    try {
      const { rows: basesRows } = await pool.query<{ cliente_id: string; lat: number; lng: number }>(
        `SELECT cliente_id,
                ST_Y(ST_Centroid(geom::geometry)) AS lat,
                ST_X(ST_Centroid(geom::geometry)) AS lng
           FROM bases
          WHERE cliente_id = ANY($1::uuid[])`,
        [[...clientesNecessarios]],
      );
      for (const b of basesRows) {
        const lista = basesPorCliente.get(b.cliente_id) ?? [];
        lista.push({ lat: Number(b.lat), lng: Number(b.lng) });
        basesPorCliente.set(b.cliente_id, lista);
      }
    } finally {
      await pool.end();
    }
  }

  const resultados: {
    placa: string;
    saidaBase: string | null;
    chegadaBase: string | null;
    kmPercorrido: number | null;
    visitas?: VisitaPonto[];
  }[] = [];
  for (const placaBruta of placas) {
    const placaNorm = normPlaca(placaBruta);
    const v = veiculoPorPlacaNorm.get(placaNorm);
    if (!v) {
      resultados.push({ placa: placaBruta, saidaBase: null, chegadaBase: null, kmPercorrido: null });
      continue;
    }
    const basesCentro = basesPorCliente.get(v.cliente_id) ?? [];
    const { data: posicoesRows, error: erroPosicoes } = await admin
      .from("posicoes_historico")
      .select("lat, lng, criado_em")
      .eq("veiculo_id", v.id)
      .gte("criado_em", inicioUTC.toISOString())
      .lt("criado_em", fimUTC.toISOString())
      .order("criado_em", { ascending: true });
    if (erroPosicoes) {
      resultados.push({ placa: placaBruta, saidaBase: null, chegadaBase: null, kmPercorrido: null });
      continue;
    }
    const posicoes = (posicoesRows ?? []) as Posicao[];
    const { saidaBase, chegadaBase } = acharSaidaEChegadaBase(posicoes, basesCentro);
    const kmPercorrido = calcularKmContinuo(filtrarJanelaRota(posicoes, saidaBase, chegadaBase));
    const pontos = pontosPorPlaca.get(placaNorm);
    const visitas = pontos ? acharVisitasPorPonto(posicoes, pontos, basesCentro) : undefined;
    resultados.push({ placa: placaBruta, saidaBase, chegadaBase, kmPercorrido, ...(visitas ? { visitas } : {}) });
  }

  return Response.json({ resultados });
}
